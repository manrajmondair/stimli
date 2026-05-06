from __future__ import annotations

import hashlib
import importlib.util
import math
import os
import re
from abc import ABC, abstractmethod
from pathlib import Path
from statistics import mean, pstdev

from app.models import Asset, BrainProviderHealth, TimelinePoint


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
    name = "tribe-v2"

    def __init__(
        self,
        checkpoint: str | None = None,
        cache_folder: str | None = None,
        device: str | None = None,
    ):
        self.checkpoint = checkpoint or os.getenv("STIMLI_TRIBE_CHECKPOINT", "facebook/tribev2")
        self.cache_folder = cache_folder or os.getenv("STIMLI_TRIBE_CACHE", str(Path(".data") / "tribe-cache"))
        self.device = device or os.getenv("STIMLI_TRIBE_DEVICE", "auto")
        self._model = None

    def predict(self, asset: Asset) -> list[TimelinePoint]:
        try:
            from tribev2 import TribeModel  # type: ignore
        except Exception as exc:
            raise RuntimeError("TRIBE dependencies are not installed in this environment.") from exc

        model = self._load_model(TribeModel)
        events = self._events_for_asset(model, asset)
        preds, segments = model.predict(events=events, verbose=False)
        return _predictions_to_timeline(asset, preds, segments)

    def health(self) -> BrainProviderHealth:
        if importlib.util.find_spec("tribev2") is None:
            return BrainProviderHealth(provider=self.name, available=False, active=False, detail="TRIBE package unavailable.")
        if os.getenv("STIMLI_TRIBE_HEALTH_LOAD", "0") == "1":
            try:
                from tribev2 import TribeModel  # type: ignore

                self._load_model(TribeModel)
            except Exception as exc:
                return BrainProviderHealth(provider=self.name, available=False, active=False, detail=f"TRIBE model could not be loaded: {exc}")
            return BrainProviderHealth(provider=self.name, available=True, active=False, detail=f"Model loaded from {self.checkpoint}")
        return BrainProviderHealth(
            provider=self.name,
            available=True,
            active=False,
            detail="Package is installed. Set STIMLI_TRIBE_HEALTH_LOAD=1 to verify checkpoint loading.",
        )

    def _load_model(self, tribe_model_cls):
        if self._model is None:
            self._model = tribe_model_cls.from_pretrained(
                self.checkpoint,
                cache_folder=self.cache_folder,
                device=self.device,
            )
        return self._model

    def _events_for_asset(self, model, asset: Asset):
        path = Path(asset.file_path) if asset.file_path else None
        suffix = path.suffix.lower() if path else ""
        if path and path.exists() and asset.type == "video" and suffix in {".mp4", ".avi", ".mkv", ".mov", ".webm"}:
            return model.get_events_dataframe(video_path=str(path))
        if path and path.exists() and asset.type == "audio" and suffix in {".wav", ".mp3", ".flac", ".ogg"}:
            return model.get_events_dataframe(audio_path=str(path))
        if path and path.exists() and asset.type == "script" and suffix == ".txt":
            return _text_events_dataframe(path.read_text(encoding="utf-8", errors="ignore"))

        text = asset.extracted_text.strip() or asset.name or asset.source_url
        if not text:
            raise RuntimeError("TRIBE requires a file or extracted text for inference.")
        return _text_events_dataframe(text)


class FallbackBrainResponseProvider(BrainResponseProvider):
    name = "tribe-v2-with-fixture-fallback"

    def __init__(self, primary: BrainResponseProvider | None = None, fallback: BrainResponseProvider | None = None):
        self.primary = primary or TribeAdapter()
        self.fallback = fallback or FixtureBrainResponseProvider()
        self.last_error: str | None = None

    def predict(self, asset: Asset) -> list[TimelinePoint]:
        try:
            self.last_error = None
            return self.primary.predict(asset)
        except Exception as exc:
            self.last_error = str(exc)
            return self.fallback.predict(asset)


def build_brain_provider() -> BrainResponseProvider:
    provider = os.getenv("STIMLI_BRAIN_PROVIDER", "fixture").strip().lower()
    if provider == "tribe":
        return TribeAdapter()
    if provider == "auto":
        return FallbackBrainResponseProvider()
    return FixtureBrainResponseProvider()


def provider_health() -> list[BrainProviderHealth]:
    active = os.getenv("STIMLI_BRAIN_PROVIDER", "fixture").strip().lower()
    fixture = BrainProviderHealth(
        provider="fixture-brain-response",
        available=True,
        active=active == "fixture",
        detail="Deterministic local provider.",
    )
    tribe = TribeAdapter().health()
    tribe.active = active == "tribe"
    auto = BrainProviderHealth(
        provider="auto",
        available=True,
        active=active == "auto",
        detail="Attempts TRIBE first and falls back to deterministic local responses.",
    )
    return [fixture, tribe, auto]


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


def _predictions_to_timeline(asset: Asset, preds, segments) -> list[TimelinePoint]:
    rows = _rows(preds)
    if not rows:
        return FixtureBrainResponseProvider().predict(asset)

    intensity = [_safe_mean(abs(value) for value in row) for row in rows]
    variability = [pstdev(row) if len(row) > 1 else 0.0 for row in rows]
    positive_share = [_safe_mean(1.0 if value > 0 else 0.0 for value in row) for row in rows]
    attention_values = _normalize(intensity)
    memory_values = _normalize(positive_share)
    load_values = _normalize(variability)

    points = []
    for index, _row in enumerate(rows):
        segment = segments[index] if index < len(segments) else None
        attention = attention_values[index]
        memory = memory_values[index]
        load = load_values[index]
        points.append(
            TimelinePoint(
                second=_segment_second(segment, index),
                attention=round(attention, 3),
                memory=round(memory, 3),
                cognitive_load=round(load, 3),
                note=_tribe_note(attention, memory, load),
            )
        )
    return points


def _rows(preds) -> list[list[float]]:
    if hasattr(preds, "tolist"):
        preds = preds.tolist()
    if not isinstance(preds, list):
        return []
    if preds and not isinstance(preds[0], list):
        return [[float(value) for value in preds]]
    return [[float(value) for value in row] for row in preds]


def _normalize(values: list[float]) -> list[float]:
    if not values:
        return []
    lo = min(values)
    hi = max(values)
    if math.isclose(lo, hi):
        return [0.58 for _ in values]
    return [0.25 + 0.65 * ((value - lo) / (hi - lo)) for value in values]


def _safe_mean(values) -> float:
    values = list(values)
    return mean(values) if values else 0.0


def _segment_second(segment, index: int) -> float:
    if segment is None:
        return float(index)
    offset = getattr(segment, "offset", None)
    start = getattr(segment, "start", None)
    if offset is not None:
        return round(float(offset), 1)
    if start is not None:
        return round(float(start), 1)
    return float(index)


def _tribe_note(attention: float, memory: float, load: float) -> str:
    if attention >= 0.78 and load <= 0.68:
        return "TRIBE predicts strong response with manageable load"
    if load >= 0.78:
        return "TRIBE predicts high response variability"
    if memory >= 0.72:
        return "TRIBE predicts memorable cortical activation"
    if attention <= 0.42:
        return "TRIBE predicts a low-response segment"
    return "TRIBE response is stable"


def _text_events_dataframe(text: str):
    try:
        import pandas as pd
        from neuralset.events.utils import standardize_events
    except Exception as exc:
        raise RuntimeError("TRIBE text events require pandas and neuralset.") from exc

    words = re.findall(r"[A-Za-z0-9']+", text)
    if not words:
        raise RuntimeError("TRIBE text inference requires at least one word.")
    seconds_per_word = 0.42
    rows = []
    for index, word in enumerate(words):
        context_start = max(0, index - 80)
        context = " ".join(words[context_start : index + 1])
        rows.append(
            {
                "type": "Word",
                "start": round(index * seconds_per_word, 3),
                "duration": seconds_per_word,
                "timeline": "default",
                "subject": "default",
                "text": word,
                "language": "english",
                "sentence": text,
                "sentence_char": 0,
                "context": context,
                "modality": "read",
            }
        )
    rows.append(
        {
            "type": "Text",
            "start": 0,
            "duration": round(len(words) * seconds_per_word, 3),
            "timeline": "default",
            "subject": "default",
            "text": text,
            "language": "english",
            "context": text,
            "modality": "read",
        }
    )
    return standardize_events(pd.DataFrame(rows))
