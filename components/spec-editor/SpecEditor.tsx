"use client";

import dynamic from "next/dynamic";

const RichTextEditor = dynamic(
  () => import("./RichTextEditor").then((mod) => mod.RichTextEditor),
  {
    ssr: false,
    loading: () => (
      <div style={{ height: "calc(100dvh - 310px)", border: "1px solid var(--border)", borderRadius: 8 }}>
        <textarea
          className="textarea"
          aria-label="Spec editor loading"
          placeholder="Loading editor..."
          style={{ height: "100%", resize: "none" }}
        />
      </div>
    )
  }
);

type SpecEditorProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

export function SpecEditor({ value, onChange, placeholder }: SpecEditorProps) {
  return (
    <RichTextEditor
      value={value}
      onChange={onChange}
      placeholder={placeholder ?? "Paste or type your ticket, spec, or feature request here..."}
    />
  );
}
