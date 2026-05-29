import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";

export type LlmProvider = "microsoft_foundry" | "anthropic" | "openai" | "google";

function firstConfigured(...values: Array<string | undefined>) {
  return values.find((value) => value?.trim())?.trim();
}

function getFoundryConfig() {
  return {
    apiKey: firstConfigured(process.env.AZURE_AI_FOUNDRY_API_KEY, process.env.AZURE_OPENAI_API_KEY),
    endpoint: firstConfigured(process.env.AZURE_AI_FOUNDRY_ENDPOINT, process.env.AZURE_OPENAI_ENDPOINT),
    deploymentName: firstConfigured(
      process.env.AZURE_AI_FOUNDRY_DEPLOYMENT_NAME,
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME
    )
  };
}

export function getProvider(): LlmProvider {
  const provider = (process.env.LLM_PROVIDER ?? "microsoft_foundry").toLowerCase();
  if (provider === "microsoft_foundry" || provider === "ms_foundry" || provider === "azure_foundry" || provider === "azure") {
    return "microsoft_foundry";
  }
  if (provider === "openai" || provider === "google" || provider === "anthropic") {
    return provider;
  }
  return "microsoft_foundry";
}

function getFallbackProvider(): LlmProvider | null {
  if (process.env.GOOGLE_API_KEY) return "google";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

export function getModel(options?: { temperature?: number; streaming?: boolean }): BaseChatModel {
  const temperature = options?.temperature ?? 0.2;
  const streaming = options?.streaming ?? false;

  let provider = getProvider();

  // Check if Azure AI Foundry is configured properly, fallback if not
  if (provider === "microsoft_foundry") {
    const foundry = getFoundryConfig();
    if (!foundry.deploymentName || !foundry.apiKey || !foundry.endpoint) {
      const fallback = getFallbackProvider();
      if (fallback) {
        console.warn(`Azure AI Foundry not fully configured. Falling back to ${fallback}.`);
        provider = fallback;
      } else {
        throw new Error(
          "Azure AI Foundry not configured. Please set AZURE_AI_FOUNDRY_ENDPOINT, AZURE_AI_FOUNDRY_API_KEY, and AZURE_AI_FOUNDRY_DEPLOYMENT_NAME, " +
          "or configure an alternative provider (GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY)."
        );
      }
    }
  }

  switch (provider) {
    case "microsoft_foundry": {
      // Use LangChain's ChatOpenAI with custom base URL for Azure AI Foundry
      const foundry = getFoundryConfig();
      const baseURL = foundry.endpoint!.replace(/\/$/, "") + "/openai/v1";

      return new ChatOpenAI({
        modelName: foundry.deploymentName!,
        openAIApiKey: foundry.apiKey!,
        temperature,
        streaming,
        configuration: {
          baseURL
        }
      });
    }
    case "openai":
      return new ChatOpenAI({
        modelName: process.env.OPENAI_MODEL ?? "gpt-4o",
        openAIApiKey: process.env.OPENAI_API_KEY,
        temperature,
        streaming
      });
    case "google":
      return new ChatGoogleGenerativeAI({
        model: process.env.GOOGLE_MODEL ?? "gemini-3.5-flash",
        apiKey: process.env.GOOGLE_API_KEY,
        temperature,
        streaming
      });
    case "anthropic":
    default:
      return new ChatAnthropic({
        model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        temperature,
        streaming
      });
  }
}

export function hasActiveProviderKey() {
  switch (getProvider()) {
    case "microsoft_foundry": {
      const foundry = getFoundryConfig();
      return Boolean(foundry.apiKey && foundry.endpoint && foundry.deploymentName);
    }
    case "openai":
      return Boolean(process.env.OPENAI_API_KEY);
    case "google":
      return Boolean(process.env.GOOGLE_API_KEY);
    case "anthropic":
    default:
      return Boolean(process.env.ANTHROPIC_API_KEY);
  }
}
