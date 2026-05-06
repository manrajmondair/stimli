from __future__ import annotations

import shutil
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.analysis import CreativeAnalyzer
from app.models import Asset, AssetType, AssetUploadResponse, Comparison, ComparisonCreate, Report
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


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/assets", response_model=AssetUploadResponse)
async def create_asset(
    asset_type: AssetType = Form(...),
    name: str | None = Form(None),
    text: str | None = Form(None),
    url: str | None = Form(None),
    duration_seconds: float | None = Form(None),
    file: UploadFile | None = File(None),
) -> AssetUploadResponse:
    asset_id = new_id("asset")
    file_path = None
    extracted_text = text or ""
    final_name = name or url or (file.filename if file else None) or "Untitled asset"

    if file:
        safe_name = Path(file.filename or f"{asset_id}.bin").name
        destination = UPLOAD_DIR / f"{asset_id}_{safe_name}"
        with destination.open("wb") as handle:
            shutil.copyfileobj(file.file, handle)
        file_path = str(destination)
        if asset_type == "script" and not extracted_text:
            extracted_text = destination.read_text(errors="ignore")

    if asset_type == "landing_page" and url and not extracted_text:
        extracted_text = _landing_page_proxy_text(url)

    if asset_type in {"image", "audio", "video"} and not extracted_text:
        extracted_text = _text_from_filename(final_name)

    asset = Asset(
        id=asset_id,
        type=asset_type,
        name=final_name,
        source_url=url,
        file_path=file_path,
        extracted_text=extracted_text.strip(),
        duration_seconds=duration_seconds,
        metadata={"original_filename": file.filename if file else None},
        created_at=now_iso(),
    )
    store.save_asset(asset)
    return AssetUploadResponse(asset=asset)


@app.get("/assets", response_model=list[Asset])
def list_assets() -> list[Asset]:
    return store.list_assets()


@app.post("/comparisons", response_model=Comparison)
def create_comparison(payload: ComparisonCreate) -> Comparison:
    assets = []
    for asset_id in payload.asset_ids:
        asset = store.get_asset(asset_id)
        if asset is None:
            raise HTTPException(status_code=404, detail=f"Asset not found: {asset_id}")
        assets.append(asset)
    comparison = analyzer.compare(new_id("cmp"), payload.objective, assets, now_iso())
    store.save_comparison(comparison)
    return comparison


@app.get("/comparisons/{comparison_id}", response_model=Comparison)
def get_comparison(comparison_id: str) -> Comparison:
    comparison = store.get_comparison(comparison_id)
    if comparison is None:
        raise HTTPException(status_code=404, detail="Comparison not found")
    return comparison


@app.get("/reports/{comparison_id}", response_model=Report)
def get_report(comparison_id: str) -> Report:
    comparison = get_comparison(comparison_id)
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
        next_steps=[
            "Apply high-severity edits to the current leader.",
            "Create one focused challenger that changes only the hook.",
            "Launch the winner with a clean post-flight label so outcome data can calibrate future scoring.",
        ],
    )


@app.post("/demo/seed", response_model=list[Asset])
def seed_demo() -> list[Asset]:
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
            metadata={"demo": True},
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
            metadata={"demo": True},
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
            metadata={"demo": True},
            created_at=now_iso(),
        ),
    ]
    for asset in samples:
        store.save_asset(asset)
    return samples


def _landing_page_proxy_text(url: str) -> str:
    cleaned = url.replace("https://", "").replace("http://", "").replace("/", " ")
    return f"Landing page submitted from {cleaned}. Add page copy for stronger analysis. Shop now."


def _text_from_filename(name: str) -> str:
    stem = Path(name).stem.replace("-", " ").replace("_", " ")
    return f"Creative asset named {stem}. Add transcript or visual notes for deeper scoring."
