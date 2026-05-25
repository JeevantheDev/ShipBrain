"use client";

import { AlertTriangle, Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";

type ApprovalGateProps = {
  open: boolean;
  title: string;
  description: string;
  entityType: string;
  entityId: string;
  details?: ReactNode;
  onApprove: (note: string) => Promise<void> | void;
  onReject: (note: string) => Promise<void> | void;
  onClose?: () => void;
};

export function ApprovalGate({
  open,
  title,
  description,
  entityType,
  entityId,
  details,
  onApprove,
  onReject,
  onClose
}: ApprovalGateProps) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  if (!open) return null;

  async function act(kind: "approve" | "reject") {
    setBusy(kind);
    try {
      if (kind === "approve") {
        await onApprove(note);
      } else {
        await onReject(note);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="toolbar" style={{ alignItems: "flex-start", marginBottom: 12 }}>
          <AlertTriangle color="var(--amber)" />
          <div>
            <h2 style={{ marginBottom: 4 }}>{title}</h2>
            <p style={{ marginBottom: 0 }}>{description}</p>
          </div>
        </div>
        <p>
          <strong>{entityType}</strong> · {entityId}
        </p>
        {details}
        <textarea
          className="textarea"
          placeholder="Optional approval note"
          style={{ minHeight: 96 }}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button className="button danger" disabled={busy !== null} onClick={() => act("reject")}>
            <X size={16} />
            {busy === "reject" ? "Rejecting..." : "Reject"}
          </button>
          <button className="button primary" disabled={busy !== null} onClick={() => act("approve")}>
            <Check size={16} />
            {busy === "approve" ? "Approving..." : "Approve"}
          </button>
        </div>
      </div>
    </div>
  );
}
