"use client";

import Link from "next/link";
import { Activity, AlertTriangle, GitPullRequest, Rocket, TestTube2 } from "lucide-react";
import { useEffect, useState } from "react";

type ActivityItem = {
  id: string;
  type: "pr" | "ci" | "deploy" | "incident";
  title: string;
  detail: string;
  status: string;
  href: string;
  createdAt: string;
};

const icons = {
  pr: GitPullRequest,
  ci: TestTube2,
  deploy: Rocket,
  incident: AlertTriangle
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

  return (
    <div className="panel">
      <h2>Recent Activity</h2>
      {error ? (
        <div className="error-panel" role="alert" style={{ marginBottom: 12 }}>
          <strong>Activity sync needs attention</strong>
          <p>{error}</p>
        </div>
      ) : null}
      {loading ? (
        <div className="loading-state" role="status">
          <span className="loading-spinner" aria-hidden="true" />
          <strong>Loading activity</strong>
          <p>Collecting recent PR, CI, deployment, and incident events.</p>
        </div>
      ) : items.length ? (
        <div className="activity">
          {items.map((item) => {
            const Icon = icons[item.type] ?? Activity;
            return (
              <Link className="activity-row activity-link" href={item.href} key={item.id}>
                <Icon size={16} />
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.detail}</p>
                </div>
                <span className="status amber">{item.status}</span>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <strong>No production activity yet</strong>
          <p>Connect a repo, generate your first Draft PR, run CI, or simulate an incident to start filling this feed.</p>
        </div>
      )}
    </div>
  );
}
