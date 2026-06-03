import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent/context", () => ({
  getShipBrainAgentContext: vi.fn()
}));

vi.mock("@/lib/ai/model", () => ({
  getModel: vi.fn(() => {
    throw new Error("Model should not be called for deterministic Draft PR merge guidance");
  })
}));

import { getShipBrainAgentContext } from "@/lib/agent/context";
import { getModel } from "@/lib/ai/model";
import { answerShipBrainQuestion } from "@/lib/ai/shipbrain-chat";

describe("ShipBrain chat routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getShipBrainAgentContext).mockResolvedValue({
      activeRepo: "acme/shop",
      repos: [{ full_name: "acme/shop" }],
      recentPrs: [
        {
          id: "spec-1",
          pr_number: 149,
          status: "merged",
          branch_name: "hotfix/example",
          base_branch: "main"
        }
      ]
    } as any);
  });

  it("answers Draft PR merge requests with manual GitHub guidance instead of listing recent PRs", async () => {
    const result = await answerShipBrainQuestion({
      supabase: { from: vi.fn() },
      userId: "user-1",
      repoFullName: "acme/shop",
      message: "Merge my Draft PR."
    });

    expect(result.action).toBeNull();
    expect(result.reply).toContain("manual GitHub-side step");
    expect(result.reply).toContain("Merge it into `develop`");
    expect(result.reply).not.toContain("Recent PRs");
    expect(getModel).not.toHaveBeenCalled();
  });

  it("answers handbook setup checklist requests without calling the model", async () => {
    vi.mocked(getShipBrainAgentContext).mockResolvedValueOnce({
      activeRepo: null,
      repos: [],
      recentPrs: []
    } as any);

    const result = await answerShipBrainQuestion({
      supabase: { from: vi.fn() },
      userId: "user-1",
      message:
        "Using the ShipBrain AI Action Handbook, show the GitHub, Cloudflare, incident integration, and manual merge/setup checklist I should verify for JeevantheDev/shipbrain_sandbox."
    });

    expect(result.action).toBeNull();
    expect(result.reply).toContain("JeevantheDev/shipbrain_sandbox");
    expect(result.reply).toContain("**GitHub**");
    expect(result.reply).toContain("**Cloudflare**");
    expect(result.reply).toContain("**Incident Integration**");
    expect(result.reply).toContain("**Manual Merge And Review**");
    expect(getModel).not.toHaveBeenCalled();
  });
});
