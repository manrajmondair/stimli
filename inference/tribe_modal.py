from __future__ import annotations

import base64
import math
import os
import re
import tempfile
from pathlib import Path
from statistics import mean, pstdev
from typing import Any

import modal
from fastapi import Header


APP_NAME = "stimli-tribe-inference"
CACHE_PATH = "/model-cache"
TRIBE_CHECKPOINT = os.getenv("STIMLI_TRIBE_CHECKPOINT", "facebook/tribev2")

app = modal.App(APP_NAME)
cache_volume = modal.Volume.from_name("stimli-tribe-cache", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "libsndfile1")
    .pip_install(
        "fastapi>=0.115.0",
        "huggingface_hub>=0.26.0",
        "numpy>=2.0.0",
        "pandas>=2.2.0",
        "torch==2.6.0",
        "torchaudio==2.6.0",
        "torchvision==0.21.0",
        "tribev2 @ git+https://github.com/facebookresearch/tribev2.git@main",
    )
)

_model = None


@app.function(
    image=image,
    gpu=os.getenv("STIMLI_MODAL_GPU", "A10G"),
    timeout=900,
    scaledown_window=300,
    max_containers=3,
    volumes={CACHE_PATH: cache_volume},
    secrets=[
        modal.Secret.from_name("stimli-huggingface"),
        modal.Secret.from_name("stimli-modal-auth"),
    ],
)
@modal.fastapi_endpoint(method="POST", label="stimli-tribe", docs=True)
def predict(payload: dict[str, Any], authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _check_auth(authorization)
    asset = payload.get("asset") or {}
    model = _load_model()
    events = _events_for_asset(model, asset)
    preds, segments = model.predict(events=events, verbose=False)
    return {
        "provider": "tribe-v2",
        "asset_id": asset.get("id"),
        "timeline": _predictions_to_timeline(asset, preds, segments),
    }


@app.function(
    image=image,
    gpu=os.getenv("STIMLI_MODAL_GPU", "A10G"),
    timeout=900,
    volumes={CACHE_PATH: cache_volume},
    secrets=[modal.Secret.from_name("stimli-huggingface")],
)
def warm() -> dict[str, Any]:
    model = _load_model()
    return {"status": "ok", "checkpoint": TRIBE_CHECKPOINT, "model": type(model).__name__}


def _check_auth(authorization: str | None) -> None:
    expected = os.getenv("STIMLI_MODAL_API_KEY")
    if not expected:
        raise _http_error(500, "Modal auth secret is not configured.")
    if authorization != f"Bearer {expected}":
        raise _http_error(401, "Unauthorized.")


def _load_model():
    global _model
    if _model is None:
        import torch
        from tribev2 import TribeModel

        device = "cuda" if torch.cuda.is_available() else "cpu"
        _model = TribeModel.from_pretrained(
            TRIBE_CHECKPOINT,
            cache_folder=CACHE_PATH,
            device=device,
            config_update={
                "data.text_feature.device": device,
                "data.image_feature.image.device": device,
                "data.audio_feature.device": device,
                "data.video_feature.image.device": device,
            },
        )
        try:
            cache_volume.commit()
        except Exception:
            pass
    return _model


def _events_for_asset(model, asset: dict[str, Any]):
    asset_type = asset.get("type")
    file_path = _asset_file(asset)
    if file_path and asset_type == "video":
        return model.get_events_dataframe(video_path=str(file_path))
    if file_path and asset_type == "audio":
        return model.get_events_dataframe(audio_path=str(file_path))
    if file_path and asset_type == "script":
        return _text_events_dataframe(file_path.read_text(encoding="utf-8", errors="ignore"))

    text = (asset.get("extracted_text") or asset.get("name") or asset.get("source_url") or "").strip()
    if not text:
        raise _http_error(400, "TRIBE requires extracted text or an uploaded audio/video/script file.")
    return _text_events_dataframe(text)


def _asset_file(asset: dict[str, Any]) -> Path | None:
    metadata = asset.get("metadata") or {}
    encoded = metadata.get("file_base64")
    if not encoded:
        return None
    suffix = Path(metadata.get("original_filename") or "").suffix
    if not suffix:
        suffix = _suffix_for_type(asset.get("type"))
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    handle.write(base64.b64decode(encoded))
    handle.close()
    return Path(handle.name)


def _suffix_for_type(asset_type: str | None) -> str:
    if asset_type == "video":
        return ".mp4"
    if asset_type == "audio":
        return ".wav"
    if asset_type == "script":
        return ".txt"
    return ".bin"


def _predictions_to_timeline(asset: dict[str, Any], preds, segments) -> list[dict[str, Any]]:
    rows = _rows(preds)
    if not rows:
        raise _http_error(502, "TRIBE returned no prediction rows.")

    intensity = [_safe_mean(abs(value) for value in row) for row in rows]
    variability = [pstdev(row) if len(row) > 1 else 0.0 for row in rows]
    positive_share = [_safe_mean(1.0 if value > 0 else 0.0 for value in row) for row in rows]
    attention_values = _normalize(intensity)
    memory_values = _normalize(positive_share)
    load_values = _normalize(variability)

    timeline = []
    for index, _row in enumerate(rows):
        segment = segments[index] if index < len(segments) else None
        attention = attention_values[index]
        memory = memory_values[index]
        load = load_values[index]
        timeline.append(
            {
                "second": _segment_second(segment, index),
                "attention": round(attention, 3),
                "memory": round(memory, 3),
                "cognitive_load": round(load, 3),
                "note": _tribe_note(attention, memory, load),
            }
        )
    return timeline


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
    import pandas as pd
    from neuralset.events.utils import standardize_events

    words = re.findall(r"[A-Za-z0-9']+", text)
    if not words:
        raise _http_error(400, "TRIBE text inference requires at least one word.")
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


def _http_error(status_code: int, detail: str):
    from fastapi import HTTPException

    return HTTPException(status_code=status_code, detail=detail)


@app.local_entrypoint()
def main():
    print(warm.remote())
