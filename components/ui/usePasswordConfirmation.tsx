"use client";

import { FormEvent, useState } from "react";
import { X } from "lucide-react";
import { createPortal } from "react-dom";

type PasswordPrompt = {
  title: string;
  description: string;
};

type PendingPrompt = PasswordPrompt & {
  resolve: (value: string | null) => void;
};

export function usePasswordConfirmation() {
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [password, setPassword] = useState("");

  function confirmPassword(prompt: PasswordPrompt) {
    setPassword("");
    return new Promise<string | null>((resolve) => {
      setPending({ ...prompt, resolve });
    });
  }

  function close(value: string | null) {
    pending?.resolve(value);
    setPending(null);
    setPassword("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!password.trim()) return;
    close(password);
  }

  function PasswordConfirmModal() {
    if (!pending) return null;
    if (typeof document === "undefined") return null;
    return createPortal(
      <div className="modal-backdrop password-confirm-backdrop" role="dialog" aria-modal="true" onClick={() => close(null)}>
        <form className="modal password-confirm-modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}>
          <div className="password-confirm-head">
            <div>
              <h2>{pending.title}</h2>
              <p>{pending.description}</p>
            </div>
            <button className="icon-button" type="button" onClick={() => close(null)} aria-label="Close">
              <X size={16} />
            </button>
          </div>
          <label className="field-label">ShipBrain password</label>
          <input
            className="input"
            type="password"
            value={password}
            autoFocus
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter your password"
          />
          <div className="toolbar modal-actions" style={{ justifyContent: "space-between" }}>
            <button className="button secondary" type="button" onClick={() => close(null)}>Cancel</button>
            <button className="button primary" type="submit" disabled={!password.trim()}>Confirm</button>
          </div>
        </form>
      </div>,
      document.body
    );
  }

  return { confirmPassword, PasswordConfirmModal };
}
