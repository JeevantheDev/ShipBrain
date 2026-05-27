"use client";

import { AlertTriangle, Bold, Code, FileText, Heading2, Italic, Link, List, ListOrdered } from "lucide-react";
import { useRef, useState } from "react";

type IncidentTemplateData = {
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  service: string;
  environment: string;
  description: string;
  impact: string;
  stepsToReproduce: string;
  expectedBehavior: string;
  actualBehavior: string;
  additionalContext: string;
};

type Props = {
  value: IncidentTemplateData;
  onChange: (data: IncidentTemplateData) => void;
};

const DEFAULT_TEMPLATE: IncidentTemplateData = {
  title: "",
  severity: "high",
  service: "",
  environment: "production",
  description: "",
  impact: "",
  stepsToReproduce: "",
  expectedBehavior: "",
  actualBehavior: "",
  additionalContext: ""
};

export function getDefaultTemplate(): IncidentTemplateData {
  return { ...DEFAULT_TEMPLATE };
}

export function templateToLogs(data: IncidentTemplateData): string {
  const sections: string[] = [];

  if (data.description) {
    sections.push(`## Description\n${data.description}`);
  }

  if (data.impact) {
    sections.push(`## Impact\n${data.impact}`);
  }

  if (data.stepsToReproduce) {
    sections.push(`## Steps to Reproduce\n${data.stepsToReproduce}`);
  }

  if (data.expectedBehavior) {
    sections.push(`## Expected Behavior\n${data.expectedBehavior}`);
  }

  if (data.actualBehavior) {
    sections.push(`## Actual Behavior\n${data.actualBehavior}`);
  }

  if (data.additionalContext) {
    sections.push(`## Additional Context\n${data.additionalContext}`);
  }

  return sections.join("\n\n");
}

export function IncidentTemplateEditor({ value, onChange }: Props) {
  const [activeField, setActiveField] = useState<keyof IncidentTemplateData | null>(null);
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  function insertMarkdown(field: keyof IncidentTemplateData, prefix: string, suffix: string = "") {
    const textarea = textareaRefs.current[field];
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = value[field] as string;
    const selected = text.substring(start, end);

    const newText = text.substring(0, start) + prefix + selected + suffix + text.substring(end);
    onChange({ ...value, [field]: newText });

    // Restore cursor position
    setTimeout(() => {
      textarea.focus();
      const newPos = start + prefix.length + selected.length + suffix.length;
      textarea.setSelectionRange(newPos, newPos);
    }, 0);
  }

  function ToolbarButton({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
    return (
      <button
        type="button"
        className="btn subtle compact"
        onClick={onClick}
        title={label}
        style={{ padding: "4px 6px", minWidth: 28 }}
      >
        <Icon size={14} />
      </button>
    );
  }

  function RichTextarea({
    field,
    placeholder,
    rows = 3
  }: {
    field: keyof IncidentTemplateData;
    placeholder: string;
    rows?: number;
  }) {
    const isActive = activeField === field;

    return (
      <div style={{ position: "relative" }}>
        {isActive && (
          <div
            style={{
              display: "flex",
              gap: 2,
              padding: "4px 6px",
              background: "var(--panel-2)",
              borderRadius: "4px 4px 0 0",
              border: "1px solid var(--line)",
              borderBottom: "none"
            }}
          >
            <ToolbarButton icon={Bold} label="Bold" onClick={() => insertMarkdown(field, "**", "**")} />
            <ToolbarButton icon={Italic} label="Italic" onClick={() => insertMarkdown(field, "_", "_")} />
            <ToolbarButton icon={Code} label="Code" onClick={() => insertMarkdown(field, "`", "`")} />
            <ToolbarButton icon={Heading2} label="Heading" onClick={() => insertMarkdown(field, "### ", "")} />
            <ToolbarButton icon={List} label="Bullet List" onClick={() => insertMarkdown(field, "- ", "")} />
            <ToolbarButton icon={ListOrdered} label="Numbered List" onClick={() => insertMarkdown(field, "1. ", "")} />
            <ToolbarButton icon={Link} label="Link" onClick={() => insertMarkdown(field, "[", "](url)")} />
          </div>
        )}
        <textarea
          ref={(el) => { textareaRefs.current[field] = el; }}
          className="textarea"
          placeholder={placeholder}
          value={value[field] as string}
          onChange={(e) => onChange({ ...value, [field]: e.target.value })}
          onFocus={() => setActiveField(field)}
          onBlur={() => setTimeout(() => setActiveField(null), 150)}
          rows={rows}
          style={{
            width: "100%",
            background: "var(--panel-2)",
            color: "var(--text)",
            border: "1px solid var(--line)",
            padding: 10,
            borderRadius: isActive ? "0 0 4px 4px" : 4,
            fontSize: 13,
            fontFamily: "inherit",
            resize: "vertical"
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header Section */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label className="field-label" style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            Incident Title *
          </label>
          <input
            type="text"
            className="input"
            placeholder="Brief description of the incident"
            value={value.title}
            onChange={(e) => onChange({ ...value, title: e.target.value })}
            style={{ width: "100%" }}
          />
        </div>
        <div>
          <label className="field-label" style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            Severity *
          </label>
          <select
            className="input"
            value={value.severity}
            onChange={(e) => onChange({ ...value, severity: e.target.value as any })}
            style={{
              width: "100%",
              height: 36,
              padding: "0 12px",
              fontSize: 13,
              color: "var(--text)",
              background: "var(--panel-2)",
              border: "1px solid var(--line)",
              borderRadius: 4,
              cursor: "pointer",
              appearance: "auto"
            }}
          >
            <option value="critical">Critical - System down</option>
            <option value="high">High - Major feature broken</option>
            <option value="medium">Medium - Feature degraded</option>
            <option value="low">Low - Minor issue</option>
          </select>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label className="field-label" style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            Affected Service
          </label>
          <input
            type="text"
            className="input"
            placeholder="e.g., checkout, auth, api"
            value={value.service}
            onChange={(e) => onChange({ ...value, service: e.target.value })}
            style={{ width: "100%" }}
          />
        </div>
        <div>
          <label className="field-label" style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            Environment
          </label>
          <select
            className="input"
            value={value.environment}
            onChange={(e) => onChange({ ...value, environment: e.target.value })}
            style={{
              width: "100%",
              height: 36,
              padding: "0 12px",
              fontSize: 13,
              color: "var(--text)",
              background: "var(--panel-2)",
              border: "1px solid var(--line)",
              borderRadius: 4,
              cursor: "pointer",
              appearance: "auto"
            }}
          >
            <option value="production">Production</option>
            <option value="staging">Staging</option>
            <option value="preview">Preview</option>
            <option value="development">Development</option>
          </select>
        </div>
      </div>

      {/* Template Sections */}
      <div className="card" style={{ padding: 12, background: "var(--bg)", border: "1px dashed var(--line)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <FileText size={16} style={{ color: "var(--brand)" }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>Incident Details Template</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label className="field-label" style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
              Description *
            </label>
            <RichTextarea
              field="description"
              placeholder="Describe the incident in detail. What is happening? When did it start?"
              rows={3}
            />
          </div>

          <div>
            <label className="field-label" style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
              Impact
            </label>
            <RichTextarea
              field="impact"
              placeholder="What is the business/user impact? How many users are affected?"
              rows={2}
            />
          </div>

          <div>
            <label className="field-label" style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
              Steps to Reproduce
            </label>
            <RichTextarea
              field="stepsToReproduce"
              placeholder="1. Go to...\n2. Click on...\n3. Observe..."
              rows={3}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label className="field-label" style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                Expected Behavior
              </label>
              <RichTextarea
                field="expectedBehavior"
                placeholder="What should happen?"
                rows={2}
              />
            </div>
            <div>
              <label className="field-label" style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                Actual Behavior
              </label>
              <RichTextarea
                field="actualBehavior"
                placeholder="What is actually happening?"
                rows={2}
              />
            </div>
          </div>

          <div>
            <label className="field-label" style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
              Additional Context
            </label>
            <RichTextarea
              field="additionalContext"
              placeholder="Add any other context: error logs, screenshots links, related PRs, etc."
              rows={3}
            />
          </div>
        </div>
      </div>

      {/* Preview Section */}
      {(value.title || value.description) && (
        <div className="card" style={{ padding: 12, background: "var(--panel-2)", border: "1px solid var(--line)" }}>
          <span className="eyebrow mono" style={{ fontSize: 9, display: "block", marginBottom: 8 }}>Preview</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <AlertTriangle size={16} style={{ color: value.severity === "critical" || value.severity === "high" ? "var(--red)" : "var(--yellow)" }} />
            <strong style={{ fontSize: 14 }}>{value.title || "Untitled Incident"}</strong>
            <span className={`status-pill ${value.severity === "critical" || value.severity === "high" ? "danger" : ""}`} style={{ fontSize: 10 }}>
              {value.severity}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {value.service && <span>Service: {value.service} · </span>}
            <span>Environment: {value.environment}</span>
          </div>
          {value.description && (
            <p style={{ fontSize: 12.5, marginTop: 8, color: "var(--text)" }}>
              {value.description.substring(0, 200)}{value.description.length > 200 ? "..." : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export type { IncidentTemplateData };
