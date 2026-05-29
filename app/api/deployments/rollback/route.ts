import { NextResponse } from "next/server";
import { dispatchCloudflareProductionDeploy } from "@/lib/github/deployments";
import { addTraceEvent } from "@/lib/orchestrator";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const { data: { user: authUser } } = await supabase.auth.getUser();

  const body = await request.json();

  // Support internal server-to-server calls with internalUserId
  const internalUserId = body.internalUserId || request.headers.get("X-Internal-User-Id");
  const user = authUser || (internalUserId ? { id: internalUserId } : null);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const targetReleaseTag = String(body.targetReleaseTag ?? "").trim();
  const repoFullName = body.repoFullName ? String(body.repoFullName) : null;
  const traceId = body.traceId ? String(body.traceId) : null;

  if (!targetReleaseTag) {
    return NextResponse.json({ error: "targetReleaseTag is required." }, { status: 400 });
  }

  const db = getSupabaseAdminClient();

  // Find the target spec by release tag
  let specQuery = db
    .from("specs")
    .select("id, repo_full_name, release_tag, release_sha, release_status, production_url, decomposed_tasks")
    .eq("user_id", user.id)
    .eq("release_tag", targetReleaseTag)
    .eq("release_status", "deployed");

  if (repoFullName) {
    specQuery = specQuery.eq("repo_full_name", repoFullName);
  }

  const { data: targetSpec, error: specError } = await specQuery.maybeSingle();

  if (specError) {
    return NextResponse.json({ error: "Unable to find release.", detail: specError.message }, { status: 500 });
  }

  if (!targetSpec) {
    return NextResponse.json({ error: `No deployed release found for tag "${targetReleaseTag}".` }, { status: 404 });
  }

  if (!targetSpec.release_sha) {
    return NextResponse.json({ error: "Target release does not have a release SHA." }, { status: 400 });
  }

  // Get current production release tag
  const { data: currentSpec } = await db
    .from("specs")
    .select("id, release_tag, release_sha")
    .eq("user_id", user.id)
    .eq("repo_full_name", targetSpec.repo_full_name)
    .eq("release_status", "deployed")
    .order("deployed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const sourceReleaseTag = currentSpec?.release_tag ?? "unknown";

  // Check for active rollbacks
  const { data: activeRollback } = await db
    .from("rollback_history")
    .select("id")
    .eq("repo_full_name", targetSpec.repo_full_name)
    .in("status", ["pending", "deploying"])
    .maybeSingle();

  if (activeRollback) {
    return NextResponse.json({ error: "A rollback is already in progress for this repository." }, { status: 409 });
  }

  // Find or create a trace for this rollback
  let trace = null;
  if (traceId) {
    const { data } = await db.from("release_traces").select("*").eq("id", traceId).eq("user_id", user.id).maybeSingle();
    trace = data;
  }

  if (!trace) {
    // Find the most recent production trace for this repo
    const { data } = await db
      .from("release_traces")
      .select("*")
      .eq("user_id", user.id)
      .eq("repo_full_name", targetSpec.repo_full_name)
      .in("status", ["production_live", "merged_main", "failed"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    trace = data;
  }

  // Dispatch the rollback deployment
  const { owner, repo } = splitRepo(targetSpec.repo_full_name);
  let deployment;
  try {
    deployment = await dispatchCloudflareProductionDeploy({
      owner,
      repo,
      releaseTag: targetReleaseTag,
      releaseSha: targetSpec.release_sha,
      isHotfix: false,
      reverseSync: false
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deployment dispatch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Create rollback history record
  const { data: rollbackRecord, error: rollbackError } = await db
    .from("rollback_history")
    .insert({
      user_id: user.id,
      repo_full_name: targetSpec.repo_full_name,
      trace_id: trace?.id ?? null,
      spec_id: targetSpec.id,
      source_release_tag: sourceReleaseTag,
      target_release_tag: targetReleaseTag,
      target_release_sha: targetSpec.release_sha,
      status: "deploying",
      initiated_by: "dashboard",
      workflow_url: deployment.workflowUrl,
      metadata: {
        targetSpecId: targetSpec.id,
        sourceSpecId: currentSpec?.id ?? null,
        deploymentWorkflowId: deployment.workflowId
      }
    })
    .select("id")
    .single();

  if (rollbackError) {
    console.error("Failed to create rollback history record:", rollbackError);
  }

  // Update trace if found
  if (trace) {
    await db.from("release_traces").update({
      status: "rolling_back",
      current_phase: "production",
      is_rollback: true,
      rollback_source_tag: sourceReleaseTag,
      rollback_target_tag: targetReleaseTag,
      rollback_metadata: {
        rollbackId: rollbackRecord?.id,
        targetSpecId: targetSpec.id,
        workflowUrl: deployment.workflowUrl,
        initiatedAt: new Date().toISOString()
      },
      production_deployment: {
        status: "deploying",
        url: deployment.workflowUrl,
        releaseTag: targetReleaseTag,
        releaseSha: targetSpec.release_sha,
        isRollback: true,
        timestamp: new Date().toISOString()
      },
      pending_action: null,
      updated_at: new Date().toISOString()
    }).eq("id", trace.id);

    await addTraceEvent({
      traceId: trace.id,
      eventType: "rollback_initiated",
      actor: "dashboard",
      actorType: "user",
      source: "manual",
      details: {
        sourceReleaseTag,
        targetReleaseTag,
        targetReleaseSha: targetSpec.release_sha,
        workflowUrl: deployment.workflowUrl,
        rollbackId: rollbackRecord?.id
      }
    });
  }

  // Create notification for rollback
  await supabase
    .from("notifications")
    .insert({
      user_id: user.id,
      type: "rollback_initiated",
      title: "Rollback Initiated",
      body: `Rolling back from ${sourceReleaseTag} to ${targetReleaseTag}`,
      href: deployment.workflowUrl,
      severity: "warning",
      repo_full_name: targetSpec.repo_full_name,
      metadata: { sourceReleaseTag, targetReleaseTag, rollbackId: rollbackRecord?.id }
    })
    .catch((err) => console.error("notification creation failed", err));

  return NextResponse.json({
    ok: true,
    rollbackId: rollbackRecord?.id,
    workflowUrl: deployment.workflowUrl,
    targetTag: targetReleaseTag,
    targetSha: targetSpec.release_sha,
    sourceTag: sourceReleaseTag,
    traceId: trace?.id ?? null
  });
}
