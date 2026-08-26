"use client";

import { useEffect, useRef, useState } from "react";

type PdfDocumentPreviewProps = {
  data: ArrayBuffer;
  name: string;
};

type PdfPage = {
  getViewport: (options: { scale: number }) => { width: number; height: number };
  render: (options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => { promise: Promise<void> };
};

type PdfDocument = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPage>;
  destroy: () => Promise<void>;
};

export function PdfDocumentPreview({ data, name }: PdfDocumentPreviewProps) {
  const [documentProxy, setDocumentProxy] = useState<PdfDocument | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [error, setError] = useState("");
  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const viewerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loadedDocument: PdfDocument | null = null;
    setDocumentProxy(null);
    setPageCount(0);
    setPage(1);
    setPageInput("1");
    setError("");

    void import("pdfjs-dist").then(async (pdfjs) => {
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
      const resolvedDocument = await loadingTask.promise as unknown as PdfDocument;
      loadedDocument = resolvedDocument;
      if (cancelled) {
        await loadedDocument.destroy();
        return;
      }
      setDocumentProxy(loadedDocument as unknown as PdfDocument);
      setPageCount(loadedDocument.numPages);
    }).catch((reason: unknown) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : "PDF 文档加载失败");
      }
    });

    return () => {
      cancelled = true;
      if (loadedDocument) void loadedDocument.destroy();
    };
  }, [data]);

  useEffect(() => {
    if (!documentProxy) return;
    let cancelled = false;

    const renderPages = async () => {
      for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
        const canvas = canvasRefs.current[pageNumber];
        if (!canvas || cancelled) continue;
        const pdfPage = await documentProxy.getPage(pageNumber);
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale });
        const deviceScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * deviceScale);
        canvas.height = Math.floor(viewport.height * deviceScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext("2d");
        if (!context) continue;
        context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
        await pdfPage.render({ canvasContext: context, viewport }).promise;
      }
    };

    void renderPages().catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "PDF 页面渲染失败");
    });
    return () => {
      cancelled = true;
    };
  }, [documentProxy, scale]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !pageCount) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      const pageNumber = visible?.target instanceof HTMLElement
        ? Number(visible.target.dataset.page)
        : 0;
      if (pageNumber) {
        setPage(pageNumber);
        setPageInput(String(pageNumber));
      }
    }, { root: viewer, threshold: [0.2, 0.6] });
    viewer.querySelectorAll<HTMLElement>("[data-page]").forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, [pageCount]);

  function goToPage(nextPage: number) {
    const target = Math.min(pageCount, Math.max(1, nextPage));
    setPage(target);
    setPageInput(String(target));
    viewerRef.current?.querySelector<HTMLElement>(`[data-page="${target}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <section className="pdf-preview-shell" aria-label={`${name} PDF 预览`}>
      <div className="pdf-preview-toolbar">
        <span className="pdf-preview-title" title={name}>{name}</span>
        <div className="pdf-preview-toolbar-group" aria-label="PDF 页面控制">
          <button type="button" onClick={() => goToPage(page - 1)} disabled={!pageCount || page <= 1} aria-label="上一页">‹</button>
          <label className="pdf-preview-page-control">
            <input
              aria-label="当前页"
              inputMode="numeric"
              value={pageCount ? pageInput : "—"}
              disabled={!pageCount}
              onChange={(event) => setPageInput(event.target.value.replace(/\D/g, ""))}
              onBlur={() => goToPage(Number(pageInput) || page)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <span>/ {pageCount || "—"}</span>
          </label>
          <button type="button" onClick={() => goToPage(page + 1)} disabled={!pageCount || page >= pageCount} aria-label="下一页">›</button>
          <span className="pdf-preview-divider" aria-hidden="true" />
          <button type="button" onClick={() => setScale((current) => Math.max(0.65, Number((current - 0.1).toFixed(2))))} disabled={!documentProxy} aria-label="缩小">−</button>
          <span className="pdf-preview-zoom">{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => setScale((current) => Math.min(2.5, Number((current + 0.1).toFixed(2))))} disabled={!documentProxy} aria-label="放大">＋</button>
        </div>
      </div>
      {error ? <div className="pdf-preview-error" role="alert">{error}</div> : null}
      {!error && !documentProxy ? <div className="pdf-preview-loading">正在加载 PDF…</div> : null}
      <div className="pdf-preview-viewer" ref={viewerRef}>
        {Array.from({ length: pageCount }, (_, index) => {
          const pageNumber = index + 1;
          return (
            <div className="pdf-preview-page" data-page={pageNumber} key={pageNumber}>
              <canvas ref={(canvas) => { canvasRefs.current[pageNumber] = canvas; }} aria-label={`第 ${pageNumber} 页`} />
            </div>
          );
        })}
      </div>
    </section>
  );
}
