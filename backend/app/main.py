from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any, cast

from fastapi import FastAPI, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.analysis import CreativeAnalyzer, build_challenger_text
from app.brain import provider_health
from app.extractor import BlockedLandingPageURL, extract_landing_page_text, normalize_public_url
from app.models import (
    Asset,
    AssetType,
    AssetUploadResponse,
    BrainProviderHealth,
    CalibrationEvaluation,
    CalibrationSummary,
    ChallengerCreate,
    ChallengerResponse,
    Comparison,
    ComparisonCreate,
    LearningSummary,
    Outcome,
    OutcomeCreate,
    PublicAsset,
    Report,
)
from app.storage import UPLOAD_DIR, Store, new_id, now_iso


app = FastAPI(title="Stimli API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = Store()
analyzer = CreativeAnalyzer()

DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024
DEFAULT_MAX_SCRIPT_TEXT_BYTES = 1 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 1024 * 1024


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/brain/providers", response_model=list[BrainProviderHealth])
def brain_providers() -> list[BrainProviderHealth]:
    return provider_health()


@app.post("/assets", response_model=AssetUploadResponse)
async def create_asset(request: Request) -> AssetUploadResponse:
    fields, file = await _parse_asset_request(request)
    asset_type = _asset_type_from_field(fields.get("asset_type") or fields.get("assetType"))
    return _create_asset_from_inputs(
        workspace_id=_workspace_id(request),
        asset_type=asset_type,
        name=_string_field(fields.get("name")) or None,
        text=_string_field(fields.get("text")) or None,
        url=_string_field(fields.get("url")) or None,
        duration_seconds=fields.get("duration_seconds") or fields.get("durationSeconds"),
        file=file,
    )


def _create_asset_from_inputs(
    *,
    workspace_id: str,
    asset_type: AssetType,
    name: str | None,
    text: str | None,
    url: str | None,
    duration_seconds: Any,
    file: UploadFile | None,
) -> AssetUploadResponse:
    asset_id = new_id("asset")
    file_path = None
    extracted_text = (text or "").strip()
    source_url = _normalize_source_url(url, asset_type)
    duration = _optional_non_negative_number(duration_seconds, "duration_seconds")
    final_name = name or source_url or (file.filename if file else None) or "Untitled asset"

    if file:
        safe_name = Path(file.filename or f"{asset_id}.bin").name
        destination = UPLOAD_DIR / f"{asset_id}_{safe_name}"
        try:
            _write_upload_with_limit(file, destination, _positive_env_int("STIMLI_MAX_DIRECT_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES))
            file_path = str(destination)
            if asset_type == "script" and not extracted_text:
                extracted_text = _read_text_file_with_limit(
                    destination,
                    _positive_env_int("STIMLI_MAX_SCRIPT_UPLOAD_TEXT_BYTES", DEFAULT_MAX_SCRIPT_TEXT_BYTES),
                )
        except HTTPException:
            destination.unlink(missing_ok=True)
            raise

    if asset_type == "landing_page" and url and not extracted_text:
        extracted_text, extraction_metadata = extract_landing_page_text(url)
    else:
        extraction_metadata = {}

    if asset_type in {"image", "audio", "video"} and not extracted_text:
        extracted_text = _text_from_filename(final_name)

    asset = Asset(
        id=asset_id,
        type=asset_type,
        name=final_name,
        source_url=source_url,
        file_path=file_path,
        extracted_text=extracted_text.strip(),
        duration_seconds=duration,
        metadata={"original_filename": file.filename if file else None, **extraction_metadata},
        created_at=now_iso(),
    )
    store.save_asset(asset, workspace_id)
    return AssetUploadResponse(asset=asset)


@app.get("/assets", response_model=list[PublicAsset])
def list_assets(request: Request) -> list[Asset]:
    return store.list_assets(_workspace_id(request))


@app.delete("/assets/{asset_id}")
def delete_asset(asset_id: str, request: Request) -> dict[str, str]:
    asset = store.delete_asset(asset_id, _workspace_id(request))
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    _cleanup_uploaded_file(asset.file_path)
    return {"deleted": asset_id}


@app.post("/comparisons", response_model=Comparison)
def create_comparison(payload: ComparisonCreate, request: Request) -> Comparison:
    workspace_id = _workspace_id(request)
    asset_ids = list(dict.fromkeys(payload.asset_ids))
    if len(asset_ids) < 2:
        raise HTTPException(status_code=400, detail="At least two distinct asset_ids are required.")
    assets = []
    for asset_id in asset_ids:
        asset = store.get_asset(asset_id, workspace_id)
        if asset is None:
            raise HTTPException(status_code=404, detail=f"Asset not found: {asset_id}")
        assets.append(asset)
    comparison = analyzer.compare(new_id("cmp"), payload.objective, assets, now_iso(), payload.brief)
    store.save_comparison(comparison, workspace_id)
    return comparison


@app.get("/comparisons", response_model=list[Comparison])
def list_comparisons(request: Request) -> list[Comparison]:
    return store.list_comparisons(_workspace_id(request))


@app.get("/comparisons/{comparison_id}", response_model=Comparison)
def get_comparison(comparison_id: str, request: Request) -> Comparison:
    return _get_comparison(comparison_id, _workspace_id(request))


@app.get("/reports/{comparison_id}", response_model=Report)
def get_report(comparison_id: str, request: Request) -> Report:
    return _report_for_comparison(comparison_id, _workspace_id(request))


def _report_for_comparison(comparison_id: str, workspace_id: str) -> Report:
    comparison = _get_comparison(comparison_id, workspace_id)
    learning = _learning_summary(store.list_outcomes(comparison_id, workspace_id), [comparison])
    winner = next((variant for variant in comparison.variants if variant.asset.id == comparison.recommendation.winner_asset_id), None)
    summary = (
        f"{comparison.recommendation.headline}. "
        f"Confidence is {round(comparison.recommendation.confidence * 100)}%. "
        f"The leading variant scored {winner.analysis.scores.overall}/100." if winner else comparison.recommendation.headline
    )
    return Report(
        comparison_id=comparison.id,
        title="Stimli Creative Decision Report",
        executive_summary=summary,
        recommendation=comparison.recommendation,
        variants=comparison.variants,
        suggestions=comparison.suggestions,
        brief=comparison.brief,
        learning_summary=learning,
        next_steps=[
            "Apply high-severity edits to the current leader.",
            "Create one focused challenger that changes only the hook.",
            "Launch the winner with a clean post-flight label so outcome data can calibrate future scoring.",
        ],
    )


@app.get("/reports/{comparison_id}/markdown")
def get_markdown_report(comparison_id: str, request: Request) -> Response:
    report = _report_for_comparison(comparison_id, _workspace_id(request))
    lines = [
        f"# {report.title}",
        "",
        report.executive_summary,
        "",
        "## Recommendation",
        "",
        f"- Verdict: {report.recommendation.verdict}",
        f"- Confidence: {round(report.recommendation.confidence * 100)}%",
        f"- Winner: {report.recommendation.winner_asset_id or 'None'}",
        "",
        "## Reasons",
        "",
        *[f"- {reason}" for reason in report.recommendation.reasons],
        "",
        "## Variant Scores",
        "",
        "| Rank | Variant | Overall | Hook | CTA | Offer | Audience |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for variant in report.variants:
        scores = variant.analysis.scores
        lines.append(
            f"| {variant.rank} | {variant.asset.name} | {scores.overall} | {scores.hook} | {scores.cta} | {scores.offer_strength} | {scores.audience_fit} |"
        )
    lines.extend(["", "## Edit Cards", ""])
    for suggestion in report.suggestions:
        lines.extend(
            [
                f"### {suggestion.target}",
                "",
                f"Severity: {suggestion.severity}",
                "",
                f"Issue: {suggestion.issue}",
                "",
                f"Edit: {suggestion.suggested_edit}",
                "",
                f"Draft: {suggestion.draft_revision or 'No draft available.'}",
                "",
            ]
        )
    lines.extend(["## Next Steps", "", *[f"- {step}" for step in report.next_steps], ""])
    return Response("\n".join(lines), media_type="text/markdown")


@app.post("/comparisons/{comparison_id}/challengers", response_model=ChallengerResponse)
def create_challenger(comparison_id: str, payload: ChallengerCreate, request: Request) -> ChallengerResponse:
    workspace_id = _workspace_id(request)
    comparison = _get_comparison(comparison_id, workspace_id)
    source_id = payload.source_asset_id or comparison.recommendation.winner_asset_id
    source_variant = next((variant for variant in comparison.variants if variant.asset.id == source_id), None)
    if source_variant is None:
        raise HTTPException(status_code=400, detail="Source asset must belong to the comparison.")
    text = build_challenger_text(source_variant.asset, comparison.brief, payload.focus)
    asset = Asset(
        id=new_id("asset"),
        type=source_variant.asset.type,
        name=f"{source_variant.asset.name} - {payload.focus.title()} Challenger",
        source_url=source_variant.asset.source_url,
        extracted_text=text,
        duration_seconds=source_variant.asset.duration_seconds,
        metadata={
            "challenger": True,
            "source_asset_id": source_variant.asset.id,
            "comparison_id": comparison.id,
            "focus": payload.focus,
        },
        created_at=now_iso(),
    )
    store.save_asset(asset, workspace_id)
    return ChallengerResponse(asset=asset, source_asset_id=source_variant.asset.id, focus=payload.focus)


@app.post("/comparisons/{comparison_id}/outcomes", response_model=Outcome)
def create_outcome(comparison_id: str, payload: OutcomeCreate, request: Request) -> Outcome:
    workspace_id = _workspace_id(request)
    comparison = _get_comparison(comparison_id, workspace_id)
    variant_ids = {variant.asset.id for variant in comparison.variants}
    if payload.asset_id not in variant_ids:
        raise HTTPException(status_code=400, detail="Outcome asset must belong to the comparison.")
    spend = _non_negative_number(payload.spend, "spend")
    impressions = _non_negative_int(payload.impressions, "impressions")
    clicks = _non_negative_int(payload.clicks, "clicks")
    conversions = _non_negative_int(payload.conversions, "conversions")
    revenue = _non_negative_number(payload.revenue, "revenue")
    outcome = Outcome(
        id=new_id("outcome"),
        comparison_id=comparison_id,
        asset_id=payload.asset_id,
        spend=spend,
        impressions=impressions,
        clicks=clicks,
        conversions=conversions,
        revenue=revenue,
        notes=payload.notes,
        created_at=now_iso(),
    )
    return store.save_outcome(outcome, workspace_id)


@app.get("/comparisons/{comparison_id}/outcomes", response_model=list[Outcome])
def list_comparison_outcomes(comparison_id: str, request: Request) -> list[Outcome]:
    workspace_id = _workspace_id(request)
    _get_comparison(comparison_id, workspace_id)
    return store.list_outcomes(comparison_id, workspace_id)


@app.get("/learning/summary", response_model=LearningSummary)
def learning_summary(request: Request) -> LearningSummary:
    workspace_id = _workspace_id(request)
    return _learning_summary(store.list_outcomes(workspace_id=workspace_id), store.list_comparisons(workspace_id))


@app.post("/demo/seed", response_model=list[PublicAsset])
def seed_demo(request: Request) -> list[Asset]:
    workspace_id = _workspace_id(request)
    store.clear_demo_assets(workspace_id)
    samples = [
        Asset(
            id=new_id("asset"),
            type="script",
            name="Variant A - Pain-led skincare hook",
            extracted_text=(
                "Stop wasting money on ten-step routines that still leave your skin dry. "
                "The Lumina barrier kit uses one proven morning system to lock in hydration for 24 hours. "
                "Thousands of customers switched after seeing calmer skin in seven days. "
                "Try the starter kit today."
            ),
            duration_seconds=28,
            metadata={"demo": True, "channel": "paid social"},
            created_at=now_iso(),
        ),
        Asset(
            id=new_id("asset"),
            type="script",
            name="Variant B - Generic product story",
            extracted_text=(
                "Our skincare brand is a revolutionary ecosystem for modern self care. "
                "We combine quality ingredients with a holistic approach designed for everyone. "
                "It is simple, premium, and made to fit your lifestyle."
            ),
            duration_seconds=25,
            metadata={"demo": True, "channel": "paid social"},
            created_at=now_iso(),
        ),
        Asset(
            id=new_id("asset"),
            type="landing_page",
            name="Landing Page - Offer dense",
            source_url="https://example.com/lumina",
            extracted_text=(
                "Lumina Hydration System. New customer bundle. Save 20 percent today. "
                "Dermatologist tested formula with ceramides, peptides, and daily SPF support. "
                "Shop the starter kit now and get free shipping."
            ),
            metadata={"demo": True, "channel": "landing page"},
            created_at=now_iso(),
        ),
    ]
    for asset in samples:
        store.save_asset(asset, workspace_id)
    return samples


def _text_from_filename(name: str) -> str:
    stem = Path(name).stem.replace("-", " ").replace("_", " ")
    return f"Creative asset named {stem}. Add transcript or visual notes for deeper scoring."


def _get_comparison(comparison_id: str, workspace_id: str) -> Comparison:
    comparison = store.get_comparison(comparison_id, workspace_id)
    if comparison is None:
        raise HTTPException(status_code=404, detail="Comparison not found")
    return comparison


def _workspace_id(request: Request) -> str:
    raw = request.headers.get("x-stimli-workspace") or request.headers.get("x-stimli-team") or "public"
    workspace_id = raw.strip()
    if not workspace_id:
        return "public"
    return workspace_id[:180]


async def _parse_asset_request(request: Request) -> tuple[dict[str, Any], UploadFile | None]:
    content_type = request.headers.get("content-type", "").lower()
    if "multipart/form-data" in content_type or "application/x-www-form-urlencoded" in content_type:
        form = await request.form()
        fields: dict[str, Any] = {}
        file: UploadFile | None = None
        for name, value in form.items():
            if name == "file" and hasattr(value, "file") and hasattr(value, "filename"):
                file = cast(UploadFile, value)
            else:
                fields[name] = value
        return fields, file

    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="JSON payload must be an object.")
    return payload, None


def _asset_type_from_field(value: Any) -> AssetType:
    raw = _string_field(value).strip().lower()
    if raw not in {"script", "landing_page", "image", "audio", "video"}:
        raise HTTPException(status_code=400, detail="asset_type must be script, landing_page, image, audio, or video.")
    return cast(AssetType, raw)


def _string_field(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    return ""


def _normalize_source_url(url: str | None, asset_type: AssetType) -> str | None:
    if not url:
        return None
    try:
        return normalize_public_url(url)
    except (BlockedLandingPageURL, ValueError) as exc:
        if asset_type == "landing_page":
            return None
        raise HTTPException(status_code=400, detail=f"url must be a public http(s) URL ({exc}).") from exc


def _write_upload_with_limit(file: UploadFile, destination: Path, max_bytes: int) -> None:
    total = 0
    try:
        with destination.open("wb") as handle:
            while True:
                chunk = file.file.read(UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(status_code=413, detail=f"Upload exceeds the {max_bytes} byte limit.")
                handle.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def _read_text_file_with_limit(path: Path, max_bytes: int) -> str:
    with path.open("rb") as handle:
        data = handle.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise HTTPException(status_code=413, detail=f"Script upload exceeds the {max_bytes} byte text limit.")
    return data.decode("utf-8", errors="ignore")


def _cleanup_uploaded_file(file_path: str | None) -> None:
    if not file_path:
        return
    try:
        path = Path(file_path).resolve()
        upload_root = UPLOAD_DIR.resolve()
        if path.is_file() and path.is_relative_to(upload_root):
            path.unlink(missing_ok=True)
    except Exception:
        pass


def _positive_env_int(name: str, fallback: int) -> int:
    try:
        value = int(os.getenv(name, ""))
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def _optional_non_negative_number(value: Any, label: str) -> float | None:
    if value is None or value == "":
        return None
    return _non_negative_number(value, label)


def _non_negative_number(value: Any, label: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise HTTPException(status_code=400, detail=f"{label} must be a non-negative number.")
    return parsed


def _non_negative_int(value: int, label: str) -> int:
    parsed = _non_negative_number(float(value), label)
    if not float(parsed).is_integer():
        raise HTTPException(status_code=400, detail=f"{label} must be a whole number.")
    return int(parsed)


def _learning_summary(outcomes: list[Outcome], comparisons: list[Comparison] | None = None) -> LearningSummary:
    total_spend = round(sum(outcome.spend for outcome in outcomes), 2)
    total_revenue = round(sum(outcome.revenue for outcome in outcomes), 2)
    total_impressions = sum(outcome.impressions for outcome in outcomes)
    total_clicks = sum(outcome.clicks for outcome in outcomes)
    total_conversions = sum(outcome.conversions for outcome in outcomes)
    average_ctr = round(total_clicks / total_impressions, 4) if total_impressions else 0
    average_cvr = round(total_conversions / total_clicks, 4) if total_clicks else 0
    best_asset_id = None
    if outcomes:
        best = max(outcomes, key=lambda outcome: (outcome.revenue - outcome.spend, outcome.conversions, outcome.clicks))
        best_asset_id = best.asset_id
    calibration = _calibration_summary(outcomes, comparisons or [])
    insight = (
        f"{calibration.aligned_predictions}/{calibration.evaluated_comparisons} predictions matched the strongest logged outcome."
        if calibration.evaluated_comparisons
        else "Outcome data is ready to compare pre-spend predictions with launch performance."
        if outcomes
        else "No launch outcomes logged yet. Add post-flight results after a test campaign."
    )
    return LearningSummary(
        outcome_count=len(outcomes),
        total_spend=total_spend,
        total_revenue=total_revenue,
        average_ctr=average_ctr,
        average_cvr=average_cvr,
        best_asset_id=best_asset_id,
        calibration=calibration,
        insight=insight,
    )


def _calibration_summary(outcomes: list[Outcome], comparisons: list[Comparison]) -> CalibrationSummary:
    outcomes_by_comparison: dict[str, list[Outcome]] = {}
    for outcome in outcomes:
        outcomes_by_comparison.setdefault(outcome.comparison_id, []).append(outcome)

    evaluations: list[CalibrationEvaluation] = []
    for comparison in comparisons:
        predicted = comparison.recommendation.winner_asset_id
        if not predicted:
            continue
        comparison_outcomes = outcomes_by_comparison.get(comparison.id, [])
        if not comparison_outcomes:
            continue
        actual = max(comparison_outcomes, key=_outcome_rank_key)
        predicted_outcome = next((outcome for outcome in comparison_outcomes if outcome.asset_id == predicted), None)
        evaluations.append(
            CalibrationEvaluation(
                comparison_id=comparison.id,
                predicted_asset_id=predicted,
                actual_best_asset_id=actual.asset_id,
                aligned=actual.asset_id == predicted,
                actual_profit=round(actual.revenue - actual.spend, 2),
                predicted_profit=round(predicted_outcome.revenue - predicted_outcome.spend, 2) if predicted_outcome else None,
            )
        )

    aligned = sum(1 for evaluation in evaluations if evaluation.aligned)
    return CalibrationSummary(
        evaluated_comparisons=len(evaluations),
        aligned_predictions=aligned,
        alignment_rate=round(aligned / len(evaluations), 3) if evaluations else 0,
        recent=evaluations[:5],
    )


def _outcome_rank_key(outcome: Outcome) -> tuple[float, int, int]:
    return (outcome.revenue - outcome.spend, outcome.conversions, outcome.clicks)
