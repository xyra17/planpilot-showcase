"use client";

import { AudioLines, Film, LoaderCircle, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState, type MouseEvent } from "react";
import type { ApiKnowledgeFile, ApiMediaMetadata } from "@/lib/technology/productApi";

type MediaDocumentPreviewProps = {
  name: string;
  kind: "audio" | "video";
  status: ApiKnowledgeFile["mediaPreviewStatus"];
  error?: string | null;
  metadata: ApiMediaMetadata;
  playbackUrl: string;
  posterUrl?: string;
  waveformUrl?: string;
  onRetry: () => Promise<void>;
};

function formatDuration(seconds?: number | null) {
  if (!seconds || !Number.isFinite(seconds)) return "时长读取中";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatBitRate(value?: number | null) {
  if (!value) return null;
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)} Mbps`
    : `${Math.round(value / 1000)} kbps`;
}

export function MediaDocumentPreview({
  name,
  kind,
  status,
  error,
  metadata,
  playbackUrl,
  posterUrl,
  waveformUrl,
  onRetry,
}: MediaDocumentPreviewProps) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [playbackError, setPlaybackError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const facts = useMemo(() => [
    formatDuration(metadata.duration),
    kind === "video" && metadata.width && metadata.height ? `${metadata.width} × ${metadata.height}` : null,
    [metadata.videoCodec, metadata.audioCodec].filter(Boolean).join(" / ") || null,
    formatBitRate(metadata.bitRate),
    metadata.previewFormat ? `预览 ${metadata.previewFormat.toUpperCase()}` : null,
  ].filter((value): value is string => Boolean(value)), [kind, metadata]);

  async function retry() {
    setRetrying(true);
    setPlaybackError("");
    try {
      await onRetry();
    } catch (reason) {
      setPlaybackError(reason instanceof Error ? reason.message : "预览重试失败，请稍后再试。");
    } finally {
      setRetrying(false);
    }
  }

  function seekFromWaveform(event: MouseEvent<HTMLButtonElement>) {
    const media = mediaRef.current;
    if (!media || !Number.isFinite(media.duration) || media.duration <= 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    media.currentTime = ratio * media.duration;
  }

  if (status === "queued" || status === "processing") {
    return (
      <section className="media-preview-shell is-status" aria-live="polite">
        <LoaderCircle className="media-preview-spinner" size={28} />
        <strong>{status === "queued" ? "媒体预览已进入处理队列" : "正在生成兼容预览"}</strong>
        <span>后台正在转码并生成{kind === "audio" ? "波形" : "视频封面"}，完成后会自动显示。</span>
      </section>
    );
  }

  if (status === "failed" || playbackError) {
    return (
      <section className="media-preview-shell is-status is-error" role="alert">
        {kind === "audio" ? <AudioLines size={28} /> : <Film size={28} />}
        <strong>媒体预览生成失败</strong>
        <span>{playbackError || error || "服务器暂时无法生成兼容的播放文件。"}</span>
        <button type="button" onClick={() => void retry()} disabled={retrying}>
          <RefreshCw className={retrying ? "is-spinning" : undefined} size={15} />
          {retrying ? "正在重试" : "重新生成预览"}
        </button>
      </section>
    );
  }

  if (status !== "ready") {
    return (
      <section className="media-preview-shell is-status">
        {kind === "audio" ? <AudioLines size={28} /> : <Film size={28} />}
        <strong>正在准备媒体预览</strong>
        <span>预览任务即将开始。</span>
      </section>
    );
  }

  return (
    <section className={`media-preview-shell is-${kind}`} aria-label={`${name} ${kind === "audio" ? "音频" : "视频"}预览`}>
      <header className="media-preview-header">
        <div className="media-preview-heading">
          {kind === "audio" ? <AudioLines size={18} /> : <Film size={18} />}
          <span title={name}>{name}</span>
        </div>
        <div className="media-preview-facts" aria-label="媒体信息">
          {facts.map((fact) => <span key={fact}>{fact}</span>)}
        </div>
      </header>

      {kind === "video" ? (
        <div className="media-video-stage">
          <video
            ref={(node) => { mediaRef.current = node; }}
            src={playbackUrl}
            poster={posterUrl}
            controls
            preload="metadata"
            playsInline
            onError={() => setPlaybackError("兼容预览文件无法播放，请重新生成。")}
          >
            当前浏览器不支持视频播放。
          </video>
        </div>
      ) : (
        <div className="media-audio-stage">
          <div className="media-audio-art" aria-hidden="true"><AudioLines size={42} /></div>
          {waveformUrl ? (
            <button type="button" className="media-waveform" onClick={seekFromWaveform} aria-label="点击波形跳转播放位置">
              {/* Authenticated preview assets are served from the backend proxy. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={waveformUrl} alt="" />
            </button>
          ) : null}
          <audio
            ref={(node) => { mediaRef.current = node; }}
            src={playbackUrl}
            controls
            preload="metadata"
            onError={() => setPlaybackError("兼容预览文件无法播放，请重新生成。")}
          >
            当前浏览器不支持音频播放。
          </audio>
        </div>
      )}
    </section>
  );
}
