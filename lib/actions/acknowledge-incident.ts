/**
 * Unified Action: Acknowledge Incident
 *
 * Acknowledges an incident to start investigating.
 * Used by: UI, AI Chat, Telegram
 */

import {
  ActionContext,
  ActionResult,
  ChainUpdate
} from "./types";
import {
  logAction,
  logError,
  createNotification,
  success,
  failure
} from "./utils";

export interface AcknowledgeIncidentInput {
  incidentId: string;
  /** Optional note for acknowledgement */
  note?: string;
}

export interface AcknowledgeIncidentResult {
  incidentId: string;
  previousStatus: string;
  acknowledged: boolean;
  acknowledgedBy: string;
}

/**
 * Acknowledge an incident to start investigating
 *
 * @param ctx - Action context with db, user, token
 * @param input - Acknowledge incident input
 * @returns Action result with acknowledgement status
 */
export async function acknowledgeIncident(
  ctx: ActionContext,
  input: AcknowledgeIncidentInput
): Promise<ActionResult<AcknowledgeIncidentResult>> {
  const chainUpdates: ChainUpdate[] = [];

  logAction("acknowledgeIncident", ctx, { input });

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

    // Already investigating or beyond?
    if (incident.status !== "open") {
      return success(
        `Incident is already ${incident.status}.`,
        {
          incidentId: incident.id,
          previousStatus,
          acknowledged: true,
          acknowledgedBy: incident.acknowledged_by || ctx.actor
        },
        chainUpdates
      );
    }

    // Update incident
    const { error: updateError } = await ctx.db
      .from("incidents")
      .update({
        status: "investigating",
        acknowledged_at: new Date().toISOString(),
        acknowledged_by: ctx.actor,
        acknowledgement_note: input.note ?? `Acknowledged via ${ctx.source}`,
        updated_at: new Date().toISOString()
      })
      .eq("id", incident.id)
      .eq("user_id", ctx.userId);

    if (updateError) {
      logError("acknowledgeIncident:update", ctx, updateError);
      return failure("Failed to update incident status.");
    }

    // Record approval event
    await ctx.db.from("approval_events").insert({
      entity_type: "incident",
      entity_id: incident.id,
      action: "incident_acknowledged",
      actor_id: ctx.userId,
      note: input.note ?? null,
      metadata: {
        incidentTitle: incident.title,
        previousStatus,
        source: ctx.source,
        actor: ctx.actor
      }
    });

    // Create notification
    await createNotification(ctx.db, ctx.userId, {
      type: "incident_acknowledged",
      title: "Incident Acknowledged",
      body: `Now investigating: "${incident.title ?? incident.id.slice(0, 8)}"`,
      href: `/incidents`,
      severity: "warning",
      repoFullName: incident.repo_full_name,
      metadata: {
        incidentId: incident.id,
        previousStatus,
        source: ctx.source
      }
    });

    logAction("acknowledgeIncident:success", ctx, {
      incidentId: incident.id,
      previousStatus
    });

    return success(
      `Incident "${incident.title ?? incident.id.slice(0, 8)}" is now being investigated.`,
      {
        incidentId: incident.id,
        previousStatus,
        acknowledged: true,
        acknowledgedBy: ctx.actor
      },
      chainUpdates
    );

  } catch (error) {
    logError("acknowledgeIncident", ctx, error);
    return failure(
      `Failed to acknowledge incident: ${error instanceof Error ? error.message : "Unknown error"}`,
      chainUpdates
    );
  }
}
