/**
 * Unified Actions Layer
 *
 * This module provides a single source of truth for all ShipBrain actions.
 * All interfaces (UI, AI Chat, Telegram) should use these actions to ensure
 * consistent behavior and proper chain updates.
 *
 * Usage:
 * ```typescript
 * import { deployPreview, buildActionContext } from "@/lib/actions";
 *
 * const ctx = await buildActionContext({ db, userId, source: "ui", repoFullName });
 * if (!ctx) throw new Error("GitHub not connected");
 *
 * const result = await deployPreview(ctx, { specId: "..." });
 * if (!result.ok) throw new Error(result.error);
 * ```
 */

// Types
export * from "./types";

// Context builders
export { buildActionContext, buildSystemContext, buildWebhookContext } from "./context";

// Actions
export { deployPreview } from "./deploy-preview";
export { deployProduction } from "./deploy-production";
export { createReleasePR } from "./create-release-pr";
export { rollback, getAvailableReleases } from "./rollback";
export { syncSpecFromGitHub, syncMultipleSpecs } from "./sync-spec";

// Hotfix Actions
export { createHotfix } from "./create-hotfix";
export { approveHotfix } from "./approve-hotfix";
export { syncHotfix } from "./sync-hotfix";
export { mergeReverseSync } from "./merge-reverse-sync";

// Incident Actions
export { analyzeIncident } from "./analyze-incident";
export { resolveIncident } from "./resolve-incident";
export { acknowledgeIncident } from "./acknowledge-incident";

// Utilities (for internal use)
export * from "./utils";
