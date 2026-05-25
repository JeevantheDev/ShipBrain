import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type ActivityItem = {
  id: string;
  type: "pr" | "ci" | "deploy" | "incident";
  title: string;
  detail: string;
  status: string;
  href: string;
  createdAt: string;
};

export async function GET() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [specsResult, ciResult, approvalsResult, incidentsResult] = await Promise.all([
    supabase
      .from("specs")
      .select("id, decomposed_tasks, repo_full_name, branch_name, status, pr_number, ci_status, ci_conclusion, deployment_status, release_tag, release_status, updated_at, created_at")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(8),
    supabase
      .from("ci_runs")
      .select("id, github_run_id, repo_full_name, branch, title, status, conclusion, pr_number, updated_at, created_at, specs!left(user_id)")
      .or(`specs.user_id.eq.${user.id},spec_id.is.null`)
      .order("updated_at", { ascending: false })
      .limit(8),
    supabase
      .from("approval_events")
      .select("id, action, entity_id, note, metadata, created_at")
      .eq("actor_id", user.id)
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("incidents")
      .select("id, alert_source, status, title, repo_full_name, service, severity, release_version, raw_logs, updated_at, created_at")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(8)
  ]);

  const items: ActivityItem[] = [];

  for (const spec of specsResult.data ?? []) {
    const plan = spec.decomposed_tasks as { prTitle?: string } | null;
    items.push({
      id: `spec-${spec.id}`,
      type: "pr",
      title: plan?.prTitle ?? `Draft PR ${spec.pr_number ? `#${spec.pr_number}` : "plan"}`,
      detail: `${spec.repo_full_name ?? "repo"} · ${spec.branch_name ?? "branch"}`,
      status: spec.release_tag ? `Release ${spec.release_tag}` : spec.deployment_status === "approved" ? "Deploy approved" : spec.ci_conclusion ? `CI ${spec.ci_conclusion}` : spec.status,
      href: "/spec-to-pr",
      createdAt: spec.updated_at ?? spec.created_at
    });
  }

  for (const run of ciResult.data ?? []) {
    items.push({
      id: `ci-${run.id}`,
      type: "ci",
      title: run.title ?? `Workflow run #${run.github_run_id}`,
      detail: `${run.repo_full_name ?? "repo"} · ${run.branch ?? "branch"}${run.pr_number ? ` · PR #${run.pr_number}` : ""}`,
      status: run.conclusion ?? run.status,
      href: "/ci",
      createdAt: run.updated_at ?? run.created_at
    });
  }

  for (const approval of approvalsResult.data ?? []) {
    items.push({
      id: `approval-${approval.id}`,
      type: "deploy",
      title: approval.action === "deploy_approved" ? "Deployment approved" : approval.action,
      detail: `${approval.metadata?.repo ?? "repo"} · ${approval.metadata?.branch ?? approval.entity_id}`,
      status: "Audited",
      href: "/ci",
      createdAt: approval.created_at
    });
  }

  for (const incident of incidentsResult.data ?? []) {
    items.push({
      id: `incident-${incident.id}`,
      type: "incident",
      title: incident.title ?? "Incident reported",
      detail: `${incident.repo_full_name ?? incident.alert_source} · ${incident.service ?? "service"} · ${incident.severity ?? "medium"}`,
      status: incident.release_version ? `Release ${incident.release_version}` : incident.status,
      href: "/incidents",
      createdAt: incident.updated_at ?? incident.created_at
    });
  }

  return NextResponse.json(
    items
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 8)
  );
}
