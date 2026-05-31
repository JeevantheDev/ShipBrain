import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/agent/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFilter(value: string | null) {
  const status = value?.trim().toLowerCase();
  if (!status) return null;
  if (status === "draft") return ["draft_created"];
  if (status === "open" || status === "active") return ["draft_created", "pending_pr"];
  if (status === "pending") return ["pending_pr"];
  if (status === "closed" || status === "cancelled") return ["closed"];
  return [status];
}

export async function GET(request: Request) {
  const auth = await requireAgentAuth(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const statuses = statusFilter(url.searchParams.get("status"));
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30), 1), 50);

  let query = auth.supabase
    .from("specs")
    .select("*")
    .eq("user_id", auth.userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (statuses?.length === 1) query = query.eq("status", statuses[0]);
  if (statuses && statuses.length > 1) query = query.in("status", statuses);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Unable to load PR records.", detail: error.message }, { status: 500 });
  return NextResponse.json({
    prs: data ?? [],
    statusAliases: {
      draft: "draft_created",
      open: ["draft_created", "pending_pr"],
      active: ["draft_created", "pending_pr"],
      pending: "pending_pr"
    }
  });
}
