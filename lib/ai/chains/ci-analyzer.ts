import { JsonOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { getModel, hasActiveProviderKey } from "@/lib/ai/model";

export const ciAnalysisSchema = z.object({
  summary: z.string(),
  rootCause: z.string(),
  fixSuggestion: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  isFlaky: z.boolean(),
  affectedFiles: z.array(z.string()).optional(),
  errorType: z.string().optional()
});

export type CiAnalysis = z.infer<typeof ciAnalysisSchema>;

type FailedStep = {
  jobName: string;
  stepName: string;
  conclusion: string;
};

export async function analyzeCiFailure(input: {
  id: string;
  branch: string;
  conclusion: string | null;
  logs: string;
  failedSteps?: FailedStep[];
}): Promise<CiAnalysis> {
  const failedStepsText = input.failedSteps?.length
    ? `\n\nFailed steps:\n${input.failedSteps.map(s => `- ${s.jobName} / ${s.stepName}`).join("\n")}`
    : "";

  if (!hasActiveProviderKey()) {
    // Improved fallback analysis without AI
    const logs = input.logs;
    let errorType = "unknown";
    let rootCause = "The run failed but detailed logs were not available for analysis.";
    let fixSuggestion = "Check the GitHub Actions logs directly for more details.";

    // Pattern matching for common error types
    if (/type.*error|cannot find.*type|ts\(\d+\)/i.test(logs)) {
      errorType = "TypeScript error";
      const typeMatch = logs.match(/error TS\d+:[^\n]+/i);
      rootCause = typeMatch ? typeMatch[0] : "TypeScript compilation failed due to type errors.";
      fixSuggestion = "Fix the TypeScript type errors shown in the logs. Check for missing type annotations, incorrect imports, or incompatible types.";
    } else if (/npm err|yarn error|module not found|cannot find module/i.test(logs)) {
      errorType = "dependency error";
      rootCause = "A required npm/yarn dependency is missing or failed to install.";
      fixSuggestion = "Run 'npm install' or 'yarn install' locally to check for dependency issues. Check package.json for typos or missing dependencies.";
    } else if (/test.*fail|expect|assert|should|jest|vitest/i.test(logs)) {
      errorType = "test failure";
      const testMatch = logs.match(/(?:FAIL|✗)[^\n]+/i);
      rootCause = testMatch ? `Test failure: ${testMatch[0]}` : "One or more tests failed.";
      fixSuggestion = "Review the failing test assertions. The expected vs received values should indicate what changed.";
    } else if (/eslint|lint|prettier/i.test(logs)) {
      errorType = "lint error";
      rootCause = "Code style or linting rules were violated.";
      fixSuggestion = "Run 'npm run lint -- --fix' or 'yarn lint --fix' to auto-fix what's possible, then manually fix remaining issues.";
    } else if (/build.*fail|next.*build|webpack|esbuild/i.test(logs)) {
      errorType = "build error";
      rootCause = "The build process failed, likely due to code or configuration issues.";
      fixSuggestion = "Run the build locally with 'npm run build' to see the full error output.";
    } else if (/timeout|timed out/i.test(logs)) {
      errorType = "timeout";
      rootCause = "The workflow or a test timed out, possibly due to an infinite loop or slow operation.";
      fixSuggestion = "Check for infinite loops, missing async/await, or operations that take too long.";
    } else if (/permission denied|access denied|unauthorized/i.test(logs)) {
      errorType = "permission error";
      rootCause = "The workflow lacks required permissions to access a resource.";
      fixSuggestion = "Check repository secrets, environment variables, and workflow permissions.";
    }

    return {
      summary: `Run ${input.id} on ${input.branch} failed with ${errorType}.${failedStepsText}`,
      rootCause,
      fixSuggestion,
      severity: input.conclusion === "failure" ? "high" : "low",
      isFlaky: /timeout|timed out|intermittent|flaky|retry/i.test(logs),
      errorType,
      affectedFiles: extractAffectedFiles(logs)
    };
  }

  const parser = new JsonOutputParser<CiAnalysis>();
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", `You are an expert CI/CD debugger analyzing GitHub Actions workflow logs for a senior engineer.

Analyze the logs carefully and provide:
1. A clear, concise summary of what failed
2. The root cause based on actual error messages in the logs
3. Specific, actionable fix suggestions with commands if applicable
4. Severity assessment (high = blocks deployment, medium = degraded, low = minor)
5. Whether this looks like a flaky test (intermittent failure)
6. List of affected files mentioned in errors (if any)
7. Error type classification (test failure, type error, build error, lint error, dependency error, timeout, permission error, etc.)

Return JSON with these fields:
- summary (string): 1-2 sentence summary
- rootCause (string): Technical explanation of the failure
- fixSuggestion (string): Step-by-step fix with commands
- severity (string): "low", "medium", or "high"
- isFlaky (boolean): true if appears intermittent
- affectedFiles (array of strings, optional): files mentioned in errors
- errorType (string, optional): classification of error type

Focus on the actual error messages in the logs. Quote specific lines when helpful.`],
    ["human", `Workflow run: {id}
Branch: {branch}
Conclusion: {conclusion}

{failedStepsText}

Full logs:
{logs}`]
  ]);

  const chain = prompt.pipe(getModel({ temperature: 0 })).pipe(parser);

  // Truncate logs if too long (keep first and last parts)
  let truncatedLogs = input.logs;
  if (truncatedLogs.length > 15000) {
    const first = truncatedLogs.slice(0, 7000);
    const last = truncatedLogs.slice(-7000);
    truncatedLogs = first + "\n\n... [logs truncated for analysis] ...\n\n" + last;
  }

  const result = await chain.invoke({
    ...input,
    logs: truncatedLogs,
    failedStepsText
  });

  return ciAnalysisSchema.parse(result);
}

function extractAffectedFiles(logs: string): string[] {
  const files: Set<string> = new Set();

  // Match common file path patterns
  const patterns = [
    /(?:at |in |from |File: |→ )([a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,4})(?::\d+)?/g,
    /error.*?([a-zA-Z0-9_\-./]+\.(?:ts|tsx|js|jsx|mjs|cjs))(?::\d+)?/gi,
    /(?:src|app|lib|components|pages)\/[a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,4}/g
  ];

  for (const pattern of patterns) {
    const matches = logs.matchAll(pattern);
    for (const match of matches) {
      const file = match[1] ?? match[0];
      if (file && !file.includes("node_modules") && file.length < 100) {
        files.add(file);
      }
    }
  }

  return Array.from(files).slice(0, 10);
}
