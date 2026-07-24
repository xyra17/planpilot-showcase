"use client";

import { useState, useRef } from "react";
import { X, Upload, Link, FileText, Plus, Loader2, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";

interface KBFillModalProps {
  open: boolean;
  kbId: string;
  goalId: string;
  kbName: string;
  onDone: () => void;
}

export default function KBFillModal({ open, kbId, goalId, kbName, onDone }: KBFillModalProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [urls, setUrls] = useState<string[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [note, setNote] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  function addUrl() {
    const trimmed = urlInput.trim();
    if (!trimmed || urls.includes(trimmed)) return;
    setUrls((prev) => [...prev, trimmed]);
    setUrlInput("");
  }

  function handleFiles(newFiles: FileList | null) {
    if (!newFiles) return;
    setFiles((prev) => [...prev, ...Array.from(newFiles)]);
  }

  async function handleDone() {
    const hasContent = files.length > 0 || urls.length > 0 || note.trim();
    if (!hasContent) { onDone(); return; }

    setIsUploading(true);
    let done = 0;
    const total = files.length + urls.length + (note.trim() ? 1 : 0);

    try {
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        form.append("kb_id", kbId);
        try {
          await api.upload("/api/v1/knowledge/upload", form);
        } catch { /* non-blocking */ }
        done++;
        setDoneCount(done);
      }

      for (const url of urls) {
        try {
          await api.post("/api/v1/knowledge/url", { url, kb_id: kbId });
        } catch { /* non-blocking */ }
        done++;
        setDoneCount(done);
      }

      if (note.trim()) {
        try {
          await api.post("/api/v1/knowledge/notes", { goalId, content: note.trim() });
        } catch { /* non-blocking */ }
        done++;
        setDoneCount(done);
      }

      void total;
    } finally {
      setIsUploading(false);
      onDone();
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col max-h-[85vh]">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <p className="text-sm font-semibold text-gray-800">向知识库添加内容</p>
            <p className="text-xs text-gray-400 mt-0.5">「{kbName}」· 可选，稍后也可在知识库页面添加</p>
          </div>
          <button type="button" onClick={onDone} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* 上传文件 */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Upload size={13} className="text-blue-600" />
              <span className="text-xs font-medium text-gray-700">上传文件</span>
              <span className="text-xs text-gray-400">（PDF、TXT、MD、DOCX…）</span>
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full border border-dashed border-gray-300 rounded-lg py-3 text-xs text-gray-500 hover:border-blue-400 hover:text-blue-500 transition"
            >
              点击选择文件
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
            {files.length > 0 && (
              <div className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 bg-gray-50 rounded-lg text-xs text-gray-700">
                    <span className="truncate flex-1">{f.name}</span>
                    <button
                      type="button"
                      onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                      className="text-gray-300 hover:text-red-500 flex-shrink-0"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 添加网址 */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Link size={13} className="text-green-600" />
              <span className="text-xs font-medium text-gray-700">添加网址</span>
            </div>
            <div className="flex gap-2">
              <input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addUrl())}
                placeholder="https://..."
                className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <button
                type="button"
                onClick={addUrl}
                disabled={!urlInput.trim()}
                className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
              >
                <Plus size={13} />
              </button>
            </div>
            {urls.length > 0 && (
              <div className="mt-2 space-y-1">
                {urls.map((u, i) => (
                  <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 bg-gray-50 rounded-lg text-xs text-gray-700">
                    <span className="truncate flex-1 text-blue-600">{u}</span>
                    <button
                      type="button"
                      onClick={() => setUrls((prev) => prev.filter((_, j) => j !== i))}
                      className="text-gray-300 hover:text-red-500 flex-shrink-0"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 添加笔记 */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <FileText size={13} className="text-purple-600" />
              <span className="text-xs font-medium text-gray-700">添加笔记</span>
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="输入笔记内容…"
              rows={3}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            />
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="px-5 py-4 border-t border-gray-100 flex gap-2">
          <button
            type="button"
            onClick={onDone}
            disabled={isUploading}
            className="flex-1 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition"
          >
            跳过
          </button>
          <button
            type="button"
            onClick={handleDone}
            disabled={isUploading}
            className="flex-[2] py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition flex items-center justify-center gap-2"
          >
            {isUploading ? (
              <><Loader2 size={13} className="animate-spin" />{doneCount > 0 ? `已上传 ${doneCount} 项…` : "上传中…"}</>
            ) : (
              <><CheckCircle2 size={14} />完成并继续</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
