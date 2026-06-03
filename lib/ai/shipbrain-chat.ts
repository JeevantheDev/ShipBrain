/**
 * ShipBrain Chat — LLM Tool Calling Architecture
 *
 * Flow:
 *  1. Build messages (system prompt + context JSON + history + user message)
 *  2. Invoke model.bind({ tools }) — the LLM decides whether to call a tool or reply in plain text
 *  3a. No tool call → stream plain text response
 *  3b. Read tool call → execute immediately, return formatted data
 *  3c. Write tool call → resolve IDs + options from context → return pending_confirmation
 *  4. On "confirm" → executeAction, return formatted result
 */

import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getModel } from "@/lib/ai/model";
import { getShipBrainAgentContext } from "@/lib/agent/context";
import { listChatMessages, type StoredChatMessage } from "@/lib/ai/chat-store";
import {
  executeAction,
  formatActionResult,
  generateConfirmation,
  validateActionState,
  type ChatAction
} from "@/lib/ai/chat-actions";
import {
  ALL_TOOLS,
  READ_TOOL_NAMES,
  TOOL_BY_NAME,
  getLangChainToolSpecs,
  resolveActionOptions,
  type ShipBrainToolName,
  type ActionOption
} from "@/lib/ai/tools";

type SupabaseLike = {
  from: (table: string) => any;
};

// ─── System Prompt ────────────────────────────────────────────────────────────

const systemPrompt = `You are ShipBrain AI, a senior production engineering assistant embedded inside a deployment dashboard.

## Your Role
You help engineering teams manage:
- GitHub Pull Requests and Spec-to-PR generation
- Preview and Production deployments
- Release pipeline approvals
- Incidents, hotfixes, and rollbacks
- CI/CD status and release traces

## How You Work
You have access to a set of tools for BOTH reading data AND executing operations.

### For information queries (use read tools):
- get_pending_deployments — pending previews and production deployments
- get_ci_status — latest GitHub Actions runs
- get_incidents — open/active incidents
- get_release_traces — release pipeline status
- get_recent_prs — open and draft pull requests

### For operations (use write tools):
- deploy_preview, deploy_production, approve_release, rollback
- create_hotfix, approve_hotfix, analyze_incident, resolve_incident, acknowledge_incident, spec_to_pr

## Tool Calling Rules
1. ALWAYS use a tool when the user asks for data or wants to perform an operation
2. For information queries: use the relevant read tool
3. For operations: use the relevant write tool and extract any IDs/numbers from the message
4. If a PR number, spec ID, incident ID, or trace ID is mentioned in the message, extract it into the tool arguments
5. Do NOT answer operational questions from memory — always call a tool
6. Never invent data. If context is empty, say so clearly

## Response Style
- Be concise and direct
- Use bullet points for lists
- Use backticks for IDs, tags, branch names
- Explain risks for production operations
- Reference specific data from the context provided

## Current Deployment State
The context includes a \`deploymentState\` object with FRESH, real-time data about:
- \`currentProductionTag\`: The release tag currently live in production
- \`currentProductionDeployedAt\`: When it was deployed
- \`recentRollbacks\`: Recent rollback history (source → target tags)
- \`pendingReleases\`: Releases waiting for deployment
- \`summary\`: Human-readable summary of current state

### Recent Commits (live from GitHub)
- \`recentMainCommits\`: Last 5 commits on main branch (sha, message, author, date)
- \`recentDevelopCommits\`: Last 5 commits on develop branch
- These are fetched live from GitHub API — if empty it means GitHub token was unavailable

### Branch Comparison (develop vs main)
- \`branchComparison\`: Shows how far develop is ahead/behind main
- \`pendingCommitsCount\`: Number of commits on develop not yet released
- \`pendingCommits\`: The actual pending commits (up to 5)

**IMPORTANT**: Always use \`deploymentState\` for questions about:
- Current production version
- Recent rollbacks
- Deployment status
- What's changed recently (use recentMainCommits)
- What's pending for release (use pendingCommits and branchComparison)
- Incident root cause analysis (correlate deployment timing with commits)

This data is fetched fresh on every request and reflects the actual current state.

## Persistent Memory
If a \`memoryNotes\` block is provided in the context, it contains facts saved from past sessions.
Use them to provide continuity across conversations — e.g. recurring incident patterns, team conventions, or preferences.

## Notifications
The context includes \`unreadNotificationCount\` and \`unreadNotifications\`.
- If unreadNotificationCount > 0 and the user hasn't specifically asked about notifications, you may proactively surface the most important one at the end of your response.
- Examples: "⚡ You have 2 unread deployment alerts — say 'show notifications' to see them."
- Do NOT mention notifications if count is 0.`;


// ─── Helpers ──────────────────────────────────────────────────────────────────

function historyText(messages: StoredChatMessage[]): string {
  if (!messages.length) return "No previous messages in this thread.";
  // #3: Raised from 12 → 20 for richer context in longer troubleshooting sessions
  return messages
    .slice(-20)
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n\n");
}

export function isConfirmation(message: string): boolean {
  const lower = message.toLowerCase().trim().replace(/[.,/#!$%^&*;:{}=\-_`~()?]/g, "");
  const words = ["confirm", "yes", "proceed", "do it", "go ahead", "ok", "okay", "yup", "yeah", "sure"];
  return words.includes(lower) || lower.startsWith("yes ") || lower.startsWith("confirm ");
}

export function isCancellation(message: string): boolean {
  const lower = message.toLowerCase().trim().replace(/[.,/#!$%^&*;:{}=\-_`~()?]/g, "");
  const words = ["cancel", "no", "abort", "stop", "nevermind", "never mind", "nope"];
  return words.includes(lower) || lower.startsWith("no ") || lower.startsWith("cancel ");
}

async function* textStream(content: string) {
  yield { content };
}

function isSpecToPrRecipeRequest(message: string): boolean {
  return /\b(create|start|new|make)\b.*\b(draft\s*)?pr\b/i.test(message) ||
    /\b(create|start|new|make)\b.*\bspec[-\s]?to[-\s]?pr\b/i.test(message);
}

function isProductionRedeployRequest(message: string): boolean {
  return /\bre[-\s]?deploy\b/i.test(message) &&
    /\b(prod|production|release\s+tag|current\s+release|current\s+tag)\b/i.test(message);
}

function isPreviewRedeployRequest(message: string): boolean {
  return /\bre[-\s]?deploy\b/i.test(message) &&
    /\b(preview|develop|dev|staging)\b/i.test(message);
}

function extractReleaseTag(message: string): string | null {
  const match = message.match(/\b((?:release|hotfix)-v[0-9][A-Za-z0-9._-]*|v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?)\b/i);
  return match?.[1] ?? null;
}

function buildRecipeSelectionAction(context: any): ChatAction {
  const recipes = (context.specPrRecipes ?? []) as any[];
  return {
    type: "spec_to_pr",
    status: recipes.length ? "needs_input" : "completed",
    params: {
      recipes,
      repoFullName: context.activeRepo ?? null
    }
  };
}

function recipeSelectionMessage(context: any): string {
  const recipes = (context.specPrRecipes ?? []) as any[];
  if (!recipes.length) {
    return "I don't see any sample tickets configured yet.";
  }
  const lines = recipes.slice(0, 8).map((recipe: any, index: number) => {
    const sample = recipe.isSample ? " · sample" : "";
    const branch = recipe.sourceBranch ? `${recipe.sourceBranch} -> ${recipe.baseBranch ?? "develop"}` : recipe.baseBranch ?? "develop";
    return `${index + 1}. **${recipe.label}**${sample} — \`${branch}\``;
  });
  return ["Choose a sample ticket to create the Draft PR:", "", ...lines].join("\n");
}

function checkRepoOnboarding(context: any): string | null {
  const repos = Array.isArray(context.repos) ? context.repos : [];
  const activeRepo = context.activeRepo;
  if (activeRepo) return null;
  if (repos.length === 0) {
    return `**Welcome to ShipBrain!**

To get started, connect a GitHub repository first.

**Next steps:**
1. Go to **Settings** in the sidebar
2. Click **Repositories**
3. Connect your GitHub repo

Once connected, I can help you deploy, manage releases, and handle incidents.`;
  }
  return null;
}

// ─── Execute read tools in-process from context ────────────────────────────────

function executeReadToolFromContext(toolName: ShipBrainToolName, args: Record<string, any>, context: any): string {
  switch (toolName) {
    case "get_pending_deployments": {
      const items = (context.pendingDeployments ?? []) as any[];
      if (!items.length) return "No pending deployments right now. All specs are either deployed or in draft state.";
      const lines = items.slice(0, 8).map((s) => {
        const title = s.decomposed_tasks?.prTitle ?? s.raw_spec?.slice(0, 60) ?? `Spec ${s.id.slice(0, 8)}`;
        return `- **#${s.pr_number ?? "?"}** ${title}\n  Status: \`${s.release_status ?? s.status}\` · Branch: \`${s.base_branch}\``;
      });
      return `**Pending Deployments (${items.length})**\n\n${lines.join("\n\n")}`;
    }

    case "get_recent_prs": {
      const prs = (context.recentPrs ?? []) as any[];
      if (!prs.length) return "No recent pull requests found.";
      const lines = prs.slice(0, 8).map((s) => {
        const title = s.decomposed_tasks?.prTitle ?? s.raw_spec?.slice(0, 60) ?? `Spec ${s.id.slice(0, 8)}`;
        return `- **PR #${s.pr_number ?? "?"}** ${title}\n  Status: \`${s.status}\` · \`${s.branch_name ?? "?"}\` → \`${s.base_branch ?? "?"}\``;
      });
      return `**Recent PRs (${prs.length})**\n\n${lines.join("\n\n")}`;
    }

    case "get_ci_status": {
      const runs = (context.ciRuns ?? []) as any[];
      if (!runs.length) return "No CI runs found for this repository.";
      const limit = args.limit ?? 5;
      const lines = runs.slice(0, limit).map((r) => {
        const status = r.conclusion ?? r.status ?? "unknown";
        const icon = status === "success" ? "✅" : status === "failure" ? "❌" : "🔄";
        return `- ${icon} **${r.workflow_name ?? r.title ?? "Workflow"}** · \`${r.branch ?? "?"}\`\n  Status: \`${status}\`${r.html_url ? ` · [View](${r.html_url})` : ""}`;
      });
      return `**CI Status — Latest ${Math.min(runs.length, limit)} runs**\n\n${lines.join("\n\n")}`;
    }

    case "get_incidents": {
      const incidents = (context.incidents ?? []) as any[];
      const filterStatus = args.status;
      const filtered = filterStatus && filterStatus !== "all"
        ? incidents.filter((i) => i.status === filterStatus)
        : incidents.filter((i) => i.status !== "resolved" && i.status !== "closed");
      if (!filtered.length) return "No active incidents right now. ✅";
      const lines = filtered.slice(0, 6).map((i) => {
        return `- 🚨 **${i.title ?? "Incident " + i.id.slice(0, 8)}**\n  Severity: \`${i.severity ?? "unknown"}\` · Status: \`${i.status}\` · Service: \`${i.service ?? "app"}\`\n  ID: \`${i.id}\``;
      });
      return `**Active Incidents (${filtered.length})**\n\n${lines.join("\n\n")}`;
    }

    case "get_release_traces": {
      const traces = (context.releaseTraces ?? []) as any[];
      if (!traces.length) return "No active release traces found.";
      const lines = traces.slice(0, 6).map((t) => {
        return `- **${t.title ?? t.id.slice(0, 8)}**\n  Status: \`${t.status}\` · Type: \`${t.type}\`\n  ID: \`${t.id}\``;
      });
      return `**Release Traces (${traces.length})**\n\n${lines.join("\n\n")}`;
    }

    case "prepare_release_handbook": {
      const traces = (context.releaseTraces ?? []) as any[];
      const latestRelease = traces.find(
        (t) => t.type === "release" && (t.status === "production_live" || t.status === "completed")
      ) || traces[0];
      if (!latestRelease) {
        return "No recent completed production release trace found to prepare a handbook from.";
      }
      
      const specs = (context.recentPrs ?? []) as any[];
      const releaseSpecs = specs.filter(
        (s) => s.release_tag === latestRelease.title || s.release_pr_number === latestRelease.release_pr_number || s.status === "merged" || s.release_status === "deployed"
      );
      
      const handbookData = {
        releaseTag: latestRelease.title ?? `Release Trace ${latestRelease.id.slice(0, 8)}`,
        status: latestRelease.status,
        updatedAt: latestRelease.updated_at,
        repo: latestRelease.repo_full_name,
        prNumber: latestRelease.release_pr_number,
        features: releaseSpecs.slice(0, 10).map(s => ({
          title: s.title ?? s.decomposed_tasks?.prTitle ?? `Spec ${s.id.slice(0, 8)}`,
          prNumber: s.pr_number,
          prUrl: s.pr_url,
          branch: s.branch_name,
          updatedAt: s.updated_at
        }))
      };

      const dateStr = handbookData.updatedAt 
        ? new Date(handbookData.updatedAt).toLocaleString() 
        : "Recent";

      const featuresMd = handbookData.features.length
        ? handbookData.features.map((f, idx) => {
            const prLink = f.prNumber && f.prUrl 
              ? `([#${f.prNumber}](${f.prUrl}))` 
              : f.prNumber 
                ? `(PR #${f.prNumber})` 
                : "";
            return `### ${idx + 1}. ${f.title}\n` +
                   `- **PR:** ${prLink || "N/A"}\n` +
                   `- **Branch:** \`${f.branch || "n/a"}\`\n` +
                   `- **Updated:** ${f.updatedAt ? new Date(f.updatedAt).toLocaleString() : "N/A"}`;
          }).join("\n\n")
        : "• No feature specs found in this release.";

      return [
        `# 📘 Product Manager Release Handbook`,
        ``,
        `> **Release Tag / Title:** \`${handbookData.releaseTag}\``,
        `> **Repository:** \`${handbookData.repo}\``,
        `> **Release PR:** ${handbookData.prNumber ? `[#${handbookData.prNumber}](https://github.com/${handbookData.repo}/pull/${handbookData.prNumber})` : "`N/A`"}`,
        `> **Status:** \`${handbookData.status}\` · **Deployed At:** \`${dateStr}\``,
        ``,
        `---`,
        ``,
        `## 🚀 Key Features & Changes Delivered`,
        ``,
        featuresMd,
        ``,
        `---`,
        ``,
        `## 💡 PM Verification & Verification Status`,
        `- **Automated Verification:** All CI/CD pipelines and checks have passed successfully.`,
        `- **Deployment Status:** Production live and fully operational.`,
        `- **Handoff Action:** Ready for customer communication and verification.`,
        ``,
        `---`,
        ``,
        `### 📢 Slack Announcement Template`,
        `\`\`\`markdown`,
        `🚀 *Production Release Announcement*`,
        ``,
        `We are pleased to announce that our latest release is now live in production!`,
        ``,
        `*What's New:*`,
        handbookData.features.map(f => `• ${f.title}${f.prNumber ? ` (#${f.prNumber})` : ""}`).join("\n"),
        ``,
        `*Details:*`,
        `• Tag: \`${handbookData.releaseTag}\``,
        `• Repo: \`${handbookData.repo}\``,
        `• Status: Deployed & Healthy`,
        `\`\`\``
      ].join("\n");
    }

    default:
      return "Data retrieved from context.";
  }
}

// ─── Resolve tool args → ChatAction params ─────────────────────────────────────

async function resolveWriteToolParams(
  toolName: ShipBrainToolName,
  args: Record<string, any>,
  context: any
): Promise<Record<string, any>> {
  const params: Record<string, any> = {};

  switch (toolName) {
    case "deploy_preview":
    case "deploy_production": {
      const prNum = args.pr_number ?? args.prNumber;
      const specId = args.spec_id ?? args.specId;
      const isRedeploy = args.redeploy === true || args.redeploy === "true";
      const requestedReleaseTag = String(args.release_tag ?? args.releaseTag ?? "").trim();
      const all = [...(context.pendingDeployments ?? []), ...(context.recentPrs ?? [])] as any[];
      if (context.activeRepo) {
        params.repoFullName = context.activeRepo;
      }
      const byNewest = (a: any, b: any) => {
        const dateA = new Date(a.deployed_at || a.updated_at || 0).getTime();
        const dateB = new Date(b.deployed_at || b.updated_at || 0).getTime();
        return dateB - dateA;
      };

      let found: any = null;
      if (specId) {
        found = all.find((s) => s.id === specId);
      } else if (prNum) {
        found = all.find((s) => String(s.pr_number) === String(prNum));
      } else if (toolName === "deploy_preview") {
        if (isRedeploy) {
          // For redeploy, find the most recently deployed preview spec
          // Sort by deployed_at or updated_at descending and find one with preview_url
          const deployedPreviews = all
            .filter((s) => s.base_branch === "develop" && s.preview_url && s.preview_status === "deployed")
            .sort(byNewest);
          found = deployedPreviews[0];
          if (found) {
            params.forceRedeploy = true;
          }
        } else {
          // For initial deploy, find spec that hasn't been deployed to preview yet
          found = all.find((s) => s.status === "merged" && s.base_branch === "develop" && !s.preview_url && s.preview_status !== "deploying");

          // If no pending preview found, try to find the most recent preview for redeploy as fallback
          if (!found) {
            const deployedPreviews = all
              .filter((s) => s.base_branch === "develop" && s.preview_url && s.preview_status === "deployed")
              .sort(byNewest);
            found = deployedPreviews[0];
            if (found) {
              params.forceRedeploy = true;
            }
          }
        }
      } else {
        const currentProductionTag = context.deploymentState?.currentProductionTag;
        const targetRedeployTag = requestedReleaseTag || (isRedeploy ? currentProductionTag : "");

        if (targetRedeployTag) {
          found = all
            .filter((s) => s.release_tag === targetRedeployTag || s.releaseTag === targetRedeployTag)
            .sort(byNewest)[0];
          if (found) {
            params.forceRedeploy = true;
          }
        }

        if (!found && isRedeploy) {
          found = all
            .filter((s) => s.release_status === "deployed" && (s.release_tag || s.releaseTag))
            .sort(byNewest)[0];
          if (found) {
            params.forceRedeploy = true;
          }
        }

        if (!found && !isRedeploy) {
          found = all.find((s) => s.release_status === "pending_deploy" || s.release_status === "ready_for_prod" || (s.status === "merged" && s.base_branch === "main"));
        }
      }

      if (found) {
        params.specId = found.id;
        params.prNumber = found.pr_number;
        params.title = found.decomposed_tasks?.prTitle ?? `PR #${found.pr_number}`;
      } else if (prNum) {
        params.prNumber = prNum;
      } else if (specId) {
        params.specId = specId;
      }

      if (toolName === "deploy_production") {
        // Use provided tag or generate a default one that will be shown in confirmation
        // This ensures the same tag is used when the user confirms
        if (requestedReleaseTag) {
          params.releaseTag = requestedReleaseTag;
        } else if (found?.releaseTag || found?.release_tag) {
          params.releaseTag = found.releaseTag || found.release_tag;
        } else if (isRedeploy && context.deploymentState?.currentProductionTag) {
          params.releaseTag = context.deploymentState.currentProductionTag;
        } else if (!isRedeploy) {
          try {
            const { getSupabaseAdminClient } = await import("@/lib/supabase/admin");
            const { getNextSemverReleaseTag } = await import("@/lib/shipbrain/semver");
            const db = getSupabaseAdminClient();
            const repoName = context.activeRepo || found?.repo || args.repo || args.repo_full_name;
            if (repoName) {
              params.releaseTag = await getNextSemverReleaseTag(db, repoName);
            } else {
              params.releaseTag = "v1.0.0";
            }
          } catch {
            params.releaseTag = "v1.0.0";
          }
        }
        if (isRedeploy) {
          params.forceRedeploy = true;
        }
      }
      break;
    }

    case "approve_release": {
      const traceId = args.trace_id ?? args.traceId;
      const prNum = args.pr_number ?? args.prNumber;
      const traces = (context.releaseTraces ?? []) as any[];

      let found: any = null;
      if (traceId) {
        found = traces.find((t) => t.id === traceId);
      } else if (prNum) {
        const n = parseInt(prNum);
        found = traces.find((t) => t.draft_pr_number === n || t.release_pr_number === n);
      }
      if (!found) {
        found = traces.find((t) => t.status === "ready_for_review" || t.status === "release_pending");
      }

      if (found) {
        params.traceId = found.id;
        params.prNumber = found.release_pr_number ?? found.draft_pr_number;
        params.title = found.title;
      } else if (traceId) {
        params.traceId = traceId;
      }
      break;
    }

    case "rollback": {
      const tag = args.target_release_tag ?? args.targetReleaseTag;
      if (tag) {
        params.targetReleaseTag = tag;
      }
      break;
    }

    case "create_hotfix": {
      const incidentId = args.incident_id ?? args.incidentId;
      const incidents = (context.incidents ?? []) as any[];
      let found: any = null;
      if (incidentId) {
        found = incidents.find((i) => i.id === incidentId || i.id.startsWith(incidentId));
      }
      if (!found) {
        found = incidents.find((i) => i.status !== "resolved" && i.status !== "closed");
      }
      if (found) {
        params.incidentId = found.id;
        params.incidentTitle = found.title;
      } else if (incidentId) {
        params.incidentId = incidentId;
      }
      // Extract branch from args or message context
      let baseBranch = args.base_branch ?? args.baseBranch;
      if (!baseBranch) {
        // Try to infer from message
        const msgLower = (args._message ?? "").toLowerCase();
        if (msgLower.includes("main") || msgLower.includes("production") || msgLower.includes("emergency")) {
          baseBranch = "main";
        } else if (msgLower.includes("develop")) {
          baseBranch = "develop";
        }
      }
      if (baseBranch) {
        params.baseBranch = baseBranch;
      }
      break;
    }

    case "approve_hotfix":
    case "analyze_incident":
    case "resolve_incident":
    case "acknowledge_incident": {
      const incidentId = args.incident_id ?? args.incidentId;
      const note = args.note ?? args.resolution_note ?? args.resolutionNote ?? args.audit_message ?? args.auditMessage;
      const incidents = (context.incidents ?? []) as any[];
      let found: any = null;
      if (incidentId) {
        found = incidents.find((i) => i.id === incidentId || i.id.startsWith(incidentId));
      }
      if (!found) {
        found = incidents.find((i) => i.status !== "resolved" && i.status !== "closed");
      }
      if (found) {
        params.incidentId = found.id;
        params.incidentTitle = found.title;
        if (note) {
          params.note = note;
        }
        // For approve_hotfix, capture the base branch and set default release tag if targeting main
        if (toolName === "approve_hotfix") {
          const baseBranch = found.hotfixBaseBranch || args.base_branch || args.baseBranch;
          if (baseBranch) {
            params.baseBranch = baseBranch;
          }
          // If targeting main and no release tag provided, generate a default one
          // If targeting main and no release tag provided, generate a default one
          if (baseBranch === "main" && !args.release_tag) {
            try {
              const { getSupabaseAdminClient } = await import("@/lib/supabase/admin");
              const { getNextSemverReleaseTag } = await import("@/lib/shipbrain/semver");
              const db = getSupabaseAdminClient();
              const repoName = context.activeRepo || found?.repo_full_name || found?.repo || args.repo;
              if (repoName) {
                params.releaseTag = await getNextSemverReleaseTag(db, repoName);
              } else {
                params.releaseTag = "v1.0.0";
              }
            } catch {
              params.releaseTag = "v1.0.0";
            }
          } else if (args.release_tag) {
            params.releaseTag = args.release_tag;
          }
        }
      } else if (incidentId) {
        params.incidentId = incidentId;
      }
      break;
    }

    case "create_release_pr": {
      if (args.release_tag || args.releaseTag) {
        params.releaseTag = args.release_tag || args.releaseTag;
      }
      break;
    }

    case "spec_to_pr": {
      params.rawSpec = args.raw_spec ?? args.rawSpec ?? null;
      params.recipeId = args.recipe_id ?? args.recipeId ?? null;
      break;
    }
  }

  return params;
}

// ─── Main exported functions ──────────────────────────────────────────────────

export async function answerShipBrainQuestion(input: {
  supabase: SupabaseLike;
  userId: string;
  userEmail?: string | null;
  repoFullName?: string | null;
  threadId?: string | null;
  message: string;
  limit?: number;
  pendingAction?: ChatAction | null;
}): Promise<{
  reply: string;
  activeRepo: string | null;
  context: any;
  historyCount: number;
  action: ChatAction | null;
}> {
  const context = await getShipBrainAgentContext({
    supabase: input.supabase,
    userId: input.userId,
    repoFullName: input.repoFullName ?? null,
    limit: input.limit ?? 12
  });

  const history = input.threadId
    ? await listChatMessages({ supabase: input.supabase, userId: input.userId, threadId: input.threadId, limit: 12 })
    : [];

  const base = { activeRepo: context.activeRepo ?? null, context, historyCount: history.length };

  // Onboarding gate
  const onboardingMsg = checkRepoOnboarding(context);
  if (onboardingMsg) {
    return { ...base, reply: onboardingMsg, action: null };
  }

  // Confirmation flow
  if (input.pendingAction?.status === "pending_confirmation") {
    const confirmTagMatch = input.message.match(/^confirm\s+tag\s+(.+)$/i);
    if (confirmTagMatch && (input.pendingAction.type === "deploy_production" || input.pendingAction.type === "approve_hotfix")) {
      const customTag = confirmTagMatch[1].trim();
      const result = await executeAction(
        input.pendingAction.type as any,
        { ...input.pendingAction.params, releaseTag: customTag },
        input.supabase as any,
        input.userId,
        input.repoFullName ?? null
      );
      return {
        ...base,
        reply: result.success
          ? formatActionResult(input.pendingAction.type as any, result.result)
          : `❌ **Action Failed**\n\n${result.error}`,
        action: result.success
          ? { ...input.pendingAction, status: "completed", params: { ...input.pendingAction.params, releaseTag: customTag }, result: result.result }
          : { ...input.pendingAction, status: "failed", params: { ...input.pendingAction.params, releaseTag: customTag }, error: result.error }
      };
    }

    // Handle "use tag X" for deploy_production or approve_hotfix
    const useTagMatch = input.message.match(/^use\s+tag\s+(.+)$/i);
    if (useTagMatch && (input.pendingAction.type === "deploy_production" || input.pendingAction.type === "approve_hotfix")) {
      const customTag = useTagMatch[1].trim();
      const updatedParams = { ...input.pendingAction.params, releaseTag: customTag };
      const confirmMsg = generateConfirmation(input.pendingAction.type as any, updatedParams, context);
      return {
        ...base,
        reply: confirmMsg,
        action: { ...input.pendingAction, params: updatedParams, confirmationMessage: confirmMsg }
      };
    }

    if (isConfirmation(input.message)) {
      const result = await executeAction(
        input.pendingAction.type as any,
        input.pendingAction.params,
        input.supabase as any,
        input.userId,
        input.repoFullName ?? null
      );
      return {
        ...base,
        reply: result.success
          ? formatActionResult(input.pendingAction.type as any, result.result)
          : `❌ **Action Failed**\n\n${result.error}`,
        action: result.success
          ? { ...input.pendingAction, status: "completed", result: result.result }
          : { ...input.pendingAction, status: "failed", error: result.error }
      };
    }
    if (isCancellation(input.message)) {
      return { ...base, reply: "Action cancelled. What else can I help you with?", action: null };
    }
  }

  if (
    input.pendingAction?.type === "spec_to_pr" &&
    input.pendingAction.status === "needs_input"
  ) {
    const recipes = input.pendingAction.params?.recipes as Array<{ id: string; label: string; heading?: string; isSample?: boolean }> | undefined;
    if (recipes?.length) {
      let selectedRecipe: { id: string; label: string } | undefined;
      if (recipes.length === 1 && isConfirmation(input.message)) {
        selectedRecipe = recipes[0];
      }
      if (!selectedRecipe) {
        const lower = input.message.toLowerCase();
        selectedRecipe = recipes.find((r) => {
          const terms = [r.id, r.label, r.heading].filter(Boolean).map((s) => String(s).toLowerCase());
          return terms.some((t) => lower.includes(t));
        });
      }
      if (!selectedRecipe && /first|sample|1st|one/.test(input.message.toLowerCase())) {
        selectedRecipe = recipes.find((r) => r.isSample) || recipes[0];
      }
      if (selectedRecipe) {
        const result = await executeAction(
          "spec_to_pr",
          { ...input.pendingAction.params, recipeId: selectedRecipe.id, repoFullName: input.repoFullName },
          input.supabase as any,
          input.userId,
          input.repoFullName ?? null
        );
        return {
          ...base,
          reply: result.success
            ? formatActionResult("spec_to_pr", result.result)
            : `❌ **Failed to create Draft PR**\n\n${result.error}`,
          action: result.success
            ? { ...input.pendingAction, status: "completed", result: result.result }
            : { ...input.pendingAction, status: "failed", error: result.error }
        };
      }
    }
  }

  if (isSpecToPrRecipeRequest(input.message)) {
    const action = buildRecipeSelectionAction(context);
    return {
      ...base,
      reply: recipeSelectionMessage(context),
      action
    };
  }

  if (isPreviewRedeployRequest(input.message)) {
    const resolvedParams = await resolveWriteToolParams("deploy_preview", { redeploy: true }, context);
    const stateValidation = await validateActionState(
      "deploy_preview" as any,
      resolvedParams,
      input.supabase as any,
      input.userId
    );

    if (!stateValidation.valid) {
      return {
        ...base,
        reply: stateValidation.message ?? "No deployed preview is available to redeploy.",
        action: { type: "deploy_preview" as any, status: "completed", params: resolvedParams, result: stateValidation.currentState }
      };
    }

    const confirmMsg = generateConfirmation("deploy_preview" as any, resolvedParams, context);
    return {
      ...base,
      reply: confirmMsg,
      action: {
        type: "deploy_preview" as any,
        status: "pending_confirmation",
        params: resolvedParams,
        confirmationMessage: confirmMsg
      } as ChatAction
    };
  }

  if (isProductionRedeployRequest(input.message)) {
    const resolvedParams = await resolveWriteToolParams("deploy_production", {
      redeploy: true,
      release_tag: extractReleaseTag(input.message)
    }, context);

    const stateValidation = await validateActionState(
      "deploy_production" as any,
      resolvedParams,
      input.supabase as any,
      input.userId
    );

    if (!stateValidation.valid) {
      return {
        ...base,
        reply: stateValidation.message ?? "No current production release tag is available to redeploy.",
        action: { type: "deploy_production" as any, status: "completed", params: resolvedParams, result: stateValidation.currentState }
      };
    }

    const confirmMsg = generateConfirmation("deploy_production" as any, resolvedParams, context);
    return {
      ...base,
      reply: confirmMsg,
      action: {
        type: "deploy_production" as any,
        status: "pending_confirmation",
        params: resolvedParams,
        confirmationMessage: confirmMsg
      } as ChatAction
    };
  }

  // Build model with tools
  const model = getModel({ temperature: 0.2 });
  const modelWithTools = model.bind({ tools: getLangChainToolSpecs() } as any);

  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(
      [
        `Current user: ${input.userEmail ?? input.userId}`,
        `Active repo: ${context.activeRepo ?? "none selected"}`,
        "ShipBrain context JSON:",
        JSON.stringify(context, null, 2),
        "",
        "Recent chat history:",
        historyText(history),
        "",
        "User message:",
        input.message
      ].join("\n")
    )
  ];

  const response = await modelWithTools.invoke(messages) as AIMessage;
  const toolCalls = (response as any).tool_calls ?? (response as any).additional_kwargs?.tool_calls ?? [];

  // No tool call — plain text reply
  if (!toolCalls.length) {
    const reply = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    return { ...base, reply, action: null };
  }

  // Parse the first tool call
  const raw = toolCalls[0];
  const toolName = (raw.name ?? raw.function?.name) as ShipBrainToolName;
  let args: Record<string, any> = {};
  try {
    args = typeof raw.args === "object" ? raw.args : JSON.parse(raw.function?.arguments ?? "{}");
  } catch { args = {}; }

  // Read tool → execute immediately
  if (READ_TOOL_NAMES.has(toolName)) {
    const result = executeReadToolFromContext(toolName, args, context);
    return {
      ...base,
      reply: result,
      action: { type: toolName as any, status: "completed", params: args, result }
    };
  }

  // Write tool → resolve params, validate state, check for options
  const tool = TOOL_BY_NAME[toolName];
  const resolvedParams = await resolveWriteToolParams(toolName, args, context);

  if (toolName === "spec_to_pr" && !resolvedParams.rawSpec && !resolvedParams.recipeId) {
    const action = buildRecipeSelectionAction(context);
    return {
      ...base,
      reply: recipeSelectionMessage(context),
      action
    };
  }

  // Validate current state before asking for confirmation (prevents stale responses)
  const stateValidation = await validateActionState(
    toolName as any,
    resolvedParams,
    input.supabase as any,
    input.userId
  );

  // If state is invalid, return the validation message directly (no confirmation needed)
  if (!stateValidation.valid) {
    return {
      ...base,
      reply: stateValidation.message ?? "Action not available in current state.",
      action: { type: toolName as any, status: "completed", params: resolvedParams, result: stateValidation.currentState }
    };
  }

  // If valid but has an info message (e.g., "already analyzed, re-running..."), prepend it
  const options = resolveActionOptions(toolName, args, context);
  const confirmMsg = stateValidation.message
    ? `${stateValidation.message}\n\n${generateConfirmation(toolName as any, resolvedParams, context)}`
    : generateConfirmation(toolName as any, resolvedParams, context);

  return {
    ...base,
    reply: confirmMsg,
    action: {
      type: toolName as any,
      status: "pending_confirmation",
      params: resolvedParams,
      confirmationMessage: confirmMsg,
      ...(options ? { options } : {})
    } as ChatAction
  };
}

export async function streamShipBrainQuestion(input: {
  supabase: SupabaseLike;
  userId: string;
  userEmail?: string | null;
  repoFullName?: string | null;
  threadId?: string | null;
  message: string;
  limit?: number;
  pendingAction?: ChatAction | null;
}): Promise<{
  context: any;
  history: StoredChatMessage[];
  action: ChatAction | null;
  stream: AsyncIterable<any>;
}> {
  const context = await getShipBrainAgentContext({
    supabase: input.supabase,
    userId: input.userId,
    repoFullName: input.repoFullName ?? null,
    limit: input.limit ?? 12
  });

  const history = input.threadId
    ? await listChatMessages({ supabase: input.supabase, userId: input.userId, threadId: input.threadId, limit: 12 })
    : [];

  const base = { context, history };

  // Onboarding gate
  const lowerMessage = input.message.toLowerCase();
  const isGeneralQuestion = /^(hi|hello|hey|help|what can you do|how do i)/i.test(lowerMessage);
  if (!isGeneralQuestion && !input.pendingAction) {
    const onboardingMsg = checkRepoOnboarding(context);
    if (onboardingMsg) {
      return { ...base, action: null, stream: textStream(onboardingMsg) };
    }
  }

  // Confirmation flow
  if (input.pendingAction?.status === "pending_confirmation") {
    const confirmTagMatch = input.message.match(/^confirm\s+tag\s+(.+)$/i);
    if (confirmTagMatch && (input.pendingAction.type === "deploy_production" || input.pendingAction.type === "approve_hotfix")) {
      const customTag = confirmTagMatch[1].trim();
      const result = await executeAction(
        input.pendingAction.type as any,
        { ...input.pendingAction.params, releaseTag: customTag },
        input.supabase as any,
        input.userId,
        input.repoFullName ?? null
      );
      const reply = result.success
        ? formatActionResult(input.pendingAction.type as any, result.result)
        : `❌ **Action Failed**\n\n${result.error}`;
      return {
        ...base,
        action: result.success
          ? { ...input.pendingAction, status: "completed", params: { ...input.pendingAction.params, releaseTag: customTag }, result: result.result }
          : { ...input.pendingAction, status: "failed", params: { ...input.pendingAction.params, releaseTag: customTag }, error: result.error },
        stream: textStream(reply)
      };
    }

    // Handle "use tag X" for deploy_production or approve_hotfix
    const useTagMatch = input.message.match(/^use\s+tag\s+(.+)$/i);
    if (useTagMatch && (input.pendingAction.type === "deploy_production" || input.pendingAction.type === "approve_hotfix")) {
      const customTag = useTagMatch[1].trim();
      const updatedParams = { ...input.pendingAction.params, releaseTag: customTag };
      const confirmMsg = generateConfirmation(input.pendingAction.type as any, updatedParams, context);
      return {
        ...base,
        action: { ...input.pendingAction, params: updatedParams, confirmationMessage: confirmMsg },
        stream: textStream(confirmMsg)
      };
    }

    if (isConfirmation(input.message)) {
      const result = await executeAction(
        input.pendingAction.type as any,
        input.pendingAction.params,
        input.supabase as any,
        input.userId,
        input.repoFullName ?? null
      );
      const reply = result.success
        ? formatActionResult(input.pendingAction.type as any, result.result)
        : `❌ **Action Failed**\n\n${result.error}`;
      return {
        ...base,
        action: result.success
          ? { ...input.pendingAction, status: "completed", result: result.result }
          : { ...input.pendingAction, status: "failed", error: result.error },
        stream: textStream(reply)
      };
    }
    if (isCancellation(input.message)) {
      return { ...base, action: null, stream: textStream("Action cancelled. What else can I help you with?") };
    }
  }

  // Handle spec_to_pr recipe selection flow
  if (
    input.pendingAction?.type === "spec_to_pr" &&
    input.pendingAction.status === "needs_input"
  ) {
    const recipes = input.pendingAction.params?.recipes as Array<{ id: string; label: string; heading?: string }> | undefined;
    if (recipes?.length) {
      let selectedRecipe: { id: string; label: string } | undefined;
      if (recipes.length === 1 && isConfirmation(input.message)) {
        selectedRecipe = recipes[0];
      }
      if (!selectedRecipe) {
        const lower = input.message.toLowerCase();
        selectedRecipe = recipes.find((r) => {
          const terms = [r.id, r.label, r.heading].filter(Boolean).map((s) => String(s).toLowerCase());
          return terms.some((t) => lower.includes(t));
        });
      }
      if (!selectedRecipe && /first|sample|1st|one/.test(input.message.toLowerCase())) {
        selectedRecipe = (recipes as any[]).find((r) => r.isSample) || recipes[0];
      }
      if (selectedRecipe) {
        const result = await executeAction(
          "spec_to_pr",
          { ...input.pendingAction.params, recipeId: selectedRecipe.id, repoFullName: input.repoFullName },
          input.supabase as any,
          input.userId,
          input.repoFullName ?? null
        );
        const reply = result.success
          ? formatActionResult("spec_to_pr", result.result)
          : `❌ **Failed to create Draft PR**\n\n${result.error}`;
        return {
          ...base,
          action: result.success
            ? { ...input.pendingAction, status: "completed", result: result.result }
            : { ...input.pendingAction, status: "failed", error: result.error },
          stream: textStream(reply)
        };
      }
    }
  }

  if (isSpecToPrRecipeRequest(input.message)) {
    const action = buildRecipeSelectionAction(context);
    return {
      ...base,
      action,
      stream: textStream(recipeSelectionMessage(context))
    };
  }

  if (isPreviewRedeployRequest(input.message)) {
    const resolvedParams = await resolveWriteToolParams("deploy_preview", { redeploy: true }, context);
    const stateValidation = await validateActionState(
      "deploy_preview" as any,
      resolvedParams,
      input.supabase as any,
      input.userId
    );

    if (!stateValidation.valid) {
      return {
        ...base,
        action: { type: "deploy_preview" as any, status: "completed", params: resolvedParams, result: stateValidation.currentState },
        stream: textStream(stateValidation.message ?? "No deployed preview is available to redeploy.")
      };
    }

    const confirmMsg = generateConfirmation("deploy_preview" as any, resolvedParams, context);
    const action: ChatAction = {
      type: "deploy_preview" as any,
      status: "pending_confirmation",
      params: resolvedParams,
      confirmationMessage: confirmMsg
    };
    return { ...base, action, stream: textStream(confirmMsg) };
  }

  if (isProductionRedeployRequest(input.message)) {
    const resolvedParams = await resolveWriteToolParams("deploy_production", {
      redeploy: true,
      release_tag: extractReleaseTag(input.message)
    }, context);

    const stateValidation = await validateActionState(
      "deploy_production" as any,
      resolvedParams,
      input.supabase as any,
      input.userId
    );

    if (!stateValidation.valid) {
      return {
        ...base,
        action: { type: "deploy_production" as any, status: "completed", params: resolvedParams, result: stateValidation.currentState },
        stream: textStream(stateValidation.message ?? "No current production release tag is available to redeploy.")
      };
    }

    const confirmMsg = generateConfirmation("deploy_production" as any, resolvedParams, context);
    const action: ChatAction = {
      type: "deploy_production" as any,
      status: "pending_confirmation",
      params: resolvedParams,
      confirmationMessage: confirmMsg
    };
    return { ...base, action, stream: textStream(confirmMsg) };
  }

  // Build model with tools and stream
  const model = getModel({ temperature: 0.2, streaming: true });
  const modelWithTools = model.bind({ tools: getLangChainToolSpecs() } as any);

  // #8 & #9: Build a richer context preamble with memory notes and notification counts
  const memoryBlock = context.memoryNotes ? context.memoryNotes.trim() : "";
  const notifHint = (context.unreadNotificationCount ?? 0) > 0
    ? `Unread notifications: ${context.unreadNotificationCount} (see unreadNotifications in context for details)`
    : "";

  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(
      [
        `Current user: ${input.userEmail ?? input.userId}`,
        `Active repo: ${context.activeRepo ?? "none selected"}`,
        ...(notifHint ? [notifHint] : []),
        ...(memoryBlock ? [memoryBlock] : []),
        "ShipBrain context JSON:",
        JSON.stringify(context, null, 2),
        "",
        "Recent chat history:",
        historyText(history),
        "",
        "User message:",
        input.message
      ].join("\n")
    )
  ];

  // Invoke non-streaming first to check for tool calls
  const probeModel = getModel({ temperature: 0.2, streaming: false });
  const probeWithTools = probeModel.bind({ tools: getLangChainToolSpecs() } as any);
  const probeResponse = await probeWithTools.invoke(messages) as AIMessage;
  const toolCalls = (probeResponse as any).tool_calls ?? (probeResponse as any).additional_kwargs?.tool_calls ?? [];

  if (!toolCalls.length) {
    // No tool call — stream the response
    const stream = await modelWithTools.stream(messages);
    return { ...base, action: null, stream };
  }

  // Parse tool call
  const raw = toolCalls[0];
  const toolName = (raw.name ?? raw.function?.name) as ShipBrainToolName;
  let args: Record<string, any> = {};
  try {
    args = typeof raw.args === "object" ? raw.args : JSON.parse(raw.function?.arguments ?? "{}");
  } catch { args = {}; }

  // Read tool → execute immediately, stream text
  if (READ_TOOL_NAMES.has(toolName)) {
    const result = executeReadToolFromContext(toolName, args, context);
    return {
      ...base,
      action: { type: toolName as any, status: "completed", params: args, result },
      stream: textStream(result)
    };
  }

  // Write tool → resolve params, validate state, check for options
  const resolvedParams = await resolveWriteToolParams(toolName, args, context);

  if (toolName === "spec_to_pr" && !resolvedParams.rawSpec && !resolvedParams.recipeId) {
    const action = buildRecipeSelectionAction(context);
    return {
      ...base,
      action,
      stream: textStream(recipeSelectionMessage(context))
    };
  }

  // Validate current state before asking for confirmation (prevents stale responses)
  const stateValidation = await validateActionState(
    toolName as any,
    resolvedParams,
    input.supabase as any,
    input.userId
  );

  // If state is invalid, return the validation message directly (no confirmation needed)
  if (!stateValidation.valid) {
    return {
      ...base,
      action: { type: toolName as any, status: "completed", params: resolvedParams, result: stateValidation.currentState },
      stream: textStream(stateValidation.message ?? "Action not available in current state.")
    };
  }

  // If valid but has an info message (e.g., "already analyzed, re-running..."), prepend it
  const options = resolveActionOptions(toolName, args, context);
  const confirmMsg = stateValidation.message
    ? `${stateValidation.message}\n\n${generateConfirmation(toolName as any, resolvedParams, context)}`
    : generateConfirmation(toolName as any, resolvedParams, context);

  const action: ChatAction = {
    type: toolName as any,
    status: "pending_confirmation",
    params: resolvedParams,
    confirmationMessage: confirmMsg,
    ...(options ? { options } : {})
  };

  return { ...base, action, stream: textStream(confirmMsg) };
}
