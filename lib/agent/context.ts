import { DEFAULT_SPEC_PR_RECIPES, recipeHeading } from "@/lib/spec-recipes";

type SupabaseLike = {
  from: (table: string) => any;
};

export async function getShipBrainAgentContext({
  supabase,
  userId,
  repoFullName,
  limit = 10
}: {
  supabase: SupabaseLike;
  userId: string;
  repoFullName?: string | null;
  limit?: number;
}) {
  const repoFilter = repoFullName?.trim();

  const reposQuery = supabase
    .from("repos")
    .select("id, full_name, setup_status, setup_pr_url, setup_pr_number, setup_metadata, connected_at, created_at")
    .eq("user_id", userId)
    .order("connected_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  const repos = await reposQuery;
  if (repos.error) throw new Error(repos.error.message);

  const connectedRepoNames = (repos.data ?? []).map((repo: any) => repo.full_name).filter(Boolean);
  const scopedRepoNames = repoFilter ? [repoFilter] : connectedRepoNames;
  const safeRepoNames = scopedRepoNames.length ? scopedRepoNames : ["__none__"];

  let specsQuery = supabase
    .from("specs")
    .select("id, repo_full_name, raw_spec, pr_number, pr_url, status, branch_name, base_branch, release_status, release_tag, preview_status, preview_url, deployment_url, decomposed_tasks, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (repoFilter) specsQuery = specsQuery.eq("repo_full_name", repoFilter);

  const ciRunsQuery = supabase
    .from("ci_runs")
    .select("id, github_run_id, repo_full_name, workflow_name, title, branch, status, conclusion, html_url, updated_at")
    .in("repo_full_name", safeRepoNames)
    .order("updated_at", { ascending: false })
    .limit(limit);

  let incidentsQuery = supabase
    .from("incidents")
    .select("id, title, status, severity, service, environment, repo_full_name, release_version, hotfix_pr_number, hotfix_pr_url, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (repoFilter) incidentsQuery = incidentsQuery.eq("repo_full_name", repoFilter);

  let tracesQuery = supabase
    .from("release_traces")
    .select("id, title, type, status, repo_full_name, source_branch, target_branch, draft_pr_number, release_pr_number, preview_deployment, production_deployment, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (repoFilter) tracesQuery = tracesQuery.eq("repo_full_name", repoFilter);

  let notificationsQuery = supabase
    .from("notifications")
    .select("id, type, title, body, repo_full_name, href, read_at, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (repoFilter) notificationsQuery = notificationsQuery.eq("repo_full_name", repoFilter);

  const recipesQuery = supabase
    .from("spec_pr_recipes")
    .select("id, label, prefix, base_branch, source_branch, ticket, is_sample, sort_order")
    .eq("active", true)
    .order("sort_order", { ascending: true });

  const [specs, ciRuns, incidents, traces, notifications, recipes] = await Promise.all([
    specsQuery,
    ciRunsQuery,
    incidentsQuery,
    tracesQuery,
    notificationsQuery,
    recipesQuery
  ]);

  const failed = [specs, ciRuns, incidents, traces, notifications].find((result) => result.error);
  if (failed?.error) throw new Error(failed.error.message);
  const recipeRows = recipes.error ? DEFAULT_SPEC_PR_RECIPES : (recipes.data ?? DEFAULT_SPEC_PR_RECIPES);

  const recentPrs = specs.data ?? [];
  const repoRows = (repos.data ?? []).map((repo: any) => ({
    ...repo,
    active: repoFilter ? repo.full_name === repoFilter : false
  }));

  // Filter for truly pending deployments:
  // - Must be in a deployable status
  // - Not already fully deployed (release_status !== "deployed")
  // - For preview: not already preview deployed (!preview_url && preview_status !== "deployed")
  const pendingDeployments = recentPrs.filter((spec: any) => {
    if (!["merged", "draft_created", "pending_pr"].includes(spec.status)) return false;
    if (spec.release_status === "deployed") return false;

    // For develop-targeted PRs, check if preview is already deployed
    if (spec.base_branch === "develop" && spec.status === "merged") {
      // If preview is already deployed/deploying, only include if ready for production (has release PR)
      if (spec.preview_url || spec.preview_status === "deployed") {
        // Include only if there's a pending production action
        return spec.release_status === "pending_deploy" || spec.release_status === "ready_for_prod";
      }
    }

    return true;
  });

  return {
    activeRepo: repoFilter ?? null,
    repos: repoRows,
    recentPrs,
    ciRuns: ciRuns.data ?? [],
    pendingDeployments,
    incidents: incidents.data ?? [],
    releaseTraces: traces.data ?? [],
    notifications: notifications.data ?? [],
    specPrRecipes: recipeRows.map((recipe: any) => ({
      id: recipe.id,
      label: recipe.label,
      prefix: recipe.prefix,
      heading: recipeHeading({
        ticket: recipe.ticket,
        label: recipe.label
      }),
      baseBranch: recipe.base_branch ?? recipe.baseBranch ?? "develop",
      sourceBranch: recipe.source_branch ?? recipe.sourceBranch ?? null,
      isSample: recipe.is_sample ?? recipe.isSample ?? false
    }))
  };
}
