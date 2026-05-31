import { NextResponse } from "next/server";
import { closePullRequest } from "@/lib/github/pr";
import { updateTraceBySpecOrPr } from "@/lib/orchestrator";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { data: spec, error: specError } = await supabase
    .from("specs")
    .select("id, repo_full_name, branch_name, pr_number, pr_url, status")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (specError || !spec) return NextResponse.json({ error: "Draft PR history was not found." }, { status: 404 });
  if (!spec.pr_number || !spec.repo_full_name) return NextResponse.json({ error: "This run has no GitHub Draft PR to close." }, { status: 400 });

  const { owner, repo } = splitRepo(spec.repo_full_name);
  const comment = String(body.comment ?? "Closed from ShipBrain to keep GitHub and ShipBrain in sync.").trim();
  const deleteBranch = Boolean(body.deleteBranch);

  let pr;
  try {
    pr = await closePullRequest({
      owner,
      repo,
      pullNumber: spec.pr_number,
      branch: spec.branch_name,
      comment,
      deleteBranch
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub rejected the PR close request.";
    const detail = /Resource not accessible by personal access token/i.test(message)
      ? "Update the GitHub token with Pull requests read/write, Contents read/write, and Metadata read access for this repository."
      : message;
    return NextResponse.json({ error: "Unable to close the GitHub Draft PR.", detail }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("specs")
    .update({
      status: "closed",
      error_message: deleteBranch && pr.branchDeleted ? "Closed from ShipBrain and source branch deleted." : "Closed from ShipBrain.",
      updated_at: new Date().toISOString()
    })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id, status, error_message, updated_at")
    .single();

  if (error) return NextResponse.json({ error: "GitHub PR closed, but ShipBrain failed to update local status.", detail: error.message }, { status: 500 });

  await updateTraceBySpecOrPr({
    specId: spec.id,
    repoFullName: spec.repo_full_name,
    prNumber: spec.pr_number,
    branchName: spec.branch_name,
    patch: {
      status: "cancelled"
    },
    event: {
      eventType: "status_changed",
      source: "manual",
      actor: user.email ?? "ShipBrain user",
      actorType: "user",
      details: {
        reason: deleteBranch && pr.branchDeleted ? "pr_closed_and_branch_deleted" : "pr_closed",
        prNumber: spec.pr_number,
        branchDeleted: pr.branchDeleted
      }
    }
  }).catch((traceError) => {
    console.error("Unable to sync release trace after PR close", traceError);
  });

  return NextResponse.json({ ok: true, pr, spec: data });
}
