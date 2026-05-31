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

describe("hasActiveProviderKey", () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.LLM_PROVIDER;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.AZURE_AI_FOUNDRY_API_KEY;
    delete process.env.AZURE_AI_FOUNDRY_ENDPOINT;
    delete process.env.AZURE_AI_FOUNDRY_DEPLOYMENT_NAME;
  });

  it("returns true when default provider is microsoft_foundry and keys are present", async () => {
    process.env.AZURE_AI_FOUNDRY_API_KEY = "key";
    process.env.AZURE_AI_FOUNDRY_ENDPOINT = "http://endpoint";
    process.env.AZURE_AI_FOUNDRY_DEPLOYMENT_NAME = "deploy";
    const { hasActiveProviderKey } = await import("@/lib/ai/model");
    expect(hasActiveProviderKey()).toBe(true);
  });

  it("falls back to google when microsoft_foundry is missing keys but GOOGLE_API_KEY is present", async () => {
    process.env.GOOGLE_API_KEY = "gkey";
    const { hasActiveProviderKey } = await import("@/lib/ai/model");
    expect(hasActiveProviderKey()).toBe(true);
  });

  it("returns false when no provider keys are available", async () => {
    const { hasActiveProviderKey } = await import("@/lib/ai/model");
    expect(hasActiveProviderKey()).toBe(false);
  });
});
