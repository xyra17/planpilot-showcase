"use client";

import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TextAlign from "@tiptap/extension-text-align";
import Color from "@tiptap/extension-color";
import { TextStyle } from "@tiptap/extension-text-style";
import { Extension } from "@tiptap/core";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { marked } from "marked";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import {
  Bold,
  CircleHelp,
  Check,
  CheckSquare2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Columns2,
  Eye,
  FileText,
  GripVertical,
  Heading1,
  Heading2,
  Highlighter,
  Italic,
  Lightbulb,
  List,
  ListOrdered,
  Minus,
  NotebookPen,
  Palette,
  Pilcrow,
  Quote,
  Redo2,
  Strikethrough,
  Underline as UnderlineIcon,
  Undo2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DocumentSourceEditor, type MarkdownSlashTrigger } from "@/components/technology/DocumentSourceEditor";
import { WorkspaceSkeleton } from "@/components/technology/WorkspaceSkeleton";

type DocumentFormat = "html" | "markdown" | "plain";

type NotionResourceEditorProps = {
  content: string;
  onChange: (content: string) => void;
  onTemplateApply?: (title: string) => void;
  documentFormat?: DocumentFormat;
  placeholder?: string;
  documentHeader?: ReactNode;
  toolbarEnd?: ReactNode;
  toolbarMount?: HTMLElement | null;
  showQuickStart?: boolean;
  onEditorModeChange?: (mode: EditorMode) => void;
};

type SlashMenuState = ({
  kind: "rich";
  from: number;
} | {
  kind: "markdown";
  apply: MarkdownSlashTrigger["apply"];
}) & {
  top: number;
  left: number;
};

type EditorMode = "rich" | "markdown" | "plain" | "split" | "preview";

type EditorModeOption = {
  value: EditorMode;
  label: string;
  hint: string;
  icon: LucideIcon;
  shortcut: string;
};

const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [{
      types: ["textStyle"],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: (element) => element.style.fontSize || null,
          renderHTML: (attributes) => attributes.fontSize ? { style: `font-size: ${attributes.fontSize}` } : {},
        },
      },
    }];
  },
});

const BlockIndent = Extension.create({
  name: "blockIndent",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading"],
      attributes: {
        indent: {
          default: 0,
          parseHTML: (element) => Number(element.getAttribute("data-indent") || 0),
          renderHTML: (attributes) => {
            const indent = Number(attributes.indent || 0);
            return indent > 0
              ? { "data-indent": indent, style: `margin-left: ${indent * 1.75}rem` }
              : {};
          },
        },
      },
    }];
  },
});

const turndown = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  headingStyle: "atx",
});

turndown.use(gfm);

turndown.addRule("highlight", {
  filter: "mark",
  replacement(content) {
    return `==${content}==`;
  },
});

function htmlToMarkdown(html: string) {
  return turndown.turndown(html || "<p></p>");
}

function markdownToHtml(markdown: string) {
  return marked.parse(markdown, { async: false, breaks: true, gfm: true }) as string;
}

function looksLikeMarkdown(value: string) {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~|[-*+]\s+\[[ xX]\]\s)|(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]]+\]\([^)]+\))/m.test(value);
}

function ToolbarButton({
  active = false,
  disabled = false,
  label,
  icon,
  onRun,
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  icon: ReactNode;
  onRun: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "is-active" : ""}
      disabled={disabled}
      aria-label={label}
      title={label}
      onMouseDown={(event) => {
        event.preventDefault();
        onRun();
      }}
    >
      {icon}
    </button>
  );
}

function RichTextToolbar({
  editor,
  end,
  endMount,
  mode,
  onModeChange,
  sourceFormat,
}: {
  editor: Editor;
  end?: ReactNode;
  endMount?: HTMLElement | null;
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  sourceFormat: DocumentFormat;
}) {
  const [, setSelectionVersion] = useState(0);
  const [styleMenuPosition, setStyleMenuPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const [fontSizeMenuPosition, setFontSizeMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [colorMenuPosition, setColorMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [highlightMenuPosition, setHighlightMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [viewSwitchCollapsed, setViewSwitchCollapsed] = useState(true);
  const viewSwitchRef = useRef<HTMLDivElement>(null);
  const styleTriggerRef = useRef<HTMLButtonElement>(null);
  const styleMenuRef = useRef<HTMLDivElement>(null);
  const fontSizeTriggerRef = useRef<HTMLButtonElement>(null);
  const fontSizeMenuRef = useRef<HTMLDivElement>(null);
  const colorTriggerRef = useRef<HTMLButtonElement>(null);
  const colorMenuRef = useRef<HTMLDivElement>(null);
  const highlightTriggerRef = useRef<HTMLButtonElement>(null);
  const highlightMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const refresh = () => setSelectionVersion((current) => current + 1);
    editor.on("selectionUpdate", refresh);
    editor.on("transaction", refresh);
    return () => {
      editor.off("selectionUpdate", refresh);
      editor.off("transaction", refresh);
    };
  }, [editor]);

  useEffect(() => {
    if (!styleMenuPosition && !fontSizeMenuPosition && !colorMenuPosition && !highlightMenuPosition) return;
    function closeStyleMenu(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      if (
        !styleTriggerRef.current?.contains(event.target)
        && !styleMenuRef.current?.contains(event.target)
        && !fontSizeTriggerRef.current?.contains(event.target)
        && !fontSizeMenuRef.current?.contains(event.target)
        && !colorTriggerRef.current?.contains(event.target)
        && !colorMenuRef.current?.contains(event.target)
        && !highlightTriggerRef.current?.contains(event.target)
        && !highlightMenuRef.current?.contains(event.target)
      ) {
        setStyleMenuPosition(null);
        setFontSizeMenuPosition(null);
        setColorMenuPosition(null);
        setHighlightMenuPosition(null);
      }
    }
    function closeStyleMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setStyleMenuPosition(null);
        setFontSizeMenuPosition(null);
        setColorMenuPosition(null);
        setHighlightMenuPosition(null);
      }
    }
    function closeStyleMenuOnViewportChange() {
      setStyleMenuPosition(null);
      setFontSizeMenuPosition(null);
      setColorMenuPosition(null);
      setHighlightMenuPosition(null);
    }
    function closeCompactMenusOnScroll() {
      setStyleMenuPosition(null);
      setFontSizeMenuPosition(null);
      setColorMenuPosition(null);
      setHighlightMenuPosition(null);
    }
    document.addEventListener("mousedown", closeStyleMenu);
    window.addEventListener("keydown", closeStyleMenuOnEscape);
    window.addEventListener("resize", closeStyleMenuOnViewportChange);
    window.addEventListener("scroll", closeCompactMenusOnScroll, true);
    return () => {
      document.removeEventListener("mousedown", closeStyleMenu);
      window.removeEventListener("keydown", closeStyleMenuOnEscape);
      window.removeEventListener("resize", closeStyleMenuOnViewportChange);
      window.removeEventListener("scroll", closeCompactMenusOnScroll, true);
    };
  }, [colorMenuPosition, fontSizeMenuPosition, highlightMenuPosition, styleMenuPosition]);

  useEffect(() => {
    function handleModeShortcuts(event: KeyboardEvent) {
      const commandKey = event.metaKey || event.ctrlKey;
      if (!commandKey) return;
      if (event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        setViewSwitchCollapsed((current) => !current);
        return;
      }
      if (!event.altKey) return;
      const shortcutMode = event.key === "1"
        ? sourceFormat === "markdown" ? "markdown" : sourceFormat === "plain" ? "plain" : "rich"
        : event.key === "2" ? sourceFormat === "plain" ? null : "markdown"
          : event.key === "3" ? sourceFormat === "plain" ? null : "split"
            : event.key === "4" ? sourceFormat === "plain" ? null : "preview" : null;
      if (!shortcutMode) return;
      event.preventDefault();
      onModeChange(shortcutMode);
      setViewSwitchCollapsed(true);
    }
    window.addEventListener("keydown", handleModeShortcuts);
    return () => window.removeEventListener("keydown", handleModeShortcuts);
  }, [onModeChange, sourceFormat]);

  useEffect(() => {
    if (viewSwitchCollapsed) return;
    function closeModeMenu(event: MouseEvent) {
      if (event.target instanceof Node && !viewSwitchRef.current?.contains(event.target)) {
        setViewSwitchCollapsed(true);
      }
    }
    function closeModeMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setViewSwitchCollapsed(true);
    }
    document.addEventListener("mousedown", closeModeMenu);
    window.addEventListener("keydown", closeModeMenuOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeModeMenu);
      window.removeEventListener("keydown", closeModeMenuOnEscape);
    };
  }, [viewSwitchCollapsed]);

  const textStyle = editor.isActive("heading", { level: 1 })
    ? "h1"
    : editor.isActive("heading", { level: 2 })
      ? "h2"
      : editor.isActive("heading", { level: 3 })
        ? "h3"
        : "paragraph";
  const styleOptions = [
    { value: "paragraph", label: "正文" },
    { value: "h1", label: "标题 1" },
    { value: "h2", label: "标题 2" },
    { value: "h3", label: "标题 3" },
  ];
  const currentStyleLabel = styleOptions.find((item) => item.value === textStyle)?.label ?? "正文";
  const fontSizeOptions = [
    { label: "默认", value: null },
    { label: "12", value: "12px" },
    { label: "14", value: "14px" },
    { label: "16", value: "16px" },
    { label: "18", value: "18px" },
    { label: "22", value: "22px" },
    { label: "28", value: "28px" },
  ];
  const currentFontSize = editor.getAttributes("textStyle").fontSize as string | undefined;
  const currentFontSizeLabel = currentFontSize?.replace("px", "") ?? "字号";
  const textColors = [
    { label: "默认文字", value: null, swatch: "var(--workspace-text)" },
    { label: "主题紫", value: "#6754d9", swatch: "#6754d9" },
    { label: "薄荷绿", value: "#278a72", swatch: "#278a72" },
    { label: "海蓝", value: "#3f72b8", swatch: "#3f72b8" },
    { label: "琥珀", value: "#a56a1f", swatch: "#a56a1f" },
    { label: "玫瑰", value: "#b34f68", swatch: "#b34f68" },
  ];
  const currentColor = editor.getAttributes("textStyle").color as string | undefined;
  const highlightColors = [
    { label: "柔和黄色", value: "#f8e79b" },
    { label: "薄荷绿色", value: "#bcebdc" },
    { label: "淡紫色", value: "#dcd3ff" },
    { label: "天空蓝色", value: "#cce3ff" },
    { label: "浅玫瑰色", value: "#f6ccd8" },
  ];
  const currentHighlight = editor.getAttributes("highlight").color as string | undefined;
  const modeOptions: EditorModeOption[] = sourceFormat === "plain" ? [
    { value: "plain" as const, label: "纯文本", hint: "原文编辑", icon: FileText, shortcut: "⌘⌥1" },
  ] : sourceFormat === "markdown" ? [
    { value: "markdown" as const, label: "Markdown", hint: "源码编辑", icon: Code2, shortcut: "⌘⌥1" },
    { value: "split" as const, label: "分栏", hint: "编辑与预览", icon: Columns2, shortcut: "⌘⌥3" },
    { value: "preview" as const, label: "预览", hint: "阅读效果", icon: Eye, shortcut: "⌘⌥4" },
  ] : [
    { value: "rich" as const, label: "编辑", hint: "富文本编辑", icon: FileText, shortcut: "⌘⌥1" },
    { value: "markdown" as const, label: "Markdown", hint: "源码编辑", icon: Code2, shortcut: "⌘⌥2" },
    { value: "split" as const, label: "分栏", hint: "编辑与预览", icon: Columns2, shortcut: "⌘⌥3" },
    { value: "preview" as const, label: "预览", hint: "阅读效果", icon: Eye, shortcut: "⌘⌥4" },
  ];
  const activeModeOption = modeOptions.find((item) => item.value === mode) ?? modeOptions[0];
  const ActiveModeIcon = activeModeOption.icon;
  const portalHost = typeof document !== "undefined"
    ? document.querySelector<HTMLElement>(".app-shell") ?? document.body
    : null;

  function applyTextStyle(value: string) {
    if (value === "paragraph") editor.chain().focus().setParagraph().run();
    if (value === "h1") editor.chain().focus().toggleHeading({ level: 1 }).run();
    if (value === "h2") editor.chain().focus().toggleHeading({ level: 2 }).run();
    if (value === "h3") editor.chain().focus().toggleHeading({ level: 3 }).run();
    setStyleMenuPosition(null);
  }

  function toggleStyleMenu() {
    setFontSizeMenuPosition(null);
    setColorMenuPosition(null);
    setHighlightMenuPosition(null);
    if (styleMenuPosition) {
      setStyleMenuPosition(null);
      return;
    }
    const bounds = styleTriggerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setStyleMenuPosition({ top: bounds.bottom + 6, left: bounds.left, width: Math.max(132, bounds.width) });
  }

  function toggleFontSizeMenu() {
    setStyleMenuPosition(null);
    setColorMenuPosition(null);
    setHighlightMenuPosition(null);
    if (fontSizeMenuPosition) {
      setFontSizeMenuPosition(null);
      return;
    }
    const bounds = fontSizeTriggerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setFontSizeMenuPosition({ top: bounds.bottom + 6, left: Math.max(12, bounds.left - 18) });
  }

  function applyFontSize(value: string | null) {
    editor.chain().focus().setMark("textStyle", { fontSize: value }).removeEmptyTextStyle().run();
    setFontSizeMenuPosition(null);
  }

  function toggleColorMenu() {
    setStyleMenuPosition(null);
    setHighlightMenuPosition(null);
    if (colorMenuPosition) {
      setColorMenuPosition(null);
      return;
    }
    const bounds = colorTriggerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setColorMenuPosition({ top: bounds.bottom + 6, left: Math.max(12, bounds.left - 72) });
  }

  function applyTextColor(color: string | null) {
    if (color) editor.chain().focus().setColor(color).run();
    else editor.chain().focus().unsetColor().run();
    setColorMenuPosition(null);
  }

  function toggleHighlightMenu() {
    setStyleMenuPosition(null);
    setColorMenuPosition(null);
    if (highlightMenuPosition) {
      setHighlightMenuPosition(null);
      return;
    }
    const bounds = highlightTriggerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setHighlightMenuPosition({ top: bounds.bottom + 6, left: Math.max(12, bounds.left - 76) });
  }

  function applyHighlight(color: string | null) {
    if (color) editor.chain().focus().setHighlight({ color }).run();
    else editor.chain().focus().unsetHighlight().run();
    setHighlightMenuPosition(null);
  }

  const toolbarEnd = (
    <div className="notion-toolbar-end">
      <div ref={viewSwitchRef} className={`notion-view-switch ${viewSwitchCollapsed ? "is-collapsed" : ""}`} aria-label="文档编辑模式">
        <button
          type="button"
          className="notion-view-switch-summary"
          aria-label={modeOptions.length === 1 ? "当前为纯文本编辑" : viewSwitchCollapsed ? "展开编辑模式" : "收起编辑模式"}
          aria-expanded={!viewSwitchCollapsed}
          aria-haspopup={modeOptions.length > 1 ? "true" : undefined}
          aria-keyshortcuts="Meta+Shift+M Control+Shift+M"
          title={modeOptions.length === 1 ? "纯文本资料按原格式编辑" : `${viewSwitchCollapsed ? "展开" : "收起"}编辑模式（⌘⇧M）`}
          onClick={() => {
            if (modeOptions.length > 1) setViewSwitchCollapsed((current) => !current);
          }}
        >
          <ActiveModeIcon size={13} aria-hidden="true" />
          <span>{activeModeOption.label}</span>
          {modeOptions.length > 1 && <ChevronDown className="notion-view-switch-chevron" size={12} aria-hidden="true" />}
        </button>
        {modeOptions.length > 1 && !viewSwitchCollapsed && (
          <div className="notion-view-switch-menu" role="tablist" aria-label="切换文档编辑模式">
            {modeOptions.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  type="button"
                  role="tab"
                  aria-label={item.label}
                  aria-selected={mode === item.value}
                  className={mode === item.value ? "is-active" : ""}
                  key={item.value}
                  title={`${item.label}（${item.shortcut}）`}
                  onClick={() => {
                    onModeChange(item.value);
                    setViewSwitchCollapsed(true);
                  }}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span><strong>{item.label}</strong><small>{item.hint}</small></span>
                  {mode === item.value && <Check size={13} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {end}
    </div>
  );

  return (
    <>
      <div className={`notion-editor-toolbar is-${mode} ${endMount ? "is-end-portaled" : ""}`} aria-label="正文格式工具栏">
      <div className="notion-toolbar-scroll">
        {mode === "rich" ? (
          <div className="notion-rich-controls">
        <div className="notion-toolbar-group">
          <ToolbarButton label="撤销" disabled={!editor.can().undo()} icon={<Undo2 size={15} />} onRun={() => editor.chain().focus().undo().run()} />
          <ToolbarButton label="重做" disabled={!editor.can().redo()} icon={<Redo2 size={15} />} onRun={() => editor.chain().focus().redo().run()} />
        </div>
        <span className="notion-toolbar-divider is-format-edge" />
        <div className="notion-format-selectors">
          <button
            ref={styleTriggerRef}
            type="button"
            className="notion-style-trigger"
            aria-label="文本样式"
            aria-haspopup="listbox"
            aria-expanded={Boolean(styleMenuPosition)}
            title="文本样式"
            onClick={toggleStyleMenu}
          >
            <span>{currentStyleLabel}</span><ChevronDown size={14} aria-hidden="true" />
          </button>
          <span className="notion-toolbar-divider is-format-inner" />
          <button
            ref={fontSizeTriggerRef}
            type="button"
            className="notion-font-size-trigger"
            aria-label="字号"
            aria-haspopup="listbox"
            aria-expanded={Boolean(fontSizeMenuPosition)}
            title="字号"
            onClick={toggleFontSizeMenu}
          >
            <span>{currentFontSizeLabel}</span><ChevronDown size={12} aria-hidden="true" />
          </button>
        </div>
        <span className="notion-toolbar-divider is-format-edge" />
        <div className="notion-toolbar-group">
          <ToolbarButton label="粗体" active={editor.isActive("bold")} icon={<Bold size={15} />} onRun={() => editor.chain().focus().toggleBold().run()} />
          <ToolbarButton label="斜体" active={editor.isActive("italic")} icon={<Italic size={15} />} onRun={() => editor.chain().focus().toggleItalic().run()} />
          <ToolbarButton label="下划线" active={editor.isActive("underline")} icon={<UnderlineIcon size={15} />} onRun={() => editor.chain().focus().toggleUnderline().run()} />
          <ToolbarButton label="删除线" active={editor.isActive("strike")} icon={<Strikethrough size={15} />} onRun={() => editor.chain().focus().toggleStrike().run()} />
          <button
            ref={highlightTriggerRef}
            type="button"
            className={`notion-highlight-trigger ${editor.isActive("highlight") ? "is-active" : ""}`}
            aria-label="高亮颜色"
            aria-haspopup="listbox"
            aria-expanded={Boolean(highlightMenuPosition)}
            title="选择高亮颜色"
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleHighlightMenu}
          >
            <Highlighter size={15} aria-hidden="true" />
            <i style={{ background: currentHighlight || "#f8e79b" }} aria-hidden="true" />
          </button>
          <button
            ref={colorTriggerRef}
            type="button"
            className="notion-color-trigger"
            aria-label="文字颜色"
            aria-haspopup="listbox"
            aria-expanded={Boolean(colorMenuPosition)}
            title="文字颜色"
            onMouseDown={(event) => {
              event.preventDefault();
              window.requestAnimationFrame(toggleColorMenu);
            }}
            onClick={(event) => {
              if (event.detail === 0) toggleColorMenu();
            }}
          >
            <Palette size={15} aria-hidden="true" />
            <i style={{ background: currentColor || "var(--notes-text)" }} aria-hidden="true" />
          </button>
        </div>
        <span className="notion-toolbar-divider" />
        <div className="notion-toolbar-group">
          <ToolbarButton label="项目列表" active={editor.isActive("bulletList")} icon={<List size={15} />} onRun={() => editor.chain().focus().toggleBulletList().run()} />
          <ToolbarButton label="编号列表" active={editor.isActive("orderedList")} icon={<ListOrdered size={15} />} onRun={() => editor.chain().focus().toggleOrderedList().run()} />
          <ToolbarButton label="待办列表" active={editor.isActive("taskList")} icon={<CheckSquare2 size={15} />} onRun={() => editor.chain().focus().toggleTaskList().run()} />
          <ToolbarButton label="引用" active={editor.isActive("blockquote")} icon={<Quote size={15} />} onRun={() => editor.chain().focus().toggleBlockquote().run()} />
        </div>
          </div>
        ) : null}
      </div>
      {!endMount && toolbarEnd}
      </div>
      {endMount && createPortal(toolbarEnd, endMount)}
      {styleMenuPosition && portalHost && createPortal(
        <div
          ref={styleMenuRef}
          className="notion-style-menu"
          role="listbox"
          aria-label="选择文本样式"
          style={{ top: styleMenuPosition.top, left: styleMenuPosition.left, minWidth: styleMenuPosition.width }}
        >
          {styleOptions.map((item) => (
            <button
              type="button"
              role="option"
              aria-selected={item.value === textStyle}
              className={item.value === textStyle ? "is-selected" : ""}
              key={item.value}
              onClick={() => applyTextStyle(item.value)}
            >
              <Check size={14} aria-hidden="true" /><span>{item.label}</span>
            </button>
          ))}
        </div>,
        portalHost,
      )}
      {fontSizeMenuPosition && portalHost && createPortal(
        <div
          ref={fontSizeMenuRef}
          className="notion-font-size-menu"
          role="listbox"
          aria-label="选择字号"
          style={{ top: fontSizeMenuPosition.top, left: fontSizeMenuPosition.left }}
        >
          {fontSizeOptions.map((item) => {
            const selected = item.value ? currentFontSize === item.value : !currentFontSize;
            return (
              <button
                type="button"
                role="option"
                aria-selected={selected}
                className={selected ? "is-selected" : ""}
                key={item.label}
                onClick={() => applyFontSize(item.value)}
              >
                <span style={{ fontSize: item.value ?? "14px" }}>Aa</span>
                <strong>{item.label}{item.value ? " px" : "字号"}</strong>
                {selected && <Check size={12} aria-hidden="true" />}
              </button>
            );
          })}
        </div>,
        portalHost,
      )}
      {colorMenuPosition && portalHost && createPortal(
        <div
          ref={colorMenuRef}
          className="notion-color-menu"
          role="listbox"
          aria-label="选择文字颜色"
          style={{ top: colorMenuPosition.top, left: colorMenuPosition.left }}
        >
          <strong>文字颜色</strong>
          <div>
            {textColors.map((item) => {
              const selected = item.value ? currentColor === item.value : !currentColor;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-label={item.label}
                  title={item.label}
                  className={selected ? "is-selected" : ""}
                  key={item.label}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyTextColor(item.value)}
                >
                  <span style={{ background: item.swatch }} aria-hidden="true" />
                  <small>{item.label}</small>
                  {selected && <Check size={12} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>,
        portalHost,
      )}
      {highlightMenuPosition && portalHost && createPortal(
        <div
          ref={highlightMenuRef}
          className="notion-highlight-menu"
          role="listbox"
          aria-label="选择高亮颜色"
          style={{ top: highlightMenuPosition.top, left: highlightMenuPosition.left }}
        >
          <strong>高亮颜色</strong>
          <div>
            {highlightColors.map((item) => (
              <button
                type="button"
                role="option"
                aria-selected={currentHighlight === item.value}
                key={item.value}
                title={item.label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyHighlight(item.value)}
              >
                <span style={{ background: item.value }} aria-hidden="true" />
                <small>{item.label}</small>
                {currentHighlight === item.value && <Check size={12} aria-hidden="true" />}
              </button>
            ))}
            <button type="button" role="option" aria-selected={!currentHighlight} onMouseDown={(event) => event.preventDefault()} onClick={() => applyHighlight(null)}>
              <span className="is-clear" aria-hidden="true" />
              <small>清除高亮</small>
              {!currentHighlight && <Check size={12} aria-hidden="true" />}
            </button>
          </div>
        </div>,
        portalHost,
      )}
    </>
  );
}

const SLASH_ITEMS = [
  { label: "正文", hint: "普通文本块", icon: Pilcrow, run: (editor: Editor) => editor.chain().focus().setParagraph().run() },
  { label: "标题 1", hint: "页面主章节", icon: Heading1, run: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 1 }).run() },
  { label: "标题 2", hint: "内容小节", icon: Heading2, run: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 2 }).run() },
  { label: "项目列表", hint: "无序列出要点", icon: List, run: (editor: Editor) => editor.chain().focus().toggleBulletList().run() },
  { label: "待办列表", hint: "可勾选的任务", icon: CheckSquare2, run: (editor: Editor) => editor.chain().focus().toggleTaskList().run() },
  { label: "引用", hint: "突出一段观点", icon: Quote, run: (editor: Editor) => editor.chain().focus().toggleBlockquote().run() },
  { label: "分割线", hint: "分隔内容区域", icon: Minus, run: (editor: Editor) => editor.chain().focus().setHorizontalRule().run() },
];

const MARKDOWN_SLASH_ITEMS = [
  { label: "一级标题", hint: "插入 # 标题", icon: Heading1, markdown: "# ", cursorOffset: 2 },
  { label: "二级标题", hint: "插入 ## 标题", icon: Heading2, markdown: "## ", cursorOffset: 3 },
  { label: "项目列表", hint: "插入无序列表", icon: List, markdown: "- ", cursorOffset: 2 },
  { label: "编号列表", hint: "插入有序列表", icon: ListOrdered, markdown: "1. ", cursorOffset: 3 },
  { label: "待办事项", hint: "插入可勾选任务", icon: CheckSquare2, markdown: "- [ ] ", cursorOffset: 6 },
  { label: "引用", hint: "插入引用块", icon: Quote, markdown: "> ", cursorOffset: 2 },
  { label: "代码块", hint: "插入围栏代码块", icon: Code2, markdown: "```\n\n```", cursorOffset: 4 },
  { label: "分割线", hint: "插入章节分隔线", icon: Minus, markdown: "---\n", cursorOffset: 4 },
] as const;

export default function NotionResourceEditor({
  content,
  onChange,
  onTemplateApply,
  documentFormat = "html",
  placeholder = "写下你的想法",
  documentHeader,
  toolbarEnd,
  toolbarMount,
  showQuickStart = true,
  onEditorModeChange,
}: NotionResourceEditorProps) {
  const editorRootRef = useRef<HTMLDivElement>(null);
  const editorBodyRef = useRef<HTMLDivElement>(null);
  const quickStartRef = useRef<HTMLElement>(null);
  const quickStartDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const quickStartManuallyPositionedRef = useRef(false);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const suppressUpdateRef = useRef(false);
  const documentFormatRef = useRef(documentFormat);
  documentFormatRef.current = documentFormat;
  const [footerHost, setFooterHost] = useState<HTMLElement | null>(null);
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>(documentFormat === "markdown" ? "markdown" : documentFormat === "plain" ? "plain" : "rich");
  const [markdownSource, setMarkdownSource] = useState(() => documentFormat === "html" ? htmlToMarkdown(content) : content);
  const [isEditorEmpty, setIsEditorEmpty] = useState(() => documentFormat === "html" ? !htmlToMarkdown(content).trim() : !content.trim());
  const [quickStartCollapsed, setQuickStartCollapsed] = useState(false);
  const [quickStartDragging, setQuickStartDragging] = useState(false);
  const [quickStartPosition, setQuickStartPosition] = useState({ x: 30, y: 26 });
  const wasEditorEmptyRef = useRef(true);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ link: false }),
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: "https" }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      TableKit.configure({ table: { resizable: true } }),
      Image.configure({ allowBase64: true, HTMLAttributes: { class: "notion-document-image" } }),
      Placeholder.configure({ placeholder }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight.configure({ multicolor: true }),
      TextStyle,
      FontSize,
      BlockIndent,
      Color,
    ],
    content: documentFormat === "html" ? content || "<p></p>" : "<p></p>",
    onUpdate: ({ editor: currentEditor }) => {
      setIsEditorEmpty(currentEditor.isEmpty);
      if (!suppressUpdateRef.current) {
        onChange(documentFormatRef.current === "markdown" ? htmlToMarkdown(currentEditor.getHTML()) : currentEditor.getHTML());
      }
    },
    editorProps: {
      attributes: {
        class: "notion-prosemirror",
        "aria-label": "资料正文",
        spellcheck: "false",
      },
      handleKeyDown(view, event) {
        if (event.key === "Escape") {
          setSlashMenu(null);
          return false;
        }
        if (event.key !== "/" || event.ctrlKey || event.metaKey || !view.state.selection.empty) return false;
        const { $from } = view.state.selection;
        if ($from.parentOffset !== 0) return false;
        const from = view.state.selection.from;
        window.requestAnimationFrame(() => {
          const rootRect = editorRootRef.current?.getBoundingClientRect();
          if (!rootRect) return;
          const caret = view.coordsAtPos(Math.min(from + 1, view.state.doc.content.size));
          setSlashMenu({
            kind: "rich",
            from,
            top: caret.bottom - rootRect.top + 8,
            left: Math.max(12, Math.min(caret.left - rootRect.left, rootRect.width - 260)),
          });
        });
        return false;
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (documentFormat !== "html") {
      setMarkdownSource(content);
      setIsEditorEmpty(!content.trim());
      return;
    }
    const editorContent = content || "<p></p>";
    if (editorContent === editor.getHTML()) return;
    suppressUpdateRef.current = true;
    editor.commands.setContent(editorContent);
    suppressUpdateRef.current = false;
    setMarkdownSource(htmlToMarkdown(content));
    setIsEditorEmpty(editor.isEmpty);
  }, [content, documentFormat, editor]);

  useEffect(() => {
    setEditorMode(documentFormat === "markdown" ? "markdown" : documentFormat === "plain" ? "plain" : "rich");
    setSlashMenu(null);
  }, [documentFormat]);

  useEffect(() => {
    if (wasEditorEmptyRef.current && !isEditorEmpty) setQuickStartCollapsed(true);
    if (!wasEditorEmptyRef.current && isEditorEmpty) setQuickStartCollapsed(false);
    wasEditorEmptyRef.current = isEditorEmpty;
  }, [isEditorEmpty]);

  useEffect(() => {
    if (editorMode !== "rich") return;

    function keepQuickStartInView() {
      const body = editorBodyRef.current?.getBoundingClientRect();
      const shell = editorRootRef.current?.closest<HTMLElement>(".note-editor")?.getBoundingClientRect();
      const launcher = quickStartRef.current?.getBoundingClientRect();
      if (!body || !shell || !launcher) return;

      const minX = shell.left - body.left + 8;
      const minY = shell.top - body.top + 8;
      const maxX = Math.max(minX, shell.right - body.left - launcher.width - 8);
      const maxY = Math.max(minY, shell.bottom - body.top - launcher.height - 8);
      setQuickStartPosition((current) => {
        if (quickStartCollapsed && !quickStartManuallyPositionedRef.current) {
          const safeCollapsedY = Math.min(maxY, Math.max(minY, 76));
          return current.x === maxX && current.y === safeCollapsedY
            ? current
            : { x: maxX, y: safeCollapsedY };
        }
        const next = {
          x: Math.min(maxX, Math.max(minX, current.x)),
          y: Math.min(maxY, Math.max(minY, current.y)),
        };
        return next.x === current.x && next.y === current.y ? current : next;
      });
    }

    const frame = window.requestAnimationFrame(keepQuickStartInView);
    window.addEventListener("resize", keepQuickStartInView);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", keepQuickStartInView);
    };
  }, [editorMode, quickStartCollapsed]);

  useEffect(() => {
    if (!slashMenu) return;
    function closeSlashMenu(event: MouseEvent) {
      if (event.target instanceof Node && !slashMenuRef.current?.contains(event.target)) setSlashMenu(null);
    }
    document.addEventListener("mousedown", closeSlashMenu);
    return () => document.removeEventListener("mousedown", closeSlashMenu);
  }, [slashMenu]);

  useEffect(() => {
    // Keep the status badge anchored to the editor viewport rather than the
    // growing document. The document canvas scrolls; the editor shell does not.
    setFooterHost(editorRootRef.current?.closest<HTMLElement>(".note-editor") ?? null);
  }, [editor]);

  const openMarkdownSlashMenu = useCallback((trigger: MarkdownSlashTrigger) => {
    const rootRect = editorRootRef.current?.getBoundingClientRect();
    if (!rootRect) return;
    setSlashMenu({
      kind: "markdown",
      top: trigger.top - rootRect.top + 6,
      left: Math.max(12, Math.min(trigger.left - rootRect.left, rootRect.width - 270)),
      apply: trigger.apply,
    });
  }, []);

  if (!editor) return <WorkspaceSkeleton variant="editor" label="正在准备编辑器" />;
  const activeEditor = editor;

  function runSlashItem(item: (typeof SLASH_ITEMS)[number]) {
    if (!slashMenu || slashMenu.kind !== "rich") return;
    const to = editor?.state.selection.from ?? slashMenu.from;
    editor?.chain().focus().deleteRange({ from: slashMenu.from, to }).run();
    if (editor) item.run(editor);
    setSlashMenu(null);
  }

  function runMarkdownSlashItem(item: (typeof MARKDOWN_SLASH_ITEMS)[number]) {
    if (!slashMenu || slashMenu.kind !== "markdown") return;
    slashMenu.apply(item.markdown, item.cursorOffset);
    setSlashMenu(null);
  }

  function changeEditorMode(nextMode: EditorMode) {
    if (documentFormat === "plain") {
      setEditorMode("plain");
      onEditorModeChange?.("plain");
      setSlashMenu(null);
      return;
    }
    if (documentFormat === "markdown") {
      const resolvedMode = nextMode === "preview" || nextMode === "split" ? nextMode : "markdown";
      setEditorMode(resolvedMode);
      onEditorModeChange?.(resolvedMode);
      setSlashMenu(null);
      return;
    }
    if (nextMode !== "rich") setMarkdownSource(htmlToMarkdown(activeEditor.getHTML()));
    setEditorMode(nextMode);
    onEditorModeChange?.(nextMode);
    setSlashMenu(null);
  }

  function updateMarkdown(value: string) {
    setMarkdownSource(value);
    if (documentFormat !== "html") {
      setIsEditorEmpty(!value.trim());
      onChange(value);
      return;
    }
    const html = markdownToHtml(value);
    suppressUpdateRef.current = true;
    activeEditor.commands.setContent(html || "<p></p>");
    suppressUpdateRef.current = false;
    setIsEditorEmpty(activeEditor.isEmpty);
    onChange(activeEditor.getHTML());
  }

  function handleMarkdownPaste(event: ClipboardEvent<HTMLDivElement>) {
    const value = event.clipboardData.getData("text/plain");
    if (!value || !looksLikeMarkdown(value)) return;
    event.preventDefault();
    activeEditor.chain().focus().insertContent(markdownToHtml(value)).run();
  }

  function moveQuickStart(clientX: number, clientY: number) {
    const drag = quickStartDragRef.current;
    const body = editorBodyRef.current?.getBoundingClientRect();
    const shell = editorRootRef.current?.closest<HTMLElement>(".note-editor")?.getBoundingClientRect();
    const launcher = quickStartRef.current?.getBoundingClientRect();
    if (!drag || !body || !shell || !launcher) return;

    const minX = shell.left - body.left + 8;
    const minY = shell.top - body.top + 8;
    const maxX = Math.max(minX, shell.right - body.left - launcher.width - 8);
    const maxY = Math.max(minY, shell.bottom - body.top - launcher.height - 8);
    setQuickStartPosition({
      x: Math.min(maxX, Math.max(minX, drag.originX + clientX - drag.startX)),
      y: Math.min(maxY, Math.max(minY, drag.originY + clientY - drag.startY)),
    });
  }

  const quickStarts = [
    {
      label: "记录今日学习",
      title: "今日学习记录",
      hint: "留下收获与下一步",
      icon: NotebookPen,
      content: '<blockquote><p>用几分钟收拢今天的收获、卡点和下一步。</p></blockquote><h3><span style="color: var(--notes-accent)">01</span> 今天真正学会了什么</h3><p><em>用自己的话写下最重要的一条收获。</em></p><p></p><h3><span style="color: var(--notes-accent)">02</span> 还有哪里没想清楚</h3><p><em>记录仍然模糊、容易出错或需要继续验证的地方。</em></p><p></p><h3><span style="color: var(--notes-accent)">03</span> 下一步行动</h3><p><em>写下一件足够具体、下次可以直接开始的事。</em></p><p></p>',
    },
    {
      label: "整理一个概念",
      title: "概念拆解",
      hint: "用自己的话讲清楚",
      icon: Lightbulb,
      content: '<blockquote><p>不要照抄定义，试着把它讲给一个刚接触的人听。</p></blockquote><h3><span style="color: var(--notes-accent)">01</span> 一句话解释</h3><p><em>它解决什么问题？核心机制是什么？</em></p><p></p><h3><span style="color: var(--notes-accent)">02</span> 一个具体例子</h3><p><em>用真实情境、题目或代码说明它如何工作。</em></p><p></p><h3><span style="color: var(--notes-accent)">03</span> 边界与易混点</h3><p><em>它不是什么？最容易与哪个概念混淆？</em></p><p></p><h3><span style="color: var(--notes-accent)">04</span> 如何验证我真的懂了</h3><p><em>设计一个问题，或尝试不看资料重新解释一次。</em></p><p></p>',
    },
    {
      label: "记录一个疑问",
      title: "疑问追踪",
      hint: "先把卡住的地方说出来",
      icon: CircleHelp,
      content: '<blockquote><p>把模糊的“不会”变成一个可以查证的具体问题。</p></blockquote><h3><span style="color: var(--notes-accent)">01</span> 我具体卡在哪里</h3><p><em>写出发生困难的步骤、条件或那一句没看懂的话。</em></p><p></p><h3><span style="color: var(--notes-accent)">02</span> 已经确认的信息</h3><p><em>列出事实，避免从头重复排查。</em></p><p></p><h3><span style="color: var(--notes-accent)">03</span> 我的猜测</h3><p><em>先写一个可能的原因，不要求立刻正确。</em></p><p></p><h3><span style="color: var(--notes-accent)">04</span> 下一次验证</h3><p><em>准备查哪份资料、问什么问题或做哪个小实验？</em></p><p></p>',
    },
  ];

  return (
    <div className="notion-resource-editor" ref={editorRootRef}>
      <RichTextToolbar
        editor={editor}
        end={toolbarEnd}
        endMount={toolbarMount}
        mode={editorMode}
        onModeChange={changeEditorMode}
        sourceFormat={documentFormat}
      />
      {documentHeader}
      <div className={`notion-editor-body is-${editorMode}`} ref={editorBodyRef}>
        {editorMode === "rich" && (
          <EditorContent editor={editor} className="notion-editor-content" onPasteCapture={handleMarkdownPaste} />
        )}
        {(editorMode === "markdown" || editorMode === "plain") && (
          <section className={`notion-markdown-source is-${editorMode}`} aria-label={editorMode === "plain" ? "纯文本编辑器" : "Markdown 编辑器"}>
            <DocumentSourceEditor
              value={markdownSource}
              format={editorMode === "plain" ? "plain" : "markdown"}
              label={editorMode === "plain" ? "纯文本原文" : "Markdown 源码"}
              onChange={updateMarkdown}
              onSlashDismiss={() => setSlashMenu(null)}
              onSlashTrigger={openMarkdownSlashMenu}
              placeholder={editorMode === "plain" ? "从这里开始编辑纯文本…" : "# 标题\n\n从这里开始写 Markdown…"}
            />
          </section>
        )}
        {editorMode === "split" && (
          <div className="notion-markdown-split" aria-label="Markdown 分栏编辑">
            <section className="notion-markdown-source" aria-label="Markdown 编辑区">
              <DocumentSourceEditor
                value={markdownSource}
                format="markdown"
                label="Markdown 源码"
                onChange={updateMarkdown}
                onSlashDismiss={() => setSlashMenu(null)}
                onSlashTrigger={openMarkdownSlashMenu}
                placeholder="# 标题\n\n从这里开始写 Markdown…"
              />
            </section>
            <section className="notion-markdown-preview" aria-label="Markdown 实时预览">
              <div className="notion-markdown-preview-content">
                {markdownSource.trim() ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdownSource}</ReactMarkdown>
                ) : (
                  <p className="is-empty">输入 Markdown 后，这里会同步显示阅读效果。</p>
                )}
              </div>
            </section>
          </div>
        )}
        {editorMode === "preview" && (
          <div className="notion-markdown-preview" aria-label="Markdown 预览">
            <div className="notion-markdown-preview-content">
              {markdownSource.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdownSource}</ReactMarkdown>
              ) : (
                <p className="is-empty">还没有可预览的内容。</p>
              )}
            </div>
          </div>
        )}
        {showQuickStart && documentFormat === "html" && editorMode === "rich" && isEditorEmpty && (
          <section
            ref={quickStartRef}
            className={`notion-quick-start ${quickStartCollapsed ? "is-collapsed" : ""}`}
            aria-label="快速开始笔记"
            data-dragging={quickStartDragging || undefined}
            style={{ left: quickStartPosition.x, top: quickStartPosition.y }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuickStartCollapsed(true);
            }}
          >
            <button
              type="button"
              className="notion-quick-start-drag"
              aria-label="拖动快速开始"
              title="拖动位置"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                quickStartDragRef.current = {
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  originX: quickStartPosition.x,
                  originY: quickStartPosition.y,
                };
                setQuickStartDragging(true);
              }}
              onPointerMove={(event) => {
                if (quickStartDragRef.current?.pointerId !== event.pointerId) return;
                quickStartManuallyPositionedRef.current = true;
                moveQuickStart(event.clientX, event.clientY);
              }}
              onPointerUp={(event) => {
                if (quickStartDragRef.current?.pointerId !== event.pointerId) return;
                quickStartDragRef.current = null;
                setQuickStartDragging(false);
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                quickStartDragRef.current = null;
                setQuickStartDragging(false);
              }}
            >
              <GripVertical size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="notion-quick-start-toggle"
              aria-label={quickStartCollapsed ? "展开快速开始" : "收起快速开始"}
              aria-expanded={!quickStartCollapsed}
              aria-controls="notion-quick-start-actions"
              title={`${quickStartCollapsed ? "展开" : "收起"}快速开始`}
              onClick={() => setQuickStartCollapsed((current) => !current)}
            >
              <span className="notion-quick-start-label">快速开始</span>
              {quickStartCollapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronLeft size={13} aria-hidden="true" />}
            </button>
            <div
              id="notion-quick-start-actions"
              className="notion-quick-start-actions"
              aria-hidden={quickStartCollapsed || undefined}
            >
              {quickStarts.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    type="button"
                    key={item.label}
                    title={item.hint}
                    tabIndex={quickStartCollapsed ? -1 : 0}
                    onClick={() => {
                      if (editor.isEmpty) {
                        editor.commands.setContent(item.content);
                        setIsEditorEmpty(false);
                        onChange(editor.getHTML());
                        onTemplateApply?.(item.title);
                        window.requestAnimationFrame(() => {
                          let firstBlankParagraphPosition = 1;
                          let foundBlankParagraph = false;
                          editor.state.doc.descendants((node, position) => {
                            if (foundBlankParagraph) return false;
                            if (node.type.name !== "paragraph" || node.content.size !== 0) return true;
                            firstBlankParagraphPosition = position + 1;
                            foundBlankParagraph = true;
                            return false;
                          });
                          editor.commands.setTextSelection(firstBlankParagraphPosition);
                          editor.commands.focus();
                        });
                      } else {
                        editor.chain().focus("end").insertContent(`<hr><h2>${item.title}</h2>${item.content}`).run();
                        let templateHeadingPosition = 1;
                        editor.state.doc.descendants((node, position) => {
                          if (node.type.name === "heading" && node.attrs.level === 2) templateHeadingPosition = position + 1;
                        });
                        editor.commands.setTextSelection(templateHeadingPosition);
                        editor.commands.focus();
                      }
                      setQuickStartCollapsed(true);
                    }}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <strong>{item.label}</strong>
                    <small>{item.hint}</small>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
      {slashMenu && (
        <div ref={slashMenuRef} className="notion-slash-menu" style={{ top: slashMenu.top, left: slashMenu.left }} role="menu" aria-label={slashMenu.kind === "markdown" ? "Markdown 命令菜单" : "内容块菜单"}>
          <small>{slashMenu.kind === "markdown" ? "Markdown 块" : "基础块"}</small>
          {(slashMenu.kind === "markdown" ? MARKDOWN_SLASH_ITEMS : SLASH_ITEMS).map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                role="menuitem"
                key={item.label}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (slashMenu.kind === "markdown") runMarkdownSlashItem(item as (typeof MARKDOWN_SLASH_ITEMS)[number]);
                  else runSlashItem(item as (typeof SLASH_ITEMS)[number]);
                }}
              >
                <span><Icon size={16} /></span>
                <div><strong>{item.label}</strong><small>{item.hint}</small></div>
              </button>
            );
          })}
        </div>
      )}
      {footerHost && createPortal(
        <footer className="notion-editor-footer">
          <span className="notion-editor-footer-hint">{editorMode === "plain" ? "纯文本按原格式编辑" : "需要标题、清单或引用时可输入 /"}</span>
          <i aria-hidden="true" />
          <span className="notion-editor-footer-count" aria-label={`当前 ${editorMode === "rich" ? editor.getText().length : markdownSource.length} 个字符`}>{editorMode === "rich" ? editor.getText().length : markdownSource.length} 个字符</span>
        </footer>,
        footerHost,
      )}
    </div>
  );
}
