from __future__ import annotations

import sys
import types

from app.brain import FallbackBrainResponseProvider, FixtureBrainResponseProvider, TribeAdapter
from app.models import Asset


class FakeSegment:
    def __init__(self, offset: float):
        self.offset = offset


class FakeModel:
    calls: list[str] = []

    @classmethod
    def from_pretrained(cls, checkpoint: str, cache_folder: str, device: str):
        cls.calls.append(f"{checkpoint}:{cache_folder}:{device}")
        return cls()

    def get_events_dataframe(self, text_path: str | None = None, audio_path: str | None = None, video_path: str | None = None):
        return {"text_path": text_path, "audio_path": audio_path, "video_path": video_path}

    def predict(self, events, verbose: bool):
        return [[0.1, 0.2, -0.1], [0.6, 0.7, 0.1], [0.2, -0.2, -0.4]], [FakeSegment(0), FakeSegment(2), FakeSegment(4)]


def test_tribe_adapter_maps_predictions_to_timeline(monkeypatch, tmp_path):
    module = types.ModuleType("tribev2")
    module.TribeModel = FakeModel
    monkeypatch.setitem(sys.modules, "tribev2", module)

    adapter = TribeAdapter(cache_folder=str(tmp_path), device="cpu")
    asset = Asset(
        id="asset_1",
        type="script",
        name="Script",
        extracted_text="Stop guessing and try the kit today.",
        created_at="2026-05-06T00:00:00+00:00",
    )

    timeline = adapter.predict(asset)

    assert adapter.name == "tribe-v2"
    assert len(timeline) == 3
    assert timeline[0].second == 0
    assert timeline[1].attention > timeline[0].attention
    assert timeline[1].note.startswith("TRIBE")


def test_auto_provider_falls_back_when_tribe_fails():
    class BrokenProvider:
        name = "broken"

        def predict(self, asset):
            raise RuntimeError("missing dependency")

    provider = FallbackBrainResponseProvider(primary=BrokenProvider(), fallback=FixtureBrainResponseProvider())
    asset = Asset(id="asset_1", type="script", name="Fallback", extracted_text="Try it today.", created_at="2026-05-06T00:00:00+00:00")

    timeline = provider.predict(asset)

    assert provider.last_error == "missing dependency"
    assert len(timeline) == 12
