import { NextResponse } from "next/server";
import { requireAgentAuth } from "@/lib/agent/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireAgentAuth(request);
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30), 1), 50);

  let query = auth.supabase
    .from("incidents")
    .select("*")
    .eq("user_id", auth.userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Unable to load incidents.", detail: error.message }, { status: 500 });
  return NextResponse.json({ incidents: data ?? [] });
}
