/**
 * Calls Azure AI Foundry chat completions through the Project endpoint
 * with the configured knowledge base attached as a data_source.
 * Returns null if knowledge base is not configured or the call fails,
 * so callers can fall back to the probe response.
 */
export async function callWithFoundryKnowledgeBase(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Promise<string | null> {
  const projectEndpoint = process.env.AZURE_AI_FOUNDRY_PROJECT_ENDPOINT?.trim();
  const knowledgeBase = process.env.AZURE_AI_FOUNDRY_KNOWLEDGE_BASE?.trim();
  const apiKey = process.env.AZURE_AI_FOUNDRY_API_KEY?.trim();
  const deployment = process.env.AZURE_AI_FOUNDRY_DEPLOYMENT_NAME?.trim();
  // Use the Azure OpenAI endpoint for the data_source search endpoint
  const openAiEndpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim()
    ?? process.env.AZURE_AI_FOUNDRY_ENDPOINT?.trim();

  if (!projectEndpoint || !knowledgeBase || !apiKey || !deployment) return null;

  const url =
    `${projectEndpoint}/openai/deployments/${deployment}/chat/completions` +
    `?api-version=2025-01-01-preview`;

  console.log(`[foundry-kb] calling → ${url}`);
  console.log(`[foundry-kb] knowledge base: ${knowledgeBase} | search endpoint: ${openAiEndpoint}`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": apiKey
      },
      body: JSON.stringify({
        messages,
        data_sources: [
          {
            type: "azure_search",
            parameters: {
              endpoint: openAiEndpoint,
              index_name: knowledgeBase,
              authentication: {
                type: "api_key",
                key: apiKey
              },
              query_type: "simple",
              top_n_documents: 5
            }
          }
        ]
      }),
      signal: AbortSignal.timeout(15_000)
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn("[foundry-kb] ❌ failed:", res.status, errBody);
      return null;
    }

    const json = await res.json();
    const citations = json.choices?.[0]?.message?.context?.citations ?? [];
    console.log(`[foundry-kb] ✅ grounded — ${citations.length} citation(s) from knowledge base`);
    if (citations.length > 0) {
      citations.forEach((c: any, i: number) => {
        console.log(`  [${i + 1}] ${c.title ?? c.filepath ?? "untitled"}`);
      });
    }
    return (json.choices?.[0]?.message?.content as string) ?? null;
  } catch (err) {
    console.warn("[foundry-kb] ❌ error:", err);
    return null;
  }
}

export function isFoundryKbConfigured(): boolean {
  return Boolean(
    process.env.AZURE_AI_FOUNDRY_PROJECT_ENDPOINT &&
    process.env.AZURE_AI_FOUNDRY_KNOWLEDGE_BASE &&
    process.env.AZURE_AI_FOUNDRY_API_KEY &&
    process.env.AZURE_AI_FOUNDRY_DEPLOYMENT_NAME
  );
}
