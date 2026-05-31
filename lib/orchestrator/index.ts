import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { pendingActionForTrace, phaseForTraceStatus } from "@/lib/orchestrator/state-machine";
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
  current_phase: string | null;
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

function withDerivedState(patch: TracePatch, trace?: { type?: string | null; target_branch?: string | null } | null) {
  const status = patch.status;
  const next: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
  if (status) {
    next.current_phase = phaseForTraceStatus(status, {
      type: trace?.type ?? null,
      target_branch: patch.target_branch ?? trace?.target_branch ?? null
    });
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
  const type = input.type ?? (input.incidentId ? "hotfix" : "feature");
  const payload = {
    user_id: userId,
    repo_full_name: input.repoFullName,
    type,
    title: input.title,
    description: input.description ?? null,
    status,
    current_phase: phaseForTraceStatus(status, { type, target_branch: input.targetBranch }),
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
    ? await db
        .from("release_traces")
        .update({ ...payload, spec_id: input.specId ?? trace.spec_id ?? null })
        .eq("id", trace.id)
        .select("*")
        .single()
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
  if (result.data.type === "release") {
    await propagateReleaseState(db, result.data);
  }
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
  const { data, error } = await db.from("release_traces").update(withDerivedState(patch, trace)).eq("id", trace.id).select("*").single();
  if (error) throw new Error(error.message);
  await addTraceEvent({ traceId: trace.id, ...event });
  await recomputePendingAction(trace.id);
  if (data.type === "release") {
    await propagateReleaseState(db, data);
  }
  return data;
}

export async function updateTraceBySpecOrPr(input: {
  specId?: string | null;
  repoFullName?: string | null;
  prNumber?: number | null;
  branchName?: string | null;
  patch: TracePatch;
  event: {
    eventType: TraceEventType;
    source: TraceSource;
    actor?: string;
    actorType?: string;
    details?: Record<string, unknown>;
  };
}) {
  const db = getSupabaseAdminClient();
  let trace: any = null;

  if (input.specId) {
    const result = await db.from("release_traces").select("*").eq("spec_id", input.specId).maybeSingle();
    trace = result.data;
  }

  if (!trace && input.repoFullName && input.prNumber) {
    const result = await db
      .from("release_traces")
      .select("*")
      .eq("repo_full_name", input.repoFullName)
      .or(`draft_pr_number.eq.${input.prNumber},release_pr_number.eq.${input.prNumber}`)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    trace = result.data;
  }

  if (!trace && input.repoFullName && input.branchName) {
    const result = await db
      .from("release_traces")
      .select("*")
      .eq("repo_full_name", input.repoFullName)
      .eq("source_branch", input.branchName)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    trace = result.data;
  }

  if (!trace) return null;

  const { data, error } = await db
    .from("release_traces")
    .update({
      ...withDerivedState(input.patch, trace),
      ...(input.specId && !trace.spec_id ? { spec_id: input.specId } : {})
    })
    .eq("id", trace.id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  await addTraceEvent({ traceId: trace.id, ...input.event });
  await recomputePendingAction(trace.id);
  if (data.type === "release") {
    await propagateReleaseState(db, data);
  }
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
  const { data, error } = await db.from("release_traces").update(withDerivedState(patch, trace)).eq("id", trace.id).select("*").single();
  if (error) throw new Error(error.message);
  await addTraceEvent({ traceId: trace.id, ...event });
  await recomputePendingAction(trace.id);
  return data;
}

export async function initiateRollback(input: {
  traceId: string;
  targetReleaseTag: string;
  targetReleaseSha: string;
  sourceReleaseTag: string;
  workflowUrl: string;
  initiatedBy: string;
  rollbackId?: string;
}) {
  const db = getSupabaseAdminClient();
  const { data: trace } = await db.from("release_traces").select("*").eq("id", input.traceId).maybeSingle();
  if (!trace) return null;

  const patch: TracePatch = {
    status: "rolling_back",
    production_deployment: {
      status: "deploying",
      url: input.workflowUrl,
      releaseTag: input.targetReleaseTag,
      releaseSha: input.targetReleaseSha,
      isRollback: true,
      timestamp: new Date().toISOString()
    }
  };

  const { data, error } = await db.from("release_traces").update({
    ...withDerivedState(patch, trace),
    is_rollback: true,
    rollback_source_tag: input.sourceReleaseTag,
    rollback_target_tag: input.targetReleaseTag,
    rollback_metadata: {
      rollbackId: input.rollbackId,
      workflowUrl: input.workflowUrl,
      initiatedAt: new Date().toISOString(),
      initiatedBy: input.initiatedBy
    }
  }).eq("id", input.traceId).select("*").single();
  if (error) throw new Error(error.message);

  await addTraceEvent({
    traceId: input.traceId,
    eventType: "rollback_initiated",
    actor: input.initiatedBy,
    actorType: input.initiatedBy === "telegram" ? "bot" : "user",
    source: input.initiatedBy === "telegram" ? "telegram" : "manual",
    details: {
      sourceReleaseTag: input.sourceReleaseTag,
      targetReleaseTag: input.targetReleaseTag,
      targetReleaseSha: input.targetReleaseSha,
      workflowUrl: input.workflowUrl,
      rollbackId: input.rollbackId
    }
  });
  await recomputePendingAction(input.traceId);
  if (data.type === "release") {
    await propagateReleaseState(db, data);
  }
  return data;
}

export async function completeRollback(input: {
  traceId?: string;
  rollbackId?: string;
  repoFullName?: string;
  releaseTag?: string;
  success: boolean;
  deployUrl?: string;
  errorMessage?: string;
}) {
  const db = getSupabaseAdminClient();

  // Find the rollback record
  let rollback = null;
  if (input.rollbackId) {
    const { data } = await db.from("rollback_history").select("*").eq("id", input.rollbackId).maybeSingle();
    rollback = data;
  } else if (input.repoFullName && input.releaseTag) {
    const { data } = await db.from("rollback_history")
      .select("*")
      .eq("repo_full_name", input.repoFullName)
      .eq("target_release_tag", input.releaseTag)
      .eq("status", "deploying")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    rollback = data;
  }

  // Update rollback record
  if (rollback) {
    await db.from("rollback_history").update({
      status: input.success ? "deployed" : "failed",
      completed_at: new Date().toISOString(),
      error_message: input.errorMessage ?? null,
      updated_at: new Date().toISOString()
    }).eq("id", rollback.id);
  }

  if (rollback && input.success) {
    const now = new Date().toISOString();

    if (rollback.metadata?.sourceSpecId) {
      await db
        .from("specs")
        .update({
          release_status: "rolled_back",
          updated_at: now
        })
        .eq("id", rollback.metadata.sourceSpecId);
    }

    if (rollback.spec_id) {
      await db
        .from("specs")
        .update({
          release_status: "deployed",
          deployment_url: input.deployUrl ?? rollback.workflow_url ?? null,
          deployed_at: now,
          updated_at: now
        })
        .eq("id", rollback.spec_id);

      const { data: targetTrace } = await db
        .from("release_traces")
        .select("*")
        .eq("spec_id", rollback.spec_id)
        .maybeSingle();

      if (targetTrace && targetTrace.id !== rollback.trace_id) {
        const targetPatch: TracePatch = {
          status: "production_live",
          production_deployment: {
            ...(targetTrace.production_deployment ?? {}),
            status: "deployed",
            url: input.deployUrl ?? targetTrace.production_deployment?.url ?? rollback.workflow_url,
            releaseTag: rollback.target_release_tag,
            releaseSha: rollback.target_release_sha,
            isRollback: true,
            timestamp: now
          }
        };

        await db.from("release_traces").update({
          ...withDerivedState(targetPatch, targetTrace),
          is_rollback: true,
          rollback_source_tag: rollback.source_release_tag,
          rollback_target_tag: rollback.target_release_tag,
          rollback_metadata: {
            rollbackId: rollback.id,
            promotedByRollback: true,
            workflowUrl: input.deployUrl ?? rollback.workflow_url,
            completedAt: now
          }
        }).eq("id", targetTrace.id);

        await addTraceEvent({
          traceId: targetTrace.id,
          eventType: "rollback_deployed",
          actor: "github-actions",
          actorType: "system",
          source: "github",
          details: {
            promotedAsLiveRelease: true,
            sourceReleaseTag: rollback.source_release_tag,
            targetReleaseTag: rollback.target_release_tag,
            deployUrl: input.deployUrl,
            rollbackId: rollback.id
          }
        });
        await recomputePendingAction(targetTrace.id);
        if (targetTrace.type === "release") {
          const { data: updatedTarget } = await db.from("release_traces").select("*").eq("id", targetTrace.id).single();
          if (updatedTarget) {
            await propagateReleaseState(db, updatedTarget);
          }
        }
      }
    }
  }

  // Find and update the trace
  let trace = null;
  if (input.traceId) {
    const { data } = await db.from("release_traces").select("*").eq("id", input.traceId).maybeSingle();
    trace = data;
  } else if (rollback?.trace_id) {
    const { data } = await db.from("release_traces").select("*").eq("id", rollback.trace_id).maybeSingle();
    trace = data;
  } else if (input.repoFullName) {
    const { data } = await db.from("release_traces")
      .select("*")
      .eq("repo_full_name", input.repoFullName)
      .eq("status", "rolling_back")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    trace = data;
  }

  if (!trace) return null;

  const patch: TracePatch = {
    status: input.success ? "rolled_back" : "failed",
    production_deployment: {
      ...(trace.production_deployment ?? {}),
      status: input.success ? "deployed" : "failed",
      url: input.deployUrl ?? trace.production_deployment?.url,
      releaseTag: input.success ? rollback?.target_release_tag ?? trace.production_deployment?.releaseTag : trace.production_deployment?.releaseTag,
      releaseSha: input.success ? rollback?.target_release_sha ?? trace.production_deployment?.releaseSha : trace.production_deployment?.releaseSha,
      isRollback: input.success,
      timestamp: new Date().toISOString()
    }
  };

  const { data, error } = await db.from("release_traces").update(withDerivedState(patch, trace)).eq("id", trace.id).select("*").single();
  if (error) throw new Error(error.message);

  await addTraceEvent({
    traceId: trace.id,
    eventType: input.success ? "rollback_deployed" : "rollback_failed",
    actor: "github-actions",
    actorType: "system",
    source: "github",
    details: {
      success: input.success,
      deployUrl: input.deployUrl,
      errorMessage: input.errorMessage,
      rollbackId: rollback?.id
    }
  });
  await recomputePendingAction(trace.id);
  if (data.type === "release") {
    await propagateReleaseState(db, data);
  }
  return data;
}

async function propagateReleaseState(db: any, releaseTrace: any) {
  if (releaseTrace.type !== "release" || !releaseTrace.release_pr_number) return;

  const patch: Record<string, any> = {
    status: releaseTrace.status,
    current_phase: releaseTrace.current_phase,
    merged_to_main: releaseTrace.merged_to_main,
    production_deployment: releaseTrace.production_deployment,
    completed_at: releaseTrace.completed_at,
    updated_at: new Date().toISOString()
  };

  // Update all feature traces associated with this release PR
  const { data: updatedFeatures } = await db
    .from("release_traces")
    .update(patch)
    .eq("repo_full_name", releaseTrace.repo_full_name)
    .eq("type", "feature")
    .eq("release_pr_number", releaseTrace.release_pr_number)
    .select("id");

  if (updatedFeatures?.length) {
    for (const feature of updatedFeatures) {
      await addTraceEvent({
        traceId: feature.id,
        eventType: "status_changed",
        actor: "ShipBrain sync",
        actorType: "system",
        source: "system",
        details: {
          note: `Propagated release state from Release PR #${releaseTrace.release_pr_number}`,
          releaseStatus: releaseTrace.status
        }
      });
      await recomputePendingAction(feature.id);
    }
  }

  // Also propagate to the specs table!
  const specPatch: Record<string, any> = {
    release_status: releaseTrace.status === "production_live" || releaseTrace.status === "completed"
      ? "deployed"
      : releaseTrace.status === "failed"
        ? "failed"
        : releaseTrace.status === "merged_main"
          ? "deploying"
          : "ready_for_prod",
    deployed_at: releaseTrace.completed_at,
    updated_at: new Date().toISOString()
  };

  if (releaseTrace.production_deployment?.url) {
    specPatch.production_url = releaseTrace.production_deployment.url;
  }

  await db
    .from("specs")
    .update(specPatch)
    .eq("repo_full_name", releaseTrace.repo_full_name)
    .eq("release_pr_number", releaseTrace.release_pr_number);
}

export async function associateFeaturesWithRelease(repoFullName: string, releasePrNumber: number, releasePrUrl: string, releasePrState: string) {
  const db = getSupabaseAdminClient();

  // Find all feature traces that are merged_develop or preview_live
  const { data: traces } = await db
    .from("release_traces")
    .select("id, title")
    .eq("repo_full_name", repoFullName)
    .eq("type", "feature")
    .in("status", ["merged_develop", "preview_live"]);

  if (traces?.length) {
    const traceStatus = releasePrState === "merged" ? "merged_main" : "release_pending";
    const phase = phaseForTraceStatus(traceStatus, { type: "feature", target_branch: "main" });

    for (const trace of traces) {
      await db
        .from("release_traces")
        .update({
          status: traceStatus,
          current_phase: phase,
          release_pr_number: releasePrNumber,
          release_pr_url: releasePrUrl,
          updated_at: new Date().toISOString()
        })
        .eq("id", trace.id);

      await addTraceEvent({
        traceId: trace.id,
        eventType: "status_changed",
        actor: "github",
        actorType: "github",
        source: "github",
        details: {
          note: `Associated with Release PR #${releasePrNumber}`,
          prNumber: releasePrNumber,
          prUrl: releasePrUrl
        }
      });
      await recomputePendingAction(trace.id);
    }
  }

  // Find all specs that are merged to develop and don't have a release PR number yet, or match this one
  const releaseStatus = releasePrState === "merged" ? "pending_deploy" : "ready_for_prod";
  await db
    .from("specs")
    .update({
      release_pr_number: releasePrNumber,
      release_pr_url: releasePrUrl,
      release_pr_status: releasePrState,
      release_status: releaseStatus,
      updated_at: new Date().toISOString()
    })
    .eq("repo_full_name", repoFullName)
    .eq("base_branch", "develop")
    .eq("status", "merged")
    .or(`release_pr_number.is.null,release_pr_number.eq.${releasePrNumber}`);
}

export async function dissociateFeaturesFromRelease(repoFullName: string, releasePrNumber: number) {
  const db = getSupabaseAdminClient();

  // Find all feature traces linked to this release PR
  const { data: traces } = await db
    .from("release_traces")
    .select("id")
    .eq("repo_full_name", repoFullName)
    .eq("type", "feature")
    .eq("release_pr_number", releasePrNumber);

  if (traces?.length) {
    for (const trace of traces) {
      await db
        .from("release_traces")
        .update({
          status: "preview_live",
          current_phase: "preview",
          release_pr_number: null,
          release_pr_url: null,
          updated_at: new Date().toISOString()
        })
        .eq("id", trace.id);

      await addTraceEvent({
        traceId: trace.id,
        eventType: "status_changed",
        actor: "github",
        actorType: "github",
        source: "github",
        details: {
          note: `Dissociated from closed Release PR #${releasePrNumber}`,
          prNumber: releasePrNumber
        }
      });
      await recomputePendingAction(trace.id);
    }
  }

  // Clear release_pr fields on specs
  await db
    .from("specs")
    .update({
      release_pr_number: null,
      release_pr_url: null,
      release_pr_status: null,
      release_status: null,
      updated_at: new Date().toISOString()
    })
    .eq("repo_full_name", repoFullName)
    .eq("release_pr_number", releasePrNumber);
}
