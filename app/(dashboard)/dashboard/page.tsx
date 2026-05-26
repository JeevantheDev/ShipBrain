import Link from "next/link";
import { DashboardPrOverview } from "@/components/dashboard/DashboardPrOverview";
import { EnvironmentsWidget } from "@/components/dashboard/EnvironmentsWidget";
import { PendingDeployQueue } from "@/components/dashboard/PendingDeployQueue";
import { RecentActivity } from "@/components/dashboard/RecentActivity";

export default function DashboardPage() {
  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <span className="bar"></span>
            command center
          </div>
          <h1>Ship software with AI doing the mechanical work.</h1>
          <div className="sub">
            Deploying changes, coordinating releases, and monitoring live status gates.
          </div>
        </div>
        <div className="head-meta">
          <span className="mono" style={{ fontSize: "12px", color: "var(--text-muted)" }}>ID: SB-CC-2026</span>
          <button className="toggle" type="button" style={{ cursor: "pointer" }}>
            <span className="label-mono">Approval: <span className="ok">Armed</span></span>
            <span className="switch"></span>
          </button>
        </div>
      </header>

      <DashboardPrOverview />

      <div className="body-grid" style={{ marginTop: 24 }}>
        {/* Left Column */}
        <div className="stack">
          <PendingDeployQueue />
        </div>

        {/* Right Column */}
        <div className="stack">
          {/* Quick Actions */}
          <div className="panel">
            <header className="panel-head">
              <h2>Quick Actions</h2>
            </header>
            <div className="qa-list">
              <Link href="/spec-to-pr" style={{ textDecoration: "none" }}>
                <button className="qa-btn" type="button">
                  <span className="qa-icon ai">
                    <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
                      <path d="M6 1.5V10.5M1.5 6H10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                    </svg>
                  </span>
                  <span className="qa-text">
                    <span className="qa-title">New Draft PR Plan</span>
                    <span className="qa-sub">spec-to-pr</span>
                  </span>
                  <span className="qa-kbd">⌘N</span>
                </button>
              </Link>

              <Link href="/incidents" style={{ textDecoration: "none" }}>
                <button className="qa-btn" type="button">
                  <span className="qa-icon danger">
                    <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
                      <path d="M6 1.5v5M6 9h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </span>
                  <span className="qa-text">
                    <span className="qa-title">Triage Incident</span>
                    <span className="qa-sub">incidents</span>
                  </span>
                  <span className="qa-kbd">⌘I</span>
                </button>
              </Link>

              <Link href="/ci" style={{ textDecoration: "none" }}>
                <button className="qa-btn" type="button">
                  <span className="qa-icon warn">
                    <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
                      <path d="M1 9h10L6 2 1 9Z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </span>
                  <span className="qa-text">
                    <span className="qa-title">Explain Failed CI</span>
                    <span className="qa-sub">ci monitor</span>
                  </span>
                  <span className="qa-kbd">⌘D</span>
                </button>
              </Link>
            </div>
          </div>

          <EnvironmentsWidget />
          <RecentActivity />
        </div>
      </div>
    </>
  );
}
