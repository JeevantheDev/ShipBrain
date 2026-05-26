"use client";

import { Loader2 } from "lucide-react";
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
        <header className="panel-head">
          <h2>Vercel Environments</h2>
          <span className="badge-count">syncing</span>
        </header>
        <div className="loading-state" style={{ border: "none", background: "transparent", padding: "20px 0" }}>
          <Loader2 size={16} className="spin" />
        </div>
      </div>
    );
  }

  if (environments.length === 0) {
    return null;
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <h2>
          <span className="triangle" aria-hidden="true" style={{ transform: "scale(0.85)", display: "inline-block", marginRight: 6 }}></span>
          Vercel Environments
          <span className="badge-count">{environments.length} active</span>
        </h2>
      </header>

      {environments.map((env) => {
        const isLive = env.status === "deployed" || env.status === "ready";
        return (
          <div className="env-card" key={env.id} style={{ borderBottom: environments.length > 1 ? "1px solid var(--line-muted)" : "none" }}>
            <div className="env-card-head">
              <div className="env-card-name">
                {env.type === "production" ? "Production" : "Preview"}
                <span className="branch">({env.branch})</span>
              </div>
              <span className={`status-pill ${isLive ? "passed" : ""}`}>
                <span className="dot"></span>
                {env.status === "deployed" || env.status === "ready" ? "live" : env.status}
              </span>
            </div>
            <div className="env-card-sub">
              {env.repo} · <span className="sha">{env.commitSha ? env.commitSha.substring(0, 7) : "—"}</span>
              {env.releaseTag && <span style={{ marginLeft: 6 }}>· {env.releaseTag}</span>}
            </div>
            <a className="btn" href={env.url} target="_blank" rel="noreferrer" style={{ width: "100%", justifyContent: "center" }}>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ marginRight: 6 }}>
                <path d="M4 2h6v6M10 2 4 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Open environment
            </a>
          </div>
        );
      })}
    </div>
  );
}
