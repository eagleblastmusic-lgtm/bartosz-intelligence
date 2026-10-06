import {
  assertContext,
  type AccessContext,
  type Database,
} from '../db/boundary.js';
import { ArtifactRepository } from '../artifacts/store.js';
import { QuotaAdmission } from './admission.js';
import { validTokenAccounting } from './accounting.js';
import type { LeaseToken } from '../../../contracts/src/jobs.js';
import type { AIResponse } from '../../../contracts/src/ai.js';

export type ResponseMetadata = Omit<AIResponse, 'raw_output'>;
export class AnalysisResponses {
  constructor(
    private db: Database,
    private context: AccessContext,
    private task: 'ANALYZE' | 'TRANSLATE' | 'HISTORICAL_COMPARE' = 'ANALYZE',
  ) {
    assertContext(context);
  }
  async record(
    token: LeaseToken,
    reservationId: string,
    artifactId: string,
    now: Date,
  ) {
    this.context.requireTask(this.task);
    const artifact = await new ArtifactRepository(
      this.db,
      this.context,
      reservationId,
    ).get(artifactId, token, this.task, now);
    const provenance = JSON.parse(artifact.provenance_json) as {
      reservation_id: string;
      response: ResponseMetadata;
      raw_output_present: boolean;
    };
    const response = provenance.response;
    const reservation = await this.db
      .prepare(
        'SELECT request_id FROM quota_reservations WHERE owner_id=? AND reservation_id=? AND job_id=? AND fencing_token=?',
      )
      .bind(
        this.context.ownerId,
        reservationId,
        token.job_id,
        token.fencing_token,
      )
      .first<{ request_id: string }>();
    if (
      artifact.state !== 'VERIFIED' ||
      artifact.schema_version !== 'provider-output:1' ||
      artifact.producer_version !== 'gemini-response:1:' + reservationId ||
      provenance.reservation_id !== reservationId ||
      typeof provenance.raw_output_present !== 'boolean' ||
      !response ||
      Object.keys(response).some(
        (k) =>
          ![
            'request_id',
            'status',
            'actual_provider',
            'actual_model',
            'finish_reason',
            'usage',
            'retry_after',
            'token_usage_numeric_fields',
          ].includes(k),
      ) ||
      response.request_id !== reservation?.request_id ||
      ![
        'OK',
        'REFUSED',
        'INCOMPLETE',
        'RATE_LIMITED',
        'AUTH_REQUIRED',
        'TEMPORARY_FAILURE',
        'INVALID_REQUEST',
      ].includes(response.status) ||
      response.actual_provider !== 'gemini' ||
      (response.token_usage_numeric_fields !== undefined &&
        !validTokenAccounting(response.token_usage_numeric_fields)) ||
      !(
        response.actual_model === null ||
        (typeof response.actual_model === 'string' &&
          response.actual_model.length <= 128)
      ) ||
      typeof response.finish_reason !== 'string' ||
      response.finish_reason.length > 128 ||
      !response.usage ||
      Object.keys(response.usage).length !== 3 ||
      !['input_tokens', 'output_tokens', 'total_tokens'].every((k) =>
        Object.hasOwn(response.usage, k),
      ) ||
      !(
        response.retry_after === null ||
        (typeof response.retry_after === 'string' &&
          response.retry_after.length <= 128)
      ) ||
      (!provenance.raw_output_present && artifact.byte_size !== 0)
    )
      throw new Error('INVALID_AI_RESPONSE_RECEIPT');
    await new QuotaAdmission(this.db, this.context, this.task).reconcile(
      reservationId,
      { ...response, raw_output: null },
      now,
    );
    return {
      artifact_id: artifactId,
      request_id: response.request_id,
      status: response.status,
      diagnostic_only: true,
    };
  }
}
