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
- Reference specific data from the context provided`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function historyText(messages: StoredChatMessage[]): string {
  if (!messages.length) return "No previous messages in this thread.";
  return messages
    .slice(-12)
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

    default:
      return "Data retrieved from context.";
  }
}

// ─── Resolve tool args → ChatAction params ─────────────────────────────────────

function resolveWriteToolParams(
  toolName: ShipBrainToolName,
  args: Record<string, any>,
  context: any
): Record<string, any> {
  const params: Record<string, any> = {};

  switch (toolName) {
    case "deploy_preview":
    case "deploy_production": {
      const prNum = args.pr_number ?? args.prNumber;
      const specId = args.spec_id ?? args.specId;
      const all = [...(context.pendingDeployments ?? []), ...(context.recentPrs ?? [])] as any[];

      let found: any = null;
      if (specId) {
        found = all.find((s) => s.id === specId);
      } else if (prNum) {
        found = all.find((s) => String(s.pr_number) === String(prNum));
      } else if (toolName === "deploy_preview") {
        found = all.find((s) => s.status === "merged" && s.base_branch === "develop" && !s.preview_url && s.preview_status !== "deploying");
      } else {
        found = all.find((s) => s.release_status === "pending_deploy" || s.release_status === "ready_for_prod" || (s.status === "merged" && s.base_branch === "main"));
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

      if (toolName === "deploy_production" && args.release_tag) {
        params.releaseTag = args.release_tag;
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

  // Write tool → resolve params, check for options
  const tool = TOOL_BY_NAME[toolName];
  const resolvedParams = resolveWriteToolParams(toolName, args, context);
  const options = resolveActionOptions(toolName, args, context);
  const confirmMsg = generateConfirmation(toolName as any, resolvedParams, context);

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

  // Build model with tools and stream
  const model = getModel({ temperature: 0.2, streaming: true });
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

  // Write tool → resolve params + options → pending_confirmation
  const resolvedParams = resolveWriteToolParams(toolName, args, context);
  const options = resolveActionOptions(toolName, args, context);
  const confirmMsg = generateConfirmation(toolName as any, resolvedParams, context);

  const action: ChatAction = {
    type: toolName as any,
    status: "pending_confirmation",
    params: resolvedParams,
    confirmationMessage: confirmMsg,
    ...(options ? { options } : {})
  };

  return { ...base, action, stream: textStream(confirmMsg) };
}
