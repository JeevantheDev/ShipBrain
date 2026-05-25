"use client";

import { ExternalLink, Globe, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

type Environment = {
  id: string;
  repo: string;
  type: "preview" | "production";
  url: string;
  branch: string;
  commitSha?: string | null;
  releaseTag?: string | null;
  status: string;
  updatedAt: string;
};

export function EnvironmentsWidget() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadEnvironments();
    const interval = window.setInterval(() => void loadEnvironments(), 60000);
    return () => window.clearInterval(interval);
  }, []);

  async function loadEnvironments() {
    try {
      const response = await fetch("/api/environments", { cache: "no-store" });
      if (response.ok) {
        const json = await response.json();
        setEnvironments(json);
      }
    } catch {
      // Silently fail - this is a nice-to-have widget
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="panel">
        <h2>Vercel Environments</h2>
        <div className="loading-state" style={{ padding: "20px 0" }}>
          <Loader2 size={20} className="spin" />
        </div>
      </div>
    );
  }

  if (environments.length === 0) {
    return null;
  }

  return (
    <div className="panel">
      <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h2 style={{ marginBottom: 0 }}>Vercel Environments</h2>
        <span className="status green">{environments.length} active</span>
      </div>
      <div className="split-list">
        {environments.map((env) => (
          <div
            key={env.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 0",
              borderBottom: "1px solid var(--border)"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Globe size={16} style={{ color: env.type === "production" ? "var(--green)" : "var(--blue)", flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 8 }}>
                  {env.type === "production" ? "Production" : "Preview"}
                  <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>
                    ({env.branch})
                  </span>
                  {env.type === "production" && (
                    <span
                      className={`status ${env.status === "deployed" ? "green" : env.status === "deploying" ? "amber" : ""}`}
                      style={{ fontSize: 10, padding: "2px 6px" }}
                    >
                      {env.status === "deployed" ? "LIVE" : env.status === "deploying" ? "DEPLOYING" : "PENDING"}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {env.repo}
                  {env.releaseTag && (
                    <span style={{ marginLeft: 6, color: "var(--green)" }}>· {env.releaseTag}</span>
                  )}
                  {env.commitSha && (
                    <span style={{ marginLeft: 6, fontFamily: "monospace" }}>@ {env.commitSha}</span>
                  )}
                </div>
              </div>
            </div>
            <a className="button secondary compact" href={env.url} target="_blank" rel="noreferrer">
              <ExternalLink size={12} />
              Open
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
