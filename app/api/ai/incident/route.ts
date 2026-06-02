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

  // Strategy: Find the deployed spec that matches the release tag, or the most recent deployed release
  let spec = null;

  // 1. Try to find by exact release tag match
  if (releaseVersion) {
    const { data } = await db
      .from("specs")
      .select("id, raw_spec, title, pr_number, pr_url, status, repo_full_name, branch_name, base_branch, release_tag, release_status, release_sha, merge_sha, release_pr_number, release_pr_url, release_pr_status, deployed_at, updated_at")
      .eq("user_id", user.id)
      .eq("repo_full_name", repoFullName)
      .eq("release_tag", releaseVersion)
      .maybeSingle();
    spec = data;
  }

  // 2. Fallback: Get the most recent deployed release for this repo
  if (!spec) {
    const { data } = await db
      .from("specs")
      .select("id, raw_spec, title, pr_number, pr_url, status, repo_full_name, branch_name, base_branch, release_tag, release_status, release_sha, merge_sha, release_pr_number, release_pr_url, release_pr_status, deployed_at, updated_at")
      .eq("user_id", user.id)
      .eq("repo_full_name", repoFullName)
      .eq("release_status", "deployed")
      .order("deployed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    spec = data;
  }

  // 3. Fallback: Get any spec with a release tag for this repo
  if (!spec) {
    const { data } = await db
      .from("specs")
      .select("id, raw_spec, title, pr_number, pr_url, status, repo_full_name, branch_name, base_branch, release_tag, release_status, release_sha, merge_sha, release_pr_number, release_pr_url, release_pr_status, deployed_at, updated_at")
      .eq("user_id", user.id)
      .eq("repo_full_name", repoFullName)
      .not("release_tag", "is", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    spec = data;
  }

  if (!spec) return null;

  const repoParts = splitRepo(repoFullName);

  // Fetch commits from PR(s) if available
  let featureCommits: any[] = [];
  let releaseCommits: any[] = [];

  if (repoParts) {
    // Fetch all commits in parallel for better performance
    const commitPromises: Promise<any>[] = [];

    // Fetch feature PR commits
    if (spec.pr_number) {
      commitPromises.push(
        listPullRequestCommits({ ...repoParts, pullNumber: spec.pr_number })
          .then(commits => ({ type: 'feature', prNumber: spec.pr_number, commits }))
          .catch((err) => {
            console.error("Error fetching feature PR commits:", err);
            return { type: 'feature', prNumber: spec.pr_number, commits: [] };
          })
      );
    }

    // Fetch release PR commits
    if (spec.release_pr_number) {
      commitPromises.push(
        listPullRequestCommits({ ...repoParts, pullNumber: spec.release_pr_number })
          .then(commits => ({ type: 'release', prNumber: spec.release_pr_number, commits }))
          .catch((err) => {
            console.error("Error fetching release PR commits:", err);
            return { type: 'release', prNumber: spec.release_pr_number, commits: [] };
          })
      );
    }

    // Also fetch all feature specs included in this release (by release_pr_number)
    if (spec.release_pr_number) {
      const { data: includedSpecs } = await db
        .from("specs")
        .select("id, title, pr_number, pr_url, branch_name")
        .eq("user_id", user.id)
        .eq("repo_full_name", repoFullName)
        .eq("release_pr_number", spec.release_pr_number)
        .neq("id", spec.id)
        .limit(10); // Limit to avoid too many API calls

      // Fetch commits from all included feature PRs in parallel
      if (includedSpecs?.length) {
        for (const includedSpec of includedSpecs) {
          if (includedSpec.pr_number) {
            commitPromises.push(
              listPullRequestCommits({ ...repoParts, pullNumber: includedSpec.pr_number })
                .then(commits => ({
                  type: 'included',
                  prNumber: includedSpec.pr_number,
                  featureTitle: includedSpec.title,
                  commits
                }))
                .catch(() => ({
                  type: 'included',
                  prNumber: includedSpec.pr_number,
                  featureTitle: includedSpec.title,
                  commits: []
                }))
            );
          }
        }
      }
    }

    // Wait for all commits to be fetched in parallel
    const commitResults = await Promise.all(commitPromises);

    for (const result of commitResults) {
      if (result.type === 'feature') {
        featureCommits = result.commits;
      } else if (result.type === 'release') {
        releaseCommits = result.commits;
      } else if (result.type === 'included') {
        featureCommits.push(...result.commits.map((c: any) => ({
          ...c,
          fromPr: result.prNumber,
          featureTitle: result.featureTitle
        })));
      }
    }
  }

  return {
    specId: spec.id,
    repo: spec.repo_full_name,
    requestedSpec: spec.raw_spec,
    featureTitle: spec.title,
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
      releasePrStatus: spec.release_pr_status,
      deployedAt: spec.deployed_at
    },
    commits: {
      featurePr: featureCommits,
      releasePr: releaseCommits,
      totalCommits: featureCommits.length + releaseCommits.length
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
