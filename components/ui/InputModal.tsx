"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type InputModalProps = {
  open: boolean;
  title: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onClose: () => void;
  onConfirm: (value: string) => void;
};

export function InputModal({
  open,
  title,
  label,
  placeholder = "",
  defaultValue = "",
  confirmLabel = "Save",
  cancelLabel = "Cancel",
  onClose,
  onConfirm
}: InputModalProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, defaultValue]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm(value);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, value, onClose, onConfirm]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="input-modal" onClick={(e) => e.stopPropagation()}>
        <div className="input-modal-header">
          <h3>{title}</h3>
          <button className="input-modal-close" type="button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="input-modal-body">
          {label && <label className="input-modal-label">{label}</label>}
          <input
            ref={inputRef}
            type="text"
            className="input-modal-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
          />
        </div>

        <div className="input-modal-footer">
          <button className="btn ghost" type="button" onClick={onClose}>
            {cancelLabel}
          </button>
          <button className="btn primary" type="button" onClick={() => onConfirm(value)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
