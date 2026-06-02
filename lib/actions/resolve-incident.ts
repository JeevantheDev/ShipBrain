/**
 * Unified Action: Resolve Incident
 *
 * Marks an incident as resolved.
 * Used by: UI, AI Chat, Telegram
 */

import { updateTraceByIncident } from "@/lib/orchestrator";
import {
  ActionContext,
  ActionResult,
  ResolveIncidentInput,
  ResolveIncidentResult,
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
 * Resolve an incident
 *
 * @param ctx - Action context with db, user, token
 * @param input - Resolve incident input
 * @returns Action result with resolution status
 */
export async function resolveIncident(
  ctx: ActionContext,
  input: ResolveIncidentInput
): Promise<ActionResult<ResolveIncidentResult>> {
  const chainUpdates: ChainUpdate[] = [];

  logAction("resolveIncident", ctx, { input });

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

    const previousStatus = incident.status;

    // Already resolved?
    if (incident.status === "resolved") {
      return success(
        "Incident is already resolved.",
        {
          incidentId: incident.id,
          previousStatus,
          resolved: true
        },
        chainUpdates
      );
    }

    // Update incident
    const { error: updateError } = await ctx.db
      .from("incidents")
      .update({
        status: "resolved",
        resolution_note: input.note ?? `Resolved via ${ctx.source}`,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", incident.id)
      .eq("user_id", ctx.userId);

    if (updateError) {
      logError("resolveIncident:update", ctx, updateError);
      return failure("Failed to update incident status.");
    }

    // Record approval event
    await ctx.db.from("approval_events").insert({
      entity_type: "incident",
      entity_id: incident.id,
      action: "incident_resolved",
      actor_id: ctx.userId,
      note: input.note ?? null,
      metadata: {
        incidentTitle: incident.title,
        previousStatus,
        source: ctx.source,
        actor: ctx.actor
      }
    });

    // Update release trace if exists
    try {
      await updateTraceByIncident(incident.id, {
        status: "completed"
      }, {
        eventType: "status_changed",
        source: ctx.source,
        actor: ctx.actor,
        details: {
          previousStatus,
          newStatus: "resolved",
          note: input.note
        }
      });
    } catch (traceError) {
      logError("resolveIncident:trace", ctx, traceError);
    }

    // Create notification
    await createNotification(ctx.db, ctx.userId, {
      type: "incident_resolved",
      title: "Incident Resolved",
      body: `Incident "${incident.title ?? incident.id.slice(0, 8)}" has been resolved`,
      href: `/incidents`,
      severity: "success",
      repoFullName: incident.repo_full_name,
      metadata: {
        incidentId: incident.id,
        previousStatus,
        source: ctx.source
      }
    });

    logAction("resolveIncident:success", ctx, {
      incidentId: incident.id,
      previousStatus
    });

    return success(
      `Incident "${incident.title ?? incident.id.slice(0, 8)}" has been resolved.`,
      {
        incidentId: incident.id,
        previousStatus,
        resolved: true
      },
      chainUpdates
    );

  } catch (error) {
    logError("resolveIncident", ctx, error);
    return failure(
      `Failed to resolve incident: ${error instanceof Error ? error.message : "Unknown error"}`,
      chainUpdates
    );
  }
}
