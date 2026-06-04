import pytest

from app.analysis import CreativeAnalyzer, _largest_advantage
from app.models import AnalysisRun, Asset, ScoreBreakdown, TimelinePoint, VariantResult


def test_comparison_picks_stronger_variant():
    analyzer = CreativeAnalyzer()
    strong = Asset(
        id="a1",
        type="script",
        name="Strong hook",
        extracted_text="Stop losing sleep over dry skin. Save 20 percent today and try the proven starter kit now.",
        created_at="2026-05-06T00:00:00+00:00",
    )
    weak = Asset(
        id="a2",
        type="script",
        name="Weak hook",
        extracted_text="Our brand is a holistic ecosystem with quality ingredients for everyone.",
        created_at="2026-05-06T00:00:00+00:00",
    )

    comparison = analyzer.compare("cmp_1", "Pick a winner", [weak, strong], "2026-05-06T00:00:00+00:00")

    assert comparison.recommendation.winner_asset_id == "a1"
    assert comparison.variants[0].analysis.scores.overall > comparison.variants[1].analysis.scores.overall
    assert comparison.suggestions


def test_analysis_is_deterministic():
    analyzer = CreativeAnalyzer()
    asset = Asset(
        id="a1",
        type="script",
        name="Repeatable",
        extracted_text="Why do most ads fail in the first three seconds? Try a clearer hook today.",
        created_at="2026-05-06T00:00:00+00:00",
    )

    first = analyzer.analyze(asset)
    second = analyzer.analyze(asset)

    assert first.scores == second.scores
    assert first.timeline == second.timeline


def test_comparison_requires_at_least_two_assets():
    analyzer = CreativeAnalyzer()
    asset = Asset(
        id="a1",
        type="script",
        name="Only one",
        extracted_text="Try the kit today.",
        created_at="2026-05-06T00:00:00+00:00",
    )

    with pytest.raises(ValueError, match="At least two assets"):
        analyzer.compare("cmp_1", "Pick a winner", [asset], "2026-05-06T00:00:00+00:00")


def test_largest_advantage_treats_lower_cognitive_load_as_better():
    best = _variant("best", overall=76, cognitive_load=45)
    other = _variant("other", overall=70, cognitive_load=75)

    reason = _largest_advantage(best, other)

    assert "lower cognitive load" in reason
    assert "30" in reason


def _variant(asset_id: str, overall: float, cognitive_load: float) -> VariantResult:
    scores = ScoreBreakdown(
        overall=overall,
        hook=60,
        clarity=60,
        cta=60,
        brand_cue=60,
        pacing=60,
        offer_strength=60,
        audience_fit=60,
        neural_attention=60,
        memory=60,
        cognitive_load=cognitive_load,
    )
    timeline = [TimelinePoint(second=0, attention=0.6, memory=0.6, cognitive_load=0.5, note="stable")]
    asset = Asset(id=asset_id, type="script", name=asset_id, extracted_text="", created_at="2026-05-06T00:00:00+00:00")
    analysis = AnalysisRun(
        asset_id=asset_id,
        provider="test",
        status="complete",
        scores=scores,
        timeline=timeline,
        feature_vector={},
        summary="test",
    )
    return VariantResult(asset=asset, analysis=analysis, rank=1, delta_from_best=0)
