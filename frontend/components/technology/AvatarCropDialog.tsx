"use client";
/* eslint-disable @next/next/no-img-element -- Local object URLs must render as exact canvas sources. */

import * as Dialog from "@radix-ui/react-dialog";
import { Camera, ImagePlus, LoaderCircle, Minus, Move, Plus, RotateCcw, X } from "lucide-react";
import { PointerEvent, useCallback, useEffect, useRef, useState } from "react";

type Point = { x: number; y: number };
type ImageSize = { width: number; height: number };

type AvatarCropDialogProps = {
  file: File;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (file: File) => Promise<void>;
  onChooseAnother: () => void;
};

const OUTPUT_SIZE = 512;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;

export function AvatarCropDialog({ file, busy, onCancel, onConfirm, onChooseAnother }: AvatarCropDialogProps) {
  const [imageUrl, setImageUrl] = useState("");
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [imageSize, setImageSize] = useState<ImageSize>({ width: 0, height: 0 });
  const [stageSize, setStageSize] = useState(0);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [error, setError] = useState("");

  useEffect(() => {
    const nextUrl = URL.createObjectURL(file);
    setImageUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [file]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => setStageSize(stage.getBoundingClientRect().width);
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const clampOffset = useCallback((candidate: Point, nextZoom = zoom): Point => {
    if (!stageSize || !imageSize.width || !imageSize.height) return { x: 0, y: 0 };
    const baseScale = Math.max(stageSize / imageSize.width, stageSize / imageSize.height);
    const maxX = Math.max(0, (imageSize.width * baseScale * nextZoom - stageSize) / 2);
    const maxY = Math.max(0, (imageSize.height * baseScale * nextZoom - stageSize) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, candidate.x)),
      y: Math.max(-maxY, Math.min(maxY, candidate.y)),
    };
  }, [imageSize.height, imageSize.width, stageSize, zoom]);

  useEffect(() => setOffset((current) => clampOffset(current)), [clampOffset]);

  const resetCrop = () => {
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
    setError("");
  };

  const changeZoom = (nextZoom: number) => {
    setZoom(nextZoom);
    setOffset((current) => clampOffset(current, nextZoom));
  };

  const moveCrop = (delta: Point) => {
    setOffset((current) => clampOffset({ x: current.x + delta.x, y: current.y + delta.y }));
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (busy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    moveCrop({ x: event.clientX - drag.x, y: event.clientY - drag.y });
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };

  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const exportCrop = async () => {
    const image = imageRef.current;
    if (!image || !stageSize || !imageSize.width || !imageSize.height) return;
    setError("");
    try {
      const scale = Math.max(stageSize / imageSize.width, stageSize / imageSize.height) * zoom;
      const sourceSize = stageSize / scale;
      const sourceX = (imageSize.width - sourceSize) / 2 - offset.x / scale;
      const sourceY = (imageSize.height - sourceSize) / 2 - offset.y / scale;
      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("当前浏览器无法生成头像");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (result) => result ? resolve(result) : reject(new Error("头像生成失败")),
        "image/webp",
        0.9,
      ));
      const name = `${file.name.replace(/\.[^.]+$/, "") || "avatar"}-cropped.webp`;
      await onConfirm(new File([blob], name, { type: "image/webp", lastModified: Date.now() }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "头像生成失败，请重试");
    }
  };

  const baseScale = imageSize.width && imageSize.height && stageSize
    ? Math.max(stageSize / imageSize.width, stageSize / imageSize.height)
    : 0;
  const previewStyle = baseScale ? {
    width: imageSize.width * baseScale * zoom,
    height: imageSize.height * baseScale * zoom,
    transform: `translate3d(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px), 0)`,
  } : undefined;

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="avatar-crop-overlay" />
        <Dialog.Content className="avatar-crop-dialog" aria-describedby="avatar-crop-description">
          <header className="avatar-crop-header">
            <div><Dialog.Title>调整头像</Dialog.Title><Dialog.Description id="avatar-crop-description">拖动图片选择构图，圆形区域就是最终显示范围。</Dialog.Description></div>
            <Dialog.Close asChild><button type="button" disabled={busy} aria-label="关闭头像裁剪"><X size={17} /></button></Dialog.Close>
          </header>

          <div
            ref={stageRef}
            className="avatar-crop-stage"
            role="application"
            tabIndex={0}
            aria-label="头像裁剪区域，可拖动图片或使用方向键调整"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 16 : 4;
              const movement: Record<string, Point> = {
                ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 },
                ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step },
              };
              if (movement[event.key]) { event.preventDefault(); moveCrop(movement[event.key]); }
            }}
          >
            {imageUrl && <img
              ref={imageRef}
              src={imageUrl}
              alt=""
              draggable={false}
              style={previewStyle}
              onLoad={(event) => {
                setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
                setStageSize(stageRef.current?.getBoundingClientRect().width ?? 0);
                resetCrop();
              }}
              onError={() => setError("无法读取这张图片，请重新选择")}
            />}
            <span className="avatar-crop-grid" aria-hidden="true" />
            <span className="avatar-crop-ring" aria-hidden="true" />
            {!imageSize.width && !error && <span className="avatar-crop-loading"><LoaderCircle size={20} />正在读取图片…</span>}
          </div>

          <p className="avatar-crop-tip"><Move size={14} />拖动取景；聚焦裁剪区域后可用方向键微调，按住 Shift 可加速。</p>
          <div className="avatar-crop-zoom">
            <Minus size={14} aria-hidden="true" />
            <label><span>缩放</span><input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step="0.01" value={zoom} aria-label="头像缩放" onChange={(event) => changeZoom(Number(event.target.value))} /></label>
            <Plus size={14} aria-hidden="true" />
            <output aria-live="polite">{Math.round(zoom * 100)}%</output>
          </div>
          {error && <p className="avatar-crop-error" role="alert">{error}</p>}

          <footer className="avatar-crop-actions">
            <button type="button" className="is-quiet" disabled={busy} onClick={onChooseAnother}><ImagePlus size={15} />重选照片</button>
            <button type="button" className="is-quiet" disabled={busy} onClick={resetCrop}><RotateCcw size={14} />重置</button>
            <span />
            <button type="button" disabled={busy} onClick={onCancel}>取消</button>
            <button type="button" className="is-primary" disabled={busy || !imageSize.width} onClick={() => void exportCrop()}>{busy ? <LoaderCircle size={15} /> : <Camera size={15} />}{busy ? "保存中…" : "保存头像"}</button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
