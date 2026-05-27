"use client";

import { ReactNode, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { SidebarNav } from "@/components/app-shell/SidebarNav";
import { UserMenu } from "@/components/app-shell/UserMenu";
import { RepoOnboarding } from "@/components/repo-onboarding/RepoOnboarding";
import { Crumbs } from "@/components/app-shell/Crumbs";
import { NotificationBell } from "@/components/app-shell/NotificationBell";

type DashboardShellProps = {
  children: ReactNode;
  provider: string;
  user: {
    name: string;
    email?: string;
    avatarUrl?: string;
  };
};

export function DashboardShell({ children, provider, user }: DashboardShellProps) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.classList.toggle("mobile-sidebar-open", sidebarOpen);
    return () => document.body.classList.remove("mobile-sidebar-open");
  }, [sidebarOpen]);

  return (
    <div className="app-shell">
      <button
        className={`sidebar-backdrop ${sidebarOpen ? "show" : ""}`}
        type="button"
        aria-label="Close navigation"
        onClick={() => setSidebarOpen(false)}
      />

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`} aria-label="Primary navigation">
        <div className="sidebar-head">
          <a href="/dashboard" className="brand" style={{ textDecoration: "none" }}>
            <div className="brand-mark">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="2" width="4" height="2" rx="0.5" fill="#e6edf3" />
                <rect x="6" y="2" width="7" height="2" rx="0.5" fill="#7d8590" />
                <rect x="1" y="6" width="9" height="2" rx="0.5" fill="#e6edf3" />
                <rect x="11" y="6" width="2" height="2" rx="0.5" fill="#a371f7" />
                <rect x="1" y="10" width="6" height="2" rx="0.5" fill="#e6edf3" />
                <rect x="8" y="10" width="5" height="2" rx="0.5" fill="#7d8590" />
              </svg>
            </div>
            <div>
              <strong style={{ fontSize: 16, letterSpacing: "-0.01em" }}>
                ship<em style={{ fontStyle: "normal", color: "var(--ai-purple)" }}>brain</em>
              </strong>
            </div>
          </a>

          <button className="mobile-sidebar-close" type="button" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <div className="sidebar-nav-block">
          <div className="sidebar-kicker">AI Production Function</div>
          <SidebarNav onNavigate={() => setSidebarOpen(false)} />
        </div>

        <div className="sidebar-user-block">
          <UserMenu name={user.name} email={user.email} avatarUrl={user.avatarUrl} />
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="mobile-menu-button" type="button" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}>
            <Menu size={18} />
          </button>
          <Crumbs />
          <div className="topbar-right">
            <RepoOnboarding />
            <span className="pill ai-pill desktop-status">
              <span className="ai-diamond">◆</span> {provider}
            </span>
            <span className="pill desktop-status gates-pill">
              <span className="status-dot"></span>
              gates armed
            </span>
            <NotificationBell />
          </div>
        </header>
        <div className="content">{children}</div>
      </main>
    </div>
  );
}
