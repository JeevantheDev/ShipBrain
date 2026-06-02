/**
 * Unified Action: Analyze Incident
 *
 * Runs AI analysis on an incident to determine root cause and fix proposal.
 * Wraps the LangChain incident analyzer chain.
 * Used by: UI, AI Chat, Telegram
 */

import { analyzeIncident as analyzeIncidentChain } from "@/lib/ai/chains/incident-analyzer";
import {
  ActionContext,
  ActionResult,
  AnalyzeIncidentInput,
  AnalyzeIncidentResult,
  ChainUpdate
} from "./types";
import {
  logAction,
  logError,
  createNotification,
  success,
  failure
} from "./utils";

/**
 * Analyze an incident using AI
 *
 * @param ctx - Action context with db, user, token
 * @param input - Analyze incident input
 * @returns Action result with analysis details
 */
export async function analyzeIncident(
  ctx: ActionContext,
  input: AnalyzeIncidentInput
): Promise<ActionResult<AnalyzeIncidentResult>> {
  const chainUpdates: ChainUpdate[] = [];

  logAction("analyzeIncident", ctx, { input });

  try {
    // Get incident
    const { data: incident, error: incidentError } = await ctx.db
      .from("incidents")
      .select("*")
      .eq("id", input.incidentId)
      .eq("user_id", ctx.userId)
      .single();

    if (incidentError || !incident) {
      return failure("Unable to load incident or incident not found.");
    }

    // Build release context if not provided
    let releaseContext = input.releaseContext;

    if (!releaseContext && incident.release_version && incident.repo_full_name) {
      // Try to fetch release context from specs
      const { data: releaseSpec } = await ctx.db
        .from("specs")
        .select("decomposed_tasks, pr_number, branch_name, merge_sha")
        .eq("repo_full_name", incident.repo_full_name)
        .eq("release_tag", incident.release_version)
        .maybeSingle();

      if (releaseSpec) {
        releaseContext = {
          release: {
            tag: incident.release_version,
            sha: releaseSpec.merge_sha
          },
          spec: releaseSpec
        };
      }
    }

    // Run AI analysis
    const analysis = await analyzeIncidentChain({
      source: incident.alert_source ?? "unknown",
      title: incident.title ?? "Incident",
      logs: incident.raw_logs ?? "",
      releaseVersion: incident.release_version ?? undefined,
      repo: incident.repo_full_name ?? undefined,
      releaseContext
    });

    logAction("analyzeIncident:analyzed", ctx, {
      confidence: analysis.confidence,
      hasRootCause: !!analysis.rootCause,
      implicatedCommits: analysis.implicatedCommits.length
    });

    // Update incident with analysis
    const { error: updateError } = await ctx.db
      .from("incidents")
      .update({
        root_cause: analysis.rootCause,
        ai_fix_proposal: analysis.fixProposal,
        ai_analysis: analysis,
        updated_at: new Date().toISOString()
      })
      .eq("id", incident.id)
      .eq("user_id", ctx.userId);

    if (updateError) {
      logError("analyzeIncident:update", ctx, updateError);
    }

    // Create notification
    await createNotification(ctx.db, ctx.userId, {
      type: "incident_analyzed",
      title: "Incident Analysis Complete",
      body: `AI analysis complete for incident: ${incident.title ?? incident.id.slice(0, 8)} (${Math.round(analysis.confidence * 100)}% confidence)`,
      href: `/incidents`,
      severity: "info",
      repoFullName: incident.repo_full_name,
      metadata: {
        incidentId: incident.id,
        confidence: analysis.confidence,
        source: ctx.source
      }
    });

    logAction("analyzeIncident:success", ctx, {
      incidentId: incident.id,
      confidence: analysis.confidence
    });

    return success(
      `Analysis complete with ${Math.round(analysis.confidence * 100)}% confidence. Root cause: ${analysis.rootCause.slice(0, 100)}...`,
      {
        incidentId: incident.id,
        rootCause: analysis.rootCause,
        fixProposal: analysis.fixProposal,
        rollbackSteps: analysis.rollbackSteps,
        changeSummary: analysis.changeSummary,
        implicatedCommits: analysis.implicatedCommits,
        confidence: analysis.confidence
      },
      chainUpdates
    );

  } catch (error) {
    logError("analyzeIncident", ctx, error);
    return failure(
      `Failed to analyze incident: ${error instanceof Error ? error.message : "Unknown error"}`,
      chainUpdates
    );
  }
}
