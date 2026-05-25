"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { useEffect, useCallback, useMemo } from "react";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  List,
  ListOrdered,
  CheckSquare,
  Heading1,
  Heading2,
  Heading3,
  Quote,
  Minus,
  Undo,
  Redo,
  Code2
} from "lucide-react";

type RichTextEditorProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

// Convert markdown to HTML for TipTap
function markdownToHtml(markdown: string): string {
  let html = markdown;

  // Escape HTML entities first
  html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Convert headers (must be at start of line)
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Convert horizontal rules
  html = html.replace(/^---+$/gm, "<hr>");

  // Convert task lists (- [ ] or - [x])
  html = html.replace(/^- \[x\] (.+)$/gm, '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>$1</p></li></ul>');
  html = html.replace(/^- \[ \] (.+)$/gm, '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>$1</p></li></ul>');

  // Convert bullet lists
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");

  // Convert numbered lists
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

  // Wrap consecutive <li> items in <ul>
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => {
    return `<ul>${match}</ul>`;
  });

  // Merge consecutive task lists
  html = html.replace(/<\/ul>\n?<ul data-type="taskList">/g, "");

  // Convert bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Convert italic
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Convert inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Convert blockquotes
  html = html.replace(/^&gt; (.+)$/gm, "<blockquote><p>$1</p></blockquote>");

  // Convert remaining lines to paragraphs (that aren't already wrapped)
  const lines = html.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      result.push("<p></p>");
    } else if (
      line.startsWith("<h1") ||
      line.startsWith("<h2") ||
      line.startsWith("<h3") ||
      line.startsWith("<ul") ||
      line.startsWith("<ol") ||
      line.startsWith("<li") ||
      line.startsWith("<hr") ||
      line.startsWith("<blockquote") ||
      line.startsWith("<p") ||
      line.startsWith("</")
    ) {
      result.push(line);
    } else {
      result.push(`<p>${line}</p>`);
    }
  }

  return result.join("");
}

export function RichTextEditor({ value, onChange, placeholder }: RichTextEditorProps) {
  // Convert markdown value to HTML for initial content
  const initialContent = useMemo(() => markdownToHtml(value), []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3]
        },
        codeBlock: {
          HTMLAttributes: {
            class: "code-block"
          }
        }
      }),
      Placeholder.configure({
        placeholder: placeholder ?? "Start typing your spec or ticket..."
      }),
      TaskList,
      TaskItem.configure({
        nested: true
      })
    ],
    content: initialContent,
    editorProps: {
      attributes: {
        class: "rich-text-editor-content"
      }
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getText());
    }
  });

  // Sync external value changes (when template is selected)
  useEffect(() => {
    if (editor && value !== editor.getText()) {
      const htmlContent = markdownToHtml(value);
      editor.commands.setContent(htmlContent);
    }
  }, [value, editor]);

  const setHeading = useCallback((level: 1 | 2 | 3) => {
    editor?.chain().focus().toggleHeading({ level }).run();
  }, [editor]);

  if (!editor) {
    return (
      <div className="rich-text-editor-loading">
        <textarea
          className="textarea"
          placeholder={placeholder}
          aria-label="Editor loading"
          readOnly
        />
      </div>
    );
  }

  return (
    <div className="rich-text-editor">
      <div className="rich-text-toolbar">
        <div className="toolbar-group">
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive("heading", { level: 1 }) ? "active" : ""}`}
            onClick={() => setHeading(1)}
            title="Heading 1"
          >
            <Heading1 size={18} />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive("heading", { level: 2 }) ? "active" : ""}`}
            onClick={() => setHeading(2)}
            title="Heading 2"
          >
            <Heading2 size={18} />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive("heading", { level: 3 }) ? "active" : ""}`}
            onClick={() => setHeading(3)}
            title="Heading 3"
          >
            <Heading3 size={18} />
          </button>
        </div>

        <div className="toolbar-divider" />

        <div className="toolbar-group">
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive("bold") ? "active" : ""}`}
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="Bold"
          >
            <Bold size={18} />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive("italic") ? "active" : ""}`}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="Italic"
          >
            <Italic size={18} />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive("strike") ? "active" : ""}`}
            onClick={() => editor.chain().focus().toggleStrike().run()}
            title="Strikethrough"
          >
            <Strikethrough size={18} />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive("code") ? "active" : ""}`}
            onClick={() => editor.chain().focus().toggleCode().run()}
            title="Inline Code"
          >
            <Code size={18} />
          </button>
        </div>

        <div className="toolbar-divider" />

        <div className="toolbar-group">
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive("bulletList") ? "active" : ""}`}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            title="Bullet List"
          >
            <List size={18} />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive("orderedList") ? "active" : ""}`}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            title="Numbered List"
          >
            <ListOrdered size={18} />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive("taskList") ? "active" : ""}`}
            onClick={() => editor.chain().focus().toggleTaskList().run()}
            title="Task List"
          >
            <CheckSquare size={18} />
          </button>
        </div>

        <div className="toolbar-divider" />

        <div className="toolbar-group">
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive("blockquote") ? "active" : ""}`}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            title="Quote"
          >
            <Quote size={18} />
          </button>
          <button
            type="button"
            className={`toolbar-btn ${editor.isActive("codeBlock") ? "active" : ""}`}
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            title="Code Block"
          >
            <Code2 size={18} />
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
            title="Horizontal Rule"
          >
            <Minus size={18} />
          </button>
        </div>

        <div className="toolbar-spacer" />

        <div className="toolbar-group">
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().undo().run()}
            disabled={!editor.can().undo()}
            title="Undo"
          >
            <Undo size={18} />
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().redo().run()}
            disabled={!editor.can().redo()}
            title="Redo"
          >
            <Redo size={18} />
          </button>
        </div>
      </div>

      <div className="rich-text-editor-scroll">
        <EditorContent editor={editor} />
      </div>

      <style jsx global>{`
        .rich-text-editor {
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--surface);
          overflow: hidden;
          display: flex;
          flex-direction: column;
          height: calc(100dvh - 310px);
        }

        .rich-text-toolbar {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 8px 12px;
          border-bottom: 1px solid var(--border);
          background: var(--surface-elevated);
          flex-wrap: wrap;
          flex-shrink: 0;
        }

        .toolbar-group {
          display: flex;
          align-items: center;
          gap: 2px;
        }

        .toolbar-divider {
          width: 1px;
          height: 24px;
          background: var(--border);
          margin: 0 6px;
        }

        .toolbar-spacer {
          flex: 1;
        }

        .toolbar-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border: none;
          background: transparent;
          border-radius: 4px;
          color: var(--text-muted);
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .toolbar-btn:hover:not(:disabled) {
          background: var(--surface-hover);
          color: var(--text);
        }

        .toolbar-btn.active {
          background: var(--accent-light);
          color: var(--accent);
        }

        .toolbar-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .rich-text-editor-scroll {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          min-height: 0;
        }

        .rich-text-editor-content {
          padding: 16px;
          outline: none;
          font-size: 14px;
          line-height: 1.6;
          color: var(--text);
          min-height: 100%;
        }

        .rich-text-editor-content > .ProseMirror {
          min-height: 100%;
          outline: none;
        }

        .rich-text-editor-scroll > .tiptap {
          padding: 16px;
          min-height: 100%;
          outline: none;
          font-size: 14px;
          line-height: 1.6;
          color: var(--text);
        }

        .rich-text-editor-content h1 {
          font-size: 1.75em;
          font-weight: 700;
          margin: 1em 0 0.5em;
          line-height: 1.3;
        }

        .rich-text-editor-content h2 {
          font-size: 1.4em;
          font-weight: 600;
          margin: 1em 0 0.5em;
          line-height: 1.3;
        }

        .rich-text-editor-content h3 {
          font-size: 1.15em;
          font-weight: 600;
          margin: 1em 0 0.5em;
          line-height: 1.3;
        }

        .rich-text-editor-content p {
          margin: 0.5em 0;
        }

        .rich-text-editor-content ul,
        .rich-text-editor-content ol {
          padding-left: 1.5em;
          margin: 0.5em 0;
        }

        .rich-text-editor-content li {
          margin: 0.25em 0;
        }

        .rich-text-editor-content ul[data-type="taskList"] {
          list-style: none;
          padding-left: 0;
        }

        .rich-text-editor-content ul[data-type="taskList"] li {
          display: flex;
          align-items: flex-start;
          gap: 8px;
        }

        .rich-text-editor-content ul[data-type="taskList"] li > label {
          flex-shrink: 0;
          margin-top: 2px;
        }

        .rich-text-editor-content ul[data-type="taskList"] li > label input[type="checkbox"] {
          width: 16px;
          height: 16px;
          cursor: pointer;
          accent-color: var(--accent);
        }

        .rich-text-editor-content ul[data-type="taskList"] li > div {
          flex: 1;
        }

        .rich-text-editor-content blockquote {
          border-left: 3px solid var(--accent);
          padding-left: 1em;
          margin: 0.5em 0;
          color: var(--text-muted);
          font-style: italic;
        }

        .rich-text-editor-content code {
          background: var(--surface-elevated);
          padding: 2px 6px;
          border-radius: 4px;
          font-family: var(--font-mono);
          font-size: 0.9em;
        }

        .rich-text-editor-content pre {
          background: var(--surface-elevated);
          padding: 12px 16px;
          border-radius: 6px;
          overflow-x: auto;
          margin: 0.75em 0;
        }

        .rich-text-editor-content pre code {
          background: none;
          padding: 0;
        }

        .rich-text-editor-content hr {
          border: none;
          border-top: 1px solid var(--border);
          margin: 1.5em 0;
        }

        .rich-text-editor-content .ProseMirror p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: var(--text-muted);
          pointer-events: none;
          height: 0;
        }

        .rich-text-editor-loading {
          height: calc(100dvh - 310px);
        }

        .rich-text-editor-loading .textarea {
          height: 100%;
          resize: none;
        }
      `}</style>
    </div>
  );
}
