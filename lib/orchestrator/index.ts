import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { pendingActionForTrace, phaseForStatus } from "@/lib/orchestrator/state-machine";
import type { ReleaseTraceStatus, ReleaseTraceType, TraceEventType, TraceSource } from "@/lib/orchestrator/types";

type TraceInput = {
  userId?: string | null;
  repoFullName: string;
  type?: ReleaseTraceType;
  title: string;
  description?: string | null;
  status?: ReleaseTraceStatus;
  sourceBranch: string;
  targetBranch: string;
  draftPrNumber?: number | null;
  draftPrUrl?: string | null;
  releasePrNumber?: number | null;
  releasePrUrl?: string | null;
  specId?: string | null;
  incidentId?: string | null;
  source?: TraceSource;
  actor?: string;
  eventType?: TraceEventType;
  details?: Record<string, unknown>;
};

type TracePatch = Partial<{
  title: string;
  description: string | null;
  status: ReleaseTraceStatus;
  source_branch: string;
  target_branch: string;
  draft_pr_number: number | null;
  draft_pr_url: string | null;
  release_pr_number: number | null;
  release_pr_url: string | null;
  merged_to_develop: Record<string, unknown> | null;
  merged_to_main: Record<string, unknown> | null;
  preview_deployment: Record<string, unknown> | null;
  production_deployment: Record<string, unknown> | null;
  reverse_sync_pr_number: number | null;
  reverse_sync_pr_url: string | null;
  reverse_sync_status: string | null;
  completed_at: string | null;
}>;

export async function addTraceEvent(input: {
  traceId: string;
  eventType: TraceEventType;
  actor?: string;
  actorType?: string;
  source: TraceSource;
  details?: Record<string, unknown>;
}) {
  const db = getSupabaseAdminClient();
  await db.from("trace_events").insert({
    trace_id: input.traceId,
    event_type: input.eventType,
    actor: input.actor ?? "ShipBrain",
    actor_type: input.actorType ?? "system",
    source: input.source,
    details: input.details ?? {}
  });
}

async function findRepoOwner(repoFullName: string) {
  const db = getSupabaseAdminClient();
  const { data } = await db.from("repos").select("user_id").eq("full_name", repoFullName).maybeSingle();
  return data?.user_id ?? null;
}

function withDerivedState(patch: TracePatch) {
  const status = patch.status;
  const next: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
  if (status) {
    next.current_phase = phaseForStatus(status);
    next.completed_at = status === "completed" ? new Date().toISOString() : patch.completed_at ?? null;
  }
  return next;
}

export async function recomputePendingAction(traceId: string) {
  const db = getSupabaseAdminClient();
  const { data: trace } = await db.from("release_traces").select("*").eq("id", traceId).maybeSingle();
  if (!trace) return null;
  const pending = pendingActionForTrace(trace);
  await db.from("release_traces").update({ pending_action: pending, updated_at: new Date().toISOString() }).eq("id", traceId);
  return pending;
}

export async function createOrUpdateTrace(input: TraceInput) {
  const db = getSupabaseAdminClient();
  const userId = input.userId ?? await findRepoOwner(input.repoFullName);
  if (!userId) throw new Error(`No ShipBrain repo owner found for ${input.repoFullName}.`);

  const status = input.status ?? "draft";
  const payload = {
    user_id: userId,
    repo_full_name: input.repoFullName,
    type: input.type ?? (input.incidentId ? "hotfix" : "feature"),
    title: input.title,
    description: input.description ?? null,
    status,
    current_phase: phaseForStatus(status),
    source_branch: input.sourceBranch,
    target_branch: input.targetBranch,
    draft_pr_number: input.draftPrNumber ?? null,
    draft_pr_url: input.draftPrUrl ?? null,
    release_pr_number: input.releasePrNumber ?? null,
    release_pr_url: input.releasePrUrl ?? null,
    spec_id: input.specId ?? null,
    incident_id: input.incidentId ?? null,
    updated_at: new Date().toISOString()
  };

  let trace: any = null;
  if (input.draftPrNumber) {
    const existing = await db
      .from("release_traces")
      .select("*")
      .eq("repo_full_name", input.repoFullName)
      .eq("draft_pr_number", input.draftPrNumber)
      .maybeSingle();
    trace = existing.data;
  }
  if (!trace && input.specId) {
    const existing = await db.from("release_traces").select("*").eq("spec_id", input.specId).maybeSingle();
    trace = existing.data;
  }
  if (!trace && input.incidentId) {
    const existing = await db.from("release_traces").select("*").eq("incident_id", input.incidentId).maybeSingle();
    trace = existing.data;
  }

  const result = trace
    ? await db.from("release_traces").update(payload).eq("id", trace.id).select("*").single()
    : await db.from("release_traces").insert(payload).select("*").single();
  if (result.error) throw new Error(result.error.message);

  const eventType = input.eventType ?? (trace ? "pr_updated" : "trace_created");
  await addTraceEvent({
    traceId: result.data.id,
    eventType,
    actor: input.actor,
    actorType: input.source === "github" ? "github" : input.source === "telegram" ? "bot" : "system",
    source: input.source ?? "system",
    details: input.details ?? {}
  });
  await recomputePendingAction(result.data.id);
  return result.data;
}

export async function updateTraceBySpec(specId: string, patch: TracePatch, event: {
  eventType: TraceEventType;
  source: TraceSource;
  actor?: string;
  actorType?: string;
  details?: Record<string, unknown>;
}) {
  const db = getSupabaseAdminClient();
  const { data: trace } = await db.from("release_traces").select("*").eq("spec_id", specId).maybeSingle();
  if (!trace) return null;
  const { data, error } = await db.from("release_traces").update(withDerivedState(patch)).eq("id", trace.id).select("*").single();
  if (error) throw new Error(error.message);
  await addTraceEvent({ traceId: trace.id, ...event });
  await recomputePendingAction(trace.id);
  return data;
}

export async function updateTraceByIncident(incidentId: string, patch: TracePatch, event: {
  eventType: TraceEventType;
  source: TraceSource;
  actor?: string;
  actorType?: string;
  details?: Record<string, unknown>;
}) {
  const db = getSupabaseAdminClient();
  const { data: trace } = await db.from("release_traces").select("*").eq("incident_id", incidentId).maybeSingle();
  if (!trace) return null;
  const { data, error } = await db.from("release_traces").update(withDerivedState(patch)).eq("id", trace.id).select("*").single();
  if (error) throw new Error(error.message);
  await addTraceEvent({ traceId: trace.id, ...event });
  await recomputePendingAction(trace.id);
  return data;
}
