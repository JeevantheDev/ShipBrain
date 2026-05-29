import { afterEach, describe, expect, it, vi } from "vitest";

describe("getModel factory", () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.LLM_PROVIDER;
  });

  it("defaults to Microsoft Foundry when LLM_PROVIDER is unset", async () => {
    const { getProvider } = await import("@/lib/ai/model");
    expect(getProvider()).toBe("microsoft_foundry");
  });

  it("supports openai", async () => {
    process.env.LLM_PROVIDER = "openai";
    const { getProvider } = await import("@/lib/ai/model");
    expect(getProvider()).toBe("openai");
  });

  it("maps azure aliases to Microsoft Foundry", async () => {
    process.env.LLM_PROVIDER = "azure";
    const { getProvider } = await import("@/lib/ai/model");
    expect(getProvider()).toBe("microsoft_foundry");
  });

  it("supports Microsoft Foundry aliases", async () => {
    process.env.LLM_PROVIDER = "ms_foundry";
    const { getProvider } = await import("@/lib/ai/model");
    expect(getProvider()).toBe("microsoft_foundry");
  });

  it("supports google", async () => {
    process.env.LLM_PROVIDER = "google";
    const { getProvider } = await import("@/lib/ai/model");
    expect(getProvider()).toBe("google");
  });
});
