import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { remoteDatabase } from './cloudflare.mjs';
import { AccessContext } from '../../packages/core/src/db/boundary.js';
import { sha256, randomToken } from '../../packages/core/src/auth/crypto.js';
import { ArtifactRepository } from '../../packages/core/src/artifacts/store.js';
import { renderAnnotationSheet } from '../gates/ai-pilot-annotation.js';
import { PromptRegistry } from '../../packages/core/src/registry/store.js';
import type { RegistryBundle } from '../../packages/core/src/registry/bundle.js';
import { ModelRegistry } from '../../packages/core/src/ai/models.js';
import { AnalysisJobs } from '../../packages/core/src/ai/jobs.js';
import {
  QuotaSnapshots,
  type GeminiQuotaObservation,
} from '../../packages/core/src/ai/quota-snapshots.js';
import type { PipelineProfile } from '../../packages/contracts/src/ai.js';

const directory = resolve('docs/verification/gate-ai');
const file = (name: string) => {
  const path = resolve(name);
  if (!path.startsWith(directory + '\\') && !path.startsWith(directory + '/'))
    throw new Error('EVIDENCE_PATH_REQUIRED');
  return path;
};
const mode = process.argv[2],
  now = new Date();
const defaults = JSON.parse(readFileSync('config/defaults.json', 'utf8')) as {
  paid_services_enabled: boolean;
};
if (defaults.paid_services_enabled !== false)
  throw new Error('PAID_POLICY_DENIED');
const decision = JSON.parse(
  readFileSync('docs/verification/gate-e/owner-use-decision.json', 'utf8'),
) as {
  google_project: string;
  owner_use_classification: string;
  region: string;
  billing_route: string;
  developer_is_only_user: boolean;
};
if (decision.billing_route !== 'disabled' || !decision.developer_is_only_user)
  throw new Error('OWNER_DECISION_REQUIRED');
if (mode === 'capabilities') {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('PROVIDER_CONFIGURATION_REQUIRED');
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash',
    {
      method: 'GET',
      headers: { 'x-goog-api-key': key },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    },
  );
  const body = await response.text();
  if (!response.ok || body.length > 65536)
    throw new Error('MODEL_READ_FAILED_' + response.status);
  const model = JSON.parse(body) as {
    name: string;
    inputTokenLimit: number;
    outputTokenLimit: number;
    supportedGenerationMethods: string[];
  };
  if (
    model.name !== 'models/gemini-3.8-flash' ||
    !Number.isSafeInteger(model.inputTokenLimit) ||
    !Number.isSafeInteger(model.outputTokenLimit) ||
    !model.supportedGenerationMethods.includes('generateContent')
  )
    throw new Error('MODEL_CAPABILITY_UNVERIFIED');
  const receipt = {
    version: 'model-capabilities:1',
    sampled_at: now.toISOString(),
    model: 'gemini-3.8-flash',
    input_tokens: model.inputTokenLimit,
    output_tokens: model.outputTokenLimit,
    supported_methods: model.supportedGenerationMethods,
    response_sha256: await sha256(body),
    generation_requests: 0,
    secret_values_recorded: false,
  };
  mkdirSync(directory, { recursive: true });
  const path = resolve(
    directory,
    'model-capabilities-' + now.toISOString().replaceAll(':', '-') + '.json',
  );
  writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(receipt) + '\n');
} else {
  // Administrative use only, with the same existing Core owner/repository
  // boundary. Cloudflare account authorization is required by the REST bridge.
  // No owner allowlist or OIDC configuration is modified; the short-lived
  // internal session is never exposed and is revoked even on failure.
  const db = remoteDatabase();
  const owners = await db
    .prepare('SELECT owner_id FROM owner_users WHERE allowlisted=1 LIMIT 2')
    .all<{ owner_id: string }>();
  if (owners.results.length !== 1) throw new Error('VERIFIED_OWNER_REQUIRED');
  const sessionHash = await sha256(randomToken());
  await db
    .prepare(
      'INSERT INTO owner_sessions(session_hash,owner_id,csrf_hash,created_at,expires_at) VALUES(?,?,?,?,?)',
    )
    .bind(
      sessionHash,
      owners.results[0]!.owner_id,
      await sha256(randomToken()),
      now.toISOString(),
      new Date(now.getTime() + 300000).toISOString(),
    )
    .run();
  try {
    const owner = await AccessContext.owner(
      db,
      sessionHash,
      new Date().toISOString(),
    );
    if (mode === 'prepare') {
      const caps = JSON.parse(readFileSync(file(process.argv[3]!), 'utf8')) as {
        version: string;
        sampled_at: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        generation_requests: number;
      };
      const tier = JSON.parse(readFileSync(file(process.argv[4]!), 'utf8')) as {
        project: string;
        tier: string;
        model: string;
        recorded_at_utc: string;
      };
      const fresh = (date: string) =>
        Number.isFinite(Date.parse(date)) &&
        Date.parse(date) <= now.getTime() &&
        now.getTime() - Date.parse(date) <= 3600000;
      if (
        caps.version !== 'model-capabilities:1' ||
        caps.generation_requests !== 0 ||
        caps.model !== 'gemini-3.8-flash' ||
        tier.model !== caps.model ||
        tier.project !== decision.google_project ||
        tier.tier !== 'FREE' ||
        !fresh(caps.sampled_at) ||
        !fresh(tier.recorded_at_utc) ||
        !Number.isSafeInteger(caps.input_tokens) ||
        caps.input_tokens < 4096 ||
        !Number.isSafeInteger(caps.output_tokens) ||
        caps.output_tokens < 4096
      )
        throw new Error('FRESH_CAPABILITIES_AND_TIER_REQUIRED');
      const registry = new PromptRegistry(db, owner);
      const bundle = JSON.parse(
        readFileSync('config/registry/master-bundle.json', 'utf8'),
      ) as RegistryBundle;
      const bundleHash = await registry.importBundle(bundle, new Date());
      const pointer = await db
        .prepare(
          "SELECT MAX(revision) AS revision FROM config_versions WHERE owner_id=? AND config_id='active-economy-prompt'",
        )
        .bind(owner.ownerId)
        .first<{ revision: number | null }>();
      if (!pointer?.revision)
        await registry.activate('ECONOMY_ANALYSIS_V1', 2, 0, new Date());
      const models = new ModelRegistry(db, owner),
        prior = await models.latest('gemini_free');
      if (prior?.quality_approvals.length)
        throw new Error('PRODUCTION_PROFILE_CHANGE_REQUIRES_REVIEW');
      const profile: PipelineProfile = {
        profile_id: 'gemini_free',
        revision: (prior?.revision ?? 0) + 1,
        provider_id: 'gemini',
        model: caps.model,
        account_key: tier.project,
        free_eligible: true,
        billing_enabled: false,
        purposes: [decision.owner_use_classification],
        regions: [decision.region],
        task_types: ['ECONOMY'],
        runtimes: ['local'],
        structured_output: true,
        context_tokens: caps.input_tokens,
        output_tokens: caps.output_tokens,
        rank: 0,
        quality_approvals: [],
        eligibility_expires_at: new Date(
          Math.min(
            Date.parse(caps.sampled_at),
            Date.parse(tier.recorded_at_utc),
          ) + 3600000,
        ).toISOString(),
      };
      await models.publish(profile, new Date());
      const policy = JSON.stringify({ RPM: 1, INPUT_TPM: 25000, RPD: 2 });
      const revision = await db
        .prepare(
          "SELECT COALESCE(MAX(revision),0)+1 AS n FROM config_versions WHERE owner_id=? AND config_id='quota-reserve-gemini_free'",
        )
        .bind(owner.ownerId)
        .first<{ n: number }>();
      await db
        .prepare('INSERT INTO config_versions VALUES(?,?,?,?,?,?)')
        .bind(
          'quota-reserve-gemini_free',
          owner.ownerId,
          revision!.n,
          policy,
          await sha256(policy),
          new Date().toISOString(),
        )
        .run();
      process.stdout.write(
        JSON.stringify({
          result: 'PREPARED',
          bundle_hash: bundleHash,
          model: profile.model,
          profile_revision: profile.revision,
          quality_approvals: 0,
          runtime: 'local',
          paid_services_enabled: false,
          generation_requests: 0,
        }) + '\n',
      );
    } else if (mode === 'export-source') {
      const run = process.argv[3],
        output = resolve(process.argv[4] ?? ''),
        privateRoot = resolve('.local/ai-pilot');
      if (
        !run ||
        !/^transcript_[a-f0-9]{64}$/.test(run) ||
        !output.startsWith(privateRoot + sep)
      )
        throw new Error('PRIVATE_PILOT_SOURCE_PATH_REQUIRED');
      const accepted = await db
        .prepare(
          "SELECT r.outcome_json,r.candidate_hash,i.external_id FROM analysis_runs r JOIN jobs j ON j.owner_id=r.owner_id AND j.job_id=r.job_id JOIN items i ON i.owner_id=r.owner_id AND i.item_id=r.item_id WHERE r.owner_id=? AND r.run_id=? AND r.state='ACCEPTED' AND j.task_type='FETCH_TRANSCRIPT' AND j.state='SUCCEEDED'",
        )
        .bind(owner.ownerId, run)
        .first<{
          outcome_json: string;
          candidate_hash: string;
          external_id: string;
        }>();
      if (
        !accepted ||
        (await sha256(accepted.outcome_json)) !== accepted.candidate_hash
      )
        throw new Error('VERIFIED_SOURCE_REQUIRED');
      const source = JSON.parse(accepted.outcome_json) as {
        source_artifact_id: string;
        segment_map_artifact_id: string;
        source_hash: string;
        authority: { authority_confidence: string };
      };
      if (source.authority?.authority_confidence !== 'CONFIRMED')
        throw new Error('SOURCE_AUTHORITY_REQUIRED');
      const repository = new ArtifactRepository(db, owner);
      const read = async (id: string) => {
        const result = await repository.readVerifiedText(id, 32 * 1024 * 1024);
        return { header: result.artifact, text: result.text };
      };
      const original = await read(source.source_artifact_id),
        map = await read(source.segment_map_artifact_id);
      if (
        original.header.kind !== 'SOURCE_ORIGINAL' ||
        original.header.content_hash !== source.source_hash ||
        map.header.kind !== 'SEGMENT_MAP' ||
        map.header.original_ref !== original.header.artifact_id ||
        map.header.producer_version !== 'source-normalizer:1'
      )
        throw new Error('SOURCE_PAIR_MISMATCH');
      const sheet = await renderAnnotationSheet({
        video_id: accepted.external_id,
        source_text: original.text,
        manifest: JSON.parse(map.text),
        manifest_hash: map.header.content_hash,
      });
      const priorSubmissions = await db
        .prepare(
          `SELECT count(*) AS n FROM quota_reservations q JOIN jobs j ON j.owner_id=q.owner_id AND j.job_id=q.job_id WHERE q.owner_id=? AND json_extract(j.payload_json,'$.snapshot.source.run_id')=? AND q.state IN ('SUBMITTED','UNKNOWN','SETTLED')`,
        )
        .bind(owner.ownerId, run)
        .first<number>('n');
      mkdirSync(output, { recursive: true });
      writeFileSync(resolve(output, 'source.txt'), original.text, {
        flag: 'wx',
      });
      writeFileSync(resolve(output, 'manifest.json'), map.text, { flag: 'wx' });
      writeFileSync(resolve(output, 'annotations.html'), sheet, { flag: 'wx' });
      writeFileSync(
        resolve(output, 'source-receipt.json'),
        JSON.stringify(
          {
            video_id: accepted.external_id,
            source_run_id: run,
            source_hash: source.source_hash,
            manifest_hash: map.header.content_hash,
            exported_at: new Date().toISOString(),
            human_annotations: 'NOT_CREATED',
            provider_requests: 0,
            prior_provider_submissions: priorSubmissions ?? 0,
            blind_pilot_eligibility:
              priorSubmissions === 0
                ? 'REQUIRES_PRE_REQUEST_FROZEN_ANNOTATIONS'
                : 'NOT_BLIND_PRE_REQUEST_CORPUS',
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
      process.stdout.write(
        JSON.stringify({
          result: 'PRIVATE_SOURCE_EXPORTED',
          output,
          source_hash: source.source_hash,
          manifest_hash: map.header.content_hash,
          generation_requests: 0,
        }) + '\n',
      );
    } else if (mode === 'enqueue') {
      const run = process.argv[3];
      if (!run || !/^transcript_[a-f0-9]{64}$/.test(run))
        throw new Error('SOURCE_RUN_REQUIRED');
      const job = await new AnalysisJobs(db, owner).enqueue(
        run,
        {
          runtime: 'local',
          mode: 'QUALITY_TEST',
          purpose: decision.owner_use_classification,
          region: decision.region,
          max_output_tokens: 4096,
          limits: {
            summary_pl: 8,
            key_points: 12,
            entity_mentions: 30,
            tools: 20,
            claims: 30,
            stance: 15,
            predictions: 15,
          },
        },
        new Date(),
      );
      process.stdout.write(
        JSON.stringify({
          job_id: job!.job_id,
          state: job!.state,
          mode: 'QUALITY_TEST',
          generation_requests: 0,
        }) + '\n',
      );
    } else if (mode === 'quota') {
      const observation = JSON.parse(
        readFileSync(file(process.argv[3]!), 'utf8'),
      ) as GeminiQuotaObservation;
      const result = await new QuotaSnapshots(db, owner).record(
        observation,
        new Date(),
      );
      process.stdout.write(
        JSON.stringify({
          result: 'RECORDED',
          ...result,
          generation_requests: 0,
        }) + '\n',
      );
    } else throw new Error('INVALID_PREPARATION_MODE');
  } finally {
    await db
      .prepare('UPDATE owner_sessions SET revoked_at=? WHERE session_hash=?')
      .bind(new Date().toISOString(), sessionHash)
      .run();
  }
}
