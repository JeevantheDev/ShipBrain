import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { appendChatMessage, getOrCreateChatThread } from "@/lib/ai/chat-store";
import { getNextSemverReleaseTag } from "@/lib/shipbrain/semver";
import { generateScaffold } from "@/lib/ai/chains/code-scaffold";
import { analyzeIncident } from "@/lib/ai/chains/incident-analyzer";
import { generatePostmortem } from "@/lib/ai/chains/postmortem";
import { decomposeSpec, specPlanSchema } from "@/lib/ai/chains/spec-decompose";
import { answerShipBrainQuestion } from "@/lib/ai/shipbrain-chat";
import { listPullRequestCommits } from "@/lib/github/commits";
import { getOctokit } from "@/lib/github/client";
import { createDraftPR } from "@/lib/github/pr";
import { createOrUpdateTrace } from "@/lib/orchestrator";
import { escapeTelegram } from "@/lib/telegram/formatter";
import {
  deployPreview,
  deployProduction,
  rollback as rollbackAction,
  createReleasePR as createReleasePRAction,
  approveHotfix as approveHotfixAction,
  resolveIncident as resolveIncidentAction,
  createHotfix as createHotfixAction,
  analyzeIncident as analyzeIncidentAction,
  syncHotfix as syncHotfixAction,
  mergeReverseSync as mergeReverseSyncAction,
  buildActionContext,
  getRepoDeploymentContext,
  getAllReposDeploymentContext
} from "@/lib/actions";

type TelegramUser = {
  user_id: string;
};

function shortId(value: string) {
  return value.slice(0, 8);
}

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

function normalizeToken(value: string) {
  return value.trim().replace(/^#/, "");
}

function generateReleaseTag() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `release-v${date}-${time}-${suffix}`;
}

function generateTraceReleaseTag() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  return `release-v${date}-${time}`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function hotfixReleaseTag(incidentId: string) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
  return `hotfix-v${date}-${incidentId.slice(0, 8)}`;
}

/**
 * Build an action context for Telegram commands using unified buildActionContext
 */
async function buildTelegramActionContext(userId: string, repoFullName: string) {
  const db = getSupabaseAdminClient();
  return buildActionContext({
    db,
    userId,
    source: "telegram",
    repoFullName,
    actor: "Telegram Bot"
  });
}

export async function runTelegramCommand(user: TelegramUser, text: string) {
  const input = text.trim().toLowerCase();
  const parts = text.trim().split(/\s+/);
  if (input.startsWith("/plan ") || input.startsWith("/ai_plan ")) {
    return createAiPlan(user, text.replace(/^\/(?:plan|ai_plan)\s+/i, ""));
  }
  if (input.startsWith("/draft_pr ")) {
    return createTelegramDraftPr(user, text.replace(/^\/draft_pr\s+/i, ""));
  }
  if (input.startsWith("/analyze_incident ") || input.startsWith("/analyse_incident ")) {
    return analyzeTelegramIncident(user, parts[1]);
  }
  if (input.startsWith("/create_hotfix ")) {
    return createTelegramHotfixPr(user, parts[1], parts[2]);
  }
  if (input.startsWith("/sync_hotfix ")) {
    return syncTelegramHotfix(user, parts[1]);
  }
  if (input.startsWith("/approve_fix ")) {
    return approveTelegramIncidentFix(user, parts[1], { releaseTag: parts[2] });
  }
  if (input.startsWith("/postmortem ") || input.startsWith("/post_mortem ")) {
    return generateTelegramPostmortem(user, parts[1]);
  }
  if (input === "/status" || input === "status") return getTraceStatus(user);
  if (input === "/traces" || input === "traces") return getReleaseTraces(user);
  if (input.startsWith("/trace ") || input.startsWith("trace ")) return getReleaseTraceDetail(user, parts[1]);
  if (input.startsWith("/approve ") || input.startsWith("approve ")) return approveTraceFromTelegram(user, parts[1]);
  if (input.startsWith("/deployments") || input.startsWith("/pending") || input.includes("pending deployment")) {
    return getPendingDeployments(user);
  }
  if (input.startsWith("/deploy_dev") || input.startsWith("/deploydev")) {
    return startPreviewDeployment(user, parts[1]);
  }
  if (input.startsWith("/redeploy_dev") || input.startsWith("/redeploydev")) {
    return startPreviewDeployment(user, parts[1], { redeploy: true });
  }
  if (input.startsWith("/deploy_prod") || input.startsWith("/deployprod")) {
    return startProductionDeployment(user, parts[1], { releaseTag: parts[2] });
  }
  if (input.startsWith("/redeploy_prod") || input.startsWith("/redeployprod")) {
    return startProductionDeployment(user, parts[1], { redeploy: true, releaseTag: parts[2] });
  }
  if (/^\/deploy(\s|$)/.test(input)) {
    return startAutoDeployment(user, parts[1]);
  }
  if (/^\/redeploy(\s|$)/.test(input)) {
    return startAutoDeployment(user, parts[1], { redeploy: true });
  }
  if (input.startsWith("/rollback_releases") || input.startsWith("/rollbackreleases")) {
    return getRollbackReleases(user);
  }
  if (input.startsWith("/rollback_status") || input.startsWith("/rollbackstatus")) {
    return getRollbackStatus(user);
  }
  if (input.startsWith("/rollback ") || input.startsWith("/rollback_")) {
    const tag = text.trim().split(/\s+/).slice(1).join(" ");
    return initiateRollbackFromTelegram(user, tag);
  }
  if (input.startsWith("/resolve ")) {
    const resolveParts = text.trim().split(/\s+/);
    const incidentId = resolveParts[1];
    const note = resolveParts.slice(2).join(" ") || "Resolved via Telegram";
    return resolveTelegramIncident(user, incidentId, note);
  }
  if (input === "/handbook" || input === "/release_handbook" || input === "/releasehandbook") {
    return prepareTelegramReleaseHandbook(user);
  }
  if (input.startsWith("/release_pr ") || input.startsWith("/create_release_pr ") || input.startsWith("/releasepr ")) {
    const tag = text.trim().split(/\s+/).slice(1).join(" ");
    return createReleasePrFromTelegram(user, tag);
  }
  if (input === "/release_pr" || input === "/create_release_pr" || input === "/releasepr") {
    return createReleasePrFromTelegram(user);
  }
  if (input === "/help" || input === "help" || input === "/start") return helpText();
  if (input.startsWith("/incident ") || input.startsWith("incident ")) return getIncidentDetail(user, parts[1]);
  if (input.startsWith("/incidents")) return getIncidents(user);
  if (input.startsWith("/releases")) return getReleases(user);
  if (input.startsWith("/pending")) return getPendingCommits(user);
  if (input.startsWith("/ci")) return getCiStatus(user);
  if (input.startsWith("/prs")) return getPendingPrs(user);
  // Route non-slash messages to AI chatbot for natural language understanding
  if (!input.startsWith("/")) return chatWithShipBrain(user, text);
  // Fallback keyword matching for slash commands only
  if (input.includes("incident")) return getIncidents(user);
  if (input.includes("release")) return getReleases(user);
  if (input.includes("ci") || input.includes("workflow")) return getCiStatus(user);
  if (input.includes("pr") || input.includes("pull")) return getPendingPrs(user);
  return [
    "I can help with ShipBrain operations.",
    "",
    "Try:",
    "• /prs",
    "• /plan <ticket>",
    "• /draft_pr <id or ticket>",
    "• /incidents",
    "• /releases",
    "• /ci",
    "• /deployments",
    "• /status",
    "• /traces",
    "• /help"
  ].join("\n");
}

async function chatWithShipBrain(user: TelegramUser, text: string) {
  const db = getSupabaseAdminClient();
  const repoFullName = await activeRepo(user.user_id);
  const thread = await getOrCreateChatThread({
    supabase: db,
    userId: user.user_id,
    repoFullName,
    channel: "telegram",
    externalThreadKey: `telegram:${user.user_id}`
  });

  // Retrieve pending action from the most recent assistant message
  const { data: recentMessages } = await db
    .from("chat_messages")
    .select("metadata")
    .eq("thread_id", thread.id)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1);

  const pendingAction = recentMessages?.[0]?.metadata?.pendingAction ?? null;

  await appendChatMessage({
    supabase: db,
    userId: user.user_id,
    threadId: thread.id,
    role: "user",
    content: text,
    metadata: { channel: "telegram", activeRepo: repoFullName }
  });

  const answer = await answerShipBrainQuestion({
    supabase: db,
    userId: user.user_id,
    repoFullName,
    threadId: thread.id,
    message: text,
    limit: 8,
    pendingAction
  });

  // Store the action in metadata if there's a pending confirmation
  const messageMetadata: Record<string, any> = {
    channel: "telegram",
    activeRepo: answer.activeRepo
  };
  if (answer.action?.status === "pending_confirmation") {
    messageMetadata.pendingAction = answer.action;
  }

  await appendChatMessage({
    supabase: db,
    userId: user.user_id,
    threadId: thread.id,
    role: "assistant",
    content: answer.reply,
    metadata: messageMetadata
  });
  return answer.reply;
}

function helpText() {
  return [
    "*ShipBrain Telegram Assistant*",
    "",
    "Commands:",
    "• /prs - pending Draft PRs and release PRs",
    "• /plan <ticket> - analyze a spec and save an AI plan",
    "• /draft_pr <id or ticket> - create a Draft PR from a saved plan or ticket",
    "• /release_pr [tag] - create release draft PR from develop to main",
    "• /handbook - prepare release handbook for Product Managers",
    "• /incidents - open and investigating incidents",
    "• /analyze_incident <id> - AI incident analysis with release context",
    "• /create_hotfix <id> [develop|main] - create incident hotfix Draft PR",
    "• /sync_hotfix <id> - refresh hotfix PR commits",
    "• /approve_fix <id> - merge hotfix and dispatch dev/prod deploy",
    "• /postmortem <id> - generate and save post-mortem",
    "• /releases - recent release status",
    "• /pending - commits on develop not yet released",
    "• /ci - latest CI workflow runs",
    "• /deployments - pending dev/prod deployment queue",
    "• /status - release trace pending-action summary",
    "• /traces - active release traces",
    "• /trace <id> - release trace detail and timeline",
    "• /approve <id|pr> - approve pending release/deploy action",
    "• /deploy_dev <id> - start develop preview deployment",
    "• /deploy_prod <id> [tag] - tag and deploy production release",
    "• /deploy <id> - auto: preview → release PR → production",
    "• /redeploy_dev <id> - re-run develop preview deployment",
    "• /redeploy_prod <id> - re-run production deployment for an existing release",
    "• /rollback_releases - list releases available for rollback",
    "• /rollback <tag> - rollback to a previous release by tag",
    "• /rollback_status - show active rollback status",
    "• /incident <id> - incident detail, hotfix PR, and reverse-sync status",
    "• /help - show this menu",
    "",
    "Use the short id shown by /deployments or /prs. Every deploy command writes a ShipBrain audit event."
  ].join("\n");
}

async function connectedRepos(userId: string) {
  const db = getSupabaseAdminClient();
  const { data } = await db.from("repos").select("full_name").eq("user_id", userId);
  return (data ?? []).map((repo) => repo.full_name);
}

async function activeRepo(userId: string) {
  const db = getSupabaseAdminClient();
  const { data: selected } = await db
    .from("user_active_repos")
    .select("repo_full_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (selected?.repo_full_name) return selected.repo_full_name;

  const { data: repo } = await db
    .from("repos")
    .select("full_name")
    .eq("user_id", userId)
    .order("connected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return repo?.full_name ?? null;
}

async function findSpec(user: TelegramUser, token?: string) {
  if (!token) throw new Error("Missing spec id. Run /prs or /deployments and use the short id shown there.");
  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) throw new Error("No connected repositories yet.");
  const normalized = normalizeToken(token);
  const { data, error } = await db
    .from("specs")
    .select("*")
    .eq("user_id", user.user_id)
    .in("repo_full_name", repos)
    .order("updated_at", { ascending: false })
    .limit(60);
  if (error) throw new Error(error.message);
  const match = (data ?? []).find((spec) =>
    String(spec.id).startsWith(normalized) ||
    String(spec.pr_number ?? "") === normalized ||
    String(spec.release_pr_number ?? "") === normalized
  );
  if (!match) throw new Error(`No ShipBrain spec found for "${normalized}".`);
  return match;
}

async function findIncident(user: TelegramUser, token?: string) {
  if (!token) throw new Error("Missing incident id. Run /incidents and use the short id shown there.");
  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) throw new Error("No connected repositories yet.");
  const normalized = normalizeToken(token);
  const { data, error } = await db
    .from("incidents")
    .select("*")
    .eq("user_id", user.user_id)
    .in("repo_full_name", repos)
    .order("updated_at", { ascending: false })
    .limit(60);
  if (error) throw new Error(error.message);
  const match = (data ?? []).find((incident) => String(incident.id).startsWith(normalized));
  if (!match) throw new Error(`No incident found for "${normalized}".`);
  return match;
}

function mapIncident(row: any) {
  return {
    id: row.id,
    source: row.alert_source === "pagerduty" ? "production-alert" : row.alert_source,
    status: row.status,
    title: row.title ?? "Incident reported",
    logs: row.raw_logs,
    repo: row.repo_full_name,
    environment: row.environment,
    service: row.service,
    severity: row.severity,
    branch: row.branch,
    commit: row.commit_sha,
    releaseVersion: row.release_version,
    rootCause: row.root_cause,
    fixProposal: row.ai_fix_proposal,
    postmortem: row.postmortem_draft,
    aiAnalysis: row.ai_analysis ?? null,
    hotfixBranch: row.hotfix_branch,
    hotfixBaseBranch: row.hotfix_base_branch,
    hotfixPrNumber: row.hotfix_pr_number,
    hotfixPrUrl: row.hotfix_pr_url,
    hotfixPrStatus: row.hotfix_pr_status,
    hotfixMergeSha: row.hotfix_merge_sha,
    hotfixCommits: row.hotfix_commits ?? [],
    reverseSyncPrNumber: row.reverse_sync_pr_number,
    reverseSyncPrUrl: row.reverse_sync_pr_url,
    reverseSyncPrStatus: row.reverse_sync_pr_status
  };
}

export async function getPendingPrs(user: TelegramUser) {
  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) return "No connected repositories yet.";
  const { data, error } = await db
    .from("specs")
    .select("id, repo_full_name, raw_spec, pr_number, pr_url, status, branch_name, base_branch, release_pr_number, release_pr_url, release_pr_status, release_status, updated_at")
    .eq("user_id", user.user_id)
    .in("repo_full_name", repos)
    .or("status.in.(pending_pr,draft_created,merged),release_status.in.(ready_for_prod,pending_deploy)")
    .order("updated_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  if (!data?.length) return "No pending PRs need attention right now.";
  return [
    "📋 *Pending ShipBrain PRs*",
    "",
    ...data.map((item, index) => [
      `${index + 1}. ${item.pr_number ? `#${item.pr_number}` : shortId(item.id)} - ${escapeTelegram(item.raw_spec).slice(0, 70)}`,
      `   Repo: \`${item.repo_full_name}\``,
      `   Branch: \`${item.branch_name ?? "n/a"} -> ${item.base_branch ?? "n/a"}\``,
      `   Status: ${item.release_status !== "not_started" ? item.release_status : item.status}`
    ].join("\n"))
  ].join("\n");
}

export async function createAiPlan(user: TelegramUser, rawTicket: string) {
  const rawSpec = rawTicket.trim();
  if (!rawSpec) return "Send a ticket after the command. Example: /plan Change cart heading color to green.";
  const db = getSupabaseAdminClient();
  const repoFullName = await activeRepo(user.user_id);
  if (!repoFullName) return "No active repository found. Connect a repo in ShipBrain first.";

  const plan = await decomposeSpec(rawSpec, repoFullName);
  const { data, error } = await db
    .from("specs")
    .insert({
      user_id: user.user_id,
      raw_spec: rawSpec,
      repo_full_name: repoFullName,
      branch_name: plan.suggestedBranch,
      base_branch: "develop",
      decomposed_tasks: plan,
      status: "draft",
      updated_at: new Date().toISOString()
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  await createOrUpdateTrace({
    userId: user.user_id,
    repoFullName,
    type: "feature",
    title: plan.prTitle,
    description: rawSpec,
    status: "draft",
    sourceBranch: plan.suggestedBranch,
    targetBranch: "develop",
    specId: data.id,
    source: "telegram",
    actor: "telegram",
    eventType: "trace_created",
    details: { command: "/plan" }
  });

  return [
    "🧠 *AI plan saved*",
    `Spec: \`${shortId(data.id)}\` · Repo: \`${repoFullName}\``,
    `PR title: ${escapeTelegram(plan.prTitle)}`,
    `Branch: \`${plan.suggestedBranch}\` -> \`develop\``,
    "",
    ...plan.tasks.slice(0, 5).map((task, index) => `${index + 1}. ${escapeTelegram(task.title)} - ${escapeTelegram(task.files.join(", "))}`),
    "",
    `Next: /draft_pr ${shortId(data.id)}`
  ].join("\n");
}

export async function createTelegramDraftPr(user: TelegramUser, inputText: string) {
  const db = getSupabaseAdminClient();
  const input = inputText.trim();
  if (!input) return "Send a saved spec id or a ticket. Example: /draft_pr abc12345";

  let spec: any | null = null;
  let rawSpec = input;
  try {
    spec = await findSpec(user, input.split(/\s+/)[0]);
    rawSpec = spec.raw_spec;
  } catch {
    spec = null;
  }

  const repoFullName = spec?.repo_full_name ?? await activeRepo(user.user_id);
  if (!repoFullName) return "No active repository found. Connect a repo in ShipBrain first.";
  const { owner, repo } = splitRepo(repoFullName);
  const plan = spec?.decomposed_tasks ? specPlanSchema.parse(spec.decomposed_tasks) : await decomposeSpec(rawSpec, repoFullName);
  const handoffOnly = /shipbrain-codegen:\s*handoff-only/i.test(rawSpec) || /shipbrain-codegen:\s*handoff-only/i.test(plan.prBody ?? "");
  const scaffold = await generateScaffold(handoffOnly ? { ...plan, prBody: `${plan.prBody}\n\nShipBrain-codegen: handoff-only` } : plan);
  const branch = spec?.branch_name || plan.suggestedBranch;
  const base = spec?.base_branch || "develop";

  const pr = await createDraftPR({
    owner,
    repo,
    base,
    branch,
    title: plan.prTitle,
    body: `${plan.prBody}\n\nCreated from Telegram by ShipBrain.`,
    files: scaffold,
    reviewers: plan.suggestedReviewers
  });

  const payload = {
    user_id: user.user_id,
    raw_spec: rawSpec,
    repo_full_name: repoFullName,
    branch_name: branch,
    base_branch: base,
    decomposed_tasks: plan,
    scaffold_code: scaffold,
    pr_number: pr.number,
    pr_url: pr.html_url,
    status: "draft_created",
    updated_at: new Date().toISOString()
  };

  const { data, error } = spec?.id
    ? await db.from("specs").update(payload).eq("id", spec.id).select("id").single()
    : await db.from("specs").insert(payload).select("id").single();
  if (error) throw new Error(error.message);

  await createOrUpdateTrace({
    userId: user.user_id,
    repoFullName,
    type: "feature",
    title: plan.prTitle,
    description: rawSpec,
    status: "draft",
    sourceBranch: branch,
    targetBranch: base,
    draftPrNumber: pr.number,
    draftPrUrl: pr.html_url,
    specId: data.id,
    source: "telegram",
    actor: "telegram",
    eventType: "pr_opened",
    details: { command: "/draft_pr", pr }
  });

  return [
    "✅ *Draft PR created*",
    `Spec: \`${shortId(data.id)}\` · PR #${pr.number}`,
    `Repo: \`${repoFullName}\``,
    `Branch: \`${branch}\` -> \`${base}\``,
    pr.html_url
  ].join("\n");
}

export async function getIncidents(user: TelegramUser) {
  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) return "No connected repositories yet.";
  const { data, error } = await db
    .from("incidents")
    .select("id, title, status, severity, service, repo_full_name, release_version, created_at")
    .eq("user_id", user.user_id)
    .in("repo_full_name", repos)
    .in("status", ["open", "investigating"])
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);

  if (!data?.length) return "✅ No open incidents.";
  return [
    "🚨 *Open Incidents*",
    "",
    ...data.map((item, index) => [
      `${index + 1}. \`${shortId(item.id)}\` - ${escapeTelegram(item.title ?? "Incident")}`,
      `   Severity: ${item.severity ?? "unknown"} · Status: ${item.status}`,
      `   Service: ${item.service ?? "app"} · Repo: \`${item.repo_full_name ?? "n/a"}\``,
      item.release_version ? `   Release: \`${item.release_version}\`` : "",
      `   Detail: /incident ${shortId(item.id)}`
    ].filter(Boolean).join("\n"))
  ].join("\n");
}

export async function getIncidentDetail(user: TelegramUser, token?: string) {
  if (!token) return "Missing incident id. Run /incidents and use the short id shown there.";
  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) return "No connected repositories yet.";
  const normalized = normalizeToken(token);

  const { data, error } = await db
    .from("incidents")
    .select("id, title, status, severity, service, repo_full_name, release_version, root_cause, ai_fix_proposal, ai_analysis, hotfix_branch, hotfix_pr_number, hotfix_pr_url, hotfix_pr_status, reverse_sync_pr_number, reverse_sync_pr_url, reverse_sync_pr_status, pagerduty_sync_status, updated_at")
    .eq("user_id", user.user_id)
    .in("repo_full_name", repos)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);

  const incident = (data ?? []).find((item) => String(item.id).startsWith(normalized));
  if (!incident) return `No incident found for "${normalized}". Run /incidents for current ids.`;

  const analysis = incident.ai_analysis as { rootCause?: string; summary?: string } | null;
  const rootCause = incident.root_cause ?? analysis?.rootCause ?? analysis?.summary;

  return [
    `🚨 *Incident ${shortId(incident.id)}*`,
    escapeTelegram(incident.title ?? "Incident"),
    "",
    `Status: ${incident.status} · Severity: ${incident.severity ?? "unknown"}`,
    `Service: ${incident.service ?? "app"} · Repo: \`${incident.repo_full_name ?? "n/a"}\``,
    incident.release_version ? `Release: \`${incident.release_version}\`` : "",
    incident.pagerduty_sync_status ? `PagerDuty sync: ${incident.pagerduty_sync_status}` : "",
    rootCause ? `Root cause: ${escapeTelegram(rootCause).slice(0, 420)}` : "Root cause: analysis pending",
    incident.ai_fix_proposal ? `AI fix: ${escapeTelegram(incident.ai_fix_proposal).slice(0, 420)}` : "",
    incident.hotfix_pr_number ? `Hotfix PR: #${incident.hotfix_pr_number} · ${incident.hotfix_pr_status ?? "open"}${incident.hotfix_pr_url ? ` · ${incident.hotfix_pr_url}` : ""}` : "Hotfix PR: not created yet",
    incident.hotfix_branch ? `Hotfix branch: \`${incident.hotfix_branch}\`` : "",
    incident.reverse_sync_pr_number ? `Reverse sync: #${incident.reverse_sync_pr_number} · ${incident.reverse_sync_pr_status ?? "open"}${incident.reverse_sync_pr_url ? ` · ${incident.reverse_sync_pr_url}` : ""}` : "Reverse sync: not started"
  ].filter(Boolean).join("\n");
}

async function incidentReleaseContext(user: TelegramUser, incident: any) {
  if (!incident.repo_full_name) return null;
  const db = getSupabaseAdminClient();
  let query = db
    .from("specs")
    .select("id, raw_spec, pr_number, pr_url, status, repo_full_name, branch_name, base_branch, release_tag, release_status, release_sha, merge_sha, release_pr_number, release_pr_url, release_pr_status, updated_at")
    .eq("user_id", user.user_id)
    .eq("repo_full_name", incident.repo_full_name)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (incident.release_version) query = query.eq("release_tag", incident.release_version);
  let { data: spec } = await query.maybeSingle();
  if (!spec && incident.release_version) {
    const fallback = await db
      .from("specs")
      .select("id, raw_spec, pr_number, pr_url, status, repo_full_name, branch_name, base_branch, release_tag, release_status, release_sha, merge_sha, release_pr_number, release_pr_url, release_pr_status, updated_at")
      .eq("user_id", user.user_id)
      .eq("repo_full_name", incident.repo_full_name)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    spec = fallback.data;
  }
  if (!spec) return null;
  const repoParts = splitRepo(incident.repo_full_name);
  const [featureCommits, releaseCommits] = await Promise.all([
    spec.pr_number ? listPullRequestCommits({ ...repoParts, pullNumber: spec.pr_number }).catch(() => []) : Promise.resolve([]),
    spec.release_pr_number ? listPullRequestCommits({ ...repoParts, pullNumber: spec.release_pr_number }).catch(() => []) : Promise.resolve([])
  ]);
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
    commits: { featurePr: featureCommits, releasePr: releaseCommits }
  };
}

export async function analyzeTelegramIncident(user: TelegramUser, token?: string) {
  const incident = await findIncident(user, token);

  // Build action context for Telegram
  const ctx = await buildTelegramActionContext(user.user_id, incident.repo_full_name || "");
  if (!ctx) {
    return "GitHub is not connected. Please link your GitHub account in settings.";
  }

  // Use unified analyzeIncident action
  const releaseContext = await incidentReleaseContext(user, incident);
  const result = await analyzeIncidentAction(ctx, {
    incidentId: incident.id,
    releaseContext
  });

  if (!result.ok) {
    return `❌ *Analysis failed:* ${escapeTelegram(result.error || result.message)}`;
  }

  const analysis = result.data;

  return [
    "🧠 *Incident analyzed*",
    `Incident: \`${shortId(incident.id)}\` · ${escapeTelegram(incident.title ?? "Incident")}`,
    `Confidence: ${Math.round((analysis?.confidence ?? 0) * 100)}%`,
    `Root cause: ${escapeTelegram(analysis?.rootCause ?? "Unknown").slice(0, 700)}`,
    `Fix: ${escapeTelegram(analysis?.fixProposal ?? "Pending").slice(0, 700)}`,
    "",
    `Next: /create_hotfix ${shortId(incident.id)} develop`
  ].join("\n");
}

function renderTelegramHotfixHandoff(input: { incident: any; analysis: any; releaseContext: any }) {
  const commits = [
    ...(input.releaseContext?.commits?.featurePr ?? []),
    ...(input.releaseContext?.commits?.releasePr ?? [])
  ];
  return [
    "# ShipBrain Incident Hotfix",
    "",
    `Incident: ${input.incident.title ?? input.incident.id}`,
    `Source release: ${input.incident.release_version ?? input.releaseContext?.release?.tag ?? "not captured"}`,
    `Repository: ${input.incident.repo_full_name}`,
    "",
    "## AI analysis",
    "",
    `Root cause: ${input.analysis?.rootCause ?? "Pending developer verification."}`,
    "",
    `Fix proposal: ${input.analysis?.fixProposal ?? "Pending developer implementation."}`,
    "",
    `How it occurred: ${input.analysis?.changeSummary ?? "ShipBrain did not receive enough commit context to infer a precise path."}`,
    "",
    "## Related release commits",
    commits.length
      ? commits.map((commit: any) => `- ${commit.shortSha ?? commit.sha?.slice(0, 7)} ${commit.message}`).join("\n")
      : "- No linked release commits were found.",
    "",
    "## Developer instructions",
    "",
    "1. Implement the fix on this hotfix branch.",
    "2. Keep commits focused and descriptive; ShipBrain will re-read this PR before manager approval.",
    "3. When the PR is reviewed, approve the incident fix in ShipBrain or Telegram.",
    "",
    "ShipBrain-codegen: incident-hotfix-handoff-only"
  ].join("\n");
}

export async function createTelegramHotfixPr(user: TelegramUser, token?: string, baseBranch?: string) {
  const incident = await findIncident(user, token);
  if (!incident.repo_full_name?.includes("/")) return "Incident is not linked to a connected GitHub repository.";
  if (incident.hotfix_pr_number) {
    return `Hotfix Draft PR already exists: #${incident.hotfix_pr_number}\n${incident.hotfix_pr_url}\nNext: /sync_hotfix ${shortId(incident.id)}`;
  }

  // If no branch specified, ask user to choose
  if (!baseBranch || !["develop", "main"].includes(baseBranch)) {
    return [
      "🔀 *Which branch should the hotfix target?*",
      "",
      "*develop* - Standard flow with preview validation",
      "  `/create_hotfix " + shortId(incident.id) + " develop`",
      "",
      "*main* - Direct to production (emergency only)",
      "  `/create_hotfix " + shortId(incident.id) + " main`"
    ].join("\n");
  }

  // Build action context for Telegram
  const ctx = await buildTelegramActionContext(user.user_id, incident.repo_full_name);
  if (!ctx) {
    return "GitHub is not connected. Please link your GitHub account in settings.";
  }

  // Get analysis context for the hotfix
  const analysis = incident.ai_analysis ?? {
    rootCause: incident.root_cause ?? "Pending analysis.",
    fixProposal: incident.ai_fix_proposal ?? "Pending developer implementation.",
    changeSummary: undefined,
    releaseContext: await incidentReleaseContext(user, incident)
  };

  // Use unified createHotfix action
  const result = await createHotfixAction(ctx, {
    incidentId: incident.id,
    baseBranch,
    analysis: {
      rootCause: analysis.rootCause,
      fixProposal: analysis.fixProposal,
      changeSummary: analysis.changeSummary,
      releaseContext: analysis.releaseContext
    }
  });

  if (!result.ok) {
    return `❌ *Failed to create hotfix:* ${escapeTelegram(result.error || result.message)}`;
  }

  const data = result.data;

  return [
    "🛠️ *Hotfix Draft PR created*",
    `Incident: \`${shortId(incident.id)}\` · Spec: \`${shortId(data?.specId ?? incident.id)}\``,
    `PR #${data?.prNumber}: ${data?.prUrl}`,
    `Branch: \`${data?.branch}\` -> \`${data?.baseBranch}\``,
    "",
    `After developer commits: /sync_hotfix ${shortId(incident.id)}`,
    `Manager approval: /approve_fix ${shortId(incident.id)}`
  ].join("\n");
}

export async function getReleases(user: TelegramUser) {
  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) return "No connected repositories yet.";
  const { data, error } = await db
    .from("specs")
    .select("id, repo_full_name, release_tag, release_status, production_url, deployed_at, updated_at")
    .eq("user_id", user.user_id)
    .in("repo_full_name", repos)
    .not("release_status", "eq", "not_started")
    .order("updated_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  if (!data?.length) return "No release history yet.";
  return [
    "🚀 *Recent Releases*",
    "",
    ...data.map((item, index) => [
      `${index + 1}. \`${item.release_tag ?? shortId(item.id)}\``,
      `   Repo: \`${item.repo_full_name}\``,
      `   Status: ${item.release_status}`,
      item.production_url ? `   URL: ${item.production_url}` : ""
    ].filter(Boolean).join("\n"))
  ].join("\n");
}

export async function getPendingCommits(user: TelegramUser) {
  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) return "No connected repositories yet.";

  const sections: string[] = ["📦 *Pending Commits (develop → main)*", ""];

  for (const repoFullName of repos.slice(0, 3)) {
    const ctx = await getRepoDeploymentContext(db, user.user_id, repoFullName);
    const repoName = repoFullName.split("/")[1] || repoFullName;

    if (!ctx.branchComparison) {
      sections.push(`*${escapeTelegram(repoName)}*: Unable to compare branches`);
      continue;
    }

    const { developAhead, developBehind } = ctx.branchComparison;

    if (developAhead === 0) {
      sections.push(`*${escapeTelegram(repoName)}*: ✅ In sync (no pending commits)`);
      continue;
    }

    sections.push(`*${escapeTelegram(repoName)}*: ${developAhead} commits ahead${developBehind > 0 ? `, ${developBehind} behind` : ""}`);

    if (ctx.pendingCommits.length > 0) {
      sections.push("");
      ctx.pendingCommits.slice(0, 5).forEach((commit, i) => {
        const msg = commit.message.length > 50 ? commit.message.slice(0, 50) + "..." : commit.message;
        sections.push(`  ${i + 1}. \`${commit.shortSha}\` ${escapeTelegram(msg)}`);
        if (commit.author) sections.push(`      by ${escapeTelegram(commit.author)}`);
      });
      if (ctx.pendingCommits.length > 5) {
        sections.push(`  ... and ${ctx.pendingCommits.length - 5} more`);
      }
    }
    sections.push("");
  }

  if (sections.length === 2) {
    return "No pending commits found.";
  }

  return sections.join("\n");
}

export async function getCiStatus(user: TelegramUser) {
  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) return "No connected repositories yet.";
  const { data, error } = await db
    .from("ci_runs")
    .select("repo_full_name, title, workflow_name, branch, conclusion, status, html_url, environment, preview_url, updated_at")
    .in("repo_full_name", repos)
    .order("updated_at", { ascending: false })
    .limit(5);
  if (error) throw new Error(error.message);
  if (!data?.length) return "No CI runs yet.";
  return [
    "⚙️ *Latest CI Runs*",
    "",
    ...data.map((item, index) => [
      `${index + 1}. ${escapeTelegram(item.title ?? item.workflow_name ?? "Workflow run")}`,
      `   Repo: \`${item.repo_full_name}\` · Branch: \`${item.branch ?? "n/a"}\``,
      `   Status: ${item.conclusion ?? item.status}${item.environment ? ` · Env: ${item.environment}` : ""}`,
      item.preview_url ? `   Preview: ${item.preview_url}` : "",
      item.html_url ? `   Run: ${item.html_url}` : ""
    ].filter(Boolean).join("\n"))
  ].join("\n");
}

export async function getPendingDeployments(user: TelegramUser) {
  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) return "No connected repositories yet.";

  const { data, error } = await db
    .from("specs")
    .select("id, repo_full_name, raw_spec, decomposed_tasks, pr_number, status, branch_name, base_branch, release_status, release_pr_number, release_pr_status, release_tag, preview_status, preview_url, production_url, updated_at")
    .eq("user_id", user.user_id)
    .in("repo_full_name", repos)
    .in("status", ["merged", "draft_created", "pending_pr"])
    .order("updated_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);

  // Group preview_ready specs by repo for consolidation
  const previewReadyByRepo = new Map<string, any[]>();
  const otherItems: string[] = [];

  for (const spec of data ?? []) {
    // Skip ShipBrain setup specs - they are for configuration, not deployments
    if (spec.branch_name?.startsWith("shipbrain/setup")) {
      continue;
    }

    const title = (spec.decomposed_tasks as { prTitle?: string } | null)?.prTitle ?? spec.raw_spec ?? `PR #${spec.pr_number}`;
    const id = shortId(spec.id);

    // Awaiting preview - show individually
    if (
      spec.status === "merged" &&
      spec.base_branch === "develop" &&
      !spec.release_pr_number &&
      spec.preview_status !== "deploying" &&
      !spec.preview_url
    ) {
      otherItems.push([
        `DEV  \`${id}\` - ${escapeTelegram(title).slice(0, 76)}`,
        `     Repo: \`${spec.repo_full_name}\` · PR #${spec.pr_number ?? "n/a"}`,
        `     Command: /deploy_dev ${id}`
      ].join("\n"));
    }

    // Preview ready - group by repo
    if (spec.preview_url && spec.base_branch === "develop" && !spec.release_pr_number) {
      const existing = previewReadyByRepo.get(spec.repo_full_name) ?? [];
      existing.push({ ...spec, title, id });
      previewReadyByRepo.set(spec.repo_full_name, existing);
    }

    // Release PR open - show individually
    if (spec.preview_url && spec.base_branch === "develop" && spec.release_pr_number && spec.release_pr_status !== "merged") {
      otherItems.push([
        `DEV  \`${id}\` - release pr open`,
        `     Repo: \`${spec.repo_full_name}\` · Release PR #${spec.release_pr_number}`,
        `     Merge PR then: /deploy_prod ${id}`
      ].join("\n"));
    }

    // Pending production deploy
    if (spec.release_status === "pending_deploy" && spec.release_pr_status === "merged") {
      otherItems.push([
        `PROD \`${id}\` - ${escapeTelegram(title).slice(0, 76)}`,
        `     Repo: \`${spec.repo_full_name}\` · Release PR #${spec.release_pr_number ?? "n/a"}`,
        `     Command: /deploy_prod ${id}`
      ].join("\n"));
    }

    // Deployed or failed
    if (["deployed", "failed"].includes(spec.release_status ?? "") && spec.release_tag) {
      otherItems.push([
        `PROD \`${id}\` - ${spec.release_tag} (${spec.release_status})`,
        `     Repo: \`${spec.repo_full_name}\`${spec.production_url ? ` · ${spec.production_url}` : ""}`,
        `     Command: /redeploy_prod ${id}`
      ].join("\n"));
    }
  }

  // Create consolidated items for preview_ready repos
  const consolidatedItems: string[] = [];
  for (const [repo, features] of previewReadyByRepo) {
    features.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    const mostRecent = features[0];

    if (features.length === 1) {
      consolidatedItems.push([
        `DEV  \`${mostRecent.id}\` - preview ready ✅`,
        `     Repo: \`${repo}\` · ${mostRecent.preview_url}`,
        `     Create Release PR: /deploy ${mostRecent.id}`
      ].join("\n"));
    } else {
      const prList = features.slice(0, 5).map(f => `#${f.pr_number}`).join(", ");
      consolidatedItems.push([
        `DEV  \`${mostRecent.id}\` - ${features.length} features ready ✅`,
        `     Repo: \`${repo}\` · PRs: ${prList}`,
        `     Create Release PR (all features): /deploy ${mostRecent.id}`
      ].join("\n"));
    }
  }

  const queue = [...consolidatedItems, ...otherItems].slice(0, 8);

  if (!queue.length) return "✅ No pending deployments right now.";
  return ["🚦 *ShipBrain Deployment Queue*", "", ...queue].join("\n\n");
}

export async function getTraceStatus(user: TelegramUser) {
  const db = getSupabaseAdminClient();

  // Get fresh deployment context for all repos
  const repoContexts = await getAllReposDeploymentContext(db, user.user_id);

  const { data, error } = await db
    .from("release_traces")
    .select("id, title, repo_full_name, status, current_phase, pending_action, updated_at")
    .eq("user_id", user.user_id)
    .order("updated_at", { ascending: false })
    .limit(40);
  if (error) throw new Error(error.message);
  const traces = data ?? [];
  const pending = traces.filter((trace) => trace.pending_action).slice(0, 6);

  // Build current production section with pending commits info
  const prodSection = repoContexts.length
    ? [
        "*Current Production:*",
        ...repoContexts.slice(0, 3).map((ctx) => {
          const repoName = ctx.repoFullName.split("/")[1];
          const tag = ctx.currentTag ? `\`${ctx.currentTag}\`` : "not deployed";
          const pending = ctx.developAhead > 0
            ? ` (${ctx.developAhead} commits pending)`
            : "";
          return `• ${repoName}: ${tag}${pending}`;
        }),
        ""
      ]
    : [];

  return [
    "📊 *ShipBrain Release Status*",
    "",
    ...prodSection,
    `Active traces: ${traces.filter((trace) => !["completed", "cancelled"].includes(trace.status)).length}`,
    `Pending actions: ${pending.length}`,
    `Failed: ${traces.filter((trace) => trace.status === "failed").length}`,
    "",
    pending.length
      ? [
          "*Pending Actions:*",
          ...pending.map((trace, index) => {
            const action = trace.pending_action as { type?: string; description?: string } | null;
            return [
              `${index + 1}. \`${shortId(trace.id)}\` ${escapeTelegram(trace.title)}`,
              `   ${action?.type ?? "action"} - ${escapeTelegram(action?.description ?? "Needs attention")}`,
              `   Detail: /trace ${shortId(trace.id)}`
            ].join("\n");
          })
        ].join("\n")
      : "✅ No pending release actions."
  ].join("\n");
}

export async function getReleaseTraces(user: TelegramUser) {
  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from("release_traces")
    .select("id, title, type, repo_full_name, status, current_phase, source_branch, target_branch, pending_action, updated_at")
    .eq("user_id", user.user_id)
    .not("status", "in", "(completed,cancelled)")
    .order("updated_at", { ascending: false })
    .limit(8);
  if (error) throw new Error(error.message);
  if (!data?.length) return "No active release traces yet.";
  return [
    "🚀 *Active Release Traces*",
    "",
    ...data.map((trace, index) => [
      `${index + 1}. \`${shortId(trace.id)}\` ${trace.type === "hotfix" ? "HOTFIX: " : ""}${escapeTelegram(trace.title)}`,
      `   \`${trace.source_branch}\` -> \`${trace.target_branch}\``,
      `   Status: ${trace.status} · Phase: ${trace.current_phase}`,
      trace.pending_action ? `   Action: ${escapeTelegram((trace.pending_action as any).description ?? "Needs attention")}` : "",
      `   Detail: /trace ${shortId(trace.id)}`
    ].filter(Boolean).join("\n"))
  ].join("\n");
}

export async function getReleaseTraceDetail(user: TelegramUser, token?: string) {
  if (!token) return "Missing trace id. Run /traces and use the short id shown there.";
  const db = getSupabaseAdminClient();
  const normalized = normalizeToken(token);
  const { data: traces, error } = await db
    .from("release_traces")
    .select("*")
    .eq("user_id", user.user_id)
    .order("updated_at", { ascending: false })
    .limit(60);
  if (error) throw new Error(error.message);
  const trace = (traces ?? []).find((item) => String(item.id).startsWith(normalized));
  if (!trace) return `No release trace found for "${normalized}". Run /traces for current ids.`;
  const { data: events } = await db
    .from("trace_events")
    .select("event_type, actor, source, details, created_at")
    .eq("trace_id", trace.id)
    .order("created_at", { ascending: false })
    .limit(6);
  const action = trace.pending_action as { type?: string; description?: string } | null;
  return [
    `📋 *Trace ${shortId(trace.id)}*`,
    `${trace.type === "hotfix" ? "🔥 " : ""}${escapeTelegram(trace.title)}`,
    "",
    `Repo: \`${trace.repo_full_name}\``,
    `Branch: \`${trace.source_branch}\` -> \`${trace.target_branch}\``,
    `Status: ${trace.status} · Phase: ${trace.current_phase}`,
    trace.draft_pr_url ? `Draft PR: #${trace.draft_pr_number} ${trace.draft_pr_url}` : "",
    trace.release_pr_url ? `Release PR: #${trace.release_pr_number} ${trace.release_pr_url}` : "",
    trace.preview_deployment?.url ? `Preview: ${trace.preview_deployment.url}` : "",
    trace.production_deployment?.url ? `Production workflow: ${trace.production_deployment.url}` : "",
    action ? `Action: ${action.type} - ${escapeTelegram(action.description ?? "")}` : "Action: none",
    "",
    "*Timeline:*",
    ...(events ?? []).map((event) => `- ${event.event_type} · ${event.source} · ${new Date(event.created_at).toLocaleString("en-IN")}`)
  ].filter(Boolean).join("\n");
}

async function findTrace(user: TelegramUser, token?: string) {
  if (!token) throw new Error("Missing trace id. Run /traces or /status first.");
  const db = getSupabaseAdminClient();
  const normalized = normalizeToken(token);
  const { data, error } = await db
    .from("release_traces")
    .select("*")
    .eq("user_id", user.user_id)
    .order("updated_at", { ascending: false })
    .limit(80);
  if (error) throw new Error(error.message);
  const trace = (data ?? []).find((item) =>
    String(item.id).startsWith(normalized) ||
    String(item.draft_pr_number ?? "") === normalized ||
    String(item.release_pr_number ?? "") === normalized
  );
  if (!trace) throw new Error(`No release trace found for "${normalized}".`);
  return trace;
}

export async function approveTraceFromTelegram(user: TelegramUser, token?: string) {
  const trace = await findTrace(user, token);
  const action = trace.pending_action as { type?: string } | null;

  if (trace.spec_id && trace.status === "merged_develop") {
    return startPreviewDeployment(user, String(trace.spec_id));
  }
  if (trace.spec_id && (action?.type === "create_release_pr" || trace.status === "preview_live")) {
    // Use unified createReleasePR action
    const ctx = await buildTelegramActionContext(user.user_id, trace.repo_full_name);
    if (!ctx) {
      return "GitHub is not connected. Please link your GitHub account in settings.";
    }

    const result = await createReleasePRAction(ctx, { repoFullName: trace.repo_full_name });
    if (!result.ok) {
      return `❌ Failed to create Release PR: ${escapeTelegram(result.error || result.message)}`;
    }

    return [
      "🚀 *Release PR created*",
      `Trace: \`${shortId(trace.id)}\` · PR #${result.data?.prNumber}`,
      `Release tag: \`${result.data?.releaseTag}\``,
      result.data?.prUrl ?? ""
    ].join("\n");
  }
  if (trace.spec_id && (action?.type === "approve_release" || trace.status === "release_pending" || trace.status === "merged_main")) {
    return startProductionDeployment(user, String(trace.spec_id));
  }
  if (trace.incident_id && action?.type === "merge_reverse_sync") {
    // Use unified mergeReverseSync action
    const ctx = await buildTelegramActionContext(user.user_id, trace.repo_full_name);
    if (!ctx) {
      return "GitHub is not connected. Please link your GitHub account in settings.";
    }

    const result = await mergeReverseSyncAction(ctx, { incidentId: trace.incident_id });
    if (!result.ok) {
      return `❌ Failed to merge reverse sync: ${escapeTelegram(result.error || result.message)}`;
    }

    return `✅ Reverse sync merged for trace \`${shortId(trace.id)}\` at \`${result.data?.mergeSha?.slice(0, 12) ?? "n/a"}\`.`;
  }
  if (trace.incident_id && ["draft", "ready_for_review"].includes(trace.status)) {
    return approveTelegramIncidentFix(user, String(trace.incident_id));
  }

  return `No approve action is currently available for trace ${shortId(trace.id)}. Current status: ${trace.status}.`;
}

async function findSpecForAction(user: TelegramUser, token?: string) {
  if (!token) throw new Error("Missing spec id. Run /deployments and use the short id shown there.");
  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) throw new Error("No connected repositories yet.");

  const normalized = normalizeToken(token);
  const { data, error } = await db
    .from("specs")
    .select("*")
    .eq("user_id", user.user_id)
    .in("repo_full_name", repos)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);

  const match = (data ?? []).find((spec) =>
    String(spec.id).startsWith(normalized) ||
    String(spec.pr_number ?? "") === normalized ||
    String(spec.release_pr_number ?? "") === normalized
  );
  if (!match) throw new Error(`No ShipBrain item found for "${normalized}". Run /deployments for current ids.`);
  return match;
}

async function defaultBranchForRepo(repoFullName: string) {
  const db = getSupabaseAdminClient();
  const { data } = await db.from("repos").select("default_branch").eq("full_name", repoFullName).maybeSingle();
  return data?.default_branch || "main";
}

export async function startPreviewDeployment(user: TelegramUser, token?: string, options: { redeploy?: boolean } = {}) {
  const spec = await findSpecForAction(user, token);

  // Preliminary validations for better Telegram UX
  if (spec.status !== "merged" || spec.base_branch !== "develop") {
    return `Preview deployment is only available after a feature PR is merged into develop. Current state: ${spec.status} -> ${spec.base_branch ?? "n/a"}.`;
  }

  if (spec.preview_status === "deploying" && !options.redeploy) {
    return "Preview deployment is already in progress. Check /ci or /deployments shortly.";
  }

  if (spec.preview_url && !options.redeploy) {
    return `Preview is already ready: ${spec.preview_url}\nUse /redeploy_dev ${shortId(spec.id)} if you want to run it again.`;
  }

  // Build action context for Telegram
  const ctx = await buildTelegramActionContext(user.user_id, spec.repo_full_name);
  if (!ctx) {
    return "GitHub is not connected. Please link your GitHub account in settings.";
  }

  // Use unified deployPreview action
  const result = await deployPreview(ctx, {
    specId: spec.id,
    forceRedeploy: options.redeploy
  });

  if (!result.ok) {
    return `❌ Preview deployment failed: ${result.error || result.message}`;
  }

  return [
    options.redeploy ? "🔁 Preview redeploy started." : "🚀 Preview deployment started.",
    `Repo: \`${spec.repo_full_name}\``,
    `Spec: \`${shortId(spec.id)}\` · PR #${spec.pr_number ?? "n/a"}`,
    `Workflow: ${result.data?.workflowUrl ?? "n/a"}`
  ].join("\n");
}

export async function syncTelegramHotfix(user: TelegramUser, token?: string) {
  const incident = await findIncident(user, token);
  if (!incident.hotfix_pr_number) return "No hotfix PR is linked yet. Use /create_hotfix <id> first.";

  // Build action context
  const ctx = await buildTelegramActionContext(user.user_id, incident.repo_full_name);
  if (!ctx) {
    return "GitHub is not connected. Please link your GitHub account in settings.";
  }

  // Use unified syncHotfix action
  const result = await syncHotfixAction(ctx, { incidentId: incident.id });

  if (!result.ok) {
    return `❌ ${result.error || result.message}`;
  }

  const commits = result.data?.commits || [];
  return [
    "🔄 *Hotfix commits synced*",
    `Incident: \`${shortId(incident.id)}\` · PR #${incident.hotfix_pr_number}`,
    commits.length ? commits.slice(0, 6).map((commit: any) => `- \`${commit.sha?.slice(0, 7)}\` ${escapeTelegram(commit.message)}`).join("\n") : "No commits found yet.",
    "",
    `Approve when reviewed: /approve_fix ${shortId(incident.id)}`
  ].join("\n");
}

export async function approveTelegramIncidentFix(user: TelegramUser, token?: string, options: { releaseTag?: string } = {}) {
  const incident = await findIncident(user, token);
  if (!incident.hotfix_pr_number) return "Create the incident hotfix Draft PR before approving the fix.";
  if (!incident.repo_full_name?.includes("/")) return "Incident is not linked to a connected GitHub repository.";

  const { owner, repo } = splitRepo(incident.repo_full_name);

  // Check if this is a production deployment (hotfix targeting main branch)
  // by fetching the PR to determine the base branch
  const octokit = getOctokit();
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: incident.hotfix_pr_number });
  const isProdDeployTarget = pr.base.ref === "main";

  // Prompt for release tag if deploying to production and no tag provided
  if (isProdDeployTarget && !options.releaseTag) {
    const defaultTag = hotfixReleaseTag(incident.id);
    return [
      "🏷️ *Confirm Hotfix Release Tag*",
      "",
      `Incident: \`${shortId(incident.id)}\``,
      `Hotfix PR: #${incident.hotfix_pr_number}`,
      `Target: \`main\` (production)`,
      "",
      `Default tag: \`${defaultTag}\``,
      "",
      "To deploy with default tag:",
      `  /approve\\_fix ${shortId(incident.id)} ${defaultTag}`,
      "",
      "Or specify a custom tag:",
      `  /approve\\_fix ${shortId(incident.id)} your-custom-tag`
    ].join("\n");
  }

  // Build action context for Telegram
  const ctx = await buildTelegramActionContext(user.user_id, incident.repo_full_name);
  if (!ctx) {
    return "GitHub is not connected. Please link your GitHub account in settings.";
  }

  // Use unified approveHotfix action
  const releaseTag = options.releaseTag || hotfixReleaseTag(incident.id);
  const result = await approveHotfixAction(ctx, {
    incidentId: incident.id,
    releaseTag,
    note: "Approved via Telegram"
  });

  if (!result.ok) {
    return `❌ *Hotfix approval failed:* ${escapeTelegram(result.error || result.message)}`;
  }

  const isProdDeploy = result.data?.isProdDeploy ?? false;
  const reverseSyncPr = result.data?.reverseSync;
  const workflowUrl = result.data?.workflowUrl;
  const mergeSha = result.data?.mergeSha;

  return [
    "✅ *Incident fix approved*",
    `Incident: \`${shortId(incident.id)}\` · PR #${incident.hotfix_pr_number}`,
    `Merged: SHA \`${mergeSha?.slice(0, 12) ?? "n/a"}\``,
    isProdDeploy ? `Release: \`${result.data?.releaseTag ?? releaseTag}\`` : "Preview deployment dispatched",
    workflowUrl ? `Workflow: ${workflowUrl}` : "",
    reverseSyncPr ? `Reverse sync PR: #${reverseSyncPr.prNumber} ${reverseSyncPr.prUrl}` : ""
  ].filter(Boolean).join("\n");
}

export async function generateTelegramPostmortem(user: TelegramUser, token?: string) {
  const db = getSupabaseAdminClient();
  const incident = await findIncident(user, token);
  const releaseContext = await incidentReleaseContext(user, incident);
  const mapped = mapIncident(incident);
  const analysis = incident.ai_analysis ?? {
    rootCause: incident.root_cause,
    fixProposal: incident.ai_fix_proposal,
    releaseContext
  };
  const { data: pastIncidents } = await db
    .from("incidents")
    .select("id, title, root_cause, ai_fix_proposal, postmortem_draft, created_at")
    .eq("user_id", user.user_id)
    .eq("repo_full_name", incident.repo_full_name)
    .eq("status", "resolved")
    .neq("id", incident.id)
    .order("created_at", { ascending: false });
  const postmortem = await generatePostmortem({
    incident: mapped,
    analysis,
    releaseContext,
    pastIncidents: pastIncidents ?? [],
    currentFixCommits: incident.hotfix_commits ?? []
  });
  await db.from("incidents").update({
    postmortem_draft: postmortem,
    updated_at: new Date().toISOString()
  }).eq("id", incident.id);

  return [
    "📄 *Post-mortem generated*",
    `Incident: \`${shortId(incident.id)}\` · ${escapeTelegram(incident.title ?? "Incident")}`,
    "",
    escapeTelegram(postmortem).slice(0, 3000)
  ].join("\n");
}

async function createReleasePrFromSpec(user: TelegramUser, spec: any) {
  const title = (spec.decomposed_tasks as { prTitle?: string } | null)?.prTitle ?? spec.raw_spec ?? `PR #${spec.pr_number}`;

  // Build action context for Telegram
  const ctx = await buildTelegramActionContext(user.user_id, spec.repo_full_name);
  if (!ctx) {
    return "GitHub is not connected. Please link your GitHub account in settings.";
  }

  // Use unified createReleasePR action
  const result = await createReleasePRAction(ctx, {
    repoFullName: spec.repo_full_name
  });

  if (!result.ok) {
    return `❌ Failed to create Release PR: ${result.error || result.message}`;
  }

  return [
    "🚀 *Release PR created*",
    `Spec: \`${shortId(spec.id)}\` · PR #${result.data?.prNumber}`,
    `Release tag: \`${result.data?.releaseTag}\``,
    `Feature: ${escapeTelegram(title).slice(0, 60)}`,
    "",
    result.data?.prUrl ?? "",
    "",
    `Next step: Merge the PR then run /deploy_prod ${shortId(spec.id)}`
  ].join("\n");
}

export async function startAutoDeployment(user: TelegramUser, token?: string, options: { redeploy?: boolean } = {}) {
  const spec = await findSpecForAction(user, token);

  if (options.redeploy) {
    if (["deployed", "failed", "pending_deploy"].includes(spec.release_status ?? "") && spec.release_tag) {
      return startProductionDeployment(user, token, { redeploy: true });
    }
    if (spec.status === "merged" && spec.base_branch === "develop") {
      return startPreviewDeployment(user, token, { redeploy: true });
    }
    return `No redeploy action is available for ${shortId(spec.id)}. Current state: ${spec.status} / ${spec.release_status ?? "not_started"}.`;
  }

  if (spec.release_status === "pending_deploy" && spec.release_pr_status === "merged") {
    return startProductionDeployment(user, token);
  }

  // Preview ready, no release PR → create release PR
  if (spec.status === "merged" && spec.base_branch === "develop" && !spec.release_pr_number && (spec.preview_url || spec.preview_status === "deployed")) {
    return createReleasePrFromSpec(user, spec);
  }

  // Merged to develop but no preview yet → start preview deployment
  if (spec.status === "merged" && spec.base_branch === "develop" && !spec.release_pr_number) {
    return startPreviewDeployment(user, token);
  }

  return `No deploy action is available for ${shortId(spec.id)}. Current state: ${spec.status} / ${spec.release_status ?? "not_started"}.`;
}

async function resolveReleaseSha(owner: string, repo: string, sha: string) {
  if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
  const octokit = getOctokit();
  const { data: commit } = await octokit.git.getCommit({ owner, repo, commit_sha: sha });
  return commit.sha;
}

export async function startProductionDeployment(user: TelegramUser, token?: string, options: { redeploy?: boolean; releaseTag?: string } = {}) {
  const db = getSupabaseAdminClient();
  const spec = await findSpecForAction(user, token);

  // Preliminary validations for better Telegram UX
  if (options.redeploy) {
    if (!["deployed", "failed", "pending_deploy"].includes(spec.release_status ?? "")) {
      return `Production redeploy is not available for release status "${spec.release_status ?? "not_started"}".`;
    }
    if (!spec.release_tag || !spec.release_sha) {
      return "Production redeploy needs an existing release tag and release SHA.";
    }
  } else {
    // Smart guidance based on current state
    const isFeatureMergedToDevelop = spec.status === "merged" && spec.base_branch === "develop";

    if (isFeatureMergedToDevelop) {
      if (!spec.release_pr_number) {
        return [
          "⚠️ *No release PR exists yet*",
          "",
          "Create a Release PR first:",
          `• Use /deploy ${shortId(spec.id)} to create one`,
          "• Or use the Deployment Queue in the web UI",
          "",
          "Then merge the PR and run /deploy\\_prod again."
        ].join("\n");
      }
      if (spec.release_pr_status !== "merged") {
        return [
          "⚠️ *Release PR not merged yet*",
          "",
          `Please review and merge Release PR #${spec.release_pr_number} on GitHub first.`,
          spec.release_pr_url ? `\n${spec.release_pr_url}` : "",
          "",
          "After merging, run /deploy\\_prod again."
        ].join("\n");
      }
    }

    // Fallback check for pending_deploy status
    if (spec.release_status !== "pending_deploy" && spec.release_pr_status !== "merged") {
      return `Production deployment needs a merged release PR. Current state: ${spec.release_pr_status ?? "n/a"} / ${spec.release_status ?? "n/a"}.`;
    }
  }

  // If no release tag provided, ask for confirmation with default tag
  const defaultTag = spec.release_tag || await getNextSemverReleaseTag(db, spec.repo_full_name);
  if (!options.releaseTag && !options.redeploy) {
    return [
      "🏷️ *Confirm Release Tag*",
      "",
      `Default tag: \`${defaultTag}\``,
      "",
      "To deploy with default tag:",
      `  /deploy\\_prod ${shortId(spec.id)} ${defaultTag}`,
      "",
      "Or customize the tag:",
      `  /deploy\\_prod ${shortId(spec.id)} your-custom-tag`
    ].join("\n");
  }

  // Build action context for Telegram
  const ctx = await buildTelegramActionContext(user.user_id, spec.repo_full_name);
  if (!ctx) {
    return "GitHub is not connected. Please link your GitHub account in settings.";
  }

  // Use unified deployProduction action
  const releaseTag = options.releaseTag || defaultTag;
  const result = await deployProduction(ctx, {
    specId: spec.id,
    releaseTag,
    releaseSha: spec.release_sha || spec.merge_sha,
    forceRedeploy: options.redeploy
  });

  if (!result.ok) {
    // Check for specific action hints
    if (result.error?.includes("No release PR exists")) {
      return [
        "⚠️ *No release PR exists yet*",
        "",
        "Create a Release PR first:",
        `• Use /deploy ${shortId(spec.id)} to create one`,
        "",
        "Then merge the PR and run /deploy\\_prod again."
      ].join("\n");
    }

    if (result.error?.includes("not merged yet")) {
      return [
        "⚠️ *Release PR not merged yet*",
        "",
        `Please merge the Release PR on GitHub first.`,
        "",
        "After merging, run /deploy\\_prod again."
      ].join("\n");
    }

    return `❌ Production deployment failed: ${result.error || result.message}`;
  }

  return [
    options.redeploy ? "🔁 Production redeploy started." : "🏷️ Production tag and deploy started.",
    `Repo: \`${spec.repo_full_name}\``,
    `Release: \`${result.data?.releaseTag ?? releaseTag}\``,
    `SHA: \`${result.data?.releaseSha?.slice(0, 12) ?? "n/a"}\``,
    `Workflow: ${result.data?.workflowUrl ?? "n/a"}`
  ].join("\n");
}

export async function getRollbackReleases(user: TelegramUser) {
  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) return "No connected repositories yet.";

  // Get fresh deployment context to find current production
  const repoContexts = await getAllReposDeploymentContext(db, user.user_id);
  const currentTags = new Set(repoContexts.map(c => c.currentTag).filter(Boolean));

  const { data, error } = await db
    .from("specs")
    .select("id, repo_full_name, release_tag, release_sha, release_status, deployed_at, decomposed_tasks")
    .eq("user_id", user.user_id)
    .in("repo_full_name", repos)
    .eq("release_status", "deployed")
    .eq("base_branch", "main")
    .not("release_tag", "is", null)
    .order("deployed_at", { ascending: false, nullsFirst: false })
    .limit(10);

  if (error) throw new Error(error.message);
  if (!data?.length) return "No releases available for rollback yet.";

  // Build current production info
  const currentProdInfo = repoContexts.length
    ? repoContexts.slice(0, 3).map(ctx => {
        const tag = ctx.currentTag ? `\`${ctx.currentTag}\`` : "none";
        return `• ${ctx.repoFullName.split("/")[1]}: ${tag}`;
      }).join("\n")
    : "None deployed";

  return [
    "🔄 *Available releases for rollback*",
    "",
    "*Current Production:*",
    currentProdInfo,
    "",
    "*Previous Releases:*",
    ...data
      .filter(item => !currentTags.has(item.release_tag)) // Exclude current production
      .slice(0, 8)
      .map((item, index) => {
        const tasks = item.decomposed_tasks as { prTitle?: string } | null;
        const title = tasks?.prTitle ?? "Release";
        const date = item.deployed_at ? new Date(item.deployed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "n/a";
        return `${index + 1}. \`${item.release_tag}\` - ${escapeTelegram(title).slice(0, 50)} (${date})`;
      }),
    "",
    "To rollback: /rollback <tag>"
  ].join("\n");
}

export async function getRollbackStatus(user: TelegramUser) {
  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) return "No connected repositories yet.";

  const { data: activeRollbacks } = await db
    .from("rollback_history")
    .select("*")
    .eq("user_id", user.user_id)
    .in("repo_full_name", repos)
    .in("status", ["pending", "deploying"])
    .order("created_at", { ascending: false })
    .limit(5);

  const { data: rollingBackTraces } = await db
    .from("release_traces")
    .select("id, title, repo_full_name, status, rollback_source_tag, rollback_target_tag, updated_at")
    .eq("user_id", user.user_id)
    .in("repo_full_name", repos)
    .eq("status", "rolling_back")
    .order("updated_at", { ascending: false })
    .limit(5);

  if (!activeRollbacks?.length && !rollingBackTraces?.length) {
    return "✅ No active rollbacks in progress.";
  }

  const lines = ["🔄 *Active Rollbacks*", ""];

  if (activeRollbacks?.length) {
    lines.push("*Rollback History:*");
    for (const rollback of activeRollbacks) {
      const startTime = new Date(rollback.initiated_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      lines.push(`• \`${rollback.repo_full_name}\`: ${rollback.source_release_tag} → ${rollback.target_release_tag}`);
      lines.push(`  Status: ${rollback.status} · Started: ${startTime}`);
      if (rollback.workflow_url) lines.push(`  Workflow: ${rollback.workflow_url}`);
    }
    lines.push("");
  }

  if (rollingBackTraces?.length) {
    lines.push("*Rolling Back Traces:*");
    for (const trace of rollingBackTraces) {
      lines.push(`• \`${shortId(trace.id)}\` ${escapeTelegram(trace.title)}`);
      lines.push(`  ${trace.rollback_source_tag ?? "current"} → ${trace.rollback_target_tag ?? "target"}`);
    }
  }

  return lines.join("\n");
}

export async function initiateRollbackFromTelegram(user: TelegramUser, token?: string) {
  if (!token?.trim()) return "Missing release tag. Run /rollback_releases to see available tags.";

  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) return "No connected repositories yet.";

  const targetTag = token.trim();

  // Find target spec to get the repo name
  const { data: targetSpec } = await db
    .from("specs")
    .select("id, repo_full_name, release_tag, release_sha, decomposed_tasks")
    .eq("user_id", user.user_id)
    .in("repo_full_name", repos)
    .eq("release_tag", targetTag)
    .eq("release_status", "deployed")
    .eq("base_branch", "main")
    .maybeSingle();

  if (!targetSpec) {
    return `No deployed release found for tag "${targetTag}". Run /rollback_releases for available tags.`;
  }

  // Build action context for Telegram
  const ctx = await buildTelegramActionContext(user.user_id, targetSpec.repo_full_name);
  if (!ctx) {
    return "GitHub is not connected. Please link your GitHub account in settings.";
  }

  // Use unified rollback action
  const result = await rollbackAction(ctx, {
    targetReleaseTag: targetTag,
    repoFullName: targetSpec.repo_full_name
  });

  if (!result.ok) {
    return `❌ Rollback failed: ${result.error || result.message}`;
  }

  const tasks = targetSpec.decomposed_tasks as { prTitle?: string } | null;
  const title = tasks?.prTitle ?? "Release";

  return [
    "🔄 *Rollback initiated*",
    `Repo: \`${targetSpec.repo_full_name}\``,
    `From: \`${result.data?.sourceTag ?? "current"}\``,
    `To: \`${targetTag}\``,
    `Title: ${escapeTelegram(title).slice(0, 60)}`,
    `SHA: \`${targetSpec.release_sha?.slice(0, 12) ?? "n/a"}\``,
    `Workflow: ${result.data?.workflowUrl ?? "n/a"}`,
    "",
    "Check progress: /rollback_status"
  ].join("\n");
}

export async function resolveTelegramIncident(user: TelegramUser, token?: string, note: string = "Resolved via Telegram") {
  const incident = await findIncident(user, token);

  // Build action context for Telegram
  const ctx = await buildTelegramActionContext(user.user_id, incident.repo_full_name || "");
  if (!ctx) {
    return "GitHub is not connected. Please link your GitHub account in settings.";
  }

  // Use unified resolveIncident action
  const result = await resolveIncidentAction(ctx, {
    incidentId: incident.id,
    note
  });

  if (!result.ok) {
    return `❌ *Failed to resolve incident:* ${escapeTelegram(result.error || result.message)}`;
  }

  return [
    "✅ *Incident resolved manually*",
    `Incident: \`${shortId(incident.id)}\` · ${escapeTelegram(incident.title ?? "Incident")}`,
    `Status: \`resolved\``,
    `Audit message: _${escapeTelegram(note)}_`
  ].join("\n");
}

export async function prepareTelegramReleaseHandbook(user: TelegramUser) {
  const db = getSupabaseAdminClient();
  const repoFullName = await activeRepo(user.user_id);
  if (!repoFullName) return "No active repository selected.";

  const { data: traces } = await db
    .from("release_traces")
    .select("*")
    .eq("user_id", user.user_id)
    .eq("repo_full_name", repoFullName)
    .eq("type", "release")
    .order("updated_at", { ascending: false });

  const latestRelease = traces?.find(
    (t) => t.status === "production_live" || t.status === "completed"
  ) || traces?.[0];

  if (!latestRelease) {
    return "No recent completed production release trace found.";
  }

  const { data: specs } = await db
    .from("specs")
    .select("title, pr_number, pr_url, branch_name, status, release_status, release_tag, release_pr_number")
    .eq("repo_full_name", repoFullName)
    .eq("user_id", user.user_id);

  const releaseSpecs = (specs ?? []).filter(
    (s) => s.release_tag === latestRelease.title || s.release_pr_number === latestRelease.release_pr_number || s.status === "merged" || s.release_status === "deployed"
  );

  const features = releaseSpecs.slice(0, 10).map((s, idx) => {
    const title = s.title ?? `Feature #${idx + 1}`;
    const prStr = s.pr_number ? ` (PR #${s.pr_number})` : "";
    return `• *${escapeTelegram(title)}*${escapeTelegram(prStr)}`;
  }).join("\n");

  const date = latestRelease.updated_at ? new Date(latestRelease.updated_at).toLocaleDateString() : "recent";

  return [
    `📘 *Product Manager Release Handbook*`,
    `-----------------------------------------`,
    `*Repository:* \`${escapeTelegram(repoFullName)}\``,
    `*Release Tag:* \`${escapeTelegram(latestRelease.title ?? latestRelease.id.slice(0, 8))}\``,
    `*Deployed At:* \`${escapeTelegram(date)}\``,
    `*Release PR:* \`${latestRelease.release_pr_number ? "#" + latestRelease.release_pr_number : "N/A"}\``,
    `*Status:* \`${escapeTelegram(latestRelease.status)}\``,
    ``,
    `🚀 *Key Features Delivered:*`,
    features || "• No feature specs found in this release.",
    ``,
    `💡 *PM Notes:*`,
    `All features have been successfully verified on preview and are now live in production. Ready for customer communication and verification.`
  ].join("\n");
}

export async function createReleasePrFromTelegram(user: TelegramUser, customTag?: string) {
  const repoFullName = await activeRepo(user.user_id);
  if (!repoFullName) return "No active repository selected.";

  // Build action context for Telegram
  const ctx = await buildTelegramActionContext(user.user_id, repoFullName);
  if (!ctx) {
    return "GitHub is not connected. Please link your GitHub account in settings.";
  }

  // Use unified createReleasePR action
  const result = await createReleasePRAction(ctx, {
    repoFullName,
    releaseTag: customTag?.trim() || undefined
  });

  if (!result.ok) {
    return `❌ *Failed to create Release PR:* ${escapeTelegram(result.error || result.message)}`;
  }

  return [
    `✅ *Release Draft PR Created!*`,
    `Repository: \`${escapeTelegram(repoFullName)}\``,
    `PR: [#${result.data?.prNumber}](${result.data?.prUrl})`,
    `Release Tag: \`${escapeTelegram(result.data?.releaseTag ?? "")}\``
  ].join("\n");
}
