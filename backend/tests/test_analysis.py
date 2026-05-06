from app.analysis import CreativeAnalyzer
from app.models import Asset


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

