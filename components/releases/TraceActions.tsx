"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type TraceActionsProps = {
  traceId: string;
  pendingType?: string | null;
  status: string;
};

export function TraceActions({ traceId, pendingType, status }: TraceActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

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

  const canVerifyPreview = pendingType === "verify_preview" || status === "preview_live";
  const canVerifyProduction = pendingType === "verify_production" || status === "production_live";
  const canComplete = status === "production_live" || status === "completed";
  const canCreateReleasePr = pendingType === "create_release_pr";
  const canMergeReverseSync = pendingType === "merge_reverse_sync";

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
      {canVerifyPreview ? (
        <button className="btn compact primary" disabled={Boolean(busy)} onClick={() => run("verify_preview")}>
          {busy === "verify_preview" ? "Verifying..." : "Verify preview"}
        </button>
      ) : null}
      {canVerifyProduction ? (
        <button className="btn compact primary" disabled={Boolean(busy)} onClick={() => run("verify_production")}>
          {busy === "verify_production" ? "Verifying..." : "Verify production"}
        </button>
      ) : null}
      {canComplete ? (
        <button className="btn compact subtle" disabled={Boolean(busy)} onClick={() => run("complete")}>
          {busy === "complete" ? "Completing..." : "Mark complete"}
        </button>
      ) : null}
      {!["completed", "cancelled"].includes(status) ? (
        <button className="btn compact ghost" disabled={Boolean(busy)} onClick={() => run("cancel")}>
          Cancel trace
        </button>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}
