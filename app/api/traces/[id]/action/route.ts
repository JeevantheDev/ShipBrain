import { NextResponse } from "next/server";
import { addTraceEvent, recomputePendingAction } from "@/lib/orchestrator";
import { phaseForStatus } from "@/lib/orchestrator/state-machine";
import { createReleasePullRequest, mergePullRequest } from "@/lib/github/pr";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

function generateReleaseTag() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  return `release-v${date}-${time}`;
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const { data: trace } = await supabase
    .from("release_traces")
    .select("*")
    .eq("id", params.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!trace) return NextResponse.json({ error: "Trace not found." }, { status: 404 });

  let nextStatus = trace.status;
  let eventType: "manual_action" | "status_changed" = "manual_action";
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (action === "create_release_pr") {
    if (!trace.spec_id) return NextResponse.json({ error: "Trace is not linked to a spec." }, { status: 409 });
    const { data: spec } = await supabase
      .from("specs")
      .select("id, release_tag, raw_spec, repo_full_name")
      .eq("id", trace.spec_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!spec) return NextResponse.json({ error: "Linked spec not found." }, { status: 404 });

    const releaseTag = spec.release_tag || generateReleaseTag();
    const { owner, repo } = splitRepo(trace.repo_full_name);
    const pr = await createReleasePullRequest({
      owner,
      repo,
      head: "develop",
      base: "main",
      releaseTag,
      body: [
        "## ShipBrain production release",
        "",
        `Trace: ${trace.id}`,
        `Source spec: ${trace.spec_id}`,
        "",
        "This PR promotes the validated develop branch into main. Production deploy still requires the release gate."
      ].join("\n")
    });

    await supabase.from("specs").update({
      release_tag: releaseTag,
      release_status: "ready_for_prod",
      release_pr_number: pr.number,
      release_pr_url: pr.html_url,
      release_pr_status: pr.state,
      updated_at: new Date().toISOString()
    }).eq("id", trace.spec_id);

    nextStatus = "release_pending";
    update.status = nextStatus;
    update.current_phase = phaseForStatus(nextStatus);
    update.release_pr_number = pr.number;
    update.release_pr_url = pr.html_url;
    eventType = "status_changed";
  } else if (action === "merge_reverse_sync") {
    if (!trace.incident_id || !trace.reverse_sync_pr_number) {
      return NextResponse.json({ error: "Trace does not have a reverse sync PR." }, { status: 409 });
    }
    const { owner, repo } = splitRepo(trace.repo_full_name);
    const merge = await mergePullRequest({
      owner,
      repo,
      pullNumber: trace.reverse_sync_pr_number,
      commitTitle: `sync: complete hotfix reverse sync for ${trace.title}`
    });

    await supabase.from("incidents").update({
      reverse_sync_pr_status: "merged",
      reverse_sync_merged_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", trace.incident_id).eq("user_id", user.id);

    nextStatus = "completed";
    update.status = nextStatus;
    update.current_phase = phaseForStatus(nextStatus);
    update.reverse_sync_status = "merged";
    update.completed_at = new Date().toISOString();
    eventType = "status_changed";
    await addTraceEvent({
      traceId: trace.id,
      eventType: "reverse_sync_merged",
      actor: user.email ?? user.id,
      actorType: "user",
      source: "manual",
      details: { action, merge }
    });
  } else if (action === "verify_preview") {
    nextStatus = trace.release_pr_number ? "release_pending" : "preview_live";
    update.status = nextStatus;
    update.current_phase = phaseForStatus(nextStatus);
    update.preview_deployment = {
      ...(trace.preview_deployment ?? {}),
      verified: true,
      verifiedAt: new Date().toISOString(),
      verifiedBy: user.email ?? user.id
    };
    eventType = "status_changed";
  } else if (action === "verify_production") {
    nextStatus = trace.reverse_sync_pr_number && trace.reverse_sync_status !== "merged" ? "production_live" : "completed";
    update.status = nextStatus;
    update.current_phase = phaseForStatus(nextStatus);
    update.completed_at = nextStatus === "completed" ? new Date().toISOString() : null;
    update.production_deployment = {
      ...(trace.production_deployment ?? {}),
      verified: true,
      verifiedAt: new Date().toISOString(),
      verifiedBy: user.email ?? user.id
    };
    eventType = "status_changed";
  } else if (action === "cancel") {
    nextStatus = "cancelled";
    update.status = nextStatus;
    update.current_phase = phaseForStatus(nextStatus);
    update.pending_action = null;
    update.completed_at = new Date().toISOString();
    eventType = "status_changed";
  } else if (action === "complete") {
    nextStatus = "completed";
    update.status = nextStatus;
    update.current_phase = phaseForStatus(nextStatus);
    update.pending_action = null;
    update.completed_at = new Date().toISOString();
    eventType = "status_changed";
  } else {
    return NextResponse.json({ error: "Unsupported trace action." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("release_traces")
    .update(update)
    .eq("id", trace.id)
    .eq("user_id", user.id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: "Unable to update trace.", detail: error.message }, { status: 500 });

  await addTraceEvent({
    traceId: trace.id,
    eventType,
    actor: user.email ?? user.id,
    actorType: "user",
    source: "manual",
    details: { action, previousStatus: trace.status, nextStatus, note: body.note ?? null }
  });
  await recomputePendingAction(trace.id);

  return NextResponse.json(data);
}
