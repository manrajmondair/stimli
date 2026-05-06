from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


AssetType = Literal["script", "landing_page", "image", "audio", "video"]


class Asset(BaseModel):
    id: str
    type: AssetType
    name: str
    source_url: str | None = None
    file_path: str | None = None
    extracted_text: str = ""
    duration_seconds: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str


class AssetUploadResponse(BaseModel):
    asset: Asset


class TimelinePoint(BaseModel):
    second: float
    attention: float
    memory: float
    cognitive_load: float
    note: str


class ScoreBreakdown(BaseModel):
    overall: float
    hook: float
    clarity: float
    cta: float
    brand_cue: float
    pacing: float
    neural_attention: float
    memory: float
    cognitive_load: float


class Suggestion(BaseModel):
    asset_id: str
    target: str
    severity: Literal["low", "medium", "high"]
    issue: str
    suggested_edit: str
    expected_effect: str


class AnalysisRun(BaseModel):
    asset_id: str
    provider: str
    status: Literal["complete"]
    scores: ScoreBreakdown
    timeline: list[TimelinePoint]
    feature_vector: dict[str, float]
    summary: str


class ComparisonCreate(BaseModel):
    asset_ids: list[str] = Field(min_length=2)
    objective: str = "Find the variant most likely to earn attention, build memory, and convert."


class VariantResult(BaseModel):
    asset: Asset
    analysis: AnalysisRun
    rank: int
    delta_from_best: float


class Recommendation(BaseModel):
    winner_asset_id: str | None
    verdict: Literal["ship", "revise"]
    confidence: float
    headline: str
    reasons: list[str]


class Comparison(BaseModel):
    id: str
    objective: str
    status: Literal["complete"]
    variants: list[VariantResult]
    recommendation: Recommendation
    suggestions: list[Suggestion]
    created_at: str


class Report(BaseModel):
    comparison_id: str
    title: str
    executive_summary: str
    recommendation: Recommendation
    variants: list[VariantResult]
    suggestions: list[Suggestion]
    next_steps: list[str]

