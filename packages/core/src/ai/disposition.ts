import { AnalysisJobs } from './jobs.js';
import { AnalysisResponses, type ResponseMetadata } from './responses.js';
import { ArtifactRepository } from '../artifacts/store.js';
import { JobStore } from '../jobs/store.js';
import { retryDisposition } from '../jobs/policy.js';
import { AnalysisValidation } from './validation.js';
import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import type { LeaseToken } from '../../../contracts/src/jobs.js';

// Disposition is derived from the retained receipt; workers cannot assert a
// provider failure category or overwrite an accepted result.
export class AnalysisDisposition {
  constructor(
    private db: Database,
    private context: AccessContext,
  ) {
    assertContext(context);
  }
  async apply(
    token: LeaseToken,
    reservationId: string,
    artifactId: string,
    now: Date,
    secret: string,
  ) {
    const started = Date.now(),
      current = () => new Date(now.getTime() + Date.now() - started);
    const prepared = await new AnalysisJobs(this.db, this.context).prepareRun(
      token,
      current(),
    );
    await new AnalysisResponses(this.db, this.context).record(
      token,
      reservationId,
      artifactId,
      current(),
    );
    const artifact = await new ArtifactRepository(this.db, this.context).get(
      artifactId,
      token,
      'ANALYZE',
      current(),
    );
    const provenance = JSON.parse(artifact.provenance_json) as {
      reservation_id: string;
      response: ResponseMetadata;
    };
    if (
      provenance.reservation_id !== reservationId ||
      provenance.response.request_id !== prepared.run_id ||
      artifact.item_id !== prepared.snapshot.source.item_id
    )
      throw new Error('INVALID_AI_RESPONSE_RECEIPT');
    const store = new JobStore(this.db, this.context),
      job = await store.get(token.job_id);
    if (!job) throw new Error('NOT_FOUND');
    const response = provenance.response;
    let decision: {
      state: 'BLOCKED' | 'DEFERRED' | 'RETRY_WAIT';
      reason: string;
      due_at: string;
    };
    if (response.status === 'TEMPORARY_FAILURE') {
      decision = retryDisposition('TRANSIENT', job.attempt_count, current());
      const providerBoundary =
        response.retry_after === null ? NaN : Date.parse(response.retry_after);
      if (
        Number.isFinite(providerBoundary) &&
        providerBoundary > Date.parse(decision.due_at)
      )
        decision.due_at = new Date(providerBoundary).toISOString();
    } else if (response.status === 'RATE_LIMITED') {
      const reset =
        response.retry_after === null ? NaN : Date.parse(response.retry_after);
      // An absent provider reset is unknown, not an invented quota boundary.
      decision = {
        state: 'DEFERRED',
        reason: 'AI_RATE_LIMITED',
        due_at: new Date(
          Number.isFinite(reset) && reset > current().getTime()
            ? reset
            : current().getTime() + 900000,
        ).toISOString(),
      };
    } else if (response.status === 'OK') {
      const validation = await new AnalysisValidation(
        this.db,
        this.context,
      ).evaluate(token, reservationId, artifactId, current(), secret);
      if (validation.status === 'VALIDATED')
        throw new Error('VALIDATED_ANALYSIS_REQUIRES_COMPLETION');
      decision = {
        state: 'BLOCKED',
        reason:
          validation.status === 'REVIEW_REQUIRED'
            ? 'AI_SOURCE_REVIEW_REQUIRED'
            : 'AI_OUTPUT_REVIEW_REQUIRED',
        due_at: current().toISOString(),
      };
    } else
      decision = {
        state: 'BLOCKED',
        reason: 'AI_' + response.status,
        due_at: current().toISOString(),
      };
    await store.disposition(
      token,
      'ANALYZE',
      decision.state,
      decision.reason,
      decision.due_at,
      current(),
    );
    return { accepted: false, run_id: prepared.run_id, ...decision };
  }
}
