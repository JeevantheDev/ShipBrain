import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SPEC_PR_RECIPES } from "@/lib/spec-recipes";

vi.mock("@/lib/actions/get-deployment-context", () => ({
  getRepoDeploymentContext: vi.fn()
}));

vi.mock("@/lib/ai/memory", () => ({
  loadMemoryNotes: vi.fn(async () => []),
  formatMemoryNotesForPrompt: vi.fn(() => "")
}));

function queryResult(data: any[] = [], error: any = null) {
  const result = Promise.resolve({ data, error });
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result)
  };
  return query;
}

describe("getShipBrainAgentContext", () => {
  it("falls back to built-in Spec-to-PR recipes when the recipes table is empty", async () => {
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "repos") {
          return queryResult([
            {
              id: "repo-1",
              full_name: "acme/shop",
              current_version: null
            }
          ]);
        }
        if (table === "spec_pr_recipes") {
          return queryResult([]);
        }
        return queryResult([]);
      })
    };

    const { getShipBrainAgentContext } = await import("@/lib/agent/context");
    const context = await getShipBrainAgentContext({
      supabase,
      userId: "user-1",
      repoFullName: "acme/shop"
    });

    expect(context.specPrRecipes).toHaveLength(DEFAULT_SPEC_PR_RECIPES.length);
    expect(context.specPrRecipes[0].id).toBe(DEFAULT_SPEC_PR_RECIPES[0].id);
    expect(context.specPrRecipes.some((recipe: any) => recipe.isSample)).toBe(true);
  });
});
