"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

type ActivityItem = {
  id: string;
  type: "pr" | "ci" | "deploy" | "incident";
  title: string;
  detail: string;
  status: string;
  href: string;
  createdAt: string;
};

export function RecentActivity() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadActivity();
    const interval = window.setInterval(() => void loadActivity(), 30000);
    return () => window.clearInterval(interval);
  }, []);

  async function loadActivity() {
    try {
      const response = await fetch("/api/activity", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to load activity");
      setItems(json);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load activity");
    } finally {
      setLoading(false);
    }
  }

  function getFiClass(item: ActivityItem) {
    if (item.type === "incident" || item.status.toLowerCase().includes("fail")) {
      return "fi alert";
    }
    if (item.type === "pr") {
      return "fi ai";
    }
    return "fi ok";
  }

  function getFiIcon(item: ActivityItem) {
    const isAlert = item.type === "incident" || item.status.toLowerCase().includes("fail");
    if (isAlert) {
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M6 2v5M6 9h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      );
    }
    if (item.type === "pr") {
      return (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="3" cy="3" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
          <circle cx="3" cy="9" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
          <circle cx="9" cy="9" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
          <path d="M3 4.5v3M4.5 9h3" stroke="currentColor" strokeWidth="1.2"/>
        </svg>
      );
    }
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="m3 6.5 2 2 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }

  function getTagLabel(type: string) {
    switch (type) {
      case "pr": return "spec-to-pr";
      case "ci": return "ci monitor";
      case "deploy": return "release";
      case "incident": return "incidents";
      default: return type;
    }
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <h2>
          Recent Activity
          <span className="badge-count">Live feed</span>
        </h2>
      </header>

      {error ? (
        <div className="error-panel" role="alert" style={{ margin: "14px 18px" }}>
          <strong>Activity sync needs attention</strong>
          <p>{error}</p>
        </div>
      ) : null}

      {loading ? (
        <div className="loading-state" role="status" style={{ border: "none", background: "transparent" }}>
          <span className="loading-spinner" aria-hidden="true" />
          <p style={{ color: "var(--text-muted)", fontSize: "13px" }}>Checking activity logs...</p>
        </div>
      ) : items.length ? (
        <ul className="feed">
          {items.map((item) => (
            <li key={item.id} style={{ cursor: "pointer" }} onClick={() => {
              if (item.href) window.location.href = item.href;
            }}>
              <div className={getFiClass(item)} title={item.type}>
                {getFiIcon(item)}
              </div>
              <div>
                <div className="fa-title">{item.title}</div>
                <div className="fa-meta">{item.detail}</div>
              </div>
              <div className="fa-right">
                <span className="fa-tag">{getTagLabel(item.type)}</span>
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6h8M6 2l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state" style={{ border: "none", background: "transparent" }}>
          <strong>No production activity yet</strong>
          <p style={{ color: "var(--text-muted)" }}>Connect a repo and start shipping to fill this feed.</p>
        </div>
      )}
    </div>
  );
}
