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
};

export type Comparison = {
  id: string;
  objective: string;
  status: "complete";
  variants: VariantResult[];
  recommendation: Recommendation;
  suggestions: Suggestion[];
  created_at: string;
};

export type Report = {
  comparison_id: string;
  title: string;
  executive_summary: string;
  recommendation: Recommendation;
  variants: VariantResult[];
  suggestions: Suggestion[];
  next_steps: string[];
};
