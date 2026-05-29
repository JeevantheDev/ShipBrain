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
  | "view_status"
  | "view_prs"
  | "view_deployments"
  | "view_incidents"
  | "view_releases"
  | "view_ci";

export type ActionStatus = "pending_confirmation" | "executing" | "completed" | "failed" | "needs_input";

export type ChatAction = {
  type: ActionType;
  status: ActionStatus;
  params: Record<string, any>;
  missingParams?: string[];
  confirmationMessage?: string;
  result?: any;
  error?: string;
};

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

// Intent detection patterns
const INTENT_PATTERNS: { pattern: RegExp; action: ActionType; paramExtractors?: Record<string, RegExp> }[] = [
  // Spec to PR
  { pattern: /(?:create|generate|make|build)\s+(?:a\s+)?(?:pr|pull\s*request)\s+(?:from|for)\s+(?:spec|feature|ticket)/i, action: "spec_to_pr" },
  { pattern: /spec[- ]?to[- ]?pr/i, action: "spec_to_pr" },
  { pattern: /draft\s+pr\s+(?:for|from)/i, action: "spec_to_pr" },

  // Deploy preview
  { pattern: /deploy\s+(?:to\s+)?(?:preview|dev|develop|staging)/i, action: "deploy_preview" },
  { pattern: /start\s+preview\s+deploy/i, action: "deploy_preview" },

  // Deploy production
  { pattern: /deploy\s+(?:to\s+)?(?:prod|production|live)/i, action: "deploy_production" },
  { pattern: /release\s+to\s+(?:prod|production)/i, action: "deploy_production" },
  { pattern: /push\s+to\s+(?:prod|production)/i, action: "deploy_production" },

  // Approve
  { pattern: /approve\s+(?:the\s+)?(?:release|deployment|pr)/i, action: "approve_release" },
  { pattern: /(?:confirm|accept)\s+(?:the\s+)?(?:release|deployment)/i, action: "approve_release" },

  // Rollback
  { pattern: /rollback\s+(?:to|production)?/i, action: "rollback" },
  { pattern: /revert\s+(?:to\s+)?(?:previous|last)\s+(?:release|version)/i, action: "rollback" },

  // Hotfix
  { pattern: /(?:create|start|make)\s+(?:a\s+)?hotfix/i, action: "create_hotfix" },
  { pattern: /hotfix\s+(?:for|incident)/i, action: "create_hotfix" },
  { pattern: /(?:approve|merge|deploy)\s+(?:the\s+)?hotfix/i, action: "approve_hotfix" },

  // Incident
  { pattern: /analyze\s+(?:the\s+)?incident/i, action: "analyze_incident" },
  { pattern: /(?:resolve|close|fix)\s+(?:the\s+)?incident/i, action: "resolve_incident" },

  // View operations
  { pattern: /(?:show|view|list|get|what(?:'s| is))\s+(?:the\s+)?(?:status|overview)/i, action: "view_status" },
  { pattern: /(?:show|view|list|get)\s+(?:my\s+)?(?:open\s+)?prs?/i, action: "view_prs" },
  { pattern: /(?:show|view|list|get)\s+(?:pending\s+)?deployments?/i, action: "view_deployments" },
  { pattern: /(?:show|view|list|get)\s+(?:active\s+)?incidents?/i, action: "view_incidents" },
  { pattern: /(?:show|view|list|get)\s+(?:recent\s+)?releases?/i, action: "view_releases" },
  { pattern: /(?:show|view|list|get)\s+ci\s+(?:status|runs?)?/i, action: "view_ci" },
  { pattern: /what(?:'s| is)\s+(?:pending|waiting)/i, action: "view_deployments" }
];

// Extract IDs and content from user message
function extractParams(message: string): Record<string, string> {
  const params: Record<string, string> = {};

  // UUID pattern
  const uuidMatch = message.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  if (uuidMatch) {
    params.specId = uuidMatch[1];
    params.traceId = uuidMatch[1];
    params.incidentId = uuidMatch[1];
  }

  // Short ID pattern (first 8 chars)
  const shortIdMatch = message.match(/\b([0-9a-f]{8})\b/i);
  if (shortIdMatch && !uuidMatch) {
    params.specId = shortIdMatch[1];
    params.traceId = shortIdMatch[1];
    params.incidentId = shortIdMatch[1];
  }

  // Release tag pattern
  const releaseMatch = message.match(/release[- ]?v?(\d{4}[.\-]\d{2}[.\-]\d{2}[.\-]?\d*)/i);
  if (releaseMatch) {
    params.releaseTag = `release-v${releaseMatch[1].replace(/\./g, "-")}`;
    params.targetReleaseTag = params.releaseTag;
  }

  // PR number
  const prMatch = message.match(/#(\d+)|pr[- ]?(\d+)/i);
  if (prMatch) {
    params.prNumber = prMatch[1] || prMatch[2];
  }

  // Extract spec/feature content for spec_to_pr
  // Look for content after "for:" or "from:" or in quotes or after common prefixes
  const specContentPatterns = [
    /(?:for|from|with|spec|feature|ticket|description):\s*["""]?([\s\S]+?)["""]?\s*$/i,
    /(?:create|generate|make)\s+(?:a\s+)?(?:pr|pull\s*request)\s+(?:for|from)\s+["""]?([\s\S]+?)["""]?\s*$/i,
    /["""](.+?)["""]$/
  ];

  for (const pattern of specContentPatterns) {
    const match = message.match(pattern);
    if (match && match[1]?.trim()) {
      params.rawSpec = match[1].trim();
      break;
    }
  }

  return params;
}

// Detect intent from user message
export function detectIntent(message: string, context: any): ActionIntent {
  for (const { pattern, action } of INTENT_PATTERNS) {
    if (pattern.test(message)) {
      const definition = ACTION_DEFINITIONS[action];
      const extractedParams = extractParams(message);
      const params: Record<string, any> = { ...extractedParams };

      // For spec_to_pr, also store the full message as potential rawSpec if not already extracted
      if (action === "spec_to_pr" && !params.rawSpec && !params.specId) {
        // Use the full message as the spec if it's substantial enough
        const messageWithoutCommand = message
          .replace(/(?:create|generate|make|build)\s+(?:a\s+)?(?:pr|pull\s*request)\s+(?:from|for)\s+(?:spec|feature|ticket)?/i, "")
          .replace(/spec[- ]?to[- ]?pr/i, "")
          .replace(/draft\s+pr\s+(?:for|from)/i, "")
          .trim();

        if (messageWithoutCommand.length > 20) {
          params.rawSpec = messageWithoutCommand;
        }
      }

      // For deploy_preview, auto-find specId from context if not provided
      if (action === "deploy_preview" && !params.specId) {
        const pendingDeployments = context.pendingDeployments ?? context.recentPrs ?? [];
        // Find spec that's merged to develop and ready for preview (status: merged, base_branch: develop, no preview_url yet)
        const readyForPreview = pendingDeployments.find((spec: any) =>
          spec.status === "merged" &&
          spec.base_branch === "develop" &&
          !spec.preview_url &&
          spec.preview_status !== "deploying"
        );
        if (readyForPreview) {
          params.specId = readyForPreview.id;
          params.prNumber = readyForPreview.pr_number;
          params.title = readyForPreview.decomposed_tasks?.prTitle || `PR #${readyForPreview.pr_number}`;
        }
      }

      // For deploy_production, auto-find specId from context if not provided
      if (action === "deploy_production" && !params.specId) {
        const pendingDeployments = context.pendingDeployments ?? context.recentPrs ?? [];
        // Find spec that's ready for production (preview deployed or release_status ready)
        const readyForProd = pendingDeployments.find((spec: any) =>
          spec.release_status === "pending_deploy" ||
          spec.release_status === "ready_for_prod" ||
          (spec.status === "merged" && spec.base_branch === "main")
        );
        if (readyForProd) {
          params.specId = readyForProd.id;
          params.prNumber = readyForProd.pr_number;
          params.title = readyForProd.decomposed_tasks?.prTitle || `PR #${readyForProd.pr_number}`;
        }
      }

      // Determine which params are actually required for this action
      let requiredParams = definition.requiredParams;

      // For spec_to_pr, rawSpec OR specId is required, not specifically specId
      if (action === "spec_to_pr") {
        if (params.rawSpec || params.specId) {
          requiredParams = []; // We have what we need
        } else {
          requiredParams = ["rawSpec"]; // We need the spec content
        }
      }

      // Check for missing required params
      const missingParams = requiredParams.filter(p => !params[p]);

      // Generate clarifying question if params missing
      let clarifyingQuestion: string | undefined;
      if (missingParams.length > 0) {
        clarifyingQuestion = generateClarifyingQuestion(action, missingParams, context);
      }

      return {
        detected: true,
        action,
        params,
        missingParams,
        clarifyingQuestion
      };
    }
  }

  return { detected: false, params: {}, missingParams: [] };
}

// Generate clarifying question based on missing params
function generateClarifyingQuestion(action: ActionType, missingParams: string[], context: any): string {
  const questions: Record<string, Record<string, string>> = {
    spec_to_pr: {
      specId: "What feature would you like to create a PR for? Please describe the feature or paste the ticket content.",
      rawSpec: "What feature would you like to create a PR for? Please describe the feature or paste the ticket content."
    },
    deploy_preview: {
      specId: "Which feature would you like to deploy to preview? Please provide the spec ID or PR number."
    },
    deploy_production: {
      specId: "Which release would you like to deploy to production? Please provide the spec ID or release trace."
    },
    approve_release: {
      traceId: "Which release would you like to approve? Please provide the trace ID or release tag."
    },
    rollback: {
      targetReleaseTag: "Which release would you like to rollback to? I can show you the available releases if you'd like."
    },
    create_hotfix: {
      incidentId: "Which incident needs a hotfix? Please provide the incident ID."
    },
    approve_hotfix: {
      incidentId: "Which hotfix would you like to approve and deploy? Please provide the incident ID."
    },
    analyze_incident: {
      incidentId: "Which incident would you like me to analyze? Please provide the incident ID."
    },
    resolve_incident: {
      incidentId: "Which incident would you like to resolve? Please provide the incident ID."
    }
  };

  const actionQuestions = questions[action];
  if (!actionQuestions) return "I need more information to proceed. Could you provide more details?";

  const firstMissing = missingParams[0];
  return actionQuestions[firstMissing] || "Could you provide more details about what you'd like to do?";
}

// Generate confirmation message for action
export function generateConfirmation(action: ActionType, params: Record<string, any>, context: any): string {
  const definition = ACTION_DEFINITIONS[action];
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

    case "deploy_production":
      return `I'll create a release tag and deploy to production for spec \`${params.specId}\`.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;

    case "approve_release":
      return `I'll approve the release for trace \`${params.traceId}\`.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;

    case "rollback":
      return `I'll rollback production to release \`${params.targetReleaseTag}\`.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;

    case "create_hotfix":
      return `I'll create a hotfix PR for incident \`${params.incidentId}\` on the ${params.baseBranch || "develop"} branch.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;

    case "approve_hotfix":
      return `I'll merge the hotfix for incident \`${params.incidentId}\` and deploy it.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;

    case "resolve_incident":
      return `I'll mark incident \`${params.incidentId}\` as resolved.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;

    default:
      return `I'll execute ${definition.label}.${riskWarning}\n\nWould you like me to proceed? Type **confirm** or **cancel**.`;
  }
}

// Execute action
export async function executeAction(
  action: ActionType,
  params: Record<string, any>,
  supabase: SupabaseClient,
  userId: string,
  repoFullName: string | null
): Promise<{ success: boolean; result?: any; error?: string }> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3003";

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
          await supabase
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
            })
            .catch((err) => console.error("notification creation failed:", err));
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
        await supabase
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
          })
          .catch((err) => console.error("notification creation failed:", err));

        return { success: true, result: data };
      }

      case "deploy_production": {
        const response = await fetch(`${baseUrl}/api/deployments/start-production`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-User-Id": userId
          },
          body: JSON.stringify({
            specId: params.specId,
            releaseTag: params.releaseTag,
            internalUserId: userId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.detail || "Failed to start production deployment");

        // Create notification
        await supabase
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
          })
          .catch((err) => console.error("notification creation failed:", err));

        return { success: true, result: data };
      }

      case "approve_release": {
        const response = await fetch(`${baseUrl}/api/deployments/approval`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ traceId: params.traceId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to approve release");
        return { success: true, result: data };
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
        await supabase
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
          })
          .catch((err) => console.error("notification creation failed:", err));

        return { success: true, result: data };
      }

      case "create_hotfix": {
        const response = await fetch(`${baseUrl}/api/incidents/hotfix`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create",
            incidentId: params.incidentId,
            baseBranch: params.baseBranch || "develop"
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to create hotfix");
        return { success: true, result: data };
      }

      case "approve_hotfix": {
        const response = await fetch(`${baseUrl}/api/incidents/hotfix`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "approve",
            incidentId: params.incidentId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to approve hotfix");
        return { success: true, result: data };
      }

      case "analyze_incident": {
        const response = await fetch(`${baseUrl}/api/ai/incident`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "analyze",
            incidentId: params.incidentId
          })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to analyze incident");
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
        `- PR: [#${result.pr?.number}](${result.pr?.url})\n` +
        `- Branch: \`${result.branch}\``;

    case "approve_hotfix":
      return `✅ **Hotfix Approved & Deploying!**\n\n` +
        `- Merged: PR #${result.pr?.number}\n` +
        `- Deployment: ${result.environment || "In progress"}`;

    case "analyze_incident":
      return `📊 **Incident Analysis**\n\n${result.analysis || "Analysis complete."}`;

    default:
      return `✅ Action completed successfully.`;
  }
}

export { ACTION_DEFINITIONS };
