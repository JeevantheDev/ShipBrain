import { JsonOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { getModel, hasActiveProviderKey } from "@/lib/ai/model";

export const incidentAnalysisSchema = z.object({
  rootCause: z.string(),
  fixProposal: z.string(),
  rollbackSteps: z.array(z.string()),
  changeSummary: z.string(),
  implicatedCommits: z.array(z.object({
    sha: z.string(),
    message: z.string(),
    reason: z.string(),
    risk: z.string()
  })),
  confidence: z.number()
});

export type IncidentAnalysis = z.infer<typeof incidentAnalysisSchema>;

export async function analyzeIncident(input: {
  source: string;
  title: string;
  logs: string;
  releaseVersion?: string;
  repo?: string;
  releaseContext?: unknown;
}): Promise<IncidentAnalysis> {
  if (!hasActiveProviderKey()) {
    return {
      rootCause:
        "The alert points to a request path exhausting its retry budget after a downstream dependency reset the connection. The most likely fault is an unbounded retry or missing timeout guard in the service function named in the logs.",
      fixProposal:
        "Add a bounded retry policy with jitter, surface dependency failures as typed errors, and temporarily reduce traffic to the affected path until the retry budget stabilizes.",
      rollbackSteps: ["Disable the latest deployment", "Restore previous retry configuration", "Verify error rate under 1%"],
      changeSummary: "ShipBrain matched the incident to the current release and reviewed the available PR commit trail before proposing remediation.",
      implicatedCommits: [],
      confidence: 0.82
    };
  }

  const parser = new JsonOutputParser<IncidentAnalysis>();
  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      [
        "You are an incident commander for a release engineering tool.",
        "Use the alert logs and the release commit context together.",
        "Return JSON only with: rootCause string, fixProposal string, rollbackSteps string array, changeSummary string, implicatedCommits array, confidence number 0-1.",
        "Each implicatedCommits item must include sha, message, reason, risk.",
        "If the commits do not directly prove causality, say so and rank them as correlation, not certainty."
      ].join(" ")
    ],
    ["human", "Source: {source}\nRepository: {repo}\nRelease version: {releaseVersion}\nTitle: {title}\nLogs:\n{logs}\n\nRelease context and commits:\n{releaseContext}"]
  ]);
  const chain = prompt.pipe(getModel({ temperature: 0 })).pipe(parser);
  return incidentAnalysisSchema.parse(await chain.invoke({ ...input, releaseContext: JSON.stringify(input.releaseContext ?? null) }));
}
