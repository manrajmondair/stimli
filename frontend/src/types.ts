export type AssetType = "script" | "landing_page" | "image" | "audio" | "video";

export type Asset = {
  id: string;
  type: AssetType;
  name: string;
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
  status: "complete";
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
  objective: string;
  brief: CreativeBrief;
  status: "complete";
  variants: VariantResult[];
  recommendation: Recommendation;
  suggestions: Suggestion[];
  created_at: string;
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
  insight: string;
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
