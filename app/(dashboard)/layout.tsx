import { redirect } from "next/navigation";
import { Bot } from "lucide-react";
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
        <div className="brand">
          <div className="brand-mark">SB</div>
          <div>
            <strong>ShipBrain</strong>
            <div style={{ color: "#a8c6bd", fontSize: 13 }}>AI Production Function</div>
          </div>
        </div>
        <SidebarNav />
      </aside>
      <main className="main">
        <header className="topbar">
          <RepoOnboarding />
          <div className="toolbar">
            <span className="status green">
              <Bot size={14} style={{ marginRight: 6 }} />
              {provider}
            </span>
            <span className="status amber">Approval gates on</span>
            <UserMenu name={displayName} email={user.email} avatarUrl={avatarUrl} />
          </div>
        </header>
        <div className="content">{children}</div>
      </main>
    </div>
  );
}
