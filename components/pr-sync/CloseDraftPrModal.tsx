"use client";

import { GitPullRequest, Trash2, X } from "lucide-react";
import { useState } from "react";

type CloseDraftPrModalProps = {
  open: boolean;
  prNumber?: number;
  branchName: string;
  title: string;
  busy?: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: (input: { comment: string; deleteBranch: boolean }) => Promise<void> | void;
};

export function CloseDraftPrModal({
  open,
  prNumber,
  branchName,
  title,
  busy = false,
  error = "",
  onClose,
  onConfirm
}: CloseDraftPrModalProps) {
  const [comment, setComment] = useState("Closed from ShipBrain to keep GitHub and ShipBrain in sync.");
  const [deleteBranch, setDeleteBranch] = useState(true);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="toolbar" style={{ alignItems: "flex-start", marginBottom: 12 }}>
          <GitPullRequest color="var(--red)" />
          <div>
            <h2 style={{ marginBottom: 4 }}>Close Draft PR</h2>
            <p style={{ marginBottom: 0 }}>
              ShipBrain will close PR #{prNumber ?? "pending"} on GitHub and update local PR, CI, and deployment indicators.
            </p>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 12 }}>
          <strong>{title}</strong>
          <p style={{ marginBottom: 0 }}>{branchName}</p>
        </div>

        <label className="field-label" htmlFor="close-pr-comment">GitHub closing comment</label>
        <textarea
          id="close-pr-comment"
          className="textarea"
          style={{ minHeight: 96 }}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />

        <label className="check-row">
          <input
            type="checkbox"
            checked={deleteBranch}
            onChange={(event) => setDeleteBranch(event.target.checked)}
          />
          Delete the source branch after closing the PR
        </label>

        {error ? (
          <div className="error-panel" role="alert">
            <strong>Unable to close Draft PR</strong>
            <p>{error}</p>
          </div>
        ) : null}

        <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button className="button secondary" disabled={busy} onClick={onClose}>
            <X size={16} />
            Cancel
          </button>
          <button className="button danger" disabled={busy} onClick={() => onConfirm({ comment, deleteBranch })}>
            <Trash2 size={16} />
            {busy ? "Closing..." : "Close PR"}
          </button>
        </div>
      </div>
    </div>
  );
}
