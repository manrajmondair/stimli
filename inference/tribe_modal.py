from __future__ import annotations

import base64
import math
import os
import re
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, pstdev
from typing import Any

import modal
from fastapi import Header


APP_NAME = "stimli-tribe-inference"
CACHE_PATH = "/model-cache"
HF_HOME = f"{CACHE_PATH}/huggingface"
TRIBE_CHECKPOINT = os.getenv("STIMLI_TRIBE_CHECKPOINT", "facebook/tribev2")

app = modal.App(APP_NAME)
cache_volume = modal.Volume.from_name("stimli-tribe-cache", create_if_missing=True)
jobs = modal.Dict.from_name("stimli-tribe-jobs", create_if_missing=True)

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
control_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi>=0.115.0")
extract_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libsndfile1", "tesseract-ocr")
    .pip_install(
        "fastapi>=0.115.0",
        "faster-whisper>=1.1.0",
        "pillow>=11.0.0",
        "pytesseract>=0.3.13",
    )
)

_model = None
_whisper_model = None
_transformers_auth_patched = False


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
        modal.Secret.from_name("stimli-vercel-blob"),
    ],
)
@modal.fastapi_endpoint(method="POST", label="stimli-tribe", docs=True)
def predict(payload: dict[str, Any], authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _check_auth(authorization)
    asset = payload.get("asset") or {}
    return _predict_asset(asset)


@app.function(
    image=control_image,
    timeout=60,
    secrets=[modal.Secret.from_name("stimli-modal-auth")],
)
@modal.fastapi_endpoint(method="POST", label="stimli-tribe-control", docs=True)
def control(payload: dict[str, Any], authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _check_auth(authorization)
    action = payload.get("action")
    if action == "start":
        asset = payload.get("asset") or {}
        if not asset.get("id"):
            raise _http_error(400, "Asset id is required.")
        job_id = payload.get("job_id") or f"job_{uuid.uuid4().hex[:12]}"
        record = _job_record(job_id, asset, "queued")
        jobs.put(job_id, record)
        run_prediction_job.spawn(job_id, asset, 0)
        return record
    if action == "status":
        job_id = payload.get("job_id")
        if not job_id:
            raise _http_error(400, "job_id is required.")
        record = jobs.get(job_id)
        if not record:
            raise _http_error(404, "Job not found.")
        return record
    if action == "cancel":
        job_id = payload.get("job_id")
        if not job_id:
            raise _http_error(400, "job_id is required.")
        record = jobs.get(job_id)
        if not record:
            raise _http_error(404, "Job not found.")
        cancelled = {**record, "status": "cancelled", "updated_at": _now()}
        jobs.put(job_id, cancelled)
        return cancelled
    raise _http_error(400, "Unsupported action.")


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
        modal.Secret.from_name("stimli-vercel-blob"),
    ],
)
def run_prediction_job(job_id: str, asset: dict[str, Any], attempt: int = 0) -> dict[str, Any]:
    existing = jobs.get(job_id) or {}
    if existing.get("status") == "cancelled":
        return existing
    jobs.put(job_id, {**_job_record(job_id, asset, "running"), "attempt": attempt})
    try:
        result = _predict_asset(asset)
        if (jobs.get(job_id) or {}).get("status") == "cancelled":
            return jobs.get(job_id)
        record = {
            **_job_record(job_id, asset, "complete"),
            "result": result,
            "timeline": result["timeline"],
            "attempt": attempt,
        }
    except Exception as exc:
        max_retries = int(os.getenv("STIMLI_MODAL_JOB_RETRIES", "1"))
        if attempt < max_retries and (jobs.get(job_id) or {}).get("status") != "cancelled":
            record = {
                **_job_record(job_id, asset, "retrying"),
                "attempt": attempt,
                "next_attempt": attempt + 1,
                "error": _error_message(exc),
            }
            jobs.put(job_id, record)
            run_prediction_job.spawn(job_id, asset, attempt + 1)
            return record
        record = {
            **_job_record(job_id, asset, "failed"),
            "error": _error_message(exc),
            "attempt": attempt,
        }
    jobs.put(job_id, record)
    return record


@app.function(
    image=extract_image,
    gpu=os.getenv("STIMLI_EXTRACT_GPU", "A10G"),
    timeout=600,
    scaledown_window=120,
    max_containers=3,
    volumes={CACHE_PATH: cache_volume},
    secrets=[
        modal.Secret.from_name("stimli-modal-auth"),
        modal.Secret.from_name("stimli-vercel-blob"),
    ],
)
@modal.fastapi_endpoint(method="POST", label="stimli-extract", docs=True)
def extract(payload: dict[str, Any], authorization: str | None = Header(default=None)) -> dict[str, Any]:
    _check_auth(authorization)
    asset = payload.get("asset") or {}
    return _extract_asset(asset)


@app.function(
    image=image,
    gpu=os.getenv("STIMLI_MODAL_GPU", "A10G"),
    timeout=900,
    volumes={CACHE_PATH: cache_volume},
    secrets=[modal.Secret.from_name("stimli-huggingface")],
)
def warm() -> dict[str, Any]:
    _configure_hf_auth()
    model = _load_model()
    return {"status": "ok", "checkpoint": TRIBE_CHECKPOINT, "model": type(model).__name__}


@app.function(
    image=image,
    secrets=[
        modal.Secret.from_name("stimli-huggingface"),
        modal.Secret.from_name("stimli-modal-auth"),
        modal.Secret.from_name("stimli-vercel-blob"),
    ],
)
def secret_status() -> dict[str, Any]:
    _configure_hf_auth(validate=False)
    hf_token = os.getenv("HF_TOKEN") or ""
    hub_token = os.getenv("HUGGING_FACE_HUB_TOKEN") or ""
    auth_token = os.getenv("STIMLI_MODAL_API_KEY") or ""
    blob_token = os.getenv("BLOB_READ_WRITE_TOKEN") or ""
    hub_status = _hf_hub_status(hf_token or hub_token)
    return {
        "hf_token_present": bool(hf_token),
        "hf_token_prefix_ok": hf_token.startswith("hf_"),
        "hub_token_present": bool(hub_token),
        "hub_token_prefix_ok": hub_token.startswith("hf_"),
        "auth_token_present": bool(auth_token),
        "blob_token_present": bool(blob_token),
        **hub_status,
    }


def _predict_asset(asset: dict[str, Any]) -> dict[str, Any]:
    _configure_hf_auth()
    model = _load_model()
    events = _events_for_asset(model, asset)
    preds, segments = model.predict(events=events, verbose=False)
    return {
        "provider": "tribe-v2",
        "asset_id": asset.get("id"),
        "timeline": _predictions_to_timeline(asset, preds, segments),
    }


def _extract_asset(asset: dict[str, Any]) -> dict[str, Any]:
    asset_type = asset.get("type")
    file_path = _asset_file(asset)
    text_parts = []
    segments = []

    if asset.get("extracted_text"):
        text_parts.append(asset["extracted_text"])

    if file_path and asset_type == "image":
        ocr_text = _ocr_image(file_path)
        if ocr_text:
            text_parts.append(ocr_text)
            segments.append({"type": "ocr", "start": 0, "end": 0, "text": ocr_text})

    if file_path and asset_type == "audio":
        transcript, transcript_segments = _transcribe_audio(file_path)
        if transcript:
            text_parts.append(transcript)
            segments.extend(transcript_segments)

    if file_path and asset_type == "video":
        audio_path = _video_audio(file_path)
        if audio_path:
            transcript, transcript_segments = _transcribe_audio(audio_path)
            if transcript:
                text_parts.append(transcript)
                segments.extend(transcript_segments)
        for frame in _video_frames(file_path):
            ocr_text = _ocr_image(frame["path"])
            if ocr_text:
                text_parts.append(ocr_text)
                segments.append({"type": "ocr", "start": frame["second"], "end": frame["second"], "text": ocr_text})

    text = _dedupe_text(" ".join(part.strip() for part in text_parts if part and part.strip()))
    return {
        "provider": "stimli-extractor",
        "asset_id": asset.get("id"),
        "text": text,
        "segments": segments[:80],
        "metadata": {
            "extraction_status": "success" if text else "empty",
            "segment_count": len(segments),
        },
    }


def _job_record(job_id: str, asset: dict[str, Any], status: str) -> dict[str, Any]:
    timestamp = _now()
    existing = jobs.get(job_id) if job_id else None
    return {
        "job_id": job_id,
        "asset_id": asset.get("id"),
        "status": status,
        "provider": "tribe-v2",
        "created_at": (existing or {}).get("created_at") or timestamp,
        "updated_at": timestamp,
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _error_message(exc: Exception) -> str:
    detail = getattr(exc, "detail", None)
    if detail:
        return str(detail)
    return str(exc) or type(exc).__name__


def _transcribe_audio(file_path: Path) -> tuple[str, list[dict[str, Any]]]:
    model = _load_whisper_model()
    segments, _info = model.transcribe(str(file_path), beam_size=1, vad_filter=True)
    rows = []
    for segment in segments:
        text = segment.text.strip()
        if text:
            rows.append(
                {
                    "type": "transcript",
                    "start": round(float(segment.start), 2),
                    "end": round(float(segment.end), 2),
                    "text": text,
                }
            )
    return _dedupe_text(" ".join(row["text"] for row in rows)), rows


def _load_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        import torch
        from faster_whisper import WhisperModel

        device = "cuda" if torch.cuda.is_available() else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"
        _whisper_model = WhisperModel(
            os.getenv("STIMLI_WHISPER_CHECKPOINT", "Systran/faster-whisper-small.en"),
            device=device,
            compute_type=compute_type,
            download_root=f"{CACHE_PATH}/whisper",
        )
        try:
            cache_volume.commit()
        except Exception:
            pass
    return _whisper_model


def _ocr_image(file_path: Path) -> str:
    try:
        from PIL import Image
        import pytesseract

        image = Image.open(file_path).convert("RGB")
        return _dedupe_text(pytesseract.image_to_string(image, config="--psm 6"))
    except Exception:
        return ""


def _video_audio(file_path: Path) -> Path | None:
    output = Path(tempfile.NamedTemporaryFile(delete=False, suffix=".wav").name)
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(file_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        str(output),
    ]
    if _run(command):
        return output
    output.unlink(missing_ok=True)
    return None


def _video_frames(file_path: Path) -> list[dict[str, Any]]:
    directory = Path(tempfile.mkdtemp())
    pattern = directory / "frame_%03d.jpg"
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(file_path),
        "-vf",
        "fps=1/4,scale=960:-1",
        "-frames:v",
        "6",
        str(pattern),
    ]
    if not _run(command):
        return []
    return [{"second": float(index * 4), "path": path} for index, path in enumerate(sorted(directory.glob("frame_*.jpg")))]


def _run(command: list[str]) -> bool:
    try:
        completed = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180, check=False)
        return completed.returncode == 0
    except Exception:
        return False


def _dedupe_text(text: str) -> str:
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9'%-]*", text or "")
    if not words:
        return ""
    compact = " ".join(words)
    return re.sub(r"\s+", " ", compact).strip()[:12000]


def _configure_hf_auth(validate: bool = True) -> None:
    token = (
        os.getenv("HF_TOKEN")
        or os.getenv("HUGGING_FACE_HUB_TOKEN")
        or os.getenv("HF_HUB_TOKEN")
    )
    os.environ.setdefault("HF_HOME", HF_HOME)
    os.environ.setdefault("HF_HUB_CACHE", f"{HF_HOME}/hub")
    os.environ.setdefault("TRANSFORMERS_CACHE", f"{HF_HOME}/transformers")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    if not token:
        if validate:
            raise _http_error(500, "Hugging Face token secret is not configured.")
        return
    os.environ["HF_TOKEN"] = token
    os.environ["HUGGING_FACE_HUB_TOKEN"] = token
    os.environ["HF_HUB_TOKEN"] = token
    _patch_transformers_auth(token)
    try:
        from huggingface_hub import login

        login(token=token, add_to_git_credential=False)
    except Exception:
        pass


def _patch_transformers_auth(token: str) -> None:
    global _transformers_auth_patched
    if _transformers_auth_patched:
        return
    try:
        import transformers
    except Exception:
        return

    class_names = [
        "AutoConfig",
        "AutoFeatureExtractor",
        "AutoModel",
        "AutoModelForCausalLM",
        "AutoModelForTextEncoding",
        "AutoProcessor",
        "AutoTokenizer",
        "MllamaForConditionalGeneration",
        "SeamlessM4TModel",
        "Wav2Vec2BertModel",
        "WhisperModel",
    ]
    for class_name in class_names:
        cls = getattr(transformers, class_name, None)
        if cls is None or not hasattr(cls, "from_pretrained"):
            continue
        original = cls.from_pretrained

        def build_wrapper(original_method):
            def wrapped(inner_cls, pretrained_model_name_or_path, *args, **kwargs):
                kwargs.setdefault("token", token)
                return original_method(pretrained_model_name_or_path, *args, **kwargs)

            return classmethod(wrapped)

        cls.from_pretrained = build_wrapper(original)
    _transformers_auth_patched = True


def _hf_hub_status(token: str) -> dict[str, Any]:
    status = {
        "hf_whoami_ok": False,
        "hf_whoami_error": None,
        "llama_access_ok": False,
        "llama_access_error": None,
        "llama_config_download_ok": False,
        "llama_config_download_error": None,
    }
    if not token:
        return status
    try:
        from huggingface_hub import whoami

        whoami(token=token)
        status["hf_whoami_ok"] = True
    except Exception as exc:
        status["hf_whoami_error"] = type(exc).__name__
    try:
        from huggingface_hub import hf_hub_download, model_info

        model_info("meta-llama/Llama-3.2-3B", token=token)
        status["llama_access_ok"] = True
        hf_hub_download(
            "meta-llama/Llama-3.2-3B",
            "config.json",
            cache_dir=HF_HOME,
            token=token,
        )
        status["llama_config_download_ok"] = True
    except Exception as exc:
        status["llama_access_error"] = type(exc).__name__
        status["llama_config_download_error"] = type(exc).__name__
    return status


def _check_auth(authorization: str | None) -> None:
    expected = os.getenv("STIMLI_MODAL_API_KEY")
    if not expected:
        raise _http_error(500, "Modal auth secret is not configured.")
    if authorization != f"Bearer {expected}":
        raise _http_error(401, "Unauthorized.")


def _load_model():
    global _model
    if _model is None:
        _configure_hf_auth()
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
    suffix = Path(metadata.get("original_filename") or "").suffix
    if not suffix:
        suffix = _suffix_for_type(asset.get("type"))
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    if encoded:
        handle.write(base64.b64decode(encoded))
    elif metadata.get("blob_url") or metadata.get("blob_download_url"):
        handle.write(_download_blob(metadata.get("blob_url") or metadata.get("blob_download_url")))
    else:
        handle.close()
        Path(handle.name).unlink(missing_ok=True)
        return None
    handle.close()
    return Path(handle.name)


def _download_blob(url: str) -> bytes:
    import urllib.request

    headers = {}
    token = os.getenv("BLOB_READ_WRITE_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=180) as response:
        return response.read()


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
    print(secret_status.remote())


@app.local_entrypoint()
def check_secrets():
    print(secret_status.remote())
