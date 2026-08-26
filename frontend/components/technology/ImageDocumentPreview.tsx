"use client";

import { Maximize2, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { useState } from "react";

type ImageDocumentPreviewProps = {
  name: string;
  src: string;
};

export function ImageDocumentPreview({ name, src }: ImageDocumentPreviewProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  function resetView() {
    setScale(1);
    setRotation(0);
  }

  return (
    <section className="image-preview-shell" aria-label={`${name} 图片预览`}>
      <div className="image-preview-toolbar">
        <span className="image-preview-title" title={name}>{name}</span>
        <div className="image-preview-toolbar-group" aria-label="图片显示控制">
          <button type="button" onClick={() => setScale((current) => Math.max(0.25, Number((current - 0.1).toFixed(2))))} disabled={error || scale <= 0.25} aria-label="缩小图片"><ZoomOut size={15} /></button>
          <span className="image-preview-zoom">{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => setScale((current) => Math.min(4, Number((current + 0.1).toFixed(2))))} disabled={error || scale >= 4} aria-label="放大图片"><ZoomIn size={15} /></button>
          <span className="image-preview-divider" aria-hidden="true" />
          <button type="button" onClick={() => setRotation((current) => (current + 90) % 360)} disabled={error} aria-label="顺时针旋转"><RotateCw size={15} /></button>
          <button type="button" onClick={resetView} disabled={error || (scale === 1 && rotation === 0)} aria-label="适应窗口"><Maximize2 size={15} /></button>
        </div>
      </div>
      <div className="image-preview-stage">
        {loading && !error ? <div className="image-preview-status">正在加载图片…</div> : null}
        {error ? <div className="image-preview-status is-error" role="alert">图片无法显示，可以下载原文件后查看。</div> : null}
        {/* Authenticated object URLs cannot be processed by next/image. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={name}
          hidden={error}
          onLoad={() => setLoading(false)}
          onError={() => { setLoading(false); setError(true); }}
          style={{ transform: `scale(${scale}) rotate(${rotation}deg)` }}
        />
      </div>
    </section>
  );
}
