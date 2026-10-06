type JsonSchema = Record<string, unknown>;
export interface PipelineProfile {
  profile_id: string;
  revision: number;
  provider_id: string;
  model: string;
  account_key: string;
  free_eligible: boolean;
  billing_enabled: boolean;
  purposes: string[];
  regions: string[];
  task_types: string[];
  runtimes: ('local' | 'cloud')[];
  structured_output: boolean;
  context_tokens: number;
  output_tokens: number;
  rank: number;
  quality_approvals: string[];
  eligibility_expires_at: string;
}
export interface AIRequest {
  request_id: string;
  runtime: 'local' | 'cloud';
  profile: PipelineProfile;
  prompt: string;
  wire_schema: JsonSchema;
  estimated_input_tokens: number;
  max_output_tokens: number;
  deadline: string;
  quality_scope: string;
  mode: 'PRODUCTION' | 'QUALITY_TEST';
  paid_services_enabled: false;
}
export interface AIResponse {
  request_id: string;
  status:
    | 'OK'
    | 'REFUSED'
    | 'INCOMPLETE'
    | 'RATE_LIMITED'
    | 'AUTH_REQUIRED'
    | 'TEMPORARY_FAILURE'
    | 'INVALID_REQUEST';
  raw_output: string | null;
  actual_provider: string;
  actual_model: string | null;
  finish_reason: string;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    total_tokens: number | null;
  };
  retry_after: string | null;
  token_usage_numeric_fields?: Record<string, number> | null;
}
export interface AIProvider {
  provider_id: string;
  run(
    request: AIRequest,
    permit: { reservation_id: string; request_id: string },
  ): Promise<AIResponse>;
}
