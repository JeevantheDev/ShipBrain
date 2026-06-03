/**
 * ShipBrain LLM Tools
 *
 * All ShipBrain actions and queries are defined here as LLM tool specs
 * that can be bound directly to the model via model.bind({ tools }).
 *
 * Two categories:
 *  - Read tools  (isRead: true)  → executed immediately, no user confirmation needed
 *  - Write tools (isRead: false) → require explicit user confirmation before execution
 *
 * When a write tool is called but an identifying param (e.g. pr_number) is missing,
 * the backend resolves available options from context and sends back a structured
 * `actionOptions` list so the frontend can render selectable chips.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ShipBrainToolName =
  | "get_pending_deployments"
  | "get_ci_status"
  | "get_incidents"
  | "get_release_traces"
  | "get_recent_prs"
  | "deploy_preview"
  | "deploy_production"
  | "approve_release"
  | "rollback"
  | "create_hotfix"
  | "approve_hotfix"
  | "analyze_incident"
  | "resolve_incident"
  | "acknowledge_incident"
  | "spec_to_pr"
  | "create_release_pr"
  | "prepare_release_handbook";

export interface ShipBrainTool {
  name: ShipBrainToolName;
  description: string;
  parameters: Record<string, unknown>;
  isRead: boolean;
  label: string;
  riskLevel: "low" | "medium" | "high";
}

/** A single selectable option the frontend renders as a chip/card */
export interface ActionOption {
  /** Short human label shown on the chip */
  label: string;
  /** Sub-label / description shown below the label */
  sublabel?: string;
  /** The message text that gets auto-sent when the user clicks this chip */
  value: string;
  /** Badge text, e.g. "high risk", "preview", "merged" */
  badge?: string;
}

// ─── Read Tools ───────────────────────────────────────────────────────────────

const GET_PENDING_DEPLOYMENTS: ShipBrainTool = {
  name: "get_pending_deployments",
  label: "Get Pending Deployments",
  description:
    "Retrieves the list of specs/PRs pending a preview or production deployment. " +
    "Use when the user asks what is pending, what needs deploying, what is waiting, or wants an overview of current state.",
  parameters: { type: "object", properties: {}, required: [] },
  isRead: true,
  riskLevel: "low"
};

const GET_CI_STATUS: ShipBrainTool = {
  name: "get_ci_status",
  label: "Get CI Status",
  description:
    "Retrieves the latest GitHub Actions CI workflow run results for the active repository. " +
    "Use when the user asks about CI, workflow runs, build status, or test results.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of recent CI runs to return. Defaults to 5." }
    },
    required: []
  },
  isRead: true,
  riskLevel: "low"
};

const GET_INCIDENTS: ShipBrainTool = {
  name: "get_incidents",
  label: "Get Incidents",
  description:
    "Lists open, active, or investigating incidents. Use when the user asks about incidents, outages, production issues, or alerts.",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["open", "investigating", "resolved", "all"],
        description: "Filter incidents by status. Defaults to open and investigating."
      }
    },
    required: []
  },
  isRead: true,
  riskLevel: "low"
};

const GET_RELEASE_TRACES: ShipBrainTool = {
  name: "get_release_traces",
  label: "Get Release Traces",
  description:
    "Retrieves active release traces showing their current pipeline phase. " +
    "Use when the user asks about releases, release pipeline, or release status.",
  parameters: { type: "object", properties: {}, required: [] },
  isRead: true,
  riskLevel: "low"
};

const GET_RECENT_PRS: ShipBrainTool = {
  name: "get_recent_prs",
  label: "Get Recent PRs",
  description:
    "Lists the user's recent open and draft pull requests. Use when the user asks to see PRs, open pull requests, or their current work.",
  parameters: { type: "object", properties: {}, required: [] },
  isRead: true,
  riskLevel: "low"
};

// ─── Write Tools ──────────────────────────────────────────────────────────────

const DEPLOY_PREVIEW: ShipBrainTool = {
  name: "deploy_preview",
  label: "Deploy to Preview",
  description:
    "Deploys or redeploys to the develop/preview environment by triggering a GitHub Actions workflow. " +
    "Use when the user says: deploy to preview, deploy to develop, deploy to staging, start preview deploy, " +
    "redeploy preview, redeploy the preview env, refresh preview, re-trigger preview deployment. " +
    "Extract the PR number from the user message if mentioned (e.g. '#73', 'PR 73'). " +
    "Set redeploy=true if the user wants to redeploy an existing preview deployment.",
  parameters: {
    type: "object",
    properties: {
      pr_number: {
        type: "string",
        description: "The GitHub pull request number to deploy, e.g. '73'. Extract from user message if mentioned."
      },
      spec_id: {
        type: "string",
        description: "The UUID of the ShipBrain spec. Use if the user provides a UUID directly."
      },
      redeploy: {
        type: "boolean",
        description: "Set to true if the user wants to redeploy/refresh an existing preview deployment. " +
          "Use this when user says: redeploy, re-deploy, refresh preview, re-trigger preview."
      }
    },
    required: []
  },
  isRead: false,
  riskLevel: "medium"
};

const DEPLOY_PRODUCTION: ShipBrainTool = {
  name: "deploy_production",
  label: "Deploy to Production",
  description:
    "Creates a release tag and triggers a production deployment. " +
    "Use when the user says: deploy to production, deploy to prod, release to production, go live. " +
    "Extract the PR number if mentioned.",
  parameters: {
    type: "object",
    properties: {
      pr_number: { type: "string", description: "The PR number for the feature to deploy to production." },
      spec_id: { type: "string", description: "The UUID of the ShipBrain spec." },
      release_tag: {
        type: "string",
        description: "An explicit release tag, e.g. 'release-v2025.05.30'. Auto-generated if not provided."
      }
    },
    required: []
  },
  isRead: false,
  riskLevel: "high"
};

const APPROVE_RELEASE: ShipBrainTool = {
  name: "approve_release",
  label: "Approve Release",
  description:
    "Approves a pending release or deployment waiting for sign-off. " +
    "Use when the user says: approve the release, approve deployment, sign off on release, give approval.",
  parameters: {
    type: "object",
    properties: {
      trace_id: { type: "string", description: "UUID of the release trace to approve." },
      pr_number: { type: "string", description: "PR number associated with the release." }
    },
    required: []
  },
  isRead: false,
  riskLevel: "high"
};

const ROLLBACK: ShipBrainTool = {
  name: "rollback",
  label: "Rollback Release",
  description:
    "Rolls back the production environment to a previous release version. " +
    "Use when the user says: rollback, revert to previous release, undo production deploy.",
  parameters: {
    type: "object",
    properties: {
      target_release_tag: {
        type: "string",
        description: "The release tag to roll back to, e.g. 'release-v2025.05.28-1200'."
      }
    },
    required: []
  },
  isRead: false,
  riskLevel: "high"
};

const CREATE_HOTFIX: ShipBrainTool = {
  name: "create_hotfix",
  label: "Create Hotfix",
  description:
    "Creates a hotfix Draft Pull Request for an active incident and acknowledges it (sets status to investigating). " +
    "Use when the user wants to create a hotfix PR or says: create hotfix, start hotfix, make hotfix PR, create a hotfix PR.",
  parameters: {
    type: "object",
    properties: {
      incident_id: { type: "string", description: "UUID of the incident to create a hotfix for." },
      base_branch: {
        type: "string",
        enum: ["develop", "main"],
        description: "The base branch for the hotfix PR. Defaults to 'develop'."
      }
    },
    required: []
  },
  isRead: false,
  riskLevel: "medium"
};

const APPROVE_HOTFIX: ShipBrainTool = {
  name: "approve_hotfix",
  label: "Approve & Deploy Hotfix",
  description:
    "Merges a hotfix PR and triggers deployment. " +
    "Use when the user says: approve hotfix, merge hotfix, deploy hotfix, ship the fix.",
  parameters: {
    type: "object",
    properties: {
      incident_id: { type: "string", description: "UUID of the incident whose hotfix should be approved." }
    },
    required: []
  },
  isRead: false,
  riskLevel: "high"
};

const ANALYZE_INCIDENT: ShipBrainTool = {
  name: "analyze_incident",
  label: "Analyze Incident",
  description:
    "Runs AI analysis on an active incident to determine root cause and propose a fix. " +
    "Use when the user says: analyze incident, investigate incident, what caused this, run AI analysis.",
  parameters: {
    type: "object",
    properties: {
      incident_id: {
        type: "string",
        description: "UUID of the incident to analyze. If not provided, the most recent active incident is used."
      }
    },
    required: []
  },
  isRead: false,
  riskLevel: "low"
};

const RESOLVE_INCIDENT: ShipBrainTool = {
  name: "resolve_incident",
  label: "Resolve Incident",
  description:
    "Marks an active incident as resolved. " +
    "Use when the user says: resolve incident, close incident, mark as resolved, incident is fixed. " +
    "Do NOT use for acknowledging/investigating an incident or creating a hotfix.",
  parameters: {
    type: "object",
    properties: {
      incident_id: {
        type: "string",
        description: "UUID of the incident to resolve. If not provided, the most recent active incident is used."
      },
      note: {
        type: "string",
        description: "Audit message or explanation of why the incident is resolved. Example: 'Confirmed fix verified on sandbox.'"
      }
    },
    required: []
  },
  isRead: false,
  riskLevel: "medium"
};

const ACKNOWLEDGE_INCIDENT: ShipBrainTool = {
  name: "acknowledge_incident",
  label: "Acknowledge Incident",
  description:
    "Acknowledges an active incident to start investigating. " +
    "Use when the user says: acknowledge incident, ack incident, acknowledge it, start investigating. " +
    "Do NOT use if the user also wants to create a hotfix PR (use create_hotfix instead).",
  parameters: {
    type: "object",
    properties: {
      incident_id: {
        type: "string",
        description: "UUID of the incident to acknowledge. If not provided, the most recent active incident is used."
      }
    },
    required: []
  },
  isRead: false,
  riskLevel: "medium"
};

const CREATE_SPEC_TO_PR: ShipBrainTool = {
  name: "spec_to_pr",
  label: "Create Spec-to-PR",
  description:
    "Creates a Draft GitHub Pull Request from a feature specification, ticket, or requirement description. " +
    "Use when the user says: create PR from spec, spec-to-pr, draft PR, create pull request for this feature, " +
    "or pastes a feature description. Capture the full description as raw_spec.",
  parameters: {
    type: "object",
    properties: {
      raw_spec: {
        type: "string",
        description: "The full feature/ticket/requirement description text to use for PR generation."
      },
      recipe_id: {
        type: "string",
        description: "ID of a Spec-to-PR recipe/template to use instead of raw text."
      }
    },
    required: []
  },
  isRead: false,
  riskLevel: "medium"
};

const CREATE_RELEASE_PR: ShipBrainTool = {
  name: "create_release_pr",
  label: "Create Release Draft PR",
  description:
    "Creates a release promotion Draft Pull Request from develop to main branch. " +
    "Use when the user wants to promote develop to main, or create a release draft PR.",
  parameters: {
    type: "object",
    properties: {
      release_tag: {
        type: "string",
        description: "An explicit release tag, e.g. 'release-v2025.05.30'. Auto-generated if not provided."
      }
    },
    required: []
  },
  isRead: false,
  riskLevel: "medium"
};

const PREPARE_RELEASE_HANDBOOK: ShipBrainTool = {
  name: "prepare_release_handbook",
  label: "Prepare Release Handbook",
  description:
    "Prepares a detailed release handbook or release notes based on the recent release to production. " +
    "Helpful for Product Managers.",
  parameters: {
    type: "object",
    properties: {
      trace_id: {
        type: "string",
        description: "The UUID of the release trace to generate the handbook for. Optional."
      }
    },
    required: []
  },
  isRead: true,
  riskLevel: "low"
};

// ─── Registry ─────────────────────────────────────────────────────────────────

export const ALL_TOOLS: ShipBrainTool[] = [
  GET_PENDING_DEPLOYMENTS,
  GET_CI_STATUS,
  GET_INCIDENTS,
  GET_RELEASE_TRACES,
  GET_RECENT_PRS,
  DEPLOY_PREVIEW,
  DEPLOY_PRODUCTION,
  APPROVE_RELEASE,
  ROLLBACK,
  CREATE_HOTFIX,
  APPROVE_HOTFIX,
  ANALYZE_INCIDENT,
  RESOLVE_INCIDENT,
  ACKNOWLEDGE_INCIDENT,
  CREATE_SPEC_TO_PR,
  CREATE_RELEASE_PR,
  PREPARE_RELEASE_HANDBOOK
];

export const READ_TOOL_NAMES = new Set<ShipBrainToolName>(
  ALL_TOOLS.filter((t) => t.isRead).map((t) => t.name)
);

export const TOOL_BY_NAME = Object.fromEntries(
  ALL_TOOLS.map((t) => [t.name, t])
) as Record<ShipBrainToolName, ShipBrainTool>;

/**
 * Returns tool specs in the format expected by LangChain's model.bind({ tools: [...] })
 * Compatible with Azure AI Foundry (OpenAI-compatible) and OpenAI directly.
 */
export function getLangChainToolSpecs() {
  return ALL_TOOLS.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

// ─── Option Generators ────────────────────────────────────────────────────────
// These resolve selectable options from live context data for each write tool
// so the frontend can show chips instead of asking a free-text question.

export function resolveActionOptions(
  toolName: ShipBrainToolName,
  args: Record<string, any>,
  context: any
): ActionOption[] | null {
  switch (toolName) {
    case "deploy_preview": {
      const items = (context.pendingDeployments ?? context.recentPrs ?? []) as any[];
      const eligible = items.filter(
        (s) => s.status === "merged" && s.base_branch === "develop" && !s.preview_url && s.preview_status !== "deploying"
      );
      if (eligible.length === 0) return null;
      return eligible.slice(0, 5).map((s) => ({
        label: s.decomposed_tasks?.prTitle ?? `PR #${s.pr_number}`,
        sublabel: `#${s.pr_number} · ${s.branch_name ?? s.base_branch}`,
        value: `Deploy PR #${s.pr_number} to preview`,
        badge: "merged"
      }));
    }

    case "deploy_production": {
      const items = (context.pendingDeployments ?? context.recentPrs ?? []) as any[];
      const eligible = items.filter(
        (s) =>
          s.release_status === "pending_deploy" ||
          s.release_status === "ready_for_prod" ||
          (s.status === "merged" && s.base_branch === "main")
      );
      if (eligible.length === 0) return null;
      return eligible.slice(0, 5).map((s) => ({
        label: s.decomposed_tasks?.prTitle ?? `PR #${s.pr_number}`,
        sublabel: `#${s.pr_number} · ${s.release_status ?? s.status}`,
        value: `Deploy PR #${s.pr_number} to production`,
        badge: "ready"
      }));
    }

    case "approve_release": {
      const traces = (context.releaseTraces ?? []) as any[];
      const eligible = traces.filter(
        (t) => t.status === "ready_for_review" || t.status === "release_pending"
      );
      if (eligible.length === 0) return null;
      return eligible.slice(0, 5).map((t) => ({
        label: t.title ?? `Trace ${t.id.slice(0, 8)}`,
        sublabel: `${t.status} · PR #${t.release_pr_number ?? t.draft_pr_number ?? "?"}`,
        value: `Approve release for trace ${t.id}`,
        badge: "pending"
      }));
    }

    case "rollback": {
      const traces = (context.releaseTraces ?? []) as any[];
      const deployed = traces.filter((t) => (t.status === "production_live" || t.status === "completed") && t.type === "release");
      if (deployed.length === 0) return null;
      return deployed.slice(0, 5).map((t) => ({
        label: t.title ?? t.id.slice(0, 8),
        sublabel: t.status,
        value: `Rollback to ${t.id}`,
        badge: "live"
      }));
    }

    case "create_hotfix": {
      // If no base branch specified, show branch selection options
      const baseBranch = args.base_branch ?? args.baseBranch;
      if (!baseBranch) {
        return [
          {
            label: "Target develop branch",
            sublabel: "Standard hotfix flow with preview validation",
            value: "Create hotfix targeting develop branch",
            badge: "develop"
          },
          {
            label: "Target main branch",
            sublabel: "Direct to production (emergency only)",
            value: "Create hotfix targeting main branch",
            badge: "main"
          }
        ];
      }
      // Fall through to incident selection
      const incidents = (context.incidents ?? []) as any[];
      const active = incidents.filter((i) => i.status !== "resolved" && i.status !== "closed");
      if (active.length === 0) return null;
      return active.slice(0, 5).map((i) => ({
        label: i.title ?? `Incident ${i.id.slice(0, 8)}`,
        sublabel: `${i.severity ?? "unknown"} · ${i.service ?? "app"} · ${i.status}`,
        value: `Create hotfix for incident ${i.id} on ${baseBranch}`,
        badge: baseBranch
      }));
    }

    case "approve_hotfix":
    case "analyze_incident":
    case "resolve_incident":
    case "acknowledge_incident": {
      const incidents = (context.incidents ?? []) as any[];
      const active = incidents.filter((i) => i.status !== "resolved" && i.status !== "closed");
      if (active.length === 0) return null;
      return active.slice(0, 5).map((i) => ({
        label: i.title ?? `Incident ${i.id.slice(0, 8)}`,
        sublabel: `${i.severity ?? "unknown"} · ${i.service ?? "app"} · ${i.status}`,
        value:
          toolName === "approve_hotfix"
            ? `Approve hotfix for incident ${i.id}`
            : toolName === "analyze_incident"
            ? `Analyze incident ${i.id}`
            : toolName === "acknowledge_incident"
            ? `Acknowledge incident ${i.id}`
            : `Resolve incident ${i.id}`,
        badge: i.severity ?? "incident"
      }));
    }

    case "spec_to_pr": {
      const recipes = (context.specPrRecipes ?? []) as any[];
      if (recipes.length === 0) return null;
      return recipes.slice(0, 6).map((r) => ({
        label: r.label,
        sublabel: `${r.baseBranch ?? "develop"}${r.isSample ? " · sample" : ""}`,
        value: `Create spec-to-pr using recipe ${r.id}`,
        badge: r.isSample ? "sample" : undefined
      }));
    }

    default:
      return null;
  }
}
