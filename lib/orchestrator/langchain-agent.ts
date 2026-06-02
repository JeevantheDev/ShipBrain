/**
 * LangChain Orchestrator Agent
 *
 * This agent wraps all unified actions as LangChain tools, providing a
 * single entry point for AI-powered interactions from:
 * - AI Chat
 * - Telegram natural language
 * - Quick Prompts
 *
 * Uses Microsoft Azure AI Foundry as the default LLM provider.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { z } from "zod";
import { getModel } from "@/lib/ai/model";
import { ActionContext, ActionResult } from "@/lib/actions/types";
import {
  deployPreview,
  deployProduction,
  createReleasePR,
  rollback,
  getAvailableReleases,
  createHotfix,
  approveHotfix,
  syncHotfix,
  analyzeIncident,
  resolveIncident,
  acknowledgeIncident
} from "@/lib/actions";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrchestratorContext {
  /** Action context for executing unified actions */
  actionCtx: ActionContext;
  /** Recent pending deployments for context */
  pendingDeployments?: any[];
  /** Active incidents for context */
  incidents?: any[];
  /** Release traces for context */
  releaseTraces?: any[];
  /** Recent PRs for context */
  recentPrs?: any[];
}

export interface OrchestratorResult {
  /** Whether the action succeeded */
  success: boolean;
  /** Human-readable message */
  message: string;
  /** Structured data from the action */
  data?: Record<string, unknown>;
  /** The tool that was called */
  toolCalled?: string;
  /** Whether user confirmation was required */
  needsConfirmation?: boolean;
  /** Options for user to select from */
  actionOptions?: Array<{
    label: string;
    sublabel?: string;
    value: string;
    badge?: string;
  }>;
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

function createOrchestratorTools(ctx: OrchestratorContext): DynamicStructuredTool[] {
  const { actionCtx } = ctx;

  return [
    // ─── Read Tools ───────────────────────────────────────────────────────────

    new DynamicStructuredTool({
      name: "get_pending_deployments",
      description: "Get list of specs/PRs pending preview or production deployment",
      schema: z.object({}),
      func: async () => {
        return JSON.stringify({
          pendingDeployments: ctx.pendingDeployments ?? [],
          message: `Found ${ctx.pendingDeployments?.length ?? 0} pending deployments`
        });
      }
    }),

    new DynamicStructuredTool({
      name: "get_incidents",
      description: "List open or investigating incidents",
      schema: z.object({
        status: z.enum(["open", "investigating", "resolved", "all"]).optional()
          .describe("Filter incidents by status")
      }),
      func: async ({ status }) => {
        let filtered = ctx.incidents ?? [];
        if (status && status !== "all") {
          filtered = filtered.filter((i: any) => i.status === status);
        } else if (!status) {
          filtered = filtered.filter((i: any) => i.status !== "resolved" && i.status !== "closed");
        }
        return JSON.stringify({
          incidents: filtered,
          message: `Found ${filtered.length} incidents`
        });
      }
    }),

    new DynamicStructuredTool({
      name: "get_release_traces",
      description: "Get active release traces showing pipeline phase",
      schema: z.object({}),
      func: async () => {
        return JSON.stringify({
          releaseTraces: ctx.releaseTraces ?? [],
          message: `Found ${ctx.releaseTraces?.length ?? 0} release traces`
        });
      }
    }),

    new DynamicStructuredTool({
      name: "get_available_releases",
      description: "Get releases available for rollback",
      schema: z.object({}),
      func: async () => {
        const result = await getAvailableReleases(actionCtx, actionCtx.repoFullName);
        return JSON.stringify(result);
      }
    }),

    // ─── Write Tools ──────────────────────────────────────────────────────────

    new DynamicStructuredTool({
      name: "deploy_preview",
      description: "Deploy a merged feature PR to the preview/develop environment",
      schema: z.object({
        pr_number: z.string().optional().describe("GitHub PR number to deploy"),
        spec_id: z.string().optional().describe("ShipBrain spec UUID")
      }),
      func: async ({ pr_number, spec_id }) => {
        const result = await deployPreview(actionCtx, {
          specId: spec_id,
          repoFullName: actionCtx.repoFullName
        });
        return JSON.stringify(formatActionResult("deploy_preview", result));
      }
    }),

    new DynamicStructuredTool({
      name: "deploy_production",
      description: "Create release tag and deploy to production",
      schema: z.object({
        pr_number: z.string().optional().describe("PR number for the feature"),
        spec_id: z.string().optional().describe("ShipBrain spec UUID"),
        release_tag: z.string().optional().describe("Explicit release tag")
      }),
      func: async ({ spec_id, release_tag }) => {
        const result = await deployProduction(actionCtx, {
          specId: spec_id,
          releaseTag: release_tag,
          repoFullName: actionCtx.repoFullName
        });
        return JSON.stringify(formatActionResult("deploy_production", result));
      }
    }),

    new DynamicStructuredTool({
      name: "create_release_pr",
      description: "Create a release promotion PR from develop to main",
      schema: z.object({
        release_tag: z.string().optional().describe("Explicit release tag")
      }),
      func: async ({ release_tag }) => {
        const result = await createReleasePR(actionCtx, {
          repoFullName: actionCtx.repoFullName,
          releaseTag: release_tag
        });
        return JSON.stringify(formatActionResult("create_release_pr", result));
      }
    }),

    new DynamicStructuredTool({
      name: "rollback",
      description: "Roll back production to a previous release",
      schema: z.object({
        target_release_tag: z.string().describe("Release tag to roll back to")
      }),
      func: async ({ target_release_tag }) => {
        const result = await rollback(actionCtx, {
          repoFullName: actionCtx.repoFullName,
          targetReleaseTag: target_release_tag
        });
        return JSON.stringify(formatActionResult("rollback", result));
      }
    }),

    new DynamicStructuredTool({
      name: "create_hotfix",
      description: "Create a hotfix PR for an incident",
      schema: z.object({
        incident_id: z.string().describe("UUID of the incident"),
        base_branch: z.enum(["develop", "main"]).optional()
          .describe("Base branch for hotfix, defaults to develop")
      }),
      func: async ({ incident_id, base_branch }) => {
        const result = await createHotfix(actionCtx, {
          incidentId: incident_id,
          baseBranch: base_branch
        });
        return JSON.stringify(formatActionResult("create_hotfix", result));
      }
    }),

    new DynamicStructuredTool({
      name: "approve_hotfix",
      description: "Merge and deploy a hotfix PR",
      schema: z.object({
        incident_id: z.string().describe("UUID of the incident"),
        release_tag: z.string().optional().describe("Custom release tag"),
        note: z.string().optional().describe("Approval note")
      }),
      func: async ({ incident_id, release_tag, note }) => {
        const result = await approveHotfix(actionCtx, {
          incidentId: incident_id,
          releaseTag: release_tag,
          note
        });
        return JSON.stringify(formatActionResult("approve_hotfix", result));
      }
    }),

    new DynamicStructuredTool({
      name: "sync_hotfix",
      description: "Sync commits from a hotfix PR",
      schema: z.object({
        incident_id: z.string().describe("UUID of the incident")
      }),
      func: async ({ incident_id }) => {
        const result = await syncHotfix(actionCtx, {
          incidentId: incident_id
        });
        return JSON.stringify(formatActionResult("sync_hotfix", result));
      }
    }),

    new DynamicStructuredTool({
      name: "analyze_incident",
      description: "Run AI analysis on an incident",
      schema: z.object({
        incident_id: z.string().describe("UUID of the incident")
      }),
      func: async ({ incident_id }) => {
        const result = await analyzeIncident(actionCtx, {
          incidentId: incident_id
        });
        return JSON.stringify(formatActionResult("analyze_incident", result));
      }
    }),

    new DynamicStructuredTool({
      name: "resolve_incident",
      description: "Mark an incident as resolved",
      schema: z.object({
        incident_id: z.string().describe("UUID of the incident"),
        note: z.string().optional().describe("Resolution note")
      }),
      func: async ({ incident_id, note }) => {
        const result = await resolveIncident(actionCtx, {
          incidentId: incident_id,
          note
        });
        return JSON.stringify(formatActionResult("resolve_incident", result));
      }
    }),

    new DynamicStructuredTool({
      name: "acknowledge_incident",
      description: "Acknowledge an incident to start investigating",
      schema: z.object({
        incident_id: z.string().describe("UUID of the incident"),
        note: z.string().optional().describe("Acknowledgement note")
      }),
      func: async ({ incident_id, note }) => {
        const result = await acknowledgeIncident(actionCtx, {
          incidentId: incident_id,
          note
        });
        return JSON.stringify(formatActionResult("acknowledge_incident", result));
      }
    })
  ];
}

function formatActionResult(toolName: string, result: ActionResult<any>): OrchestratorResult {
  return {
    success: result.ok,
    message: result.message,
    data: result.data,
    toolCalled: toolName
  };
}

// ─── Agent Creation ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are ShipBrain, an AI assistant for release engineering and incident management.

You help developers and engineering managers with:
- Deploying code to preview and production environments
- Managing release pipelines
- Handling production incidents
- Creating and managing hotfix PRs
- Rolling back releases when needed

Guidelines:
1. Always use the appropriate tool to execute actions - never just describe what you would do
2. For write operations (deploy, approve, rollback), confirm with the user before executing if the operation is high-risk
3. When multiple options are available, list them clearly for the user to choose
4. Provide clear, concise responses focused on the action taken
5. If an action fails, explain why and suggest alternatives

Current repository: {repo_full_name}
User: {actor}`;

/**
 * Create a LangChain agent executor for the orchestrator
 */
export async function createOrchestratorAgent(ctx: OrchestratorContext): Promise<AgentExecutor> {
  const tools = createOrchestratorTools(ctx);
  const model = getModel({ temperature: 0 });

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", SYSTEM_PROMPT],
    new MessagesPlaceholder("chat_history"),
    ["human", "{input}"],
    new MessagesPlaceholder("agent_scratchpad")
  ]);

  const agent = await createToolCallingAgent({
    llm: model,
    tools,
    prompt
  });

  return new AgentExecutor({
    agent,
    tools,
    verbose: process.env.NODE_ENV === "development",
    maxIterations: 5,
    returnIntermediateSteps: true
  });
}

/**
 * Execute a natural language request through the orchestrator
 */
export async function executeOrchestratorRequest(
  ctx: OrchestratorContext,
  input: string,
  chatHistory: Array<{ role: "human" | "ai"; content: string }> = []
): Promise<OrchestratorResult> {
  try {
    const agent = await createOrchestratorAgent(ctx);

    // Convert chat history to LangChain message format
    const formattedHistory = chatHistory.map(msg =>
      msg.role === "human"
        ? ["human", msg.content] as const
        : ["ai", msg.content] as const
    );

    const result = await agent.invoke({
      input,
      chat_history: formattedHistory,
      repo_full_name: ctx.actionCtx.repoFullName,
      actor: ctx.actionCtx.actor
    });

    // Extract the tool that was called from intermediate steps
    const toolCalled = result.intermediateSteps?.[0]?.action?.tool;

    return {
      success: true,
      message: result.output,
      toolCalled
    };

  } catch (error) {
    console.error("[Orchestrator] Agent execution error:", error);
    return {
      success: false,
      message: `Failed to execute request: ${error instanceof Error ? error.message : "Unknown error"}`
    };
  }
}

/**
 * Execute a specific tool directly (bypass LLM decision-making)
 * Used for Quick Prompts and direct action execution
 */
export async function executeOrchestratorTool(
  ctx: OrchestratorContext,
  toolName: string,
  args: Record<string, any>
): Promise<OrchestratorResult> {
  try {
    switch (toolName) {
      case "deploy_preview":
        return formatActionResult(toolName, await deployPreview(ctx.actionCtx, {
          specId: args.spec_id,
          repoFullName: ctx.actionCtx.repoFullName,
          forceRedeploy: args.force
        }));

      case "deploy_production":
        return formatActionResult(toolName, await deployProduction(ctx.actionCtx, {
          specId: args.spec_id,
          releaseTag: args.release_tag,
          releaseSha: args.release_sha,
          repoFullName: ctx.actionCtx.repoFullName,
          forceRedeploy: args.force
        }));

      case "create_release_pr":
        return formatActionResult(toolName, await createReleasePR(ctx.actionCtx, {
          repoFullName: ctx.actionCtx.repoFullName,
          releaseTag: args.release_tag
        }));

      case "rollback":
        return formatActionResult(toolName, await rollback(ctx.actionCtx, {
          repoFullName: ctx.actionCtx.repoFullName,
          targetReleaseTag: args.target_release_tag
        }));

      case "create_hotfix":
        return formatActionResult(toolName, await createHotfix(ctx.actionCtx, {
          incidentId: args.incident_id,
          baseBranch: args.base_branch,
          analysis: args.analysis
        }));

      case "approve_hotfix":
        return formatActionResult(toolName, await approveHotfix(ctx.actionCtx, {
          incidentId: args.incident_id,
          releaseTag: args.release_tag,
          note: args.note
        }));

      case "sync_hotfix":
        return formatActionResult(toolName, await syncHotfix(ctx.actionCtx, {
          incidentId: args.incident_id
        }));

      case "analyze_incident":
        return formatActionResult(toolName, await analyzeIncident(ctx.actionCtx, {
          incidentId: args.incident_id,
          releaseContext: args.release_context
        }));

      case "resolve_incident":
        return formatActionResult(toolName, await resolveIncident(ctx.actionCtx, {
          incidentId: args.incident_id,
          note: args.note
        }));

      case "acknowledge_incident":
        return formatActionResult(toolName, await acknowledgeIncident(ctx.actionCtx, {
          incidentId: args.incident_id,
          note: args.note
        }));

      case "get_available_releases":
        return formatActionResult(toolName, await getAvailableReleases(ctx.actionCtx, ctx.actionCtx.repoFullName));

      default:
        return {
          success: false,
          message: `Unknown tool: ${toolName}`,
          toolCalled: toolName
        };
    }
  } catch (error) {
    console.error(`[Orchestrator] Tool execution error (${toolName}):`, error);
    return {
      success: false,
      message: `Failed to execute ${toolName}: ${error instanceof Error ? error.message : "Unknown error"}`,
      toolCalled: toolName
    };
  }
}
