import { JsonOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { getModel, hasActiveProviderKey } from "@/lib/ai/model";

export const specPlanSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      files: z.array(z.string()),
      estimatedLines: z.number().optional()
    })
  ),
  prTitle: z.string(),
  prBody: z.string(),
  suggestedBranch: z.string(),
  suggestedReviewers: z.array(z.string()).default([])
});

/** Context about recent PRs for AI to include in its analysis */
export type PrHistoryContext = {
  recentPrs?: Array<{
    number: number;
    title: string;
    branch?: string;
    status?: string;
    mergedAt?: string;
  }>;
  recentReleases?: Array<{
    tag: string;
    sha?: string;
    deployedAt?: string;
  }>;
  relatedIncidents?: Array<{
    id: string;
    title: string;
    severity?: string;
    status?: string;
  }>;
};

export type SpecPlan = z.infer<typeof specPlanSchema>;

function slugifyBranch(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

function normalizeSpecPlan(raw: unknown, repoFullName: string): SpecPlan {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
  const tasks = rawTasks.map((task, index) => {
    const item = task && typeof task === "object" ? (task as Record<string, unknown>) : {};
    const title =
      item.title ??
      item.name ??
      item.task ??
      item.summary ??
      item.heading ??
      `Implementation task ${index + 1}`;
    const description =
      item.description ??
      item.details ??
      item.acceptanceCriteria ??
      item.summary ??
      "Implement this step from the provided ticket.";
    const files = asStringArray(item.files ?? item.filePaths ?? item.paths ?? item.changedFiles);

    return {
      title: String(title),
      description: String(description),
      files: files.length ? files : [`shipbrain/generated-task-${index + 1}.ts`],
      estimatedLines: typeof item.estimatedLines === "number" ? item.estimatedLines : undefined
    };
  });

  const prTitle = String(input.prTitle ?? input.pullRequestTitle ?? input.title ?? "feat: implement requested ShipBrain workflow");
  const suggestedBranch = slugifyBranch(
    String(input.suggestedBranch ?? input.branch ?? input.branchName ?? prTitle.replace(/^feat:\s*/i, "feat/"))
  );

  return specPlanSchema.parse({
    tasks: tasks.length
      ? tasks
      : [
          {
            title: "Implement requested workflow",
            description: "Create the code path, UI surface, and tests described by the ticket.",
            files: ["shipbrain/generated-workflow.ts"]
          }
        ],
    prTitle,
    prBody: String(input.prBody ?? input.pullRequestBody ?? "## Changes\n- Implement requested workflow\n- Add supporting tests"),
    suggestedBranch: suggestedBranch || "feat/shipbrain-generated-workflow",
    suggestedReviewers: asStringArray(input.suggestedReviewers ?? input.reviewers)
  });
}

function escapePromptValue(value: string) {
  return value.replace(/{/g, "{{").replace(/}/g, "}}");
}

function formatHistoryContext(history?: PrHistoryContext): string {
  if (!history) return "";

  const sections: string[] = [];

  if (history.recentPrs?.length) {
    sections.push("## Recent PRs merged to this repository:");
    for (const pr of history.recentPrs.slice(0, 10)) {
      const status = pr.status ? ` (${pr.status})` : "";
      const merged = pr.mergedAt ? ` - merged ${pr.mergedAt}` : "";
      sections.push(`- PR #${pr.number}: ${pr.title}${status}${merged}`);
    }
  }

  if (history.recentReleases?.length) {
    sections.push("\n## Recent releases:");
    for (const release of history.recentReleases.slice(0, 5)) {
      const deployed = release.deployedAt ? ` - deployed ${release.deployedAt}` : "";
      sections.push(`- ${release.tag}${deployed}`);
    }
  }

  if (history.relatedIncidents?.length) {
    sections.push("\n## Related incidents:");
    for (const incident of history.relatedIncidents.slice(0, 5)) {
      const severity = incident.severity ? ` [${incident.severity}]` : "";
      const status = incident.status ? ` (${incident.status})` : "";
      sections.push(`- ${incident.title}${severity}${status}`);
    }
  }

  return sections.length ? `\n\n${sections.join("\n")}` : "";
}

export async function decomposeSpec(
  rawSpec: string,
  repoFullName: string,
  historyContext?: PrHistoryContext
): Promise<SpecPlan> {
  const historySection = formatHistoryContext(historyContext);

  if (!hasActiveProviderKey()) {
    // Fallback response when no AI key is configured
    const historyNote = historyContext?.recentPrs?.length
      ? `\n\n### Related PRs\n${historyContext.recentPrs.slice(0, 5).map(pr => `- #${pr.number}: ${pr.title}`).join("\n")}`
      : "";

    return {
      tasks: [
        {
          title: "Create typed implementation surface",
          description: "Add the API or component entry point described by the ticket with validation and clear boundaries.",
          files: ["app/api/generated/route.ts"],
          estimatedLines: 48
        },
        {
          title: "Add user-facing workflow",
          description: "Expose the generated capability in the relevant dashboard page using existing UI patterns.",
          files: ["components/generated/GeneratedCard.tsx"],
          estimatedLines: 72
        },
        {
          title: "Cover output parsing",
          description: "Add a focused Vitest case for the response shape and failure path.",
          files: ["tests/unit/generated.test.ts"],
          estimatedLines: 32
        }
      ],
      prTitle: "feat: scaffold requested production workflow",
      prBody: `## Changes\n- Decomposed spec for ${repoFullName}\n- Added scaffold files\n- Added test coverage plan${historyNote}`,
      suggestedBranch: "feat/shipbrain-scaffold",
      suggestedReviewers: ["alex"]
    };
  }

  const parser = new JsonOutputParser<Record<string, unknown>>();
  const systemPrompt = historyContext
    ? `You are ShipBrain, an AI release manager. You have access to the repository's PR history and should use it to provide context in the PR body. Include a "### Related PRs" or "### Release Context" section in the prBody that references relevant past PRs when appropriate. Return only strict JSON with this exact shape: {{"tasks":[{{"title":"string","description":"string","files":["path"],"estimatedLines":40}}],"prTitle":"string","prBody":"markdown string with history context","suggestedBranch":"lowercase-branch","suggestedReviewers":[]}}. Do not use alternate keys like name or taskName.`
    : `You are ShipBrain. Return only strict JSON with this exact shape: {{"tasks":[{{"title":"string","description":"string","files":["path"],"estimatedLines":40}}],"prTitle":"string","prBody":"markdown string","suggestedBranch":"lowercase-branch","suggestedReviewers":[]}}. Do not use alternate keys like name or taskName.`;

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    ["human", "Repo: {repoFullName}\nSpec:\n{rawSpec}{historyContext}"]
  ]);

  const chain = prompt.pipe(getModel({ temperature: 0.1 })).pipe(parser);
  const result = await chain.invoke({
    rawSpec: escapePromptValue(rawSpec),
    repoFullName: escapePromptValue(repoFullName),
    historyContext: escapePromptValue(historySection)
  });
  return normalizeSpecPlan(result, repoFullName);
}
