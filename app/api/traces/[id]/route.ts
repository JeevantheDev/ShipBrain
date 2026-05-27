import { NextResponse } from "next/server";
import { addTraceEvent, recomputePendingAction } from "@/lib/orchestrator";
import { phaseForStatus } from "@/lib/orchestrator/state-machine";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("release_traces")
    .select("*, trace_events(*)")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .order("created_at", { referencedTable: "trace_events", ascending: false })
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Unable to load trace.", detail: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Trace not found." }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status) {
    updates.status = body.status;
    updates.current_phase = phaseForStatus(body.status);
    updates.completed_at = body.status === "completed" ? new Date().toISOString() : null;
  }
  if (body.pendingAction !== undefined) updates.pending_action = body.pendingAction;
  if (body.title) updates.title = body.title;

  const { data, error } = await supabase
    .from("release_traces")
    .update(updates)
    .eq("id", params.id)
    .eq("user_id", user.id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: "Unable to update trace.", detail: error.message }, { status: 500 });

  await addTraceEvent({
    traceId: params.id,
    eventType: "manual_action",
    actor: user.email ?? user.id,
    actorType: "user",
    source: "manual",
    details: { updates }
  });
  await recomputePendingAction(params.id);

  return NextResponse.json(data);
}
