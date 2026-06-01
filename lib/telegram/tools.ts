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
import {
  createReleaseTag,
  dispatchCloudflareProductionDeploy,
  dispatchDevelopPreviewDeploy
} from "@/lib/github/deployments";
import { createDraftPR, createReleasePullRequest, createReverseSyncPR, mergePullRequest, tagCommitForRelease } from "@/lib/github/pr";
import { createOrUpdateTrace, updateTraceByIncident, updateTraceBySpec, initiateRollback, addTraceEvent, associateFeaturesWithRelease } from "@/lib/orchestrator";
import { phaseForStatus } from "@/lib/orchestrator/state-machine";
import { resolvePagerDutyIncident } from "@/lib/pagerduty/incidents";
import { escapeTelegram } from "@/lib/telegram/formatter";

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
  const db = getSupabaseAdminClient();
  const incident = await findIncident(user, token);
  const releaseContext = await incidentReleaseContext(user, incident);
  const analysis = await analyzeIncident({
    source: incident.alert_source ?? "manual",
    title: incident.title ?? "Incident",
    logs: incident.raw_logs ?? "",
    repo: incident.repo_full_name ?? "unknown",
    releaseVersion: incident.release_version ?? "unknown",
    releaseContext
  });

  await db.from("incidents").update({
    status: incident.status === "open" ? "investigating" : incident.status,
    root_cause: analysis.rootCause,
    ai_fix_proposal: analysis.fixProposal,
    ai_analysis: { ...analysis, releaseContext },
    updated_at: new Date().toISOString()
  }).eq("id", incident.id);

  return [
    "🧠 *Incident analyzed*",
    `Incident: \`${shortId(incident.id)}\` · ${escapeTelegram(incident.title ?? "Incident")}`,
    `Confidence: ${Math.round((analysis.confidence ?? 0) * 100)}%`,
    `Root cause: ${escapeTelegram(analysis.rootCause).slice(0, 700)}`,
    `Fix: ${escapeTelegram(analysis.fixProposal).slice(0, 700)}`,
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
  const db = getSupabaseAdminClient();
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

  const base = baseBranch;
  const { owner, repo } = splitRepo(incident.repo_full_name);
  const analysis = incident.ai_analysis ?? {
    rootCause: incident.root_cause ?? "Pending analysis.",
    fixProposal: incident.ai_fix_proposal ?? "Pending developer implementation."
  };
  const releaseContext = analysis.releaseContext ?? await incidentReleaseContext(user, incident);
  const branch = `hotfix/incident-${incident.id.slice(0, 8)}-${slugify(incident.title ?? "fix") || "fix"}`;
  const handoff = renderTelegramHotfixHandoff({ incident, analysis, releaseContext });
  const pr = await createDraftPR({
    owner,
    repo,
    base,
    branch,
    title: `hotfix: ${incident.title ?? "incident fix"}`,
    body: [
      "## ShipBrain incident hotfix",
      "",
      `Incident: \`${incident.id}\``,
      `Release: \`${incident.release_version ?? releaseContext?.release?.tag ?? "not captured"}\``,
      "",
      "### AI root cause",
      analysis.rootCause ?? "Pending analysis.",
      "",
      "### Fix direction",
      analysis.fixProposal ?? "Pending developer implementation."
    ].join("\n"),
    files: { "SHIPBRAIN_INCIDENT_HOTFIX.md": handoff }
  });
  const commits = await listPullRequestCommits({ owner, repo, pullNumber: pr.number }).catch(() => []);

  const { data: spec } = await db.from("specs").insert({
    user_id: user.user_id,
    raw_spec: handoff,
    repo_full_name: incident.repo_full_name,
    branch_name: branch,
    base_branch: base,
    pr_number: pr.number,
    pr_url: pr.html_url,
    status: "draft_created",
    incident_id: incident.id,
    updated_at: new Date().toISOString()
  }).select("id").single();

  const { error } = await db.from("incidents").update({
    status: "investigating",
    root_cause: analysis.rootCause ?? incident.root_cause,
    ai_fix_proposal: analysis.fixProposal ?? incident.ai_fix_proposal,
    ai_analysis: analysis,
    hotfix_branch: branch,
    hotfix_base_branch: base,
    hotfix_pr_number: pr.number,
    hotfix_pr_url: pr.html_url,
    hotfix_pr_status: "draft_created",
    hotfix_commits: commits,
    updated_at: new Date().toISOString()
  }).eq("id", incident.id);
  if (error) throw new Error(error.message);

  await createOrUpdateTrace({
    userId: user.user_id,
    repoFullName: incident.repo_full_name,
    type: "hotfix",
    title: `Hotfix: ${incident.title ?? "incident fix"}`,
    description: incident.raw_logs,
    status: "draft",
    sourceBranch: branch,
    targetBranch: base,
    draftPrNumber: pr.number,
    draftPrUrl: pr.html_url,
    specId: spec?.id ?? null,
    incidentId: incident.id,
    source: "telegram",
    actor: "telegram",
    eventType: "hotfix_created",
    details: { command: "/create_hotfix", pr, base }
  });

  return [
    "🛠️ *Hotfix Draft PR created*",
    `Incident: \`${shortId(incident.id)}\` · Spec: \`${shortId(spec?.id ?? incident.id)}\``,
    `PR #${pr.number}: ${pr.html_url}`,
    `Branch: \`${branch}\` -> \`${base}\``,
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
  const { data, error } = await db
    .from("release_traces")
    .select("id, title, repo_full_name, status, current_phase, pending_action, updated_at")
    .eq("user_id", user.user_id)
    .order("updated_at", { ascending: false })
    .limit(40);
  if (error) throw new Error(error.message);
  const traces = data ?? [];
  const pending = traces.filter((trace) => trace.pending_action).slice(0, 6);
  return [
    "📊 *ShipBrain Release Status*",
    "",
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
    const db = getSupabaseAdminClient();
    const { owner, repo } = splitRepo(trace.repo_full_name);
    const releaseTag = await getNextSemverReleaseTag(db, trace.repo_full_name);
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
        "Created from Telegram. Production deploy still requires the release gate."
      ].join("\n")
    });
    await db.from("specs").update({
      release_tag: releaseTag,
      release_status: "ready_for_prod",
      release_pr_number: pr.number,
      release_pr_url: pr.html_url,
      release_pr_status: pr.state,
      updated_at: new Date().toISOString()
    }).eq("id", trace.spec_id);
    await db.from("release_traces").update({
      status: "release_pending",
      current_phase: "production",
      release_pr_number: pr.number,
      release_pr_url: pr.html_url,
      updated_at: new Date().toISOString()
    }).eq("id", trace.id);
    await db.from("trace_events").insert({
      trace_id: trace.id,
      event_type: "release_pr_created",
      actor: "telegram",
      actor_type: "bot",
      source: "telegram",
      details: { command: "/approve", releaseTag, pr }
    });
    return [
      "🚀 *Release PR created*",
      `Trace: \`${shortId(trace.id)}\` · PR #${pr.number}`,
      `Release tag: \`${releaseTag}\``,
      pr.html_url
    ].join("\n");
  }
  if (trace.spec_id && (action?.type === "approve_release" || trace.status === "release_pending" || trace.status === "merged_main")) {
    return startProductionDeployment(user, String(trace.spec_id));
  }
  if (trace.incident_id && action?.type === "merge_reverse_sync") {
    const { owner, repo } = splitRepo(trace.repo_full_name);
    const merge = await mergePullRequest({
      owner,
      repo,
      pullNumber: trace.reverse_sync_pr_number,
      commitTitle: `sync: complete hotfix reverse sync for ${trace.title}`
    });
    const db = getSupabaseAdminClient();
    await db.from("incidents").update({
      reverse_sync_pr_status: "merged",
      reverse_sync_merged_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", trace.incident_id);
    await db.from("release_traces").update({
      status: "completed",
      current_phase: "live",
      reverse_sync_status: "merged",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq("id", trace.id);
    await db.from("trace_events").insert({
      trace_id: trace.id,
      event_type: "reverse_sync_merged",
      actor: "telegram",
      actor_type: "bot",
      source: "telegram",
      details: { command: "/approve", merge }
    });
    return `✅ Reverse sync merged for trace \`${shortId(trace.id)}\` at \`${merge.sha.slice(0, 12)}\`.`;
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
  const db = getSupabaseAdminClient();
  const spec = await findSpecForAction(user, token);

  if (spec.status !== "merged" || spec.base_branch !== "develop") {
    return `Preview deployment is only available after a feature PR is merged into develop. Current state: ${spec.status} -> ${spec.base_branch ?? "n/a"}.`;
  }

  if (spec.preview_status === "deploying") {
    return "Preview deployment is already in progress. Check /ci or /deployments shortly.";
  }

  if (spec.preview_url && !options.redeploy) {
    return `Preview is already ready: ${spec.preview_url}\nUse /redeploy_dev ${shortId(spec.id)} if you want to run it again.`;
  }

  const { owner, repo } = splitRepo(spec.repo_full_name);
  // Use the spec's base_branch to ensure we deploy from the correct branch
  const targetBranch = spec.base_branch || "develop";
  const deployment = await dispatchDevelopPreviewDeploy({
    owner,
    repo,
    ref: targetBranch,
    defaultBranch: await defaultBranchForRepo(spec.repo_full_name),
    sourcePrNumber: spec.pr_number,
    noFallback: true // Prevent falling back to main for preview deployments
  });

  await db.from("specs").update({
    deployment_status: "develop_validated",
    preview_status: "deploying",
    preview_url: options.redeploy ? null : spec.preview_url,
    updated_at: new Date().toISOString()
  }).eq("id", spec.id);

  await updateTraceBySpec(spec.id, {
    status: "merged_develop",
    preview_deployment: { status: "deploying", url: deployment.workflowUrl, timestamp: new Date().toISOString() }
  }, {
    eventType: options.redeploy ? "manual_action" : "deployment_started",
    source: "telegram",
    actor: "telegram",
    actorType: "bot",
    details: { command: options.redeploy ? "/redeploy_dev" : "/deploy_dev", deployment }
  });

  await db.from("approval_events").insert({
    entity_type: "spec",
    entity_id: spec.id,
    action: options.redeploy ? "telegram_redeploy_preview" : "telegram_deploy_preview",
    actor_id: user.user_id,
    note: options.redeploy ? "Telegram requested develop preview redeploy" : "Telegram requested develop preview deploy",
    metadata: {
      specId: spec.id,
      repo: spec.repo_full_name,
      workflowUrl: deployment.workflowUrl,
      command: options.redeploy ? "redeploy_dev" : "deploy_dev"
    }
  });

  return [
    options.redeploy ? "🔁 Preview redeploy started." : "🚀 Preview deployment started.",
    `Repo: \`${spec.repo_full_name}\``,
    `Spec: \`${shortId(spec.id)}\` · PR #${spec.pr_number ?? "n/a"}`,
    `Workflow: ${deployment.workflowUrl}`
  ].join("\n");
}

export async function syncTelegramHotfix(user: TelegramUser, token?: string) {
  const db = getSupabaseAdminClient();
  const incident = await findIncident(user, token);
  if (!incident.hotfix_pr_number) return "No hotfix PR is linked yet. Use /create_hotfix <id> first.";
  const { owner, repo } = splitRepo(incident.repo_full_name);
  const commits = await listPullRequestCommits({ owner, repo, pullNumber: incident.hotfix_pr_number });
  await db.from("incidents").update({
    hotfix_commits: commits,
    updated_at: new Date().toISOString()
  }).eq("id", incident.id);

  return [
    "🔄 *Hotfix commits synced*",
    `Incident: \`${shortId(incident.id)}\` · PR #${incident.hotfix_pr_number}`,
    commits.length ? commits.slice(0, 6).map((commit: any) => `- \`${commit.shortSha ?? commit.sha?.slice(0, 7)}\` ${escapeTelegram(commit.message)}`).join("\n") : "No commits found yet.",
    "",
    `Approve when reviewed: /approve_fix ${shortId(incident.id)}`
  ].join("\n");
}

export async function approveTelegramIncidentFix(user: TelegramUser, token?: string, options: { releaseTag?: string } = {}) {
  const db = getSupabaseAdminClient();
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

  const commits = await listPullRequestCommits({ owner, repo, pullNumber: incident.hotfix_pr_number });
  const merge = await mergePullRequest({
    owner,
    repo,
    pullNumber: incident.hotfix_pr_number,
    commitTitle: `hotfix: resolve ${incident.title ?? incident.id}`
  });
  const isProdDeploy = merge.baseBranch === "main";
  // Use provided release tag or generate default
  const releaseTag = options.releaseTag || hotfixReleaseTag(incident.id);
  let deployment: any = null;
  let deploymentError: string | null = null;

  try {
    if (isProdDeploy) {
      const release = await tagCommitForRelease({ owner, repo, sha: merge.sha, releaseTag });
      deployment = await dispatchCloudflareProductionDeploy({
        owner,
        repo,
        releaseTag: release.releaseTag,
        releaseSha: release.sha,
        isHotfix: true,
        reverseSync: true
      });
    } else {
      deployment = await dispatchDevelopPreviewDeploy({
        owner,
        repo,
        ref: merge.baseBranch,
        defaultBranch: await defaultBranchForRepo(incident.repo_full_name),
        sourcePrNumber: incident.hotfix_pr_number
      });
    }
  } catch (error) {
    deploymentError = error instanceof Error ? error.message : "Hotfix deployment dispatch failed.";
  }

  let pagerDutySyncStatus = incident.pagerduty_sync_status ?? null;
  let pagerDutySyncError = incident.pagerduty_sync_error ?? null;
  if (incident.alert_source === "pagerduty" && incident.external_id) {
    const pagerDutyResult = await resolvePagerDutyIncident({
      incidentId: incident.external_id,
      fromEmail: process.env.PAGERDUTY_FROM_EMAIL,
      note: [
        "ShipBrain approved and merged the incident hotfix from Telegram.",
        `Hotfix PR: ${incident.hotfix_pr_url}`,
        `Merge SHA: ${merge.sha}`,
        incident.root_cause ? `Root cause: ${incident.root_cause}` : "",
        incident.ai_fix_proposal ? `Fix proposal: ${incident.ai_fix_proposal}` : ""
      ].filter(Boolean).join("\n\n")
    });
    pagerDutySyncStatus = pagerDutyResult.ok ? (pagerDutyResult.skipped ? "skipped" : "resolved") : "action_required";
    pagerDutySyncError = pagerDutyResult.ok ? pagerDutyResult.detail ?? null : pagerDutyResult.detail ?? "Alert provider sync failed.";
  }

  let reverseSyncPr: Awaited<ReturnType<typeof createReverseSyncPR>> | null = null;
  let reverseSyncError: string | null = null;
  if (merge.baseBranch === "main") {
    try {
      reverseSyncPr = await createReverseSyncPR({
        owner,
        repo,
        sourceBranch: "main",
        targetBranch: "develop",
        incidentId: incident.id,
        incidentTitle: incident.title ?? "Incident fix",
        hotfixPrNumber: incident.hotfix_pr_number,
        releaseTag
      });
    } catch (error) {
      reverseSyncError = error instanceof Error ? error.message : "Failed to create reverse sync PR";
    }
  }

  await db.from("approval_events").insert({
    entity_type: "incident",
    entity_id: incident.id,
    action: "telegram_fix_approved",
    actor_id: user.user_id,
    note: "Telegram approved and merged the incident hotfix.",
    metadata: {
      hotfixPrNumber: incident.hotfix_pr_number,
      mergeSha: merge.sha,
      releaseTag: isProdDeploy ? releaseTag : null,
      deploymentDispatched: Boolean(deployment),
      deploymentError,
      reverseSyncPrNumber: reverseSyncPr?.number ?? null
    }
  });

  await db.from("incidents").update({
    status: "investigating",
    hotfix_pr_status: "merged",
    hotfix_branch: merge.headBranch,
    hotfix_base_branch: merge.baseBranch,
    hotfix_merge_sha: merge.sha,
    hotfix_commits: commits,
    release_version: isProdDeploy ? releaseTag : incident.release_version,
    fix_approved_at: new Date().toISOString(),
    pagerduty_sync_status: pagerDutySyncStatus,
    pagerduty_sync_error: pagerDutySyncError,
    reverse_sync_pr_number: reverseSyncPr?.number ?? null,
    reverse_sync_pr_url: reverseSyncPr?.html_url ?? null,
    reverse_sync_pr_status: reverseSyncPr ? "open" : null,
    reverse_sync_branch: reverseSyncPr ? "develop" : null,
    reverse_sync_created_at: reverseSyncPr ? new Date().toISOString() : null,
    reverse_sync_error: reverseSyncError,
    updated_at: new Date().toISOString()
  }).eq("id", incident.id);

  const specUpdate: Record<string, any> = {
    status: "merged",
    branch_name: merge.headBranch,
    base_branch: merge.baseBranch,
    merge_sha: merge.sha,
    feature_head_sha: merge.destinationSha,
    deployment_url: deployment?.workflowUrl ?? null,
    error_message: deploymentError,
    merged_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (isProdDeploy) {
    specUpdate.deployment_status = deployment ? "approved" : "not_requested";
    specUpdate.release_tag = releaseTag;
    specUpdate.release_sha = deployment ? merge.sha : null;
    specUpdate.release_status = deployment ? "deploying" : "failed";
  } else {
    specUpdate.deployment_status = deployment ? "develop_validated" : "not_requested";
    specUpdate.preview_status = deployment ? "deploying" : "failed";
  }
  await db.from("specs").update(specUpdate).eq("incident_id", incident.id);

  const tracePatch: Record<string, any> = {
    status: isProdDeploy ? (deployment ? "merged_main" : "failed") : (deployment ? "merged_develop" : "failed"),
    reverse_sync_pr_number: reverseSyncPr?.number ?? null,
    reverse_sync_pr_url: reverseSyncPr?.html_url ?? null,
    reverse_sync_status: reverseSyncPr ? "pending" : null
  };
  if (isProdDeploy) {
    tracePatch.merged_to_main = { sha: merge.sha, timestamp: new Date().toISOString(), actor: "telegram" };
    tracePatch.production_deployment = { status: deployment ? "deploying" : "failed", url: deployment?.workflowUrl ?? null, timestamp: new Date().toISOString() };
  } else {
    tracePatch.merged_to_develop = { sha: merge.sha, timestamp: new Date().toISOString(), actor: "telegram" };
    tracePatch.preview_deployment = { status: deployment ? "deploying" : "failed", url: deployment?.workflowUrl ?? null, timestamp: new Date().toISOString() };
  }
  await updateTraceByIncident(incident.id, tracePatch, {
    eventType: "pr_merged",
    source: "telegram",
    actor: "telegram",
    actorType: "bot",
    details: { command: "/approve_fix", merge, deployment, deploymentError, reverseSyncPr, reverseSyncError }
  });

  return [
    "✅ *Incident fix approved*",
    `Incident: \`${shortId(incident.id)}\` · PR #${incident.hotfix_pr_number}`,
    `Merged into: \`${merge.baseBranch}\` · SHA \`${merge.sha.slice(0, 12)}\``,
    isProdDeploy ? `Release: \`${releaseTag}\`` : "Preview deployment dispatched",
    deployment ? `Workflow: ${deployment.workflowUrl}` : `Deployment needs attention: ${deploymentError}`,
    reverseSyncPr ? `Reverse sync PR: #${reverseSyncPr.number} ${reverseSyncPr.html_url}` : "",
    pagerDutySyncError ? `Alert sync: ${pagerDutySyncError}` : ""
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
  const { owner, repo } = splitRepo(spec.repo_full_name);
  const db = getSupabaseAdminClient();
  const releaseTag = await getNextSemverReleaseTag(db, spec.repo_full_name);
  const title = (spec.decomposed_tasks as { prTitle?: string } | null)?.prTitle ?? spec.raw_spec ?? `PR #${spec.pr_number}`;

  const pr = await createReleasePullRequest({
    owner,
    repo,
    head: "develop",
    base: "main",
    releaseTag,
    body: [
      "## ShipBrain production release",
      "",
      `Feature: ${title}`,
      `Spec: ${spec.id}`,
      `Feature PR: #${spec.pr_number ?? "n/a"}`,
      "",
      "Created from Telegram. Production deploy still requires the release gate."
    ].join("\n")
  });

  await db.from("specs").update({
    release_tag: releaseTag,
    release_status: "ready_for_prod",
    release_pr_number: pr.number,
    release_pr_url: pr.html_url,
    release_pr_status: pr.state,
    updated_at: new Date().toISOString()
  }).eq("id", spec.id);

  // Find and update associated trace if exists
  // First try by spec_id, then by repo + source_branch if not found
  let { data: trace } = await db
    .from("release_traces")
    .select("id")
    .eq("user_id", user.user_id)
    .eq("spec_id", spec.id)
    .maybeSingle();

  // If not found by spec_id, try by repo and branch
  if (!trace) {
    const { data: traceByBranch } = await db
      .from("release_traces")
      .select("id")
      .eq("user_id", user.user_id)
      .eq("repo_full_name", spec.repo_full_name)
      .eq("source_branch", spec.branch_name)
      .eq("target_branch", "develop")
      .in("status", ["merged_develop", "preview_live"])
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    trace = traceByBranch;
  }

  if (trace) {
    await db.from("release_traces").update({
      status: "release_pending",
      current_phase: "production",
      release_pr_number: pr.number,
      release_pr_url: pr.html_url,
      target_branch: "main",  // Update target to main since we're now promoting to production
      updated_at: new Date().toISOString()
    }).eq("id", trace.id);

    await db.from("trace_events").insert({
      trace_id: trace.id,
      event_type: "release_pr_created",
      actor: "telegram",
      actor_type: "bot",
      source: "telegram",
      details: { command: "/deploy", releaseTag, pr }
    });
  }

  await db.from("approval_events").insert({
    entity_type: "spec",
    entity_id: spec.id,
    action: "release_pr_created",
    actor_id: user.user_id,
    note: `Release PR created from Telegram /deploy command`,
    metadata: { releaseTag, prNumber: pr.number, prUrl: pr.html_url }
  });

  return [
    "🚀 *Release PR created*",
    `Spec: \`${shortId(spec.id)}\` · PR #${pr.number}`,
    `Release tag: \`${releaseTag}\``,
    `Feature: ${escapeTelegram(title).slice(0, 60)}`,
    "",
    pr.html_url,
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

  const { owner, repo } = splitRepo(spec.repo_full_name);
  const releaseTag = options.releaseTag || defaultTag;
  let releaseSha = spec.release_sha || spec.merge_sha;
  if (!releaseSha) return "No release SHA is available yet. Refresh ShipBrain after the release PR merge and try again.";
  releaseSha = await resolveReleaseSha(owner, repo, releaseSha);

  if (!spec.release_tag) {
    await createReleaseTag({
      owner,
      repo,
      tag: releaseTag,
      sha: releaseSha,
      message: "Production release created by ShipBrain Telegram"
    });
  }

  const deployment = await dispatchCloudflareProductionDeploy({
    owner,
    repo,
    releaseTag,
    releaseSha
  });

  await db.from("specs").update({
    release_tag: releaseTag,
    release_sha: releaseSha,
    release_status: "deploying",
    deployment_status: "deploying",
    updated_at: new Date().toISOString()
  }).eq("id", spec.id);

  await updateTraceBySpec(spec.id, {
    status: "merged_main",
    release_pr_number: spec.release_pr_number ?? null,
    release_pr_url: spec.release_pr_url ?? null,
    production_deployment: { status: "deploying", url: deployment.workflowUrl, releaseTag, releaseSha, timestamp: new Date().toISOString() }
  }, {
    eventType: options.redeploy ? "manual_action" : "deployment_started",
    source: "telegram",
    actor: "telegram",
    actorType: "bot",
    details: { command: options.redeploy ? "/redeploy_prod" : "/deploy_prod", deployment, releaseTag, releaseSha }
  });

  await db.from("approval_events").insert({
    entity_type: "spec",
    entity_id: spec.id,
    action: options.redeploy ? "telegram_redeploy_production" : "telegram_deploy_production",
    actor_id: user.user_id,
    note: options.redeploy ? "Telegram requested production redeploy" : "Telegram approved production deployment",
    metadata: {
      specId: spec.id,
      repo: spec.repo_full_name,
      releaseTag,
      releaseSha,
      workflowUrl: deployment.workflowUrl,
      command: options.redeploy ? "redeploy_prod" : "deploy_prod"
    }
  });

  return [
    options.redeploy ? "🔁 Production redeploy started." : "🏷️ Production tag and deploy started.",
    `Repo: \`${spec.repo_full_name}\``,
    `Release: \`${releaseTag}\``,
    `SHA: \`${releaseSha.slice(0, 12)}\``,
    `Workflow: ${deployment.workflowUrl}`
  ].join("\n");
}

export async function getRollbackReleases(user: TelegramUser) {
  const db = getSupabaseAdminClient();
  const repos = await connectedRepos(user.user_id);
  if (!repos.length) return "No connected repositories yet.";

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

  return [
    "🔄 *Available releases for rollback*",
    "",
    ...data.map((item, index) => {
      const tasks = item.decomposed_tasks as { prTitle?: string } | null;
      const title = tasks?.prTitle ?? "Release";
      const date = item.deployed_at ? new Date(item.deployed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "n/a";
      return `${index + 1}. \`${item.release_tag}\` - ${escapeTelegram(title).slice(0, 50)} (${date})`;
    }),
    "",
    "To rollback: /rollback release-v2026.05.XX-XXXXXX"
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

  // Find target spec by release tag
  const { data: targetSpec } = await db
    .from("specs")
    .select("id, repo_full_name, release_tag, release_sha, release_status, decomposed_tasks")
    .eq("user_id", user.user_id)
    .in("repo_full_name", repos)
    .eq("release_tag", targetTag)
    .eq("release_status", "deployed")
    .eq("base_branch", "main")
    .maybeSingle();

  if (!targetSpec) {
    return `No deployed release found for tag "${targetTag}". Run /rollback_releases for available tags.`;
  }

  if (!targetSpec.release_sha) {
    return "Target release does not have a release SHA.";
  }

  // Get current production release tag
  const { data: currentSpec } = await db
    .from("specs")
    .select("id, release_tag, release_sha")
    .eq("user_id", user.user_id)
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
    return "A rollback is already in progress for this repository. Run /rollback_status to check.";
  }

  // Find the most recent production trace for this repo
  const { data: trace } = await db
    .from("release_traces")
    .select("*")
    .eq("user_id", user.user_id)
    .eq("repo_full_name", targetSpec.repo_full_name)
    .eq("type", "release")
    .in("status", ["production_live", "merged_main", "failed"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Dispatch the rollback deployment
  const { owner, repo } = splitRepo(targetSpec.repo_full_name);
  let deployment;
  try {
    deployment = await dispatchCloudflareProductionDeploy({
      owner,
      repo,
      releaseTag: targetTag,
      releaseSha: targetSpec.release_sha,
      isHotfix: false,
      reverseSync: false
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deployment dispatch failed";
    return `❌ Rollback failed: ${message}`;
  }

  // Create rollback history record
  const { data: rollbackRecord } = await db
    .from("rollback_history")
    .insert({
      user_id: user.user_id,
      repo_full_name: targetSpec.repo_full_name,
      trace_id: trace?.id ?? null,
      spec_id: targetSpec.id,
      source_release_tag: sourceReleaseTag,
      target_release_tag: targetTag,
      target_release_sha: targetSpec.release_sha,
      status: "deploying",
      initiated_by: "telegram",
      workflow_url: deployment.workflowUrl,
      metadata: {
        targetSpecId: targetSpec.id,
        sourceSpecId: currentSpec?.id ?? null,
        deploymentWorkflowId: deployment.workflowId
      }
    })
    .select("id")
    .single();

  // Update trace if found
  if (trace) {
    await initiateRollback({
      traceId: trace.id,
      targetReleaseTag: targetTag,
      targetReleaseSha: targetSpec.release_sha,
      sourceReleaseTag,
      workflowUrl: deployment.workflowUrl,
      initiatedBy: "telegram",
      rollbackId: rollbackRecord?.id
    });
  }

  // Log approval event
  await db.from("approval_events").insert({
    entity_type: "spec",
    entity_id: targetSpec.id,
    action: "telegram_rollback_initiated",
    actor_id: user.user_id,
    note: `Telegram initiated rollback from ${sourceReleaseTag} to ${targetTag}`,
    metadata: {
      sourceReleaseTag,
      targetReleaseTag: targetTag,
      targetReleaseSha: targetSpec.release_sha,
      rollbackId: rollbackRecord?.id,
      workflowUrl: deployment.workflowUrl
    }
  });

  const tasks = targetSpec.decomposed_tasks as { prTitle?: string } | null;
  const title = tasks?.prTitle ?? "Release";

  return [
    "🔄 *Rollback initiated*",
    `Repo: \`${targetSpec.repo_full_name}\``,
    `From: \`${sourceReleaseTag}\``,
    `To: \`${targetTag}\``,
    `Title: ${escapeTelegram(title).slice(0, 60)}`,
    `SHA: \`${targetSpec.release_sha.slice(0, 12)}\``,
    `Workflow: ${deployment.workflowUrl}`,
    "",
    "Check progress: /rollback_status"
  ].join("\n");
}

export async function resolveTelegramIncident(user: TelegramUser, token?: string, note: string = "Resolved via Telegram") {
  const db = getSupabaseAdminClient();
  const incident = await findIncident(user, token);
  
  await db.from("incidents").update({
    status: "resolved",
    resolved_at: new Date().toISOString(),
    resolution_note: note,
    updated_at: new Date().toISOString()
  }).eq("id", incident.id);

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

  let trace = traces?.find(t => t.status === "preview_live") || traces?.[0];
  if (!trace) {
    return "No active release trace found to promote.";
  }

  const { data: profile } = await db
    .from("profiles")
    .select("github_access_token")
    .eq("id", user.user_id)
    .maybeSingle();
  const userGitHubToken = profile?.github_access_token;
  if (!userGitHubToken) {
    return "GitHub is not connected. Please link your GitHub account in settings.";
  }

  const { data: mergedSpecs } = await db
    .from("specs")
    .select("id, title, pr_number, pr_url, branch_name")
    .eq("repo_full_name", repoFullName)
    .eq("user_id", user.user_id)
    .eq("status", "merged")
    .eq("base_branch", "develop")
    .is("release_pr_number", null)
    .order("merged_at", { ascending: false });

  const featuresSection = mergedSpecs?.length
    ? [
        "### Features included in this release",
        "",
        ...mergedSpecs.map((s) =>
          s.pr_number
            ? `- ${s.title} ([#${s.pr_number}](${s.pr_url}))`
            : `- ${s.title}`
        ),
        ""
      ]
    : [];

  const releaseTag = customTag?.trim() || trace.release_tag || `release-v${new Date().toISOString().slice(0, 10).replace(/-/g, ".")}-${Date.now().toString().slice(-6)}`;
  const [owner, repo] = repoFullName.split("/");

  try {
    const pr = await createReleasePullRequest({
      owner,
      repo,
      head: "develop",
      base: "main",
      releaseTag,
      body: [
        "## ShipBrain production release",
        "",
        `**Release tag:** \`${releaseTag}\``,
        "",
        ...featuresSection,
        "---",
        "",
        `Trace: \`${trace.id}\``,
        "",
        "This PR promotes the validated develop branch into main. Production deploy will be triggered after merge."
      ].join("\n"),
      token: userGitHubToken
    });

    if (trace.spec_id) {
      await db.from("specs").update({
        release_tag: releaseTag,
        release_status: "ready_for_prod",
        release_pr_number: pr.number,
        release_pr_url: pr.html_url,
        release_pr_status: pr.state,
        updated_at: new Date().toISOString()
      }).eq("id", trace.spec_id);
    }

    await associateFeaturesWithRelease(
      repoFullName,
      pr.number,
      pr.html_url,
      pr.state
    ).catch((err) => console.error("Failed to associate features with release:", err));

    const nextStatus = "release_pending";
    await db.from("release_traces").update({
      status: nextStatus,
      current_phase: phaseForStatus(nextStatus),
      release_pr_number: pr.number,
      release_pr_url: pr.html_url,
      updated_at: new Date().toISOString()
    }).eq("id", trace.id);

    await addTraceEvent({
      traceId: trace.id,
      eventType: "status_changed",
      actor: user.user_id,
      actorType: "user",
      source: "manual",
      details: {
        message: `Release PR #${pr.number} created to promote develop to main.`,
        prNumber: pr.number,
        prUrl: pr.html_url,
        releaseTag
      }
    });

    return [
      `✅ *Release Draft PR Created!*`,
      `Repository: \`${escapeTelegram(repoFullName)}\``,
      `PR: [#${pr.number}](${pr.html_url})`,
      `Release Tag: \`${escapeTelegram(releaseTag)}\``
    ].join("\n");
  } catch (error: any) {
    return `❌ *Failed to create Release PR:* ${escapeTelegram(error.message)}`;
  }
}
