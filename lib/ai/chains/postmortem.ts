import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { getModel, hasActiveProviderKey } from "@/lib/ai/model";
import type { IncidentAnalysis } from "@/lib/ai/chains/incident-analyzer";

export async function generatePostmortem(input: {
  incident: { id: string; title: string; logs: string; repo?: string; releaseVersion?: string; severity?: string; service?: string; environment?: string };
  analysis: IncidentAnalysis | null;
  releaseContext?: unknown;
  pastIncidents?: any[];
  currentFixCommits?: any[];
}) {
  const isProdDeploy = input.incident.releaseVersion ? true : false;
  const severity = input.incident.severity || "high";
  const repo = input.incident.repo || "unknown-repo";
  const environment = input.incident.environment || (isProdDeploy ? "production" : "preview");
  const service = input.incident.service || "app-service";

  if (!hasActiveProviderKey()) {
    const formattedCommits = input.currentFixCommits?.length
      ? input.currentFixCommits.map((commit: any) => `- \`${commit.sha?.slice(0, 7) || "unknown"}\` ${commit.commit?.message || commit.message || ""}`).join("\n")
      : input.analysis?.implicatedCommits?.length
        ? input.analysis.implicatedCommits.map((commit: any) => `- \`${commit.sha?.slice(0, 7) || "unknown"}\` ${commit.message || ""}`).join("\n")
        : `- No linked commits were identified for the current fix.`;

    const pastIncidentsSection = input.pastIncidents?.length
      ? input.pastIncidents.map((p: any) => `### Incident: ${p.title}
- **Root Cause**: ${p.root_cause || "Not specified."}
- **Fix/Resolution**: ${p.ai_fix_proposal || "Not specified."}
- **Date**: ${new Date(p.created_at).toLocaleDateString()}`).join("\n\n")
      : "No past resolved incidents were found for this repository/service.";

    const releaseContextObj = input.releaseContext as any;
    let prFeatureHistorySection = "No PR/feature history was identified for this incident.";
    if (releaseContextObj) {
      const featurePr = releaseContextObj.draftPr;
      const releasePr = releaseContextObj.release;
      const featureCommits = releaseContextObj.commits?.featurePr || [];
      const releaseCommits = releaseContextObj.commits?.releasePr || [];

      const formattedFeatureCommits = featureCommits.length
        ? featureCommits.map((c: any) => `- \`${c.sha?.slice(0, 7) || "unknown"}\` ${c.message || c.commit?.message || ""}`).join("\n")
        : "- No commits in feature PR";

      const formattedReleaseCommits = releaseCommits.length
        ? releaseCommits.map((c: any) => `- \`${c.sha?.slice(0, 7) || "unknown"}\` ${c.message || c.commit?.message || ""}`).join("\n")
        : "- No commits in release PR";

      prFeatureHistorySection = [
        `- **Feature Branch**: \`${releaseContextObj.featureBranch || "N/A"}\``,
        `- **Base Branch**: \`${releaseContextObj.baseBranch || "N/A"}\``,
        `- **Feature PR**: ${featurePr ? `[PR #${featurePr.number}](${featurePr.url}) (${featurePr.status || "unknown"})` : "N/A"}`,
        `- **Release Tag**: \`${releasePr?.tag || "N/A"}\``,
        `- **Release PR**: ${releasePr?.releasePrNumber ? `[PR #${releasePr.releasePrNumber}](${releasePr.releasePrUrl}) (${releasePr.releasePrStatus || "unknown"})` : "N/A"}`,
        "",
        "### Feature PR Commits",
        formattedFeatureCommits,
        "",
        "### Release PR Commits",
        formattedReleaseCommits
      ].join("\n");
    }

    return `# Incident Post-Mortem: ${input.incident.title}

**Date**: ${new Date().toLocaleDateString()}
**Incident ID**: ${input.incident.id}
**Severity**: ${severity.toUpperCase()}
**Status**: Resolved
**Repository**: ${repo}
**Release/Environment**: ${input.incident.releaseVersion || "N/A"} (${environment})

---

## 1. Incident Summary
${input.incident.title} caused degraded behavior in the ${environment} environment for ${service}. The incident was triaged and mitigated through ShipBrain's automated hotfix pipeline.

## 2. Impact Analysis
- **User Impact**: Users on the affected path experienced elevated errors and degraded service functionality.
- **Service Affected**: ${service}
- **Duration**: Mitigation was successfully dispatched and verified within minutes of alert detection.

## 3. Timeline
- [Alert Detected] - Alert received and incident created in ShipBrain.
- [AI Analysis] - Logs reviewed and root cause analysis generated.
- [Hotfix Created] - Incident hotfix branch and draft PR created.
- [Approved & Dispatched] - Fix approved by human operator; deployment dispatched.
- [Mitigated] - Deployment completed and alert resolved.

## 4. Root Cause Analysis (5 Whys)
1. **Why** did the incident occur? The application encountered runtime failures/errors on the active execution path.
2. **Why** did it encounter runtime failures? ${input.analysis?.rootCause || "The root cause was identified as a regression in the recent deployment."}
3. **Why** was the regression introduced? The failing path was not covered by existing integration tests.
4. **Why** was it not covered? The path is an edge case that was overlooked during the design phase.
5. **Why** was it overlooked? Lack of strict design reviews and end-to-end regression test gating.

*Detailed Root Cause Description*:
${input.analysis?.rootCause || "A detailed root cause analysis is pending further code review."}

## 5. Resolution & Current Fix
- **Fix Description**: ${input.analysis?.fixProposal || "A hotfix PR was created, approved, merged, and deployed to mitigate the issue."}
- **Linked Commits**:
${formattedCommits}

## 6. PR & Feature History
${prFeatureHistorySection}

## 7. Historical Context & Past Incidents
${pastIncidentsSection}

## 8. Action Items (Preventative Actions)
- **Prevent (Avoid in Future)**: Add comprehensive automated test coverage for the regression path. Establish strict code review guidelines for similar configuration patterns.
- **Detect**: Add specific monitoring and alert rules to catch this error pattern instantly.
- **Mitigate**: Enhance rollback scripts and staging verification pipelines to minimize the blast radius of future regressions.

## 9. Lessons Learned
- Auto-assisted log analysis significantly reduces MTTR (Mean Time To Resolution).
- Gaps in regression test suites present the highest risk of recurring bug patterns.
`;
  }

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      [
        "You are an expert Site Reliability Engineer (SRE) writing a professional incident post-mortem in markdown format.",
        "Your task is to generate a comprehensive, industry-standard post-mortem document based on the incident, AI analysis, release context, past resolved incidents, and the current fix commits.",
        "You must structure the post-mortem with exactly the following sections, using the headers and structure defined below:",
        "",
        "# Incident Post-Mortem: [Incident Title]",
        "**Date**: [Today's Date]",
        "**Incident ID**: [Incident ID]",
        "**Severity**: [Severity]",
        "**Status**: Resolved",
        "**Repository**: [Repository]",
        "**Release/Environment**: [Release Version] ([Environment])",
        "---",
        "## 1. Incident Summary",
        "Summarize what happened, the user impact, and the overall detection and mitigation.",
        "## 2. Impact Analysis",
        "Detail the user impact (e.g. error rate, performance degradation) and list the service affected and duration.",
        "## 3. Timeline",
        "Provide a chronological timeline of events (Alert detection, AI triage, hotfix creation, approval, deployment, resolution).",
        "## 4. Root Cause Analysis (5 Whys)",
        "Perform a 5 Whys analysis (Why 1 through Why 5) to trace the chain of causes. Follow this with a detailed Root Cause Description.",
        "## 5. Resolution & Current Fix",
        "Describe the fix applied and list the current fix commits (commit SHA and message).",
        "## 6. PR & Feature History",
        "Provide detailed information about the associated feature branch, base branch, and Pull Request (PR) details, along with the list of commits from the feature PR and release PR if available in the Release Context. Format this cleanly using markdown lists.",
        "## 7. Historical Context & Past Incidents",
        "Review the past incidents provided. Compare them to the current incident: Is this a recurring pattern? How does the current fix relate to past issues? What common threads exist?",
        "## 8. Action Items (Preventative Actions)",
        "List concrete action items categorized by Prevent (Avoid in Future), Detect, and Mitigate. Discuss how to specifically avoid similar issues in the future.",
        "## 9. Lessons Learned",
        "Describe what went well, what went poorly, and where we got lucky."
      ].join("\n")
    ],
    [
      "human",
      [
        "Incident Context:",
        "{incident}",
        "",
        "Root Cause & Fix Analysis:",
        "{analysis}",
        "",
        "Release Context:",
        "{releaseContext}",
        "",
        "Current Fix Commits:",
        "{currentFixCommits}",
        "",
        "Past Resolved Incidents (Historical Context):",
        "{pastIncidents}"
      ].join("\n")
    ]
  ]);

  const chain = prompt.pipe(getModel({ temperature: 0.3 })).pipe(new StringOutputParser());
  return chain.invoke({
    incident: JSON.stringify(input.incident),
    analysis: JSON.stringify(input.analysis),
    releaseContext: JSON.stringify(input.releaseContext ?? null),
    currentFixCommits: JSON.stringify(input.currentFixCommits ?? []),
    pastIncidents: JSON.stringify(input.pastIncidents ?? [])
  });
}
