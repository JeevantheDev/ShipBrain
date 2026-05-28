"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { InputModal } from "@/components/ui/InputModal";

type Environment = {
  id: string;
  repo: string;
  specId?: string;
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
  const [redeployingId, setRedeployingId] = useState<string | null>(null);
  const [redeployTarget, setRedeployTarget] = useState<Environment | null>(null);
  const [redeployError, setRedeployError] = useState<Record<string, string>>({});
  const [redeploySuccess, setRedeploySuccess] = useState<Record<string, string>>({});

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

  function defaultReleaseTag() {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
    const time = now.toISOString().slice(11, 19).replace(/:/g, "");
    return `release-v${date}-${time}`;
  }

  async function redeployEnvironment(env: Environment, releaseTag?: string) {
    setRedeployingId(env.id);
    setRedeployError({});
    setRedeploySuccess({});

    try {
      const endpoint = env.type === "preview"
        ? "/api/deployments/redeploy-preview"
        : "/api/deployments/redeploy-production";

      // For redeploy, we need to find the spec ID
      // The env.id format is "preview-{repo}" or "prod-{repo}"
      // We'll use a direct workflow dispatch instead

      const response = await fetch("/api/environments/redeploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: env.repo,
          environment: env.type,
          branch: env.type === "preview" ? "develop" : "main",
          releaseTag: releaseTag?.trim() || undefined
        })
      });

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json.detail ?? json.error ?? "Failed to trigger redeploy");
      }

      setRedeployTarget(null);
      setRedeploySuccess({ [env.id]: json.releaseTag ? `Redeployment started for ${json.releaseTag}` : `Redeployment started for ${env.type}` });
      await loadEnvironments();

      // Clear success message after 5 seconds
      setTimeout(() => {
        setRedeploySuccess({});
      }, 5000);

    } catch (error) {
      setRedeployError({
        [env.id]: error instanceof Error ? error.message : "Failed to trigger redeploy"
      });
    } finally {
      setRedeployingId(null);
    }
  }

  if (loading) {
    return (
      <div className="panel">
        <header className="panel-head">
          <h2>Environments</h2>
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
          Environments
          <span className="badge-count">{environments.length} active</span>
        </h2>
      </header>

      {environments.map((env) => {
        const isLive = env.status === "deployed" || env.status === "ready";
        const canOpen = env.type === "production"
          ? env.status === "deployed" && Boolean(env.url) && env.url !== "#"
          : isLive && Boolean(env.url) && env.url !== "#";
        const canRedeploy = env.type === "production" ? canOpen : isLive;
        const isRedeploying = redeployingId === env.id;

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

            {redeployError[env.id] && (
              <div style={{
                padding: "8px 12px",
                background: "rgba(248, 81, 73, 0.1)",
                border: "1px solid var(--red)",
                borderRadius: 4,
                fontSize: "12px",
                color: "var(--red)",
                marginBottom: 8
              }}>
                {redeployError[env.id]}
              </div>
            )}

            {redeploySuccess[env.id] && (
              <div style={{
                padding: "8px 12px",
                background: "rgba(63, 185, 80, 0.1)",
                border: "1px solid var(--green)",
                borderRadius: 4,
                fontSize: "12px",
                color: "var(--green)",
                marginBottom: 8
              }}>
                {redeploySuccess[env.id]}
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              {canOpen ? (
                <a
                  className="btn"
                  href={env.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{ flex: 1, justifyContent: "center" }}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ marginRight: 6 }}>
                    <path d="M4 2h6v6M10 2 4 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Open
                </a>
              ) : (
                <button
                  className="btn"
                  disabled
                  title={env.type === "production" ? "Production is not live yet. Deploy it first from CI Monitor." : "Preview URL is not available yet."}
                  style={{ flex: 1, justifyContent: "center" }}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ marginRight: 6 }}>
                    <path d="M4 2h6v6M10 2 4 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Open
                </button>
              )}
              <button
                className="btn"
                onClick={() => {
                  if (env.type === "production") {
                    setRedeployTarget(env);
                  } else {
                    void redeployEnvironment(env);
                  }
                }}
                disabled={isRedeploying || !canRedeploy}
                title={canRedeploy ? `Redeploy ${env.type} from ${env.type === "preview" ? "develop" : "main"} branch` : "Redeploy is available after the first successful deployment."}
                style={{ flex: 1, justifyContent: "center" }}
              >
                {isRedeploying ? (
                  <Loader2 size={12} className="spin" style={{ marginRight: 6 }} />
                ) : (
                  <RefreshCw size={12} style={{ marginRight: 6 }} />
                )}
                Redeploy
              </button>
            </div>
          </div>
        );
      })}
      <InputModal
        open={Boolean(redeployTarget)}
        title="Redeploy production"
        label="Release tag"
        placeholder={defaultReleaseTag()}
        defaultValue=""
        confirmLabel={redeployingId === redeployTarget?.id ? "Redeploying..." : "Start Redeploy"}
        cancelLabel="Cancel"
        onClose={() => {
          if (redeployingId) return;
          setRedeployTarget(null);
        }}
        onConfirm={(value) => {
          if (!redeployTarget || redeployingId) return;
          void redeployEnvironment(redeployTarget, value);
        }}
      />
    </div>
  );
}
