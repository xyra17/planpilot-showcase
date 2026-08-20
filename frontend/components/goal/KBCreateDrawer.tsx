"use client";

import { useState, useRef } from "react";
import { X, BookOpen, Upload, Link, FileText, Plus } from "lucide-react";

export interface PendingKb {
  name: string;
  description: string;
  files: File[];
  urls: string[];
  note: string;
}

interface KBCreateDrawerProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (kb: PendingKb) => void;
}

export default function KBCreateDrawer({ open, onClose, onConfirm }: KBCreateDrawerProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [urls, setUrls] = useState<string[]>([]);
  const [urlInput, setUrlInput] = useState("");
  const [note, setNote] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setName(""); setDescription(""); setFiles([]); setUrls([]); setUrlInput(""); setNote("");
  }

  function handleConfirm() {
    if (!name.trim()) return;
    onConfirm({ name: name.trim(), description: description.trim(), files, urls, note });
    reset();
    onClose();
  }

  function handleClose() { reset(); onClose(); }

  function addUrl() {
    const t = urlInput.trim();
    if (!t || urls.includes(t)) return;
    setUrls((p) => [...p, t]);
    setUrlInput("");
  }

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/20" style={{ zIndex: 320 }} onClick={handleClose} />

      <div role="dialog" aria-modal="true" aria-label="新建知识库" className="journal-dialog fixed top-0 right-0 h-full w-96 bg-white shadow-2xl flex flex-col" style={{ zIndex: 321 }}>
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <BookOpen size={16} className="text-accent" />
            <span className="text-sm font-semibold text-gray-800">新建知识库</span>
          </div>
          <button type="button" onClick={handleClose} className="p-1 rounded-lg hover:bg-gray-100 transition text-gray-400">
            <X size={16} />
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* 基础信息 */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">
                知识库名称 <span className="text-red-400">*</span>
              </label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：Python 学习资料"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault())}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">描述（可选）</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="简单描述这个知识库的用途"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
              />
            </div>
          </div>

          <div className="border-t border-gray-100" />

          {/* 上传文件 */}
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Upload size={13} className="text-accent" />
              <span className="text-xs font-medium text-gray-700">上传文件</span>
              <span className="text-xs text-gray-400">（可选）</span>
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full border border-dashed border-gray-300 rounded-lg py-2.5 text-xs text-gray-500 hover:border-accent hover:text-accent transition"
            >
              点击选择文件（PDF、TXT、MD…）
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => setFiles((p) => [...p, ...Array.from(e.target.files ?? [])])}
            />
            {files.length > 0 && (
              <div className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 bg-gray-50 rounded-lg text-xs text-gray-700">
                    <span className="truncate flex-1">{f.name}</span>
                    <button type="button" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500">×</button>
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
              <span className="text-xs text-gray-400">（可选）</span>
            </div>
            <div className="flex gap-2">
              <input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addUrl())}
                placeholder="https://..."
                className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-xs outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
              />
              <button
                type="button"
                onClick={addUrl}
                disabled={!urlInput.trim()}
                className="px-3 py-1.5 bg-accent text-white rounded-lg hover:bg-accent-dark disabled:opacity-50 transition"
              >
                <Plus size={13} />
              </button>
            </div>
            {urls.length > 0 && (
              <div className="mt-2 space-y-1">
                {urls.map((u, i) => (
                  <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 bg-gray-50 rounded-lg text-xs">
                    <span className="truncate flex-1 text-accent">{u}</span>
                    <button type="button" onClick={() => setUrls((p) => p.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-500">×</button>
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
              <span className="text-xs text-gray-400">（可选）</span>
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="输入笔记内容…"
              rows={3}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-accent focus:border-transparent resize-none"
            />
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="px-5 py-4 border-t border-gray-100 flex gap-2">
          <button type="button" onClick={handleClose} className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 transition">
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!name.trim()}
            className="flex-1 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent-dark disabled:opacity-50 transition"
          >
            确认创建
          </button>
        </div>
      </div>
    </>
  );
}
