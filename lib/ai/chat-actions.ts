/**
 * ShipBrain Chat Actions - Cloudflare-style AI operation execution
 *
 * This module handles:
 * 1. Intent detection from user messages
 * 2. Parameter gathering with clarifying questions
 * 3. Action confirmation
 * 4. Action execution via ShipBrain APIs
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_SPEC_PR_RECIPES } from "@/lib/spec-recipes";
import {
  createReleasePR as createReleasePRAction,
  deployPreview as deployPreviewAction,
  deployProduction as deployProductionAction,
  rollback as rollbackAction,
  createHotfix as createHotfixAction,
  approveHotfix as approveHotfixAction,
  analyzeIncident as analyzeIncidentAction,
  resolveIncident as resolveIncidentAction,
  acknowledgeIncident as acknowledgeIncidentAction,
  buildActionContext,
  ActionContext
} from "@/lib/actions";

export type ActionType =
  | "spec_to_pr"
  | "deploy_preview"
  | "deploy_production"
  | "approve_release"
  | "rollback"
  | "create_hotfix"
  | "approve_hotfix"
  | "analyze_incident"
  | "resolve_incident"
  | "acknowledge_incident"
  | "create_release_pr"
  | "view_status"
  | "view_prs"
  | "view_deployments"
  | "view_incidents"
  | "view_releases"
  | "view_ci";

export type ActionStatus = "pending_confirmation" | "executing" | "completed" | "failed" | "needs_input";

/** A selectable chip the frontend renders when the LLM wants input selection */
export type ActionOption = {
  label: string;
  sublabel?: string;
  /** The message text auto-sent when the user clicks this option */
  value: string;
  badge?: string;
};

export type ChatAction = {
  type: ActionType;
  status: ActionStatus;
  params: Record<string, any>;
  missingParams?: string[];
  confirmationMessage?: string;
  result?: any;
  error?: string;
  /** Selectable options surfaced by the backend so the user doesn't need to type */
  options?: ActionOption[];
};

// ActionIntent type retained for backward compatibility with any remaining references
export type ActionIntent = {
  detected: boolean;
  action?: ActionType;
  params: Record<string, any>;
  missingParams: string[];
  clarifyingQuestion?: string;
};

// State validation result - if invalid, contains message to show user
export type StateValidationResult = {
  valid: boolean;
  /** Message to show user if state is invalid */
  message?: string;
  /** Current state from database (for context) */
  currentState?: Record<string, any>;
};

/**
 * Validates the current state of an entity before asking for confirmation.
 * This prevents stale responses where e.g. an already-resolved incident asks for resolve confirmation.
 *
 * @param action - The action type
 * @param params - Resolved params for the action
 * @param supabase - Database client
 * @param userId - Current user ID
 * @returns Validation result - if invalid, includes message to show user
 */
export async function validateActionState(
  action: ActionType,
  params: Record<string, any>,
  supabase: SupabaseClient,
  userId: string
): Promise<StateValidationResult> {
  try {
    switch (action) {
      case "resolve_incident": {
        if (!params.incidentId) {
          return { valid: false, message: "No incident specified to resolve." };
        }
        const { data: incident } = await supabase
          .from("incidents")
          .select("id, title, status, resolved_at, resolution_note")
          .eq("id", params.incidentId)
          .eq("user_id", userId)
          .single();

        if (!incident) {
          return { valid: false, message: "Incident not found." };
        }
        if (incident.status === "resolved") {
          const resolvedTime = incident.resolved_at
            ? new Date(incident.resolved_at).toLocaleString()
            : "earlier";
          return {
            valid: false,
            message: `✅ **Incident Already Resolved**\n\nIncident "${incident.title ?? incident.id.slice(0, 8)}" was already resolved at ${resolvedTime}.\n\n${incident.resolution_note ? `**Note:** ${incident.resolution_note}` : ""}`,
            currentState: { status: incident.status, resolvedAt: incident.resolved_at }
          };
        }
        return { valid: true, currentState: { status: incident.status } };
      }

      case "acknowledge_incident": {
        if (!params.incidentId) {
          return { valid: false, message: "No incident specified to acknowledge." };
        }
        const { data: incident } = await supabase
          .from("incidents")
          .select("id, title, status, acknowledged_at, acknowledged_by")
          .eq("id", params.incidentId)
          .eq("user_id", userId)
          .single();

        if (!incident) {
          return { valid: false, message: "Incident not found." };
        }
        if (incident.status !== "open") {
          const statusText = incident.status === "resolved"
            ? "already resolved"
            : `already being investigated (status: \`${incident.status}\`)`;
          return {
            valid: false,
            message: `ℹ️ **Incident Already Acknowledged**\n\nIncident "${incident.title ?? incident.id.slice(0, 8)}" is ${statusText}.${incident.acknowledged_by ? `\n\n**Acknowledged by:** ${incident.acknowledged_by}` : ""}`,
            currentState: { status: incident.status, acknowledgedBy: incident.acknowledged_by }
          };
        }
        return { valid: true, currentState: { status: incident.status } };
      }

      case "analyze_incident": {
        if (!params.incidentId) {
          return { valid: false, message: "No incident specified to analyze." };
        }
        const { data: incident } = await supabase
          .from("incidents")
          .select("id, title, status, ai_analysis, root_cause")
          .eq("id", params.incidentId)
          .eq("user_id", userId)
          .single();

        if (!incident) {
          return { valid: false, message: "Incident not found." };
        }
        // Analysis can be re-run even if resolved, but notify if already analyzed
        if (incident.ai_analysis && incident.root_cause) {
          // Allow re-analysis but inform user
          return {
            valid: true,
            message: `ℹ️ This incident was already analyzed. Running analysis again will refresh the results.\n\n**Previous Root Cause:** ${incident.root_cause.slice(0, 100)}...`,
            currentState: { status: incident.status, hasAnalysis: true }
          };
        }
        return { valid: true, currentState: { status: incident.status } };
      }

      case "deploy_preview": {
        if (!params.specId) {
          return { valid: false, message: "No spec specified for preview deployment." };
        }
        const { data: spec } = await supabase
          .from("specs")
          .select("id, pr_number, status, preview_status, preview_url, base_branch")
          .eq("id", params.specId)
          .eq("user_id", userId)
          .single();

        if (!spec) {
          return { valid: false, message: "Spec not found." };
        }
        if (spec.preview_status === "deployed" && spec.preview_url) {
          return {
            valid: false,
            message: `✅ **Already Deployed to Preview**\n\nPR #${spec.pr_number ?? "?"} is already deployed to preview.\n\n**Preview URL:** ${spec.preview_url}`,
            currentState: { previewStatus: spec.preview_status, previewUrl: spec.preview_url }
          };
        }
        if (spec.preview_status === "deploying") {
          return {
            valid: false,
            message: `🔄 **Preview Deployment In Progress**\n\nPR #${spec.pr_number ?? "?"} is currently being deployed to preview. Please wait for completion.`,
            currentState: { previewStatus: spec.preview_status }
          };
        }
        return { valid: true, currentState: { status: spec.status, previewStatus: spec.preview_status } };
      }

      case "deploy_production": {
        if (!params.specId) {
          return { valid: false, message: "No spec specified for production deployment." };
        }
        const { data: spec } = await supabase
          .from("specs")
          .select("id, pr_number, status, release_status, release_tag, deployed_at, deployment_url")
          .eq("id", params.specId)
          .eq("user_id", userId)
          .single();

        if (!spec) {
          return { valid: false, message: "Spec not found." };
        }
        if (spec.release_status === "deployed") {
          const deployedTime = spec.deployed_at
            ? new Date(spec.deployed_at).toLocaleString()
            : "earlier";
          return {
            valid: false,
            message: `✅ **Already Deployed to Production**\n\nPR #${spec.pr_number ?? "?"} with tag \`${spec.release_tag}\` was deployed at ${deployedTime}.${spec.deployment_url ? `\n\n**Production URL:** ${spec.deployment_url}` : ""}`,
            currentState: { releaseStatus: spec.release_status, releaseTag: spec.release_tag }
          };
        }
        if (spec.release_status === "deploying") {
          return {
            valid: false,
            message: `🔄 **Production Deployment In Progress**\n\nPR #${spec.pr_number ?? "?"} is currently being deployed to production. Please wait for completion.`,
            currentState: { releaseStatus: spec.release_status }
          };
        }
        return { valid: true, currentState: { status: spec.status, releaseStatus: spec.release_status } };
      }

      case "approve_hotfix": {
        if (!params.incidentId) {
          return { valid: false, message: "No incident specified for hotfix approval." };
        }
        const { data: incident } = await supabase
          .from("incidents")
          .select("id, title, status, hotfix_pr_number, hotfix_pr_status, hotfix_merged_at")
          .eq("id", params.incidentId)
          .eq("user_id", userId)
          .single();

        if (!incident) {
          return { valid: false, message: "Incident not found." };
        }
        if (!incident.hotfix_pr_number) {
          return {
            valid: false,
            message: `❌ **No Hotfix PR**\n\nIncident "${incident.title ?? incident.id.slice(0, 8)}" doesn't have a hotfix PR yet. Create one first with "create hotfix".`,
            currentState: { status: incident.status, hasHotfix: false }
          };
        }
        if (incident.hotfix_pr_status === "merged" || incident.hotfix_merged_at) {
          return {
            valid: false,
            message: `✅ **Hotfix Already Merged**\n\nHotfix PR #${incident.hotfix_pr_number} was already merged${incident.hotfix_merged_at ? ` at ${new Date(incident.hotfix_merged_at).toLocaleString()}` : ""}.`,
            currentState: { hotfixStatus: incident.hotfix_pr_status, merged: true }
          };
        }
        return { valid: true, currentState: { status: incident.status, hotfixPr: incident.hotfix_pr_number } };
      }

      case "create_hotfix": {
        if (!params.incidentId) {
          return { valid: false, message: "No incident specified for hotfix creation." };
        }
        const { data: incident } = await supabase
          .from("incidents")
          .select("id, title, status, hotfix_pr_number, hotfix_pr_url")
          .eq("id", params.incidentId)
          .eq("user_id", userId)
          .single();

        if (!incident) {
          return { valid: false, message: "Incident not found." };
        }
        if (incident.status === "resolved") {
          return {
            valid: false,
            message: `✅ **Incident Already Resolved**\n\nIncident "${incident.title ?? incident.id.slice(0, 8)}" is already resolved. No hotfix needed.`,
            currentState: { status: incident.status }
          };
        }
        if (incident.hotfix_pr_number) {
          return {
            valid: false,
            message: `ℹ️ **Hotfix PR Already Exists**\n\nIncident "${incident.title ?? incident.id.slice(0, 8)}" already has hotfix PR #${incident.hotfix_pr_number}.\n\n${incident.hotfix_pr_url ? `**PR URL:** ${incident.hotfix_pr_url}` : ""}\n\nTo deploy it, say "approve hotfix".`,
            currentState: { status: incident.status, hotfixPr: incident.hotfix_pr_number }
          };
        }
        return { valid: true, currentState: { status: incident.status } };
      }

      case "rollback": {
        // Rollback validation - check if target release exists and is different from current
        if (!params.targetReleaseTag) {
          return { valid: false, message: "No target release tag specified for rollback." };
        }
        // Validation will happen in the action itself since we need repo context
        return { valid: true };
      }

      // These actions don't need pre-validation
      case "spec_to_pr":
      case "create_release_pr":
      case "approve_release":
      case "view_status":
      case "view_prs":
      case "view_deployments":
      case "view_incidents":
      case "view_releases":
      case "view_ci":
        return { valid: true };

      default:
        return { valid: true };
    }
  } catch (error) {
    console.error("[validateActionState] Error:", error);
    // On error, allow the action to proceed - it will fail with proper error handling
    return { valid: true };
  }
}

// Action definitions with required parameters
const ACTION_DEFINITIONS: Record<ActionType, {
  label: string;
  description: string;
  requiredParams: string[];
  optionalParams: string[];
  confirmRequired: boolean;
  riskLevel: "low" | "medium" | "high";
}> = {
  spec_to_pr: {
    label: "Create PR from Spec",
    description: "Generate a Draft PR from a specification or feature request",
    requiredParams: ["specId"],
    optionalParams: ["handoffOnly"],
    confirmRequired: true,
    riskLevel: "medium"
  },
  create_release_pr: {
    label: "Create Release Draft PR",
    description: "Create a draft release promotion Pull Request from develop to main branch",
    requiredParams: [],
    optionalParams: ["releaseTag"],
    confirmRequired: true,
    riskLevel: "medium"
  },
  deploy_preview: {
    label: "Deploy to Preview",
    description: "Deploy a merged PR to the preview/develop environment",
    requiredParams: ["specId"],
    optionalParams: [],
    confirmRequired: true,
    riskLevel: "medium"
  },
  deploy_production: {
    label: "Deploy to Production",
    description: "Create release tag and deploy to production",
    requiredParams: ["specId"],
    optionalParams: [],
    confirmRequired: true,
    riskLevel: "high"
  },
  approve_release: {
    label: "Approve Release",
    description: "Approve a pending release or deployment action",
    requiredParams: ["traceId"],
    optionalParams: [],
    confirmRequired: true,
    riskLevel: "high"
  },
  rollback: {
    label: "Rollback Release",
    description: "Rollback production to a previous release",
    requiredParams: ["targetReleaseTag"],
    optionalParams: [],
    confirmRequired: true,
    riskLevel: "high"
  },
  create_hotfix: {
    label: "Create Hotfix",
    description: "Create a hotfix PR for an incident",
    requiredParams: ["incidentId"],
    optionalParams: ["baseBranch"],
    confirmRequired: true,
    riskLevel: "medium"
  },
  approve_hotfix: {
    label: "Approve & Deploy Hotfix",
    description: "Merge hotfix PR and deploy",
    requiredParams: ["incidentId"],
    optionalParams: [],
    confirmRequired: true,
    riskLevel: "high"
  },
  analyze_incident: {
    label: "Analyze Incident",
    description: "Run AI analysis on an incident",
    requiredParams: ["incidentId"],
    optionalParams: [],
    confirmRequired: false,
    riskLevel: "low"
  },
  resolve_incident: {
    label: "Resolve Incident",
    description: "Mark an incident as resolved",
    requiredParams: ["incidentId"],
    optionalParams: ["note"],
    confirmRequired: true,
    riskLevel: "medium"
  },
  acknowledge_incident: {
    label: "Acknowledge Incident",
    description: "Start investigating an incident",
    requiredParams: ["incidentId"],
    optionalParams: [],
    confirmRequired: true,
    riskLevel: "medium"
  },
  view_status: {
    label: "View Status",
    description: "Show current release and deployment status",
    requiredParams: [],
    optionalParams: [],
    confirmRequired: false,
    riskLevel: "low"
  },
  view_prs: {
    label: "View PRs",
    description: "List open and pending PRs",
    requiredParams: [],
    optionalParams: [],
    confirmRequired: false,
    riskLevel: "low"
  },
  view_deployments: {
    label: "View Deployments",
    description: "Show pending deployment queue",
    requiredParams: [],
    optionalParams: [],
    confirmRequired: false,
    riskLevel: "low"
  },
  view_incidents: {
    label: "View Incidents",
    description: "List active incidents",
    requiredParams: [],
    optionalParams: [],
    confirmRequired: false,
    riskLevel: "low"
  },
  view_releases: {
    label: "View Releases",
    description: "Show recent releases",
    requiredParams: [],
    optionalParams: [],
    confirmRequired: false,
    riskLevel: "low"
  },
  view_ci: {
    label: "View CI",
    description: "Show CI run status",
    requiredParams: [],
    optionalParams: [],
    confirmRequired: false,
    riskLevel: "low"
  }
};

// ─── Legacy intent detection removed ─────────────────────────────────────────
// Intent detection is now handled by the LLM via tool calling (lib/ai/tools.ts).

/** @deprecated Use LLM tool calling via lib/ai/tools.ts instead */
export function detectIntent(_message: string, _context: any): ActionIntent {
  return { detected: false, params: {}, missingParams: [] };
}


// Generate confirmation message for action
export function generateConfirmation(action: ActionType, params: Record<string, any>, context: any): string {
  const definition = ACTION_DEFINITIONS[action];
  // Safety guard: if action is not in ACTION_DEFINITIONS, return a generic prompt
  if (!definition) {
    return `Ready to execute **${action}**. Would you like me to proceed? Type **confirm** or **cancel**.`;
  }
  const riskWarning = definition.riskLevel === "high"
    ? "\n\n⚠️ **This is a production-impacting action.**"
    : "";

  switch (action) {
    case "spec_to_pr": {
      const specPreview = params.rawSpec
        ? params.rawSpec.length > 100
          ? `"${params.rawSpec.slice(0, 100)}..."`
          : `"${params.rawSpec}"`
        : params.specId
          ? `spec \`${params.specId}\``
          : "the provided spec";
      return `I'll create a Draft PR from ${specPreview}.${riskWarning}\n\nThis will:\n- Analyze the spec with AI\n- Generate implementation code\n- Create a draft PR on GitHub\n\nWould you like me to proceed?`;
    }

    case "create_release_pr": {
      const tagInfo = params.releaseTag ? ` with tag \`${params.releaseTag}\`` : "";
      return `I'll create a Draft Release PR from **develop** to **main** branch${tagInfo}.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;
    }

    case "deploy_preview":
      return `I'll deploy spec \`${params.specId}\` to the preview environment.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;

    case "deploy_production": {
      // params.releaseTag is now always set by resolveWriteToolParams
      const releaseTag = params.releaseTag;
      return `I'll deploy to production for spec \`${params.specId}\`.\n\n**Release Tag:** \`${releaseTag}\`\n\nTo proceed with this tag, type **confirm**.\nTo use a custom tag, type: **use tag your-custom-tag**\nOr type **cancel** to abort.`;
    }

    case "approve_release":
      return `I'll approve the release for trace \`${params.traceId}\`.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;

    case "rollback":
      return `I'll rollback production to release \`${params.targetReleaseTag}\`.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;

    case "create_hotfix":
      if (!params.baseBranch) {
        return `I'll create a hotfix PR for incident \`${params.incidentId}\`.\n\n**Which branch should I target?**\n- **develop** - Standard flow with preview validation\n- **main** - Direct to production (emergency only)\n\nPlease select a branch option above or type "develop" or "main".`;
      }
      return `I'll create a hotfix PR for incident \`${params.incidentId}\` on the **${params.baseBranch}** branch.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;

    case "approve_hotfix": {
      // params.baseBranch and params.releaseTag are now set by resolveWriteToolParams
      const isMainTarget = params.baseBranch === "main";

      if (isMainTarget && params.releaseTag) {
        return `I'll merge the hotfix for incident \`${params.incidentId}\` and deploy it to **production**.${riskWarning}\n\n**Release Tag:** \`${params.releaseTag}\`\n\nTo proceed with this tag, type **confirm**.\nTo use a custom tag, type: **use tag your-custom-tag**\nOr type **cancel** to abort.`;
      }
      return `I'll merge the hotfix for incident \`${params.incidentId}\` and deploy it.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;
    }

    case "resolve_incident":
      return `I'll mark incident \`${params.incidentId}\` as resolved with note: "${params.note || "Resolved via AI Chat"}".${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;

    case "acknowledge_incident":
      return `I'll acknowledge incident \`${params.incidentTitle || params.incidentId}\` to start investigating.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;

    default:
      return `I'll execute ${definition.label}.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;
  }
}

// Resolve base URL for internal API calls
function getInternalApiBaseUrl(): string {
  // Try various environment variables in order of preference
  const candidates = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.SHIPBRAIN_API_URL,
    process.env.NEXT_PUBLIC_SHIPBRAIN_API_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`,
    process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,
    "http://localhost:3003"
  ];

  for (const candidate of candidates) {
    if (candidate?.trim()) {
      const url = candidate.trim();
      // Ensure URL has protocol
      const withProtocol = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      return withProtocol.replace(/\/$/, "");
    }
  }

  return "http://localhost:3003";
}

// Execute action
export async function executeAction(
  action: ActionType,
  params: Record<string, any>,
  supabase: SupabaseClient,
  userId: string,
  repoFullName: string | null
): Promise<{ success: boolean; result?: any; error?: string }> {
  const baseUrl = getInternalApiBaseUrl();

  try {
    switch (action) {
      case "spec_to_pr": {
        // For spec_to_pr, we need either rawSpec, recipeId, or specId
        let rawSpec = params.rawSpec;
        let baseBranch = params.baseBranch;
        let sourceBranch = params.sourceBranch;

        // If we have a recipeId, load the recipe's ticket content
        if (!rawSpec && params.recipeId) {
          const recipe = DEFAULT_SPEC_PR_RECIPES.find(r => r.id === params.recipeId);
          if (recipe) {
            rawSpec = recipe.ticket;
            baseBranch = baseBranch || recipe.baseBranch;
            sourceBranch = sourceBranch || recipe.sourceBranch;
          }
        }

        // If we have a specId but no rawSpec, try to look it up
        if (!rawSpec && params.specId) {
          const { data: spec } = await supabase
            .from("specs")
            .select("content, raw_spec")
            .eq("id", params.specId)
            .maybeSingle();

          if (spec) {
            rawSpec = spec.raw_spec || spec.content;
          }
        }

        // If still no rawSpec, we need to ask for it
        if (!rawSpec) {
          return {
            success: false,
            error: "Please provide the spec content or feature description to create a PR."
          };
        }

        const response = await fetch(`${baseUrl}/api/ai/spec-to-pr`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-User-Id": userId
          },
          body: JSON.stringify({
            rawSpec,
            createPr: true,
            repoFullName: repoFullName || undefined,
            baseBranchOverride: baseBranch || undefined,
            useExistingSourceBranch: Boolean(sourceBranch),
            branchOverride: sourceBranch || undefined,
            handoffOnly: params.handoffOnly ?? false,
            internalUserId: userId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.detail || "Failed to create PR");

        return { success: true, result: data };
      }

      case "create_release_pr": {
        if (!repoFullName) {
          throw new Error("No active repository selected.");
        }

        // Build unified action context (uses admin client internally)
        const ctx = await buildActionContext({ db: supabase, userId, source: "chat", repoFullName: repoFullName || undefined });
        if (!ctx) {
          throw new Error("GitHub is not connected. Please connect your GitHub account in Settings.");
        }

        // Use unified createReleasePR action
        const result = await createReleasePRAction(ctx, {
          repoFullName,
          releaseTag: params.releaseTag
        });

        if (!result.ok) {
          throw new Error(result.error || result.message);
        }

        return {
          success: true,
          result: {
            prNumber: result.data?.prNumber,
            prUrl: result.data?.prUrl,
            releaseTag: result.data?.releaseTag,
            specId: result.data?.specId
          }
        };
      }

      case "deploy_preview": {
        // Build unified action context
        const previewCtx = await buildActionContext({ db: supabase, userId, source: "chat", repoFullName: repoFullName || undefined });
        if (!previewCtx) {
          throw new Error("GitHub is not connected. Please connect your GitHub account in Settings.");
        }

        // Use unified deployPreview action
        const previewResult = await deployPreviewAction(previewCtx, {
          specId: params.specId,
          repoFullName: repoFullName || undefined,
          forceRedeploy: params.forceRedeploy
        });

        if (!previewResult.ok) {
          throw new Error(previewResult.error || previewResult.message);
        }

        return {
          success: true,
          result: {
            specId: previewResult.data?.specId,
            workflowUrl: previewResult.data?.workflowUrl,
            previewUrl: previewResult.data?.previewUrl,
            status: previewResult.data?.status
          }
        };
      }

      case "deploy_production": {
        // Build unified action context
        const prodCtx = await buildActionContext({ db: supabase, userId, source: "chat", repoFullName: repoFullName || undefined });
        if (!prodCtx) {
          throw new Error("GitHub is not connected. Please connect your GitHub account in Settings.");
        }

        // Use unified deployProduction action
        const prodResult = await deployProductionAction(prodCtx, {
          specId: params.specId,
          releaseTag: params.releaseTag,
          repoFullName: repoFullName || undefined,
          forceRedeploy: params.forceRedeploy
        });

        if (!prodResult.ok) {
          // Provide helpful guidance for common errors
          if (prodResult.message.includes("Release PR")) {
            return {
              success: false,
              error: `${prodResult.message}\n\nWould you like me to create a Release PR? Say "create release PR".`
            };
          }
          throw new Error(prodResult.error || prodResult.message);
        }

        return {
          success: true,
          result: {
            specId: prodResult.data?.specId,
            releaseTag: prodResult.data?.releaseTag,
            releaseSha: prodResult.data?.releaseSha,
            workflowUrl: prodResult.data?.workflowUrl,
            productionUrl: prodResult.data?.productionUrl,
            status: prodResult.data?.status
          }
        };
      }

      case "approve_release": {
        // Build unified action context
        const approveCtx = await buildActionContext({ db: supabase, userId, source: "chat", repoFullName: repoFullName || undefined });
        if (!approveCtx) {
          throw new Error("GitHub is not connected. Please connect your GitHub account in Settings.");
        }

        // Resolve traceId to specId if needed
        let specId = params.specId;

        if (!specId && params.traceId) {
          const { data: trace } = await supabase
            .from("release_traces")
            .select("spec_id")
            .eq("id", params.traceId)
            .single();
          specId = trace?.spec_id;
        }

        if (!specId) {
          throw new Error("Could not find spec for this release. Please use 'Deploy to Production' from the Deployment Queue instead.");
        }

        // Use unified deployProduction action (same as deploy_production case)
        const approveResult = await deployProductionAction(approveCtx, {
          specId,
          releaseTag: params.releaseTag,
          repoFullName: repoFullName || undefined
        });

        if (!approveResult.ok) {
          throw new Error(approveResult.error || approveResult.message);
        }

        return {
          success: true,
          result: {
            specId: approveResult.data?.specId,
            releaseTag: approveResult.data?.releaseTag,
            releaseSha: approveResult.data?.releaseSha,
            workflowUrl: approveResult.data?.workflowUrl,
            productionUrl: approveResult.data?.productionUrl,
            status: approveResult.data?.status,
            nextStep: "Production deployment in progress"
          }
        };
      }

      case "rollback": {
        // Build unified action context
        const rollbackCtx = await buildActionContext({ db: supabase, userId, source: "chat", repoFullName: repoFullName || undefined });
        if (!rollbackCtx) {
          throw new Error("GitHub is not connected. Please connect your GitHub account in Settings.");
        }

        // Use unified rollback action
        const rollbackResult = await rollbackAction(rollbackCtx, {
          repoFullName: repoFullName || "",
          targetReleaseTag: params.targetReleaseTag
        });

        if (!rollbackResult.ok) {
          throw new Error(rollbackResult.error || rollbackResult.message);
        }

        return {
          success: true,
          result: {
            rollbackId: rollbackResult.data?.rollbackId,
            sourceTag: rollbackResult.data?.sourceTag,
            targetTag: rollbackResult.data?.targetTag,
            workflowUrl: rollbackResult.data?.workflowUrl
          }
        };
      }

      case "create_hotfix": {
        // Build unified action context
        const hotfixCtx = await buildActionContext({ db: supabase, userId, source: "chat", repoFullName: repoFullName || undefined });
        if (!hotfixCtx) {
          throw new Error("GitHub is not connected. Please connect your GitHub account in Settings.");
        }

        // Use unified createHotfix action
        const hotfixResult = await createHotfixAction(hotfixCtx, {
          incidentId: params.incidentId,
          baseBranch: params.baseBranch || "develop",
          analysis: params.analysis
        });

        if (!hotfixResult.ok) {
          throw new Error(hotfixResult.error || hotfixResult.message);
        }

        return {
          success: true,
          result: {
            incidentId: hotfixResult.data?.incidentId,
            specId: hotfixResult.data?.specId,
            pr: {
              number: hotfixResult.data?.prNumber,
              html_url: hotfixResult.data?.prUrl,
              branch: hotfixResult.data?.branch
            },
            branch: hotfixResult.data?.branch,
            baseBranch: hotfixResult.data?.baseBranch
          }
        };
      }

      case "approve_hotfix": {
        // Build unified action context
        const approveHotfixCtx = await buildActionContext({ db: supabase, userId, source: "chat", repoFullName: repoFullName || undefined });
        if (!approveHotfixCtx) {
          throw new Error("GitHub is not connected. Please connect your GitHub account in Settings.");
        }

        // Use unified approveHotfix action
        const approveResult = await approveHotfixAction(approveHotfixCtx, {
          incidentId: params.incidentId,
          releaseTag: params.releaseTag,
          note: params.note
        });

        if (!approveResult.ok) {
          throw new Error(approveResult.error || approveResult.message);
        }

        return {
          success: true,
          result: {
            incidentId: approveResult.data?.incidentId,
            merged: approveResult.data?.merged,
            mergeSha: approveResult.data?.mergeSha,
            releaseTag: approveResult.data?.releaseTag,
            workflowUrl: approveResult.data?.workflowUrl,
            reverseSync: approveResult.data?.reverseSync,
            isProdDeploy: approveResult.data?.isProdDeploy,
            environment: approveResult.data?.isProdDeploy ? "Production" : "Preview"
          }
        };
      }

      case "analyze_incident": {
        // Build unified action context
        const analyzeCtx = await buildActionContext({ db: supabase, userId, source: "chat", repoFullName: repoFullName || undefined });
        if (!analyzeCtx) {
          throw new Error("GitHub is not connected. Please connect your GitHub account in Settings.");
        }

        // Use unified analyzeIncident action
        const analyzeResult = await analyzeIncidentAction(analyzeCtx, {
          incidentId: params.incidentId,
          releaseContext: params.releaseContext
        });

        if (!analyzeResult.ok) {
          throw new Error(analyzeResult.error || analyzeResult.message);
        }

        return {
          success: true,
          result: {
            incidentId: analyzeResult.data?.incidentId,
            rootCause: analyzeResult.data?.rootCause,
            fixProposal: analyzeResult.data?.fixProposal,
            rollbackSteps: analyzeResult.data?.rollbackSteps,
            changeSummary: analyzeResult.data?.changeSummary,
            implicatedCommits: analyzeResult.data?.implicatedCommits,
            confidence: analyzeResult.data?.confidence
          }
        };
      }

      case "resolve_incident": {
        // Build unified action context
        const resolveCtx = await buildActionContext({ db: supabase, userId, source: "chat", repoFullName: repoFullName || undefined });
        if (!resolveCtx) {
          throw new Error("GitHub is not connected. Please connect your GitHub account in Settings.");
        }

        // Use unified resolveIncident action
        const resolveResult = await resolveIncidentAction(resolveCtx, {
          incidentId: params.incidentId,
          note: params.note || "Resolved via AI Chat"
        });

        if (!resolveResult.ok) {
          throw new Error(resolveResult.error || resolveResult.message);
        }

        return {
          success: true,
          result: {
            id: resolveResult.data?.incidentId,
            previousStatus: resolveResult.data?.previousStatus,
            resolved: resolveResult.data?.resolved,
            resolutionNote: params.note || "Resolved via AI Chat"
          }
        };
      }

      case "acknowledge_incident": {
        // Build unified action context
        const ackCtx = await buildActionContext({ db: supabase, userId, source: "chat", repoFullName: repoFullName || undefined });
        if (!ackCtx) {
          throw new Error("GitHub is not connected. Please connect your GitHub account in Settings.");
        }

        // Use unified acknowledgeIncident action
        const ackResult = await acknowledgeIncidentAction(ackCtx, {
          incidentId: params.incidentId,
          note: params.note
        });

        if (!ackResult.ok) {
          throw new Error(ackResult.error || ackResult.message);
        }

        return {
          success: true,
          result: {
            id: ackResult.data?.incidentId,
            title: params.incidentTitle,
            previousStatus: ackResult.data?.previousStatus,
            acknowledgedBy: ackResult.data?.acknowledgedBy
          }
        };
      }

      // View operations - fetch and return data
      case "view_status":
      case "view_prs":
      case "view_deployments":
      case "view_incidents":
      case "view_releases":
      case "view_ci": {
        // These are handled by the context already provided to the AI
        return { success: true, result: { message: "Data available in context" } };
      }

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Action failed"
    };
  }
}

// Format action result for display
export function formatActionResult(action: ActionType, result: any): string {
  switch (action) {
    case "spec_to_pr": {
      if (!result.pr) {
        // Plan only, no PR created yet
        return `**Spec Analysis Complete**\n\n` +
          `- Title: ${result.prTitle || "N/A"}\n` +
          `- Branch: \`${result.suggestedBranch || "feature/..."}\`\n` +
          `- Files: ${result.scaffold?.length || 0} files planned\n\n` +
          `Run again with \`createPr: true\` to create the PR.`;
      }
      const prUrl = result.pr.html_url || result.pr.url || "#";
      const prNumber = result.pr.number || "?";
      const branch = result.pr.head?.ref || result.suggestedBranch || "feature/...";
      const filesCount = result.scaffold?.length || 0;
      return `**Draft PR Created Successfully!**\n\n` +
        `- PR: [#${prNumber}](${prUrl})\n` +
        `- Branch: \`${branch}\`\n` +
        `- Files: ${filesCount} files generated\n\n` +
        `The PR is ready for review on GitHub.`;
    }

    case "create_release_pr":
      return `✅ **Release Draft PR Created Successfully!**\n\n` +
        `- PR: [#${result.prNumber}](${result.prUrl})\n` +
        `- Release Tag: \`${result.releaseTag}\`\n\n` +
        `The PR promotes develop to main and is ready for review on GitHub.`;

    case "deploy_preview":
      return `✅ **Preview Deployment Started!**\n\n` +
        `- Environment: Preview/Develop\n` +
        `- Workflow: [View on GitHub](${result.workflowUrl})`;

    case "deploy_production":
      return `✅ **Production Deployment Started!**\n\n` +
        `- Release Tag: \`${result.releaseTag}\`\n` +
        `- Workflow: [View on GitHub](${result.workflowUrl})`;

    case "approve_release":
      return `✅ **Release Approved!**\n\n` +
        `- Next Step: ${result.nextStep || "Deployment in progress"}`;

    case "rollback":
      return `✅ **Rollback Initiated!**\n\n` +
        `- Target Release: \`${result.targetTag}\`\n` +
        `- Workflow: [View on GitHub](${result.workflowUrl})`;

    case "create_hotfix":
      return `✅ **Hotfix PR Created!**\n\n` +
        `- PR: [#${result.pr?.number}](${result.pr?.url || result.pr?.html_url || "#"})\n` +
        `- Branch: \`${result.pr?.branch || result.incident?.hotfixBranch || result.branch || "unknown"}\``;

    case "approve_hotfix":
      return `✅ **Hotfix Approved & Deploying!**\n\n` +
        `- Merged: PR #${result.pr?.number || result.hotfixPrNumber}\n` +
        `${result.releaseTag ? `- Release Tag: \`${result.releaseTag}\`\n` : ""}` +
        `- Deployment: ${result.environment || (result.deployment ? "Production" : result.deployment?.workflowUrl ? "In progress" : "Preview")}`;

    case "analyze_incident": {
      const rollbackText = result.rollbackSteps?.length
        ? result.rollbackSteps.map((step: string) => `  - ${step}`).join("\n")
        : "  - No specific rollback steps recommended.";

      const commitsText = result.implicatedCommits?.length
        ? result.implicatedCommits.map((c: any) => `  - \`${String(c.sha).slice(0, 7)}\`: ${c.message}\n    *Reason*: ${c.reason}\n    *Risk*: ${c.risk}`).join("\n")
        : "  - No commits directly implicated.";

      const confidencePct = typeof result.confidence === "number" ? Math.round(result.confidence * 100) : null;
      const confidenceText = confidencePct !== null ? `${confidencePct}%` : "n/a";

      return `📊 **Incident Analysis Complete**

- **Root Cause**:
  ${result.rootCause || "Under investigation."}

- **Fix Proposal**:
  ${result.fixProposal || "No fix proposed yet."}

- **Rollback Steps**:
${rollbackText}

- **Implicated Commits**:
${commitsText}

- **Change Summary**:
  ${result.changeSummary || "Analysis completed."}

- **Confidence Score**: \`${confidenceText}\``;
    }

    case "resolve_incident":
      return `✅ **Incident Resolved Successfully!**\n\n` +
        `- Incident: \`${result.title || result.id}\`\n` +
        `- Status: \`resolved\`\n` +
        `- Note: ${result.resolutionNote || "Resolved via AI Chat"}`;

    case "acknowledge_incident":
      return `✅ **Incident Acknowledged Successfully!**\n\n` +
        `- Incident: \`${result.title || result.id}\`\n` +
        `- Status: \`investigating\`\n` +
        `- Assigned to: \`${result.acknowledgedBy || "operator"}\``;

    default:
      return `✅ Action completed successfully.`;
  }
}

export { ACTION_DEFINITIONS };
