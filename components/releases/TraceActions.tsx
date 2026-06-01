"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { RollbackSelector } from "@/components/releases/RollbackSelector";

type TraceActionsProps = {
  traceId: string;
  specId?: string | null;
  pendingType?: string | null;
  status: string;
  repoFullName?: string;
  currentReleaseTag?: string;
  type?: string;
};

function generateReleaseTag() {
  return "v1.0.0";
}

export function TraceActions({ traceId, specId, pendingType, status, repoFullName, currentReleaseTag, type }: TraceActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showRollback, setShowRollback] = useState(false);
  const [showProductionDeploy, setShowProductionDeploy] = useState(false);
  const [releaseTag, setReleaseTag] = useState(generateReleaseTag);

  useEffect(() => {
    if (showProductionDeploy && repoFullName) {
      fetch("/api/deployments/pending")
        .then((res) => res.json())
        .then((data) => {
          const matched = data.find((item: any) => item.repo === repoFullName && item.queueType === "production");
          if (matched && matched.releaseTag) {
            setReleaseTag(matched.releaseTag);
          }
        })
        .catch(() => null);
    }
  }, [showProductionDeploy, repoFullName]);

  async function run(action: string) {
    setBusy(action);
    setError("");
    const response = await fetch(`/api/traces/${traceId}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action })
    }).catch(() => null);
    const json = await response?.json().catch(() => ({}));
    setBusy(null);
    if (!response?.ok) {
      setError(json.error ?? "Unable to update trace.");
      return;
    }
    router.refresh();
  }

  async function deployPreview() {
    if (!specId) {
      setError("No spec linked to this trace. Use CI Monitor to deploy.");
      return;
    }
    setBusy("deploy_preview");
    setError("");
    const response = await fetch("/api/deployments/start-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specId })
    }).catch(() => null);
    const json = await response?.json().catch(() => ({}));
    setBusy(null);
    if (!response?.ok) {
      setError(json.error ?? "Unable to start preview deployment.");
      return;
    }
    router.refresh();
  }

  async function deployProduction() {
    if (!specId) {
      setError("No spec linked to this trace. Use CI Monitor to deploy.");
      return;
    }
    if (!releaseTag.trim()) {
      setError("Release tag is required.");
      return;
    }
    setBusy("deploy_production");
    setError("");
    const response = await fetch("/api/deployments/start-production", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specId, releaseTag: releaseTag.trim() })
    }).catch(() => null);
    const json = await response?.json().catch(() => ({}));
    setBusy(null);
    if (!response?.ok) {
      setError(json.error ?? json.detail ?? "Unable to start production deployment.");
      return;
    }
    setShowProductionDeploy(false);
    router.refresh();
  }

  const canCreateReleasePr = pendingType === "create_release_pr";
  const canMergeReverseSync = pendingType === "merge_reverse_sync";
  const canDeployPreview = pendingType === "deploy_preview" && specId;
  const canDeployProduction = pendingType === "deploy_to_production" && specId;
  const canRollback = ["production_live", "merged_main", "failed"].includes(status) && repoFullName && type === "release";
  const isRollingBack = status === "rolling_back";

  return (
    <div className="trace-actions">
      {canDeployPreview ? (
        <button
          className="btn compact primary"
          disabled={Boolean(busy)}
          onClick={deployPreview}
        >
          {busy === "deploy_preview" ? "Deploying..." : "Deploy to preview"}
        </button>
      ) : null}

      {canDeployProduction && !showProductionDeploy ? (
        <button
          className="btn compact primary"
          disabled={Boolean(busy)}
          onClick={() => setShowProductionDeploy(true)}
        >
          Deploy to production
        </button>
      ) : null}

      {showProductionDeploy && canDeployProduction ? (
        <div className="production-deploy-form">
          <label className="form-label">Release Tag</label>
          <input
            type="text"
            className="form-input"
            value={releaseTag}
            onChange={(e) => setReleaseTag(e.target.value)}
            placeholder="e.g., v1.0.0"
            disabled={Boolean(busy)}
          />
          <div className="deploy-form-actions">
            <button
              className="btn compact primary"
              disabled={Boolean(busy) || !releaseTag.trim()}
              onClick={deployProduction}
            >
              {busy === "deploy_production" ? "Deploying..." : "Confirm deploy"}
            </button>
            <button
              className="btn compact ghost"
              disabled={Boolean(busy)}
              onClick={() => setShowProductionDeploy(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {canCreateReleasePr ? (
        <button className="btn compact primary" disabled={Boolean(busy)} onClick={() => run("create_release_pr")}>
          {busy === "create_release_pr" ? "Creating..." : "Create release PR"}
        </button>
      ) : null}

      {canMergeReverseSync ? (
        <button className="btn compact primary" disabled={Boolean(busy)} onClick={() => run("merge_reverse_sync")}>
          {busy === "merge_reverse_sync" ? "Merging..." : "Merge reverse sync"}
        </button>
      ) : null}

      {!["completed", "cancelled"].includes(status) ? (
        <button className="btn compact ghost" disabled={Boolean(busy)} onClick={() => run("cancel")}>
          Cancel trace
        </button>
      ) : null}

      {canRollback && !isRollingBack ? (
        <button
          className="btn compact warning"
          disabled={Boolean(busy)}
          onClick={() => setShowRollback(!showRollback)}
        >
          {showRollback ? "Hide rollback" : "Rollback production"}
        </button>
      ) : null}

      {isRollingBack ? (
        <span className="rollback-in-progress">Rollback in progress...</span>
      ) : null}

      {error ? <p className="form-error">{error}</p> : null}

      {showRollback && repoFullName ? (
        <div className="rollback-section">
          <RollbackSelector
            repoFullName={repoFullName}
            currentTag={currentReleaseTag}
            traceId={traceId}
            onRollback={() => {
              setShowRollback(false);
              router.refresh();
            }}
            disabled={Boolean(busy)}
          />
        </div>
      ) : null}
    </div>
  );
}
