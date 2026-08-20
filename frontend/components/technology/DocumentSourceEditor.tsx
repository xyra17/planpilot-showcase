"use client";

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { useMemo } from "react";

type DocumentSourceEditorProps = {
  value: string;
  format: "markdown" | "plain";
  label: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onSlashDismiss?: () => void;
  onSlashTrigger?: (trigger: MarkdownSlashTrigger) => void;
};

export type MarkdownSlashTrigger = {
  top: number;
  left: number;
  apply: (markdown: string, cursorOffset?: number) => void;
};

export function DocumentSourceEditor({
  value,
  format,
  label,
  placeholder,
  onChange,
  onSlashDismiss,
  onSlashTrigger,
}: DocumentSourceEditorProps) {
  const extensions = useMemo(() => [
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      "aria-label": label,
      spellcheck: format === "plain" ? "true" : "false",
    }),
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (event.key === "Escape") {
          onSlashDismiss?.();
          return false;
        }
        if (format !== "markdown" || event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return false;
        const selection = view.state.selection.main;
        if (!selection.empty) return false;
        const line = view.state.doc.lineAt(selection.head);
        const beforeCursor = view.state.doc.sliceString(line.from, selection.head);
        if (beforeCursor.trim()) return false;

        event.preventDefault();
        const slashFrom = selection.head;
        view.dispatch({
          changes: { from: slashFrom, insert: "/" },
          selection: { anchor: slashFrom + 1 },
        });
        window.requestAnimationFrame(() => {
          const caret = view.coordsAtPos(slashFrom + 1);
          if (!caret) return;
          onSlashTrigger?.({
            top: caret.bottom,
            left: caret.left,
            apply(markdown, cursorOffset = markdown.length) {
              const replaceTo = Math.min(slashFrom + 1, view.state.doc.length);
              view.dispatch({
                changes: { from: slashFrom, to: replaceTo, insert: markdown },
                selection: { anchor: slashFrom + Math.min(cursorOffset, markdown.length) },
              });
              view.focus();
            },
          });
        });
        return true;
      },
    }),
    ...(format === "markdown" ? [markdown({ base: markdownLanguage })] : []),
  ], [format, label, onSlashDismiss, onSlashTrigger]);

  return (
    <div className="notion-source-editor-shell">
      <CodeMirror
        className="notion-source-code-editor"
        value={value}
        minHeight="390px"
        height="100%"
        theme="none"
        extensions={extensions}
        basicSetup={{
          bracketMatching: true,
          closeBrackets: true,
          completionKeymap: true,
          defaultKeymap: true,
          drawSelection: true,
          dropCursor: true,
          foldGutter: format === "markdown",
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          highlightSelectionMatches: true,
          history: true,
          lineNumbers: true,
          searchKeymap: true,
        }}
        indentWithTab={false}
        placeholder={placeholder}
        onChange={onChange}
      />
    </div>
  );
}
