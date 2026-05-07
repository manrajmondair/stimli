export type AssetType = "script" | "landing_page" | "image" | "audio" | "video";

export type Asset = {
  id: string;
  type: AssetType;
  name: string;
  project_id?: string | null;
  source_url?: string | null;
  file_path?: string | null;
  extracted_text: string;
  duration_seconds?: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type TimelinePoint = {
  second: number;
  attention: number;
  memory: number;
  cognitive_load: number;
  note: string;
};

export type ScoreBreakdown = {
  overall: number;
  hook: number;
  clarity: number;
  cta: number;
  brand_cue: number;
  pacing: number;
  offer_strength: number;
  audience_fit: number;
  neural_attention: number;
  memory: number;
  cognitive_load: number;
};

export type AnalysisRun = {
  asset_id: string;
  provider: string;
  status: "queued" | "running" | "retrying" | "processing" | "complete" | "failed" | "cancelled";
  scores: ScoreBreakdown;
  timeline: TimelinePoint[];
  feature_vector: Record<string, number>;
  summary: string;
};

export type VariantResult = {
  asset: Asset;
  analysis: AnalysisRun;
  rank: number;
  delta_from_best: number;
};

export type Recommendation = {
  winner_asset_id: string | null;
  verdict: "ship" | "revise";
  confidence: number;
  headline: string;
  reasons: string[];
};

export type Suggestion = {
  asset_id: string;
  target: string;
  severity: "low" | "medium" | "high";
  issue: string;
  suggested_edit: string;
  expected_effect: string;
  draft_revision: string;
};

export type CreativeBrief = {
  brand_name: string;
  audience: string;
  product_category: string;
  primary_offer: string;
  required_claims: string[];
  forbidden_terms: string[];
};

export type Comparison = {
  id: string;
  project_id?: string | null;
  objective: string;
  brief: CreativeBrief;
  status: "processing" | "complete" | "failed" | "cancelled";
  variants: VariantResult[];
  recommendation: Recommendation;
  suggestions: Suggestion[];
  jobs?: ComparisonJob[];
  created_at: string;
};

export type Project = {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  created_at: string;
};

export type ComparisonJob = {
  job_id: string;
  asset_id: string;
  status: "queued" | "running" | "retrying" | "processing" | "complete" | "failed" | "cancelled";
  provider: string;
  error?: string | null;
  attempt?: number | null;
  previous_job_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type OutcomeCreate = {
  asset_id: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  notes: string;
};

export type Outcome = OutcomeCreate & {
  id: string;
  comparison_id: string;
  created_at: string;
};

export type ChallengerResponse = {
  asset: Asset;
  source_asset_id: string;
  focus: "hook" | "cta" | "offer" | "clarity";
};

export type LearningSummary = {
  outcome_count: number;
  total_spend: number;
  total_revenue: number;
  average_ctr: number;
  average_cvr: number;
  best_asset_id: string | null;
  calibration: {
    evaluated_comparisons: number;
    aligned_predictions: number;
    alignment_rate: number;
    recent: Array<{
      comparison_id: string;
      predicted_asset_id: string;
      actual_best_asset_id: string;
      aligned: boolean;
      actual_profit: number;
      predicted_profit: number | null;
    }>;
  };
  insight: string;
};

export type BrainProviderHealth = {
  provider: string;
  available: boolean;
  active: boolean;
  detail: string;
};

export type Plan = {
  id: "research" | "growth" | "scale";
  name: string;
  asset_limit_per_hour: number;
  comparison_limit_per_hour: number;
  commercial: boolean;
  configured: boolean;
};

export type BillingStatus = {
  current_plan: Plan;
  billing_configured: boolean;
  commercial_use_enabled: boolean;
  license: {
    provider: string;
    tribe_commercial_license: boolean;
    mode: "research-only" | "commercial-ready";
  };
  plans: Plan[];
};

export type Report = {
  comparison_id: string;
  title: string;
  executive_summary: string;
  recommendation: Recommendation;
  variants: VariantResult[];
  suggestions: Suggestion[];
  next_steps: string[];
  brief: CreativeBrief;
  learning_summary: LearningSummary | null;
};

export type ShareLink = {
  token: string;
  path: string;
  api_path: string;
  url: string;
  expires_at: string;
};

export type TeamInvite = {
  id: string;
  team_id: string;
  team_name: string;
  email: string;
  role: TeamRole;
  url?: string;
  token?: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
};

export type TeamRole = "owner" | "admin" | "analyst" | "viewer";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  created_at: string;
};

export type Team = {
  id: string;
  name: string;
  role?: TeamRole;
  created_at: string;
};

export type AuthSession = {
  authenticated: boolean;
  user: AuthUser | null;
  team: Team | null;
  role?: TeamRole | "anonymous";
  permissions?: string[];
  teams: Team[];
};

export type TeamMember = {
  user_id: string;
  role: TeamRole;
  email: string;
  name: string;
  created_at: string;
  updated_at: string | null;
};

export type AuditEvent = {
  id: string;
  workspace_id: string;
  actor_id: string;
  actor_email: string;
  action: string;
  target_type: string;
  target_id: string;
  details: Record<string, unknown>;
  created_at: string;
};

export type AdminSummary = {
  jobs: Record<string, number>;
  providers: BrainProviderHealth[];
  recent_events: AuditEvent[];
  storage: { mode: string; persistent: boolean; detail: string };
  inference: {
    remote_configured: boolean;
    control_configured: boolean;
    extractor_configured: boolean;
    strict_remote: boolean;
  };
};

export type BrandProfile = {
  id: string;
  name: string;
  brief: CreativeBrief;
  voice_rules: string[];
  compliance_notes: string[];
  created_at: string;
  updated_at: string;
};

export type GovernancePolicy = {
  private_uploads: boolean;
  public_share_links: boolean;
  share_link_ttl_days: number;
  deletion_workflow: string;
  export_scope: string;
  retention_days: number;
  commercial_license_mode: string;
};

export type GovernanceRequest = {
  id: string;
  request_type: string;
  target_type: string;
  target_id: string;
  reason: string;
  status: "pending_review" | "approved" | "rejected" | "complete";
  requested_by: string | null;
  created_at: string;
};

export type WorkspaceExport = {
  schema: string;
  exported_at: string;
  workspace_id: string;
  policy: GovernancePolicy;
  projects: Project[];
  assets: Asset[];
  comparisons: Comparison[];
  outcomes: Outcome[];
  audit_events: AuditEvent[];
  brand_profiles: BrandProfile[];
  governance_requests: GovernanceRequest[];
  benchmark_runs: BenchmarkRun[];
  imports: ImportJob[];
  members: TeamMember[];
};

export type LibraryAsset = Asset & {
  library: {
    text_length: number;
    extraction_status: string;
    has_private_blob: boolean;
    source: string;
  };
};

export type LibraryResponse = {
  assets: LibraryAsset[];
  total: number;
};

export type ImportJob = {
  id: string;
  platform: string;
  source: string;
  status: "complete" | "partial" | "failed";
  total_items: number;
  imported_items: number;
  failed_items: number;
  failures: Array<{ item: unknown; error: string }>;
  created_at: string;
};

export type BenchmarkRun = {
  id: string;
  benchmark_id: string;
  benchmark_name: string;
  case_count: number;
  aligned: number;
  accuracy: number;
  average_confidence: number;
  results: Array<{
    expected: string;
    predicted: string;
    aligned: boolean;
    confidence: number;
    winner_score: number;
  }>;
  created_at: string;
};

export type ValidationCalibration = {
  learning: LearningSummary;
  confidence_bins: Array<{
    label: string;
    min: number;
    max: number;
    predictions: number;
    aligned: number;
    observed_accuracy: number;
  }>;
  benchmark_runs: BenchmarkRun[];
};
