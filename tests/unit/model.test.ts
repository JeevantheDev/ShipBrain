import { afterEach, describe, expect, it, vi } from "vitest";

describe("getModel factory", () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.LLM_PROVIDER;
  });

  it("defaults to anthropic when LLM_PROVIDER is unset", async () => {
    const { getProvider } = await import("@/lib/ai/model");
    expect(getProvider()).toBe("anthropic");
  });

  it("supports openai", async () => {
    process.env.LLM_PROVIDER = "openai";
    const { getProvider } = await import("@/lib/ai/model");
    expect(getProvider()).toBe("openai");
  });

  it("supports azure", async () => {
    process.env.LLM_PROVIDER = "azure";
    const { getProvider } = await import("@/lib/ai/model");
    expect(getProvider()).toBe("azure");
  });

  it("supports google", async () => {
    process.env.LLM_PROVIDER = "google";
    const { getProvider } = await import("@/lib/ai/model");
    expect(getProvider()).toBe("google");
  });
});
