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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rawSpec,
            createPr: true,
            repoFullName: repoFullName || undefined,
            baseBranchOverride: baseBranch || undefined,
            useExistingSourceBranch: Boolean(sourceBranch),
            branchOverride: sourceBranch || undefined,
            handoffOnly: params.handoffOnly ?? false
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.detail || "Failed to create PR");

        // Save to specs table for Recent AI PRs (server-to-server call doesn't pass auth cookies)
        if (data.pr && userId && repoFullName) {
          const { error: specError } = await supabase
            .from("specs")
            .insert({
              user_id: userId,
              raw_spec: rawSpec,
              decomposed_tasks: data,
              scaffold_code: data.scaffold ?? {},
              status: "draft_created",
              repo_full_name: repoFullName,
              branch_name: data.pr.head?.ref ?? data.suggestedBranch,
              base_branch: baseBranch || "develop",
              pr_number: data.pr.number,
              pr_url: data.pr.html_url,
              updated_at: new Date().toISOString()
            });

          if (specError) {
            console.error("spec save failed in executeAction:", specError.message);
          }

          // Create notification
          const { error: notifError } = await supabase
            .from("notifications")
            .insert({
              user_id: userId,
              type: "pr_created",
              title: "Draft PR Created",
              body: `Created draft PR #${data.pr.number}: ${data.prTitle}`,
              href: data.pr.html_url,
              severity: "info",
              repo_full_name: repoFullName,
              metadata: { prNumber: data.pr.number, branch: data.pr.head?.ref }
            });
          if (notifError) console.error("notification creation failed:", notifError);
        }

        return { success: true, result: data };
      }

      case "deploy_preview": {
        // Validate spec exists and belongs to user
        const { data: spec, error: specError } = await supabase
          .from("specs")
          .select("id, status, repo_full_name, branch_name, base_branch, pr_number, merge_sha, preview_status, preview_url")
          .eq("id", params.specId)
          .eq("user_id", userId)
          .single();

        if (specError || !spec) {
          throw new Error("Spec not found or access denied");
        }

        if (spec.status !== "merged") {
          throw new Error(`Spec must be merged before preview deployment. Current status: ${spec.status}`);
        }

        if (spec.base_branch !== "develop") {
          throw new Error("Preview deployment is only available for PRs merged to develop");
        }

        if (spec.preview_url) {
          throw new Error(`Preview is already deployed: ${spec.preview_url}`);
        }

        if (spec.preview_status === "deploying") {
          throw new Error("Preview deployment is already in progress");
        }

        // Call the preview deployment API with internal flag
        const response = await fetch(`${baseUrl}/api/deployments/start-preview`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-User-Id": userId // Pass user ID for internal auth
          },
          body: JSON.stringify({ specId: params.specId, internalUserId: userId })
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || data.detail || "Failed to start preview deployment");
        }

        // Create notification
        const { error: notifError2 } = await supabase
          .from("notifications")
          .insert({
            user_id: userId,
            type: "preview_deploy_started",
            title: "Preview Deployment Started",
            body: `Deploying PR #${spec.pr_number} to preview environment`,
            href: data.workflowUrl || data.ciRunUrl,
            severity: "info",
            repo_full_name: spec.repo_full_name,
            metadata: { specId: spec.id, prNumber: spec.pr_number }
          });
        if (notifError2) console.error("notification creation failed:", notifError2);

        return { success: true, result: data };
      }

      case "deploy_production": {
        let releaseTag = params.releaseTag;
        if (!releaseTag) {
          const now = new Date();
          const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
          const time = now.toISOString().slice(11, 16).replace(":", "");
          releaseTag = `release-v${date}-${time}`;
        }
        const response = await fetch(`${baseUrl}/api/deployments/start-production`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-User-Id": userId
          },
          body: JSON.stringify({
            specId: params.specId,
            releaseTag,
            internalUserId: userId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.detail || "Failed to start production deployment");

        // Create notification
        const { error: notifError3 } = await supabase
          .from("notifications")
          .insert({
            user_id: userId,
            type: "production_deploy_started",
            title: "Production Deployment Started",
            body: `Deploying ${data.releaseTag} to production`,
            href: data.workflowUrl,
            severity: "warning",
            repo_full_name: repoFullName,
            metadata: { specId: params.specId, releaseTag: data.releaseTag }
          });
        if (notifError3) console.error("notification creation failed:", notifError3);

        return { success: true, result: data };
      }

      case "approve_release": {
        // Resolve traceId to specId, then use the same deploy_production flow
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

        // Use the same production deployment API
        let releaseTag = params.releaseTag;
        if (!releaseTag) {
          const now = new Date();
          const date = now.toISOString().slice(0, 10).replace(/-/g, ".");
          const time = now.toISOString().slice(11, 16).replace(":", "");
          releaseTag = `release-v${date}-${time}`;
        }

        const response = await fetch(`${baseUrl}/api/deployments/start-production`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-User-Id": userId
          },
          body: JSON.stringify({
            specId,
            releaseTag,
            internalUserId: userId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.detail || "Failed to start production deployment");
        return { success: true, result: { ...data, nextStep: "Production deployment in progress" } };
      }

      case "rollback": {
        const response = await fetch(`${baseUrl}/api/deployments/rollback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-User-Id": userId
          },
          body: JSON.stringify({
            targetReleaseTag: params.targetReleaseTag,
            repoFullName,
            internalUserId: userId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.detail || "Failed to initiate rollback");

        // Create notification
        const { error: notifError4 } = await supabase
          .from("notifications")
          .insert({
            user_id: userId,
            type: "rollback_initiated",
            title: "Rollback Initiated",
            body: `Rolling back to ${params.targetReleaseTag}`,
            href: data.workflowUrl,
            severity: "warning",
            repo_full_name: repoFullName,
            metadata: { targetReleaseTag: params.targetReleaseTag, rollbackId: data.rollbackId }
          });
        if (notifError4) console.error("notification creation failed:", notifError4);

        return { success: true, result: data };
      }

      case "create_hotfix": {
        const response = await fetch(`${baseUrl}/api/incidents/hotfix`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-User-Id": userId
          },
          body: JSON.stringify({
            action: "create",
            incidentId: params.incidentId,
            baseBranch: params.baseBranch || "develop",
            internalUserId: userId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.detail || "Failed to create hotfix");
        return { success: true, result: data };
      }

      case "approve_hotfix": {
        const response = await fetch(`${baseUrl}/api/incidents/hotfix`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-User-Id": userId
          },
          body: JSON.stringify({
            action: "approve",
            incidentId: params.incidentId,
            releaseTag: params.releaseTag, // Pass custom release tag if provided
            internalUserId: userId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.detail || "Failed to approve hotfix");
        return { success: true, result: data };
      }

      case "analyze_incident": {
        const response = await fetch(`${baseUrl}/api/ai/incident`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-User-Id": userId
          },
          body: JSON.stringify({
            action: "analyze",
            incidentId: params.incidentId,
            internalUserId: userId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to analyze incident");
        return { success: true, result: data };
      }

      case "resolve_incident": {
        const response = await fetch(`${baseUrl}/api/incidents`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-User-Id": userId
          },
          body: JSON.stringify({
            id: params.incidentId,
            action: "resolve",
            note: "Resolved via AI Chat",
            internalUserId: userId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.detail || "Failed to resolve incident");
        return { success: true, result: data };
      }

      case "acknowledge_incident": {
        const response = await fetch(`${baseUrl}/api/incidents`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-User-Id": userId
          },
          body: JSON.stringify({
            id: params.incidentId,
            action: "acknowledge",
            internalUserId: userId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.detail || "Failed to acknowledge incident");
        return { success: true, result: data };
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
