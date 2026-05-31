import { NextResponse } from "next/server";
import { analyzeIncident } from "@/lib/ai/chains/incident-analyzer";
import { generatePostmortem } from "@/lib/ai/chains/postmortem";
import { listPullRequestCommits } from "@/lib/github/commits";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function splitRepo(repoFullName?: string | null) {
  if (!repoFullName?.includes("/")) return null;
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

async function getIncidentReleaseContext(incident: any, db: any, user: any) {
  const repoFullName = String(incident?.repo ?? "").trim();
  const releaseVersion = String(incident?.releaseVersion ?? "").trim();
  if (!repoFullName || !user) return null;

  let query = db
    .from("specs")
    .select("id, raw_spec, pr_number, pr_url, status, repo_full_name, branch_name, base_branch, release_tag, release_status, release_sha, merge_sha, release_pr_number, release_pr_url, release_pr_status, updated_at")
    .eq("user_id", user.id)
    .eq("repo_full_name", repoFullName)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (releaseVersion) {
    query = query.eq("release_tag", releaseVersion);
  }

  let { data: spec } = await query.maybeSingle();
  if (!spec && releaseVersion) {
    const fallback = await db
      .from("specs")
      .select("id, raw_spec, pr_number, pr_url, status, repo_full_name, branch_name, base_branch, release_tag, release_status, release_sha, merge_sha, release_pr_number, release_pr_url, release_pr_status, updated_at")
      .eq("user_id", user.id)
      .eq("repo_full_name", repoFullName)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    spec = fallback.data;
  }

  if (!spec) return null;

  const repoParts = splitRepo(repoFullName);
  const [featureCommits, releaseCommits] = repoParts
    ? await Promise.all([
        listPullRequestCommits({ ...repoParts, pullNumber: spec.pr_number }).catch((err) => {
          console.error("Error fetching feature PR commits:", err);
          return [];
        }),
        listPullRequestCommits({ ...repoParts, pullNumber: spec.release_pr_number }).catch((err) => {
          console.error("Error fetching release PR commits:", err);
          return [];
        })
      ])
    : [[], []];

  return {
    specId: spec.id,
    repo: spec.repo_full_name,
    requestedSpec: spec.raw_spec,
    featureBranch: spec.branch_name,
    baseBranch: spec.base_branch,
    draftPr: spec.pr_number ? { number: spec.pr_number, url: spec.pr_url, status: spec.status } : null,
    release: {
      tag: spec.release_tag,
      status: spec.release_status,
      sha: spec.release_sha,
      mergeSha: spec.merge_sha,
      releasePrNumber: spec.release_pr_number,
      releasePrUrl: spec.release_pr_url,
      releasePrStatus: spec.release_pr_status
    },
    commits: {
      featurePr: featureCommits,
      releasePr: releaseCommits
    }
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const supabase = getSupabaseServerClient();
    const {
      data: { user: authUser }
    } = await supabase.auth.getUser();

    const internalUserId = body.internalUserId || request.headers.get("X-Internal-User-Id");
    const user = authUser || (internalUserId ? { id: internalUserId, email: null } : null);
    const isInternalCall = !authUser && !!internalUserId;

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = isInternalCall ? getSupabaseAdminClient() : supabase;

    let incident = body.incident;
    if (!incident && body.incidentId) {
      const { data: incidentRow, error: incidentErr } = await db
        .from("incidents")
        .select("*")
        .eq("id", body.incidentId)
        .eq("user_id", user.id)
        .single();
      
      if (incidentErr || !incidentRow) {
        return NextResponse.json({ error: "Incident not found", detail: incidentErr?.message }, { status: 404 });
      }

      incident = {
        id: incidentRow.id,
        source: incidentRow.alert_source,
        title: incidentRow.title,
        logs: incidentRow.raw_logs,
        repo: incidentRow.repo_full_name,
        environment: incidentRow.environment,
        service: incidentRow.service,
        severity: incidentRow.severity,
        releaseVersion: incidentRow.release_version
      };
    }

    const releaseContext = body.releaseContext ?? await getIncidentReleaseContext(incident, db, user);

    if (body.action === "postmortem") {
      let pastIncidents: any[] = [];
      let currentFixCommits: any[] = [];

      if (incident?.repo) {
        const { data } = await db
          .from("incidents")
          .select("id, title, root_cause, ai_fix_proposal, postmortem_draft, created_at")
          .eq("user_id", user.id)
          .eq("repo_full_name", incident.repo)
          .eq("status", "resolved")
          .neq("id", incident.id)
          .order("created_at", { ascending: false });
        if (data) pastIncidents = data;

        const { data: incidentRow } = await db
          .from("incidents")
          .select("hotfix_commits")
          .eq("id", incident.id)
          .eq("user_id", user.id)
          .maybeSingle();
        if (incidentRow?.hotfix_commits) {
          currentFixCommits = incidentRow.hotfix_commits;
        }
      }

      const postmortem = await generatePostmortem({
        incident,
        analysis: body.analysis ?? null,
        releaseContext,
        pastIncidents,
        currentFixCommits
      });
      return NextResponse.json({ postmortem });
    }

    const analysis = await analyzeIncident({
      source: incident?.source ?? "manual",
      title: incident?.title ?? "Incident",
      logs: incident?.logs ?? "",
      repo: incident?.repo ?? "unknown",
      releaseVersion: incident?.releaseVersion ?? "unknown",
      releaseContext
    });

    return NextResponse.json({ ...analysis, releaseContext });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Incident action failed" }, { status: 500 });
  }
}
