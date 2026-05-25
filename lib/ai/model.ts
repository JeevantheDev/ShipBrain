import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";

export type LlmProvider = "anthropic" | "openai" | "google" | "azure";

export function getProvider(): LlmProvider {
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  if (provider === "openai" || provider === "google" || provider === "azure" || provider === "anthropic") {
    return provider;
  }
  return "anthropic";
}

export function getModel(options?: { temperature?: number; streaming?: boolean }): BaseChatModel {
  const temperature = options?.temperature ?? 0.2;
  const streaming = options?.streaming ?? false;

  switch (getProvider()) {
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
    case "azure":
      return new ChatOpenAI({
        modelName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
        openAIApiKey: process.env.AZURE_OPENAI_API_KEY,
        temperature,
        streaming,
        configuration: {
          baseURL: `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT_NAME}`,
          defaultQuery: {
            "api-version": process.env.AZURE_OPENAI_API_VERSION ?? "2024-05-01-preview"
          },
          defaultHeaders: {
            "api-key": process.env.AZURE_OPENAI_API_KEY ?? ""
          }
        }
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
    case "openai":
      return Boolean(process.env.OPENAI_API_KEY);
    case "google":
      return Boolean(process.env.GOOGLE_API_KEY);
    case "azure":
      return Boolean(
        process.env.AZURE_OPENAI_API_KEY &&
          process.env.AZURE_OPENAI_ENDPOINT &&
          process.env.AZURE_OPENAI_DEPLOYMENT_NAME
      );
    case "anthropic":
    default:
      return Boolean(process.env.ANTHROPIC_API_KEY);
  }
}
