from __future__ import annotations

import sys
import types

from app.brain import FallbackBrainResponseProvider, FixtureBrainResponseProvider, TribeAdapter, _predictions_to_timeline
from app.models import Asset


class FakeSegment:
    def __init__(self, offset: float):
        self.offset = offset


class FakeModel:
    calls: list[str] = []

    @classmethod
    def from_pretrained(cls, checkpoint: str, cache_folder: str, device: str, **_kwargs):
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


def test_tribe_adapter_resolves_auto_device(monkeypatch, tmp_path):
    module = types.ModuleType("tribev2")
    module.TribeModel = FakeModel
    torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
    monkeypatch.setitem(sys.modules, "tribev2", module)
    monkeypatch.setitem(sys.modules, "torch", torch)
    FakeModel.calls.clear()

    adapter = TribeAdapter(cache_folder=str(tmp_path), device="auto")
    asset = Asset(
        id="asset_1",
        type="script",
        name="Script",
        extracted_text="Stop guessing and try the kit today.",
        created_at="2026-05-06T00:00:00+00:00",
    )

    adapter.predict(asset)

    assert FakeModel.calls[-1].endswith(":cpu")


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


def test_timeline_conversion_handles_dict_and_missing_segments():
    asset = Asset(id="asset_1", type="script", name="Segments", extracted_text="Try it today.", created_at="2026-05-06T00:00:00+00:00")

    timeline = _predictions_to_timeline(asset, [[0.1, 0.2], [0.5, -0.1]], [{"start": 2.34}])

    assert timeline[0].second == 2.3
    assert timeline[1].second == 1.0


def test_fixture_provider_is_deterministic():
    # The fixture provider backs "reproducible demos" — the same asset must
    # always yield an identical predicted timeline.
    asset = Asset(
        id="asset_det",
        type="script",
        name="Hook",
        extracted_text="Stop guessing. Try the kit today.",
        created_at="2026-05-06T00:00:00+00:00",
    )
    provider = FixtureBrainResponseProvider()
    first = provider.predict(asset)
    second = provider.predict(asset)
    assert len(first) == 12
    shape = lambda timeline: [(p.second, p.attention, p.memory, p.cognitive_load) for p in timeline]
    assert shape(first) == shape(second)


def test_fixture_provider_varies_by_content():
    provider = FixtureBrainResponseProvider()
    hooky = Asset(id="a", type="script", name="A", extracted_text="Stop guessing. Try the kit today.", created_at="2026-05-06T00:00:00+00:00")
    flat = Asset(id="b", type="script", name="B", extracted_text="A generic product story with no opener.", created_at="2026-05-06T00:00:00+00:00")
    assert [p.attention for p in provider.predict(hooky)] != [p.attention for p in provider.predict(flat)]


def test_timeline_conversion_falls_back_to_fixture_on_empty_or_invalid_predictions():
    asset = Asset(id="empty", type="script", name="Empty", extracted_text="Try it.", created_at="2026-05-06T00:00:00+00:00")
    # No rows, and a non-list payload, must both degrade to the 12-point fixture
    # rather than producing an empty timeline (which would crash downstream means/maxes).
    assert len(_predictions_to_timeline(asset, [], None)) == 12
    assert len(_predictions_to_timeline(asset, "not-a-list", None)) == 12
