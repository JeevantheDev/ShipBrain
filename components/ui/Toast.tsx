"use client";

import { Check, X, AlertCircle, Info } from "lucide-react";
import { useEffect, useState } from "react";

type ToastType = "success" | "error" | "info" | "warning";

type ToastProps = {
  open: boolean;
  message: string;
  type?: ToastType;
  duration?: number;
  onClose: () => void;
};

const icons: Record<ToastType, typeof Check> = {
  success: Check,
  error: X,
  info: Info,
  warning: AlertCircle
};

export function Toast({
  open,
  message,
  type = "success",
  duration = 3000,
  onClose
}: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setVisible(true);
      const timeout = setTimeout(() => {
        setVisible(false);
        setTimeout(onClose, 200);
      }, duration);
      return () => clearTimeout(timeout);
    }
  }, [open, duration, onClose]);

  if (!open && !visible) return null;

  const Icon = icons[type];

  return (
    <div className={`toast toast-${type} ${visible ? "toast-visible" : "toast-hidden"}`} role="alert">
      <span className="toast-icon">
        <Icon size={14} />
      </span>
      <span className="toast-message">{message}</span>
      <button className="toast-close" type="button" onClick={() => {
        setVisible(false);
        setTimeout(onClose, 200);
      }} aria-label="Dismiss">
        <X size={12} />
      </button>
    </div>
  );
}

// Hook for easier toast management
export function useToast() {
  const [toast, setToast] = useState<{ open: boolean; message: string; type: ToastType }>({
    open: false,
    message: "",
    type: "success"
  });

  const showToast = (message: string, type: ToastType = "success") => {
    setToast({ open: true, message, type });
  };

  const hideToast = () => {
    setToast((prev) => ({ ...prev, open: false }));
  };

  return { toast, showToast, hideToast };
}
