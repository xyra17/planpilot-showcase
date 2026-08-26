"""Generate cached, browser-compatible media previews with FFmpeg."""

from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
from pathlib import Path
from typing import Any

from src.celery_app import celery_app
from src.config import settings
from src.core.time import utc_now
from src.services.object_storage import extension_for_reference, get_object_storage
from src.tasks.runtime import run_async

AUDIO_EXTENSIONS = {"mp3", "wav", "m4a", "aac", "ogg", "flac"}
VIDEO_EXTENSIONS = {"mp4", "webm", "mov", "m4v", "mkv"}
MEDIA_EXTENSIONS = AUDIO_EXTENSIONS | VIDEO_EXTENSIONS


class MediaPreviewError(RuntimeError):
    pass


async def _run(command: list[str], *, capture_stdout: bool = False) -> bytes:
    if shutil.which(command[0]) is None:
        raise MediaPreviewError(f"服务器未安装 {command[0]}")
    process = await asyncio.create_subprocess_exec(
        *command,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE if capture_stdout else asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(), timeout=settings.media_preview_timeout_seconds
        )
    except TimeoutError as exc:
        process.kill()
        await process.communicate()
        raise MediaPreviewError("媒体预览生成超时") from exc
    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace")[-1200:].strip()
        raise MediaPreviewError(f"媒体处理失败：{detail or 'FFmpeg 返回错误'}")
    return stdout or b""


async def _probe(path: Path) -> dict[str, Any]:
    payload = await _run(
        [
            "ffprobe",
            "-protocol_whitelist",
            "file,pipe,crypto,data",
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(path),
        ],
        capture_stdout=True,
    )
    try:
        return json.loads(payload)
    except json.JSONDecodeError as exc:
        raise MediaPreviewError("无法读取媒体元数据") from exc


def _float(value: Any) -> float | None:
    try:
        result = float(value)
        return round(result, 3) if result >= 0 else None
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> int | None:
    try:
        result = int(value)
        return result if result >= 0 else None
    except (TypeError, ValueError):
        return None


def _metadata(probe: dict[str, Any], ext: str, source_size: int) -> dict[str, Any]:
    streams = probe.get("streams") if isinstance(probe.get("streams"), list) else []
    video = next((row for row in streams if row.get("codec_type") == "video"), {})
    audio = next((row for row in streams if row.get("codec_type") == "audio"), {})
    format_row = probe.get("format") if isinstance(probe.get("format"), dict) else {}
    duration = _float(format_row.get("duration"))
    if duration is None:
        duration = _float(video.get("duration") or audio.get("duration"))
    return {
        "kind": "audio" if ext in AUDIO_EXTENSIONS else "video",
        "duration": duration,
        "width": _int(video.get("width")),
        "height": _int(video.get("height")),
        "videoCodec": video.get("codec_name"),
        "audioCodec": audio.get("codec_name"),
        "bitRate": _int(format_row.get("bit_rate")),
        "sourceFormat": ext,
        "sourceSize": source_size,
        "previewFormat": "mp3" if ext in AUDIO_EXTENSIONS else "mp4",
    }


async def _transcode_audio(source: Path, playback: Path, waveform: Path) -> None:
    await _run(
        [
            "ffmpeg",
            "-nostdin",
            "-protocol_whitelist",
            "file,pipe,crypto,data",
            "-v",
            "error",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "192k",
            "-map_metadata",
            "-1",
            "-y",
            str(playback),
        ]
    )
    await _run(
        [
            "ffmpeg",
            "-nostdin",
            "-protocol_whitelist",
            "file,pipe,crypto,data",
            "-v",
            "error",
            "-i",
            str(source),
            "-filter_complex",
            "aformat=channel_layouts=mono,showwavespic=s=1600x240:colors=0x8b5cf6",
            "-frames:v",
            "1",
            "-y",
            str(waveform),
        ]
    )


async def _transcode_video(
    source: Path, playback: Path, poster: Path, duration: float | None
) -> None:
    await _run(
        [
            "ffmpeg",
            "-nostdin",
            "-protocol_whitelist",
            "file,pipe,crypto,data",
            "-v",
            "error",
            "-i",
            str(source),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            "-map_metadata",
            "-1",
            "-y",
            str(playback),
        ]
    )
    seek = min(5.0, max(0.0, (duration or 0.0) * 0.1))
    await _run(
        [
            "ffmpeg",
            "-nostdin",
            "-protocol_whitelist",
            "file,pipe,crypto,data",
            "-v",
            "error",
            "-ss",
            f"{seek:.3f}",
            "-i",
            str(playback),
            "-frames:v",
            "1",
            "-vf",
            "scale='min(1280,iw)':-2",
            "-q:v",
            "3",
            "-y",
            str(poster),
        ]
    )


@celery_app.task(
    name="src.tasks.media_preview.process_media_preview",
    bind=True,
    max_retries=2,
    default_retry_delay=30,
)
def process_media_preview(self, item_id: str, source_version: str) -> None:
    try:
        run_async(_process(item_id, source_version))
    except Exception as exc:
        if self.request.retries >= self.max_retries:
            run_async(_mark_failed(item_id, source_version, exc))
            raise
        raise self.retry(exc=exc)


async def _process(item_id: str, source_version: str) -> None:
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from src.models import KnowledgeItem

    engine = create_async_engine(settings.database_url)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    storage = get_object_storage()
    created: list[str] = []
    try:
        async with session_factory() as db:
            item = (
                await db.execute(select(KnowledgeItem).where(KnowledgeItem.id == item_id))
            ).scalar_one_or_none()
            if not item or item.media_source_version != source_version or not item.file_path:
                return
            ext = extension_for_reference(item.file_path)
            if ext not in MEDIA_EXTENSIONS:
                return
            item.media_preview_status = "processing"
            item.media_preview_error = None
            await db.commit()
            source_reference = item.file_path
            source_size = item.file_size_bytes
            user_id = item.user_id

        with tempfile.TemporaryDirectory(prefix="planpilot-media-") as directory:
            temp = Path(directory)
            source = temp / f"source.{ext}"
            playback = temp / ("preview.mp3" if ext in AUDIO_EXTENSIONS else "preview.mp4")
            poster = temp / "poster.jpg"
            waveform = temp / "waveform.png"
            await storage.download_to_file(source_reference, str(source))
            probe = await _probe(source)
            metadata = _metadata(probe, ext, source_size)
            if ext in AUDIO_EXTENSIONS:
                await _transcode_audio(source, playback, waveform)
            else:
                await _transcode_video(source, playback, poster, metadata.get("duration"))

            prefix = f"knowledge/{user_id}/previews/{item_id}/{source_version}"
            playback_ext = "mp3" if ext in AUDIO_EXTENSIONS else "mp4"
            playback_ref = await storage.put_file(
                f"{prefix}/playback.{playback_ext}",
                str(playback),
                "audio/mpeg" if ext in AUDIO_EXTENSIONS else "video/mp4",
            )
            created.append(playback_ref)
            poster_ref = None
            waveform_ref = None
            if poster.exists():
                poster_ref = await storage.put_file(
                    f"{prefix}/poster.jpg", str(poster), "image/jpeg"
                )
                created.append(poster_ref)
            if waveform.exists():
                waveform_ref = await storage.put_file(
                    f"{prefix}/waveform.png", str(waveform), "image/png"
                )
                created.append(waveform_ref)

        async with session_factory() as db:
            item = (
                await db.execute(select(KnowledgeItem).where(KnowledgeItem.id == item_id))
            ).scalar_one_or_none()
            if not item or item.media_source_version != source_version:
                for reference in created:
                    await storage.delete(reference)
                return
            item.media_playback_path = playback_ref
            item.media_poster_path = poster_ref
            item.media_waveform_path = waveform_ref
            item.media_metadata = metadata
            item.media_preview_status = "ready"
            item.media_preview_error = None
            item.media_previewed_at = utc_now()
            await db.commit()
    except Exception:
        for reference in created:
            try:
                await storage.delete(reference)
            except Exception:
                pass
        raise
    finally:
        await engine.dispose()


async def _mark_failed(item_id: str, source_version: str, exc: Exception) -> None:
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from src.models import KnowledgeItem

    engine = create_async_engine(settings.database_url)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as db:
            item = (
                await db.execute(select(KnowledgeItem).where(KnowledgeItem.id == item_id))
            ).scalar_one_or_none()
            if item and item.media_source_version == source_version:
                item.media_preview_status = "failed"
                item.media_preview_error = str(exc)[-1000:] or "媒体预览生成失败"
                await db.commit()
    finally:
        await engine.dispose()
