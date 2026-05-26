import { describe, expect, it } from "vitest";
import { analyzeCiFailure } from "@/lib/ai/chains/ci-analyzer";

describe("CI analyzer", () => {
  it("returns explanation and fix suggestion", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await analyzeCiFailure({
      id: "1",
      branch: "feat/test",
      conclusion: "failure",
      logs: "error TS1234: TypeError at src/app.ts:10"
    });
    expect(result.summary).toBeTruthy();
    expect(result.rootCause).toContain("src/app.ts");
    expect(result.fixSuggestion).toBeTruthy();
    expect(["low", "medium", "high"]).toContain(result.severity);
    expect(typeof result.isFlaky).toBe("boolean");
  });
});
