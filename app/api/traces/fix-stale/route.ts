import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { phaseForTraceStatus, pendingActionForTrace } from "@/lib/orchestrator/state-machine";
import type { ReleaseTraceStatus } from "@/lib/orchestrator/types";

export const runtime = "nodejs";

/**
 * Fix stale release traces by:
 * 1. Syncing trace status with linked spec status
 * 2. Recomputing pending actions for all traces
 * 3. Updating current_phase based on status
 */
export async function POST() {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = getSupabaseAdminClient();
  let fixed = 0;
  let errors: string[] = [];

  // Get all traces for this user that might be stale
  const { data: traces, error: tracesError } = await db
    .from("release_traces")
    .select("id, status, current_phase, spec_id, draft_pr_number, release_pr_number, type, target_branch, pending_action, repo_full_name")
    .eq("user_id", user.id)
    .not("status", "in", "(completed,cancelled,rolled_back)");

  if (tracesError) {
    return NextResponse.json({ error: "Failed to fetch traces", detail: tracesError.message }, { status: 500 });
  }

  for (const trace of traces ?? []) {
    try {
      let newStatus: ReleaseTraceStatus | null = null;
      let specData: any = null;

      // If trace has a linked spec, check its status
      if (trace.spec_id) {
        const { data: spec } = await db
          .from("specs")
          .select("status, base_branch, branch_name, release_status, release_pr_status, preview_status, preview_url")
          .eq("id", trace.spec_id)
          .single();

        specData = spec;

        if (spec) {
          // Determine correct trace status based on spec
          if (spec.status === "merged") {
            if (spec.base_branch === "main") {
              // Merged to main
              if (spec.release_status === "deployed") {
                newStatus = "production_live";
              } else if (spec.release_status === "deploying") {
                newStatus = "merged_main";
              } else {
                newStatus = "merged_main";
              }
            } else if (spec.base_branch === "develop") {
              // Merged to develop
              if (spec.preview_url || spec.preview_status === "deployed") {
                newStatus = "preview_live";
              } else if (spec.preview_status === "deploying") {
                newStatus = "merged_develop";
              } else if (spec.release_pr_status === "merged") {
                // Release PR already merged
                newStatus = "merged_main";
              } else if (spec.release_status === "ready_for_prod" || spec.release_pr_status === "open") {
                // Ready for release PR
                newStatus = "preview_live";
              } else {
                newStatus = "merged_develop";
              }
            }
          } else if (spec.status === "closed") {
            newStatus = "cancelled";
          }
        }
      }

      // If no spec or couldn't determine from spec, check PR status directly
      if (!newStatus && trace.draft_pr_number && trace.repo_full_name) {
        // Try to find a spec by PR number
        const { data: specByPr } = await db
          .from("specs")
          .select("id, status, base_branch, branch_name, release_status, preview_status, preview_url")
          .eq("repo_full_name", trace.repo_full_name)
          .eq("pr_number", trace.draft_pr_number)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (specByPr) {
          specData = specByPr;

          // Link the spec to the trace if not already linked
          if (!trace.spec_id) {
            await db
              .from("release_traces")
              .update({ spec_id: specByPr.id, updated_at: new Date().toISOString() })
              .eq("id", trace.id);
          }

          if (specByPr.status === "merged") {
            if (specByPr.base_branch === "main") {
              newStatus = specByPr.release_status === "deployed" ? "production_live" : "merged_main";
            } else if (specByPr.base_branch === "develop") {
              if (specByPr.preview_url || specByPr.preview_status === "deployed") {
                newStatus = "preview_live";
              } else {
                newStatus = "merged_develop";
              }
            }
          } else if (specByPr.status === "closed") {
            newStatus = "cancelled";
          }
        }
      }

      // Update trace if status changed or needs recomputation
      const statusToUse = newStatus ?? trace.status as ReleaseTraceStatus;
      const correctPhase = phaseForTraceStatus(statusToUse, { type: trace.type, target_branch: trace.target_branch });
      const correctPendingAction = pendingActionForTrace({
        status: statusToUse,
        type: trace.type,
        target_branch: trace.target_branch,
        draft_pr_number: trace.draft_pr_number,
        release_pr_number: trace.release_pr_number,
        preview_deployment: null,
        production_deployment: null,
        reverse_sync_pr_number: null,
        reverse_sync_status: null,
        rollback_target_tag: null
      });

      const needsUpdate =
        (newStatus && newStatus !== trace.status) ||
        correctPhase !== trace.current_phase ||
        JSON.stringify(correctPendingAction) !== JSON.stringify(trace.pending_action);

      if (needsUpdate) {
        const { error: updateError } = await db
          .from("release_traces")
          .update({
            status: statusToUse,
            current_phase: correctPhase,
            pending_action: correctPendingAction,
            spec_id: specData?.id ?? trace.spec_id,
            updated_at: new Date().toISOString()
          })
          .eq("id", trace.id);

        if (updateError) {
          errors.push(`Trace ${trace.id}: ${updateError.message}`);
        } else {
          fixed++;
        }
      }
    } catch (err) {
      errors.push(`Trace ${trace.id}: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  }

  return NextResponse.json({
    ok: true,
    fixed,
    total: traces?.length ?? 0,
    errors: errors.length > 0 ? errors : undefined
  });
}
