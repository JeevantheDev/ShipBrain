import { describe, expect, it } from "vitest";
import { decomposeSpec } from "@/lib/ai/chains/spec-decompose";

describe("spec decomposition", () => {
  it("returns actionable task JSON without provider keys", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await decomposeSpec("Create an items API", "test/repo");
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(result.tasks[0].title).toBeTruthy();
    expect(result.tasks[0].files.length).toBeGreaterThan(0);
    expect(result.suggestedBranch).toMatch(/^[a-z0-9\-/]+$/);
  });
});
