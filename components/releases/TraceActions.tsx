"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RollbackSelector } from "@/components/releases/RollbackSelector";

type TraceActionsProps = {
  traceId: string;
  pendingType?: string | null;
  status: string;
  repoFullName?: string;
  currentReleaseTag?: string;
  type?: string;
};

export function TraceActions({ traceId, pendingType, status, repoFullName, currentReleaseTag, type }: TraceActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showRollback, setShowRollback] = useState(false);

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

  const canCreateReleasePr = pendingType === "create_release_pr";
  const canMergeReverseSync = pendingType === "merge_reverse_sync";
  const canRollback = ["production_live", "merged_main", "failed"].includes(status) && repoFullName && type === "release";
  const isRollingBack = status === "rolling_back";

  return (
    <div className="trace-actions">
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
