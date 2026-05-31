import { describe, expect, it } from "vitest";
import { pendingActionForTrace, phaseForStatus } from "@/lib/orchestrator/state-machine";

describe("release trace state machine", () => {
  it("maps trace statuses to product phases", () => {
    expect(phaseForStatus("draft")).toBe("development");
    expect(phaseForStatus("preview_live")).toBe("preview");
    expect(phaseForStatus("release_pending")).toBe("production");
    expect(phaseForStatus("production_live")).toBe("live");
    expect(phaseForStatus("failed")).toBe("attention");
  });

  it("surfaces preview verification after develop merge", () => {
    expect(pendingActionForTrace({ status: "merged_develop", draft_pr_number: 12 })).toBeNull();
  });

  it("asks for a release PR once preview is live", () => {
    expect(pendingActionForTrace({ status: "preview_live" })).toMatchObject({
      type: "create_release_pr"
    });
  });

  it("keeps hotfix traces open until reverse sync is merged", () => {
    expect(pendingActionForTrace({
      status: "production_live",
      reverse_sync_pr_number: 48,
      reverse_sync_status: "open"
    })).toMatchObject({
      type: "merge_reverse_sync"
    });
  });
});
