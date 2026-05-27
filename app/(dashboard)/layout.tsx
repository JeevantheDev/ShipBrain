import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/app-shell/DashboardShell";
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
    <DashboardShell
      provider={provider}
      user={{ name: displayName, email: user.email, avatarUrl }}
    >
      {children}
    </DashboardShell>
  );
}
