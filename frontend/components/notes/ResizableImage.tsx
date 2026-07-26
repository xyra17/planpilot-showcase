"use client";

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useCallback, useRef } from "react";

const MIN_WIDTH = 20;
const MAX_WIDTH = 100;

export default function ResizableImage({
  node,
  selected,
  updateAttributes,
}: NodeViewProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const width = Number(node.attrs.width) || 100;

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const container = wrapperRef.current?.parentElement;
      if (!container) return;

      const startX = event.clientX;
      const startWidth = width;
      const containerWidth = container.getBoundingClientRect().width;

      const handleMove = (moveEvent: PointerEvent) => {
        const deltaPercent = ((moveEvent.clientX - startX) / containerWidth) * 100;
        const nextWidth = Math.min(
          MAX_WIDTH,
          Math.max(MIN_WIDTH, Math.round(startWidth + deltaPercent))
        );
        updateAttributes({ width: nextWidth });
      };

      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [updateAttributes, width]
  );

  return (
    <NodeViewWrapper
      ref={wrapperRef}
      as="figure"
      className={`resizable-image group relative my-3 max-w-full rounded-lg ${
        selected ? "ring-2 ring-blue-500 ring-offset-2" : ""
      }`}
      style={{ width: `${width}%` }}
      data-drag-handle
    >
      <img
        src={node.attrs.src}
        alt={node.attrs.alt ?? ""}
        title={node.attrs.title ?? undefined}
        draggable={false}
        className="block h-auto max-h-[70vh] w-full rounded-lg object-contain bg-gray-50"
      />
      {selected && (
        <>
          <span className="image-size-label absolute left-2 top-2 rounded-md bg-gray-900/75 px-2 py-1 text-[11px] font-medium text-white">
            {width}%
          </span>
          <button
            type="button"
            aria-label="拖动调整图片大小"
            title="拖动调整图片大小"
            onPointerDown={startResize}
            className="image-resize-handle absolute -bottom-2 -right-2 h-5 w-5 cursor-nwse-resize rounded-full border-2 border-white bg-blue-500 shadow-md"
          />
        </>
      )}
    </NodeViewWrapper>
  );
}
