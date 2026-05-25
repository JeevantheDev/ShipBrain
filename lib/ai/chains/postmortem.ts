import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { getModel, hasActiveProviderKey } from "@/lib/ai/model";
import type { IncidentAnalysis } from "@/lib/ai/chains/incident-analyzer";

const sections = ["Summary", "Timeline", "How it occurred", "Related commits", "Root cause", "Impact", "Resolution", "Action items", "Lessons learned"];

export async function generatePostmortem(input: {
  incident: { id: string; title: string; logs: string; repo?: string; releaseVersion?: string };
  analysis: IncidentAnalysis | null;
  releaseContext?: unknown;
}) {
  if (!hasActiveProviderKey()) {
    return `# Post-mortem: ${input.incident.title}

## Summary
${input.incident.title} caused degraded production behavior and was triaged through ShipBrain${input.incident.releaseVersion ? ` for release ${input.incident.releaseVersion}` : ""}.

## Timeline
- Alert received and incident created
- Logs reviewed by AI analysis
- Release and PR commit history reviewed
- Fix proposal approved by human operator

## How it occurred
${input.analysis?.changeSummary ?? "ShipBrain could not match a release commit trail for this incident."}

## Related commits
${input.analysis?.implicatedCommits?.length ? input.analysis.implicatedCommits.map((commit) => `- \`${commit.sha}\` ${commit.message}: ${commit.reason}`).join("\n") : "- No directly implicated commits were identified from the available context."}

## Root cause
${input.analysis?.rootCause ?? "Root cause analysis was not available."}

## Impact
Users on the affected path experienced elevated failures until mitigation. Repository context: ${input.incident.repo ?? "not captured"}.

## Resolution
${input.analysis?.fixProposal ?? "The service was stabilized and monitored."}

## Action items
- Add regression coverage for the failing path
- Add alert metadata to speed up future diagnosis
- Review retry and timeout settings

## Lessons learned
Approval-gated AI analysis reduced triage time while keeping humans in control.
`;
  }

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      [
        `Write a concise markdown post-mortem with exactly these sections: ${sections.join(", ")}.`,
        "In How it occurred, connect the incident to the release flow and commit evidence.",
        "In Related commits, list the branch/PR commits and explain whether each is causal, correlated, or merely contextual."
      ].join(" ")
    ],
    ["human", "Incident:\n{incident}\nAnalysis:\n{analysis}\nRelease context:\n{releaseContext}"]
  ]);
  const chain = prompt.pipe(getModel({ temperature: 0.3 })).pipe(new StringOutputParser());
  return chain.invoke({
    incident: JSON.stringify(input.incident),
    analysis: JSON.stringify(input.analysis),
    releaseContext: JSON.stringify(input.releaseContext ?? null)
  });
}
