"use client";

import { AlertTriangle, Bell, CheckCheck, CircleDot, GitMerge, KeyRound, Rocket, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  href: string;
  severity: string;
  repo_full_name?: string | null;
  metadata?: Record<string, unknown>;
  read_at?: string | null;
  created_at: string;
};

function relativeTime(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  return `${Math.floor(diff / day)}d ago`;
}

function iconFor(type: string, severity: string) {
  if (type.includes("incident")) return <AlertTriangle size={15} />;
  if (type.includes("secret")) return <KeyRound size={15} />;
  if (type.includes("merged")) return <GitMerge size={15} />;
  if (type.includes("release")) return <Rocket size={15} />;
  if (severity === "success") return <CheckCheck size={15} />;
  return <CircleDot size={15} />;
}

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);

  const visibleItems = useMemo(() => items.slice(0, 20), [items]);

  useEffect(() => {
    void loadNotifications();
  }, []);

  useEffect(() => {
    function handleOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  useEffect(() => {
    let channel: ReturnType<ReturnType<typeof getSupabaseBrowserClient>["channel"]> | null = null;
    let cancelled = false;

    async function subscribe() {
      const supabase = getSupabaseBrowserClient();
      const {
        data: { user }
      } = await supabase.auth.getUser();

      if (!user || cancelled) return;

      channel = supabase
        .channel(`notifications:${user.id}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` },
          () => void loadNotifications(false)
        )
        .subscribe();
    }

    void subscribe();
    return () => {
      cancelled = true;
      if (channel) getSupabaseBrowserClient().removeChannel(channel);
    };
  }, []);

  async function loadNotifications(showLoading = true) {
    if (showLoading) setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/notifications", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to load notifications");
      setItems(json.notifications ?? []);
      setUnreadCount(json.unreadCount ?? 0);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load notifications");
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  async function markRead(id: string) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, read_at: item.read_at ?? new Date().toISOString() } : item));
    setUnreadCount((count) => Math.max(0, count - 1));
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id })
    });
  }

  async function markAllRead() {
    setItems((current) => current.map((item) => ({ ...item, read_at: item.read_at ?? new Date().toISOString() })));
    setUnreadCount(0);
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markAll: true })
    });
  }

  async function clearRead() {
    setItems((current) => current.filter((item) => !item.read_at));
    await fetch("/api/notifications", { method: "DELETE" });
    await loadNotifications(false);
  }

  async function openNotification(item: NotificationItem) {
    if (!item.read_at) await markRead(item.id);
    setOpen(false);
    router.push(item.href || "/dashboard");
  }

  return (
    <div className="notification-shell" ref={wrapperRef}>
      <button
        className={`icon-btn notification-trigger ${unreadCount ? "has-unread" : ""}`}
        aria-label={unreadCount ? `${unreadCount} unread notifications` : "Notifications"}
        aria-expanded={open}
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={14} />
        {unreadCount ? <span className="notification-badge">{unreadCount > 9 ? "9+" : unreadCount}</span> : null}
      </button>

      {open ? (
        <div className="notification-popover" role="dialog" aria-label="Notifications">
          <div className="notification-head">
            <div>
              <strong>Notifications</strong>
              <p>{unreadCount ? `${unreadCount} unread update${unreadCount === 1 ? "" : "s"}` : "All caught up"}</p>
            </div>
            <button className="icon-btn" aria-label="Close notifications" type="button" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>

          <div className="notification-actions">
            <button className="text-link" type="button" onClick={markAllRead} disabled={!unreadCount}>
              <CheckCheck size={13} /> Mark all read
            </button>
            <button className="text-link" type="button" onClick={clearRead} disabled={!items.some((item) => item.read_at)}>
              <Trash2 size={13} /> Clear read
            </button>
          </div>

          <div className="notification-list">
            {loading ? (
              <div className="notification-empty">Loading notifications...</div>
            ) : error ? (
              <div className="notification-empty error-text">{error}</div>
            ) : visibleItems.length ? (
              visibleItems.map((item) => (
                <button
                  className={`notification-item ${item.read_at ? "read" : "unread"} severity-${item.severity}`}
                  key={item.id}
                  type="button"
                  onClick={() => void openNotification(item)}
                >
                  <span className="notification-icon">{iconFor(item.type, item.severity)}</span>
                  <span className="notification-copy">
                    <span className="notification-title-row">
                      <strong>{item.title}</strong>
                      <small>{relativeTime(item.created_at)}</small>
                    </span>
                    <span>{item.body}</span>
                    {item.repo_full_name ? <code>{item.repo_full_name}</code> : null}
                  </span>
                  {!item.read_at ? <span className="notification-unread-dot" aria-hidden="true" /> : null}
                </button>
              ))
            ) : (
              <div className="notification-empty">
                <strong>No notifications yet</strong>
                <span>Releases, incidents, secret changes, and merged PRs will appear here.</span>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
