import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/agent/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireAgentAuth(request);
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.supabase
    .from("specs")
    .select("*")
    .eq("user_id", auth.userId)
    .in("status", ["merged", "draft_created", "pending_pr"])
    .not("release_status", "eq", "deployed")
    .order("updated_at", { ascending: false })
    .limit(30);

  if (error) return NextResponse.json({ error: "Unable to load pending deployments.", detail: error.message }, { status: 500 });
  return NextResponse.json({ pendingDeployments: data ?? [] });
}
