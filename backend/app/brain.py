from __future__ import annotations

import hashlib
import math
from abc import ABC, abstractmethod

from app.models import Asset, TimelinePoint


class BrainResponseProvider(ABC):
    name: str

    @abstractmethod
    def predict(self, asset: Asset) -> list[TimelinePoint]:
        raise NotImplementedError


class FixtureBrainResponseProvider(BrainResponseProvider):
    name = "fixture-brain-response"

    def predict(self, asset: Asset) -> list[TimelinePoint]:
        text = " ".join([asset.name, asset.extracted_text, asset.source_url or ""]).lower()
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        seed = int(digest[:8], 16)
        words = [word.strip(".,!?;:()[]{}\"'").lower() for word in text.split()]
        word_count = max(len(words), 1)
        duration = asset.duration_seconds or max(8.0, min(45.0, word_count / 2.4))
        points = []

        curiosity = _contains(words, {"why", "secret", "stop", "mistake", "new", "before", "without"})
        proof = _contains(words, {"proven", "tested", "study", "reviews", "trusted", "customers"})
        urgency = _contains(words, {"today", "now", "limited", "last", "fast", "minutes"})
        brand = _contains(words, {"stimli", "brand", "formula", "routine", "system", "kit"})

        for index in range(12):
            second = round(index * duration / 11, 1)
            phase = index / 11
            noise = ((seed >> (index % 16)) & 7) / 100
            hook_lift = 0.2 if index < 3 and curiosity else 0
            proof_lift = 0.12 if 3 <= index <= 8 and proof else 0
            urgency_lift = 0.12 if index >= 8 and urgency else 0
            brand_lift = 0.08 if brand else 0
            attention = _clamp(0.5 + 0.18 * math.sin(phase * math.pi * 1.7) + hook_lift + urgency_lift + noise)
            memory = _clamp(0.42 + 0.16 * math.sin(phase * math.pi) + proof_lift + brand_lift + noise / 2)
            cognitive_load = _clamp(0.34 + min(word_count / 500, 0.28) + 0.12 * math.sin(phase * math.pi * 2.2))
            points.append(
                TimelinePoint(
                    second=second,
                    attention=round(attention, 3),
                    memory=round(memory, 3),
                    cognitive_load=round(cognitive_load, 3),
                    note=_note_for_point(index, attention, memory, cognitive_load),
                )
            )

        return points


class TribeAdapter(BrainResponseProvider):
    name = "tribe-adapter"

    def predict(self, asset: Asset) -> list[TimelinePoint]:
        try:
            import tribev2  # type: ignore
        except Exception as exc:
            raise RuntimeError("TRIBE dependencies are not installed in this environment.") from exc

        raise RuntimeError(
            f"{tribev2.__name__} is available, but this adapter is intentionally left behind a research-only integration boundary."
        )


def _contains(words: list[str], candidates: set[str]) -> bool:
    return any(word in candidates for word in words)


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _note_for_point(index: int, attention: float, memory: float, load: float) -> str:
    if index < 3 and attention >= 0.7:
        return "Strong early attention capture"
    if load >= 0.68:
        return "High processing load may cause drop-off"
    if memory >= 0.68:
        return "Memorable proof or brand cue moment"
    if attention < 0.45:
        return "Low-signal section"
    return "Stable response"

