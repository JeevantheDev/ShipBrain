import { redirect } from "next/navigation";
import { SidebarNav } from "@/components/app-shell/SidebarNav";
import { UserMenu } from "@/components/app-shell/UserMenu";
import { RepoOnboarding } from "@/components/repo-onboarding/RepoOnboarding";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const displayName =
    user.user_metadata?.name ??
    user.user_metadata?.user_name ??
    user.email?.split("@")[0] ??
    "ShipBrain user";
  const avatarUrl = user.user_metadata?.avatar_url as string | undefined;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="/dashboard" className="brand" style={{ textDecoration: "none" }}>
          <div className="brand-mark">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="2" width="4" height="2" rx="0.5" fill="#e6edf3"/>
              <rect x="6" y="2" width="7" height="2" rx="0.5" fill="#7d8590"/>
              <rect x="1" y="6" width="9" height="2" rx="0.5" fill="#e6edf3"/>
              <rect x="11" y="6" width="2" height="2" rx="0.5" fill="#a371f7"/>
              <rect x="1" y="10" width="6" height="2" rx="0.5" fill="#e6edf3"/>
              <rect x="8" y="10" width="5" height="2" rx="0.5" fill="#7d8590"/>
            </svg>
          </div>
          <div>
            <strong style={{ fontSize: 16, letterSpacing: "-0.01em" }}>
              ship<em style={{ fontStyle: "normal", color: "var(--ai-purple)" }}>brain</em>
            </strong>
          </div>
        </a>

        <div style={{ marginTop: 14 }}>
          <div style={{ color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", letterSpacing: "0.05em", textTransform: "uppercase" as const, padding: "0 8px 8px" }}>
            AI Production Function
          </div>
          <SidebarNav />
        </div>

        <div style={{ marginTop: "auto", paddingTop: 14, borderTop: "1px solid var(--line-muted)" }}>
          <UserMenu name={displayName} email={user.email} avatarUrl={avatarUrl} />
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <RepoOnboarding />
          <div className="toolbar">
            <button className="status green" style={{ cursor: "pointer", border: "1px solid rgba(63,185,80,0.3)", borderRadius: 4, padding: "2px 8px", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace", background: "transparent" }}>
              <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--green)", marginRight: 6 }}></span>
              all gates armed
            </button>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "var(--text-muted)", letterSpacing: "0.04em" }}>
              ◆ {provider}
            </span>
            <UserMenu name={displayName} email={user.email} avatarUrl={avatarUrl} />
          </div>
        </header>
        <div className="content">{children}</div>
      </main>
    </div>
  );
}
