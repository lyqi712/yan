import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def run_json(command):
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False, timeout=60)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "command failed").strip())
    return json.loads(result.stdout or "{}")


def timestamp(value):
    value = max(float(value or 0), 0.0)
    hours = int(value // 3600)
    minutes = int(value % 3600 // 60)
    seconds = value % 60
    return f"{hours:02d}:{minutes:02d}:{seconds:06.3f}"


def as_list(value):
    if value is None:
        return []
    if hasattr(value, "tolist"):
        return value.tolist()
    return list(value)


def build_ocr_engine():
    model_dir = Path(os.environ.get('WXLENS_OCR_MODEL_DIR', str(Path(__file__).parent / 'models')))
    required = {name: model_dir / name for name in ['det.onnx', 'rec.onnx', 'cls.onnx', 'keys.txt']}
    if not all(p.is_file() for p in required.values()):
        raise RuntimeError('本地OCR模型缺失，未自动下载；详见docs/optional-runtime.md')
    from rapidocr import RapidOCR
    return RapidOCR(params={'Det.model_path': str(required['det.onnx']), 'Rec.model_path': str(required['rec.onnx']), 'Cls.model_path': str(required['cls.onnx']), 'Rec.rec_keys_path': str(required['keys.txt']), 'Det.limit_side_len': 1280, 'Det.limit_type': 'max'})


def ocr_frame(engine, frame_path):
    result = engine(str(frame_path))
    texts = [str(item or "").strip() for item in as_list(getattr(result, "txts", None))]
    scores = [float(item) for item in as_list(getattr(result, "scores", None))]
    lines = [{"text": text, "confidence": scores[index] if index < len(scores) else None} for index, text in enumerate(texts) if text]
    return lines


def transcribe(source, duration):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return {"available": False, "engine": "faster-whisper", "segments": [], "language": None, "warning": "faster-whisper is not installed; speech transcription was skipped."}
    model_name = os.environ.get("WXLENS_ASR_MODEL", "small")
    device = os.environ.get("WXLENS_ASR_DEVICE", "cpu")
    compute_type = os.environ.get("WXLENS_ASR_COMPUTE_TYPE", "int8" if device == "cpu" else "float16")
    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type, download_root=os.environ.get("WXLENS_ASR_MODEL_DIR") or None, local_files_only=True)
        segments, info = model.transcribe(str(source), language=os.environ.get("WXLENS_ASR_LANGUAGE") or None, vad_filter=True, beam_size=5)
    except Exception as exc:
        return {"available": False, "engine": "faster-whisper", "model": model_name, "segments": [], "language": None, "warning": f"Speech transcription unavailable: {type(exc).__name__}: {exc}"}
    rows = []
    for segment in segments:
        text = str(segment.text or "").strip()
        if text:
            rows.append({"start": round(float(segment.start), 3), "end": round(float(segment.end), 3), "text": text})
    return {"available": True, "engine": "faster-whisper", "model": model_name, "device": device, "computeType": compute_type, "language": getattr(info, "language", None), "languageProbability": getattr(info, "language_probability", None), "duration": duration, "segments": rows}


def extract_visual_timeline(source, duration, engine):
    max_frames = max(3, min(int(os.environ.get("WXLENS_VIDEO_MAX_KEYFRAMES", "24")), 60))
    interval = max(float(os.environ.get("WXLENS_VIDEO_FRAME_INTERVAL_SECONDS", "15")), 1.0)
    wanted = max(3, min(max_frames, int(math.ceil(duration / interval)) + 1)) if duration > 0 else 3
    if wanted == 1 or duration <= 0:
        times = [0.0]
    else:
        times = sorted(set(round(duration * index / (wanted - 1), 3) for index in range(wanted)))
    timeline = []
    with tempfile.TemporaryDirectory(prefix="wxlens-video-") as temp_dir:
        for index, second in enumerate(times):
            frame = Path(temp_dir) / f"frame-{index:04d}.jpg"
            command = ["ffmpeg", "-v", "error", "-ss", str(second), "-i", str(source), "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", "-y", str(frame)]
            result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False, timeout=60)
            if result.returncode != 0 or not frame.is_file():
                timeline.append({"timestamp": second, "ocrText": "", "ocrLines": [], "warning": (result.stderr or "frame extraction failed").strip()})
                continue
            lines = ocr_frame(engine, frame)
            timeline.append({"timestamp": second, "ocrText": "\n".join(row["text"] for row in lines), "ocrLines": lines})
    return timeline


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    source = Path(args.input).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)

    probe = run_json(["ffprobe", "-v", "error", "-show_entries", "format=filename,format_name,duration,size,bit_rate:stream=index,codec_name,codec_type,width,height,sample_rate,channels", "-of", "json", str(source)])
    duration = float(probe.get("format", {}).get("duration") or 0)
    streams = probe.get("streams") or []
    has_video = any(row.get("codec_type") == "video" for row in streams)
    has_audio = any(row.get("codec_type") == "audio" for row in streams)
    warnings = []

    speech = transcribe(source, duration) if has_audio else {"available": False, "engine": "faster-whisper", "segments": [], "language": None, "warning": "No audio stream found."}
    if speech.get("warning"):
        warnings.append(speech["warning"])

    visual_timeline = []
    if has_video:
        try:
            visual_timeline = extract_visual_timeline(source, duration, build_ocr_engine())
        except Exception as error:
            warnings.append(f"关键帧OCR未完成：{error}")
    else:
        warnings.append("No video stream found; visual timeline was skipped.")

    lines = []
    for segment in speech.get("segments", []):
        lines.append(f"[{timestamp(segment['start'])}-{timestamp(segment['end'])}] {segment['text']}")
    for frame in visual_timeline:
        if frame.get("ocrText"):
            lines.append(f"[frame {timestamp(frame['timestamp'])}] {frame['ocrText']}")

    payload = {
        "text": "\n".join(lines),
        "parser": "local-video-deep-reader" if has_video else "local-audio-asr-reader",
        "coverage": {
            "streams": len(streams),
            "durationSeconds": duration,
            "audioStream": has_audio,
            "videoStream": has_video,
            "asrSegments": len(speech.get("segments", [])),
            "keyframes": len(visual_timeline),
            "keyframeOcrFrames": sum(1 for frame in visual_timeline if frame.get("ocrText")),
            "fullTimelineSampled": bool(has_video and visual_timeline),
        },
        "metadata": {"probe": probe, "speech": speech, "visualTimeline": visual_timeline},
        "warnings": warnings,
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        raise
