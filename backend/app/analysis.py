from __future__ import annotations

import re
from statistics import mean

from app.brain import BrainResponseProvider, FixtureBrainResponseProvider
from app.models import AnalysisRun, Asset, Comparison, CreativeBrief, Recommendation, ScoreBreakdown, Suggestion, VariantResult


CTA_WORDS = {"buy", "shop", "try", "start", "get", "claim", "book", "subscribe", "download", "order"}
HOOK_WORDS = {"stop", "why", "secret", "mistake", "before", "after", "new", "finally", "without", "save"}
PROOF_WORDS = {"proven", "tested", "reviews", "trusted", "clinical", "study", "customers", "results"}
BRAND_WORDS = {"brand", "logo", "name", "signature", "formula", "routine", "system", "kit"}
JARGON_WORDS = {"synergy", "leverage", "paradigm", "holistic", "revolutionary", "seamless", "ecosystem"}


class CreativeAnalyzer:
    def __init__(self, provider: BrainResponseProvider | None = None):
        self.provider = provider or FixtureBrainResponseProvider()

    def analyze(self, asset: Asset, brief: CreativeBrief | None = None) -> AnalysisRun:
        brief = brief or CreativeBrief()
        words = _words(asset.extracted_text or asset.name or asset.source_url or "")
        timeline = self.provider.predict(asset)
        neural_attention = mean(point.attention for point in timeline)
        memory = mean(point.memory for point in timeline)
        cognitive_load = mean(point.cognitive_load for point in timeline)
        scores = ScoreBreakdown(
            overall=0,
            hook=_hook_score(words),
            clarity=_clarity_score(asset.extracted_text, words),
            cta=_cta_score(words),
            brand_cue=_brand_score(words, asset, brief),
            pacing=_pacing_score(asset, words),
            offer_strength=_offer_score(words, brief),
            audience_fit=_audience_score(words, brief),
            neural_attention=round(neural_attention * 100, 1),
            memory=round(memory * 100, 1),
            cognitive_load=round(cognitive_load * 100, 1),
        )
        scores.overall = _overall(scores)
        feature_vector = {
            "word_count": float(len(words)),
            "peak_attention": round(max(point.attention for point in timeline), 3),
            "attention_drop": round(timeline[0].attention - timeline[-1].attention, 3),
            "load_peak": round(max(point.cognitive_load for point in timeline), 3),
        }
        return AnalysisRun(
            asset_id=asset.id,
            provider=self.provider.name,
            status="complete",
            scores=scores,
            timeline=timeline,
            feature_vector=feature_vector,
            summary=_summary(asset, scores),
        )

    def compare(self, comparison_id: str, objective: str, assets: list[Asset], created_at: str, brief: CreativeBrief | None = None) -> Comparison:
        brief = brief or CreativeBrief()
        analyses = [self.analyze(asset, brief) for asset in assets]
        ranked = sorted(zip(assets, analyses), key=lambda pair: pair[1].scores.overall, reverse=True)
        best_score = ranked[0][1].scores.overall
        variants = [
            VariantResult(asset=asset, analysis=analysis, rank=index + 1, delta_from_best=round(best_score - analysis.scores.overall, 1))
            for index, (asset, analysis) in enumerate(ranked)
        ]
        recommendation = _recommendation(variants)
        suggestions = []
        for variant in variants:
            suggestions.extend(_suggestions_for_variant(variant.asset, variant.analysis, brief))
        suggestions = sorted(suggestions, key=lambda item: {"high": 0, "medium": 1, "low": 2}[item.severity])[:8]
        return Comparison(
            id=comparison_id,
            objective=objective,
            brief=brief,
            status="complete",
            variants=variants,
            recommendation=recommendation,
            suggestions=suggestions,
            created_at=created_at,
        )


def _words(text: str) -> list[str]:
    return re.findall(r"[a-zA-Z0-9']+", text.lower())


def _hook_score(words: list[str]) -> float:
    first = words[:24]
    base = 44
    base += min(sum(word in HOOK_WORDS for word in first) * 12, 30)
    base += 14 if any(any(char.isdigit() for char in word) for word in first) else 0
    base += 10 if len(first) <= 18 else 0
    return round(min(base, 100), 1)


def _clarity_score(text: str, words: list[str]) -> float:
    if not words:
        return 48
    sentences = max(len(re.findall(r"[.!?]", text)), 1)
    avg_sentence = len(words) / sentences
    jargon_penalty = min(sum(word in JARGON_WORDS for word in words) * 8, 24)
    length_penalty = max(0, avg_sentence - 18) * 1.6
    return round(max(30, min(100, 88 - jargon_penalty - length_penalty)), 1)


def _cta_score(words: list[str]) -> float:
    if not words:
        return 35
    last = words[-40:]
    count = sum(word in CTA_WORDS for word in last)
    return round(min(100, 42 + count * 18 + (8 if count and len(last) <= 35 else 0)), 1)


def _brand_score(words: list[str], asset: Asset, brief: CreativeBrief) -> float:
    count = sum(word in BRAND_WORDS for word in words)
    named = any(token in words for token in _words(asset.name))
    brand_terms = _words(brief.brand_name)
    named = named or bool(brand_terms and all(term in words for term in brand_terms[:3]))
    score = 38 + min(count * 14, 42) + (14 if named else 0)
    return round(min(100, score), 1)


def _pacing_score(asset: Asset, words: list[str]) -> float:
    if asset.type in {"image", "landing_page"}:
        density = len(words)
        return round(max(35, min(100, 88 - max(0, density - 80) * 0.35)), 1)
    duration = asset.duration_seconds or max(8, len(words) / 2.5)
    words_per_second = len(words) / max(duration, 1)
    return round(max(35, min(100, 92 - abs(words_per_second - 2.5) * 13)), 1)


def _offer_score(words: list[str], brief: CreativeBrief) -> float:
    offer_terms = _words(brief.primary_offer)
    offer_hits = sum(term in words for term in offer_terms)
    proof_hits = sum(word in PROOF_WORDS for word in words)
    number_hit = any(any(char.isdigit() for char in word) for word in words)
    score = 44 + min(offer_hits * 11, 28) + min(proof_hits * 8, 20) + (10 if number_hit else 0)
    return round(min(100, score), 1)


def _audience_score(words: list[str], brief: CreativeBrief) -> float:
    audience_terms = [term for term in _words(brief.audience) if len(term) > 2]
    category_terms = [term for term in _words(brief.product_category) if len(term) > 2]
    required_terms = [term for claim in brief.required_claims for term in _words(claim) if len(term) > 2]
    forbidden_terms = [term for term in brief.forbidden_terms for term in _words(term)]
    hits = sum(term in words for term in audience_terms + category_terms + required_terms)
    misses = sum(term in words for term in forbidden_terms)
    score = 58 + min(hits * 6, 32) - min(misses * 14, 36)
    if not audience_terms and not category_terms and not required_terms:
        score = 68
    return round(max(25, min(100, score)), 1)


def _overall(scores: ScoreBreakdown) -> float:
    value = (
        scores.hook * 0.16
        + scores.clarity * 0.12
        + scores.cta * 0.12
        + scores.brand_cue * 0.1
        + scores.pacing * 0.1
        + scores.offer_strength * 0.11
        + scores.audience_fit * 0.09
        + scores.neural_attention * 0.14
        + scores.memory * 0.09
        - max(0, scores.cognitive_load - 62) * 0.08
    )
    return round(max(0, min(100, value)), 1)


def _summary(asset: Asset, scores: ScoreBreakdown) -> str:
    strengths = []
    if scores.hook >= 72:
        strengths.append("opens with a strong hook")
    if scores.cta >= 72:
        strengths.append("makes the next action clear")
    if scores.neural_attention >= 66:
        strengths.append("sustains predicted attention")
    if scores.memory >= 64:
        strengths.append("has memorable proof or brand cues")
    if not strengths:
        strengths.append("needs a sharper first impression")
    return f"{asset.name} " + ", ".join(strengths) + "."


def _recommendation(variants: list[VariantResult]) -> Recommendation:
    best = variants[0]
    runner_up = variants[1]
    gap = best.analysis.scores.overall - runner_up.analysis.scores.overall
    verdict = "ship" if best.analysis.scores.overall >= 68 and gap >= 3 else "revise"
    confidence = round(min(0.94, 0.58 + gap / 45 + max(0, best.analysis.scores.overall - 65) / 120), 2)
    reasons = [
        f"Highest composite score at {best.analysis.scores.overall}/100.",
        _largest_advantage(best, runner_up),
        "Recommendation is based on relative creative quality, predicted response, and editability before spend.",
    ]
    headline = f"Ship {best.asset.name}" if verdict == "ship" else f"Revise before shipping; {best.asset.name} is the current leader"
    return Recommendation(
        winner_asset_id=best.asset.id,
        verdict=verdict,
        confidence=confidence,
        headline=headline,
        reasons=reasons,
    )


def _largest_advantage(best: VariantResult, other: VariantResult) -> str:
    best_scores = best.analysis.scores.model_dump()
    other_scores = other.analysis.scores.model_dump()
    candidates = [(key, best_scores[key] - other_scores[key]) for key in best_scores if key != "overall"]
    key, delta = max(candidates, key=lambda item: item[1])
    label = key.replace("_", " ")
    if delta <= 0:
        return "The leader wins on balance rather than a single dominant signal."
    return f"Biggest edge is {label}, ahead by {round(delta, 1)} points."


def _suggestions_for_variant(asset: Asset, analysis: AnalysisRun, brief: CreativeBrief) -> list[Suggestion]:
    scores = analysis.scores
    suggestions = []
    if scores.hook < 70:
        suggestions.append(
            Suggestion(
                asset_id=asset.id,
                target="0-3 seconds / opening line",
                severity="high",
                issue="The opening does not create enough immediate tension or curiosity.",
                suggested_edit="Lead with the customer's painful before-state, a specific number, or a surprising claim before explaining the product.",
                expected_effect="Higher early attention and a clearer reason to keep watching or reading.",
                draft_revision=_draft_hook(asset, brief),
            )
        )
    if scores.cta < 66:
        suggestions.append(
            Suggestion(
                asset_id=asset.id,
                target="Final third",
                severity="medium",
                issue="The next step is too soft or missing.",
                suggested_edit="End with one direct action such as 'Try the starter kit today' or 'Shop the routine now'.",
                expected_effect="Reduces decision friction and improves conversion intent.",
                draft_revision=_draft_cta(brief),
            )
        )
    if scores.brand_cue < 62:
        suggestions.append(
            Suggestion(
                asset_id=asset.id,
                target="First half",
                severity="medium",
                issue="Brand ownership is weak.",
                suggested_edit="Add the brand or product name near the first proof point and repeat it close to the CTA.",
                expected_effect="Improves recall so attention compounds into brand memory.",
                draft_revision=_draft_brand_line(brief),
            )
        )
    if scores.cognitive_load > 66 or scores.clarity < 68:
        suggestions.append(
            Suggestion(
                asset_id=asset.id,
                target="Dense sections",
                severity="high",
                issue="The creative asks the audience to process too much at once.",
                suggested_edit="Split long claims into one idea per beat and remove abstract filler words.",
                expected_effect="Lowers processing load and makes the strongest claim easier to remember.",
                draft_revision="Break this section into one claim, one proof point, and one next step.",
            )
        )
    if scores.pacing < 66:
        suggestions.append(
            Suggestion(
                asset_id=asset.id,
                target="Middle section",
                severity="low",
                issue="Pacing is likely to feel uneven for the format.",
                suggested_edit="Shorten setup, move proof earlier, and reserve the final beat for a single CTA.",
                expected_effect="Keeps attention from flattening after the hook.",
                draft_revision="Move the strongest proof point into the first half and cut any setup that repeats the same idea.",
            )
        )
    if scores.offer_strength < 68 and brief.primary_offer:
        suggestions.append(
            Suggestion(
                asset_id=asset.id,
                target="Offer beat",
                severity="medium",
                issue="The creative does not make the offer feel concrete enough.",
                suggested_edit=f"Name the offer directly: {brief.primary_offer}. Pair it with one proof point or numeric benefit.",
                expected_effect="Makes the value exchange easier to understand before the CTA.",
                draft_revision=f"{brief.primary_offer}: one simple way to get the benefit without rebuilding your routine.",
            )
        )
    if scores.audience_fit < 68 and brief.audience:
        suggestions.append(
            Suggestion(
                asset_id=asset.id,
                target="Audience framing",
                severity="medium",
                issue="The message is not specific enough to the target audience.",
                suggested_edit=f"Rewrite one early line so it directly addresses {brief.audience}.",
                expected_effect="Improves relevance and reduces the feeling of a generic ad.",
                draft_revision=f"For {brief.audience}, this should feel like the easiest next step.",
            )
        )
    return suggestions


def build_challenger_text(asset: Asset, brief: CreativeBrief, focus: str) -> str:
    original = asset.extracted_text.strip() or asset.name
    brand = brief.brand_name or "the brand"
    audience = brief.audience or "people with this problem"
    offer = brief.primary_offer or "the offer"
    proof = brief.required_claims[0] if brief.required_claims else "a clearer proof point"

    if focus == "cta":
        return f"{original}\n\nTry {offer} today from {brand}."
    if focus == "offer":
        return f"Stop guessing what will work for {audience}. {brand}'s {offer} gives you {proof}. Shop the starter option today."
    if focus == "clarity":
        return f"For {audience}: one problem, one proof point, one next step. {brand} gives you {proof}. Try {offer} today."
    return f"Stop settling for a routine that does not work for {audience}. {brand} gives you {proof} with {offer}. Try it today."


def _draft_hook(asset: Asset, brief: CreativeBrief) -> str:
    audience = brief.audience or "your target customer"
    brand = brief.brand_name or asset.name
    return f"Stop making {audience} work this hard. {brand} gives them a faster path to the result."


def _draft_cta(brief: CreativeBrief) -> str:
    offer = brief.primary_offer or "the starter option"
    return f"Try {offer} today."


def _draft_brand_line(brief: CreativeBrief) -> str:
    brand = brief.brand_name or "the product"
    claim = brief.required_claims[0] if brief.required_claims else "the proof point"
    return f"{brand} is the system behind {claim}."
