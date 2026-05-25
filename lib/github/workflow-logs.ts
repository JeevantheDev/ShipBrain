import { getOctokit } from "@/lib/github/client";

export type WorkflowLogInput = {
  owner: string;
  repo: string;
  runId: number;
  token?: string;
};

export type WorkflowLogsResult = {
  logs: string;
  jobs: Array<{
    name: string;
    conclusion: string | null;
    logs: string;
  }>;
  failedSteps: Array<{
    jobName: string;
    stepName: string;
    conclusion: string;
  }>;
};

/**
 * Fetches workflow run logs from GitHub Actions API
 * Returns structured logs for AI analysis
 */
export async function fetchWorkflowLogs(input: WorkflowLogInput): Promise<WorkflowLogsResult> {
  const octokit = getOctokit(input.token);

  // Get workflow run details
  const { data: run } = await octokit.actions.getWorkflowRun({
    owner: input.owner,
    repo: input.repo,
    run_id: input.runId
  });

  // Get jobs for this run
  const { data: jobsResponse } = await octokit.actions.listJobsForWorkflowRun({
    owner: input.owner,
    repo: input.repo,
    run_id: input.runId,
    per_page: 50
  });

  const jobs = jobsResponse.jobs ?? [];
  const failedSteps: WorkflowLogsResult["failedSteps"] = [];
  const jobLogs: WorkflowLogsResult["jobs"] = [];
  const logParts: string[] = [];

  // Gather basic run info
  logParts.push(`# Workflow Run: ${run.name}`);
  logParts.push(`Repository: ${input.owner}/${input.repo}`);
  logParts.push(`Branch: ${run.head_branch}`);
  logParts.push(`Commit: ${run.head_sha?.slice(0, 7)}`);
  logParts.push(`Status: ${run.status}`);
  logParts.push(`Conclusion: ${run.conclusion ?? "pending"}`);
  logParts.push(`Triggered by: ${run.event}`);
  logParts.push(`URL: ${run.html_url}`);
  logParts.push("");

  // Process each job
  for (const job of jobs) {
    const steps = job.steps ?? [];
    const jobLogParts: string[] = [];

    jobLogParts.push(`## Job: ${job.name}`);
    jobLogParts.push(`Status: ${job.status} / ${job.conclusion ?? "pending"}`);
    jobLogParts.push("");

    // List all steps with their status
    for (const step of steps) {
      const status = step.conclusion ?? step.status ?? "pending";
      const emoji = status === "success" ? "✓" : status === "failure" ? "✗" : status === "skipped" ? "○" : "…";
      jobLogParts.push(`  ${emoji} ${step.name}: ${status}`);

      // Track failed steps
      if (step.conclusion === "failure" || step.conclusion === "cancelled") {
        failedSteps.push({
          jobName: job.name,
          stepName: step.name,
          conclusion: step.conclusion
        });
      }
    }
    jobLogParts.push("");

    // Try to fetch actual log content for failed jobs
    if (job.conclusion === "failure" || job.conclusion === "cancelled") {
      try {
        const { data: jobLogsData } = await octokit.actions.downloadJobLogsForWorkflowRun({
          owner: input.owner,
          repo: input.repo,
          job_id: job.id
        });

        // Parse the log content - it's typically a string
        const rawLogs = typeof jobLogsData === "string" ? jobLogsData : String(jobLogsData);

        // Extract relevant error lines (around error keywords and last 100 lines)
        const lines = rawLogs.split("\n");
        const errorLines: string[] = [];
        const errorPatterns = [
          /error/i,
          /fail/i,
          /exception/i,
          /fatal/i,
          /exit code [1-9]/i,
          /command not found/i,
          /cannot find/i,
          /undefined reference/i,
          /type.*error/i,
          /syntax.*error/i,
          /npm err/i,
          /yarn error/i,
          /enoent/i,
          /permission denied/i,
          /timeout/i
        ];

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (errorPatterns.some(pattern => pattern.test(line))) {
            // Get context: 2 lines before and 5 lines after
            const start = Math.max(0, i - 2);
            const end = Math.min(lines.length, i + 6);
            const context = lines.slice(start, end).join("\n");
            if (!errorLines.includes(context)) {
              errorLines.push(context);
            }
          }
        }

        // Also include the last 50 lines for context
        const lastLines = lines.slice(-50).join("\n");

        if (errorLines.length > 0) {
          jobLogParts.push("### Error context:");
          jobLogParts.push("```");
          jobLogParts.push(errorLines.slice(0, 10).join("\n---\n")); // Limit to 10 error contexts
          jobLogParts.push("```");
          jobLogParts.push("");
        }

        if (lastLines.trim()) {
          jobLogParts.push("### Last 50 lines of log:");
          jobLogParts.push("```");
          jobLogParts.push(lastLines);
          jobLogParts.push("```");
        }

        jobLogs.push({
          name: job.name,
          conclusion: job.conclusion,
          logs: errorLines.join("\n---\n") + "\n\n" + lastLines
        });
      } catch {
        // Log download might fail for older runs
        jobLogParts.push("(Unable to fetch detailed logs for this job)");
        jobLogs.push({
          name: job.name,
          conclusion: job.conclusion,
          logs: "(logs unavailable)"
        });
      }
    } else {
      jobLogs.push({
        name: job.name,
        conclusion: job.conclusion,
        logs: ""
      });
    }

    logParts.push(jobLogParts.join("\n"));
  }

  // Add summary of failures
  if (failedSteps.length > 0) {
    logParts.push("\n## Failed Steps Summary:");
    for (const step of failedSteps) {
      logParts.push(`- ${step.jobName} / ${step.stepName}: ${step.conclusion}`);
    }
  }

  return {
    logs: logParts.join("\n"),
    jobs: jobLogs,
    failedSteps
  };
}

/**
 * Lightweight version that just gets basic info without downloading full logs
 * Use this when you don't need detailed error analysis
 */
export async function fetchWorkflowSummary(input: WorkflowLogInput): Promise<string> {
  const octokit = getOctokit(input.token);

  const { data: run } = await octokit.actions.getWorkflowRun({
    owner: input.owner,
    repo: input.repo,
    run_id: input.runId
  });

  const { data: jobsResponse } = await octokit.actions.listJobsForWorkflowRun({
    owner: input.owner,
    repo: input.repo,
    run_id: input.runId,
    per_page: 50
  });

  const jobs = jobsResponse.jobs ?? [];
  const lines: string[] = [];

  lines.push(`Workflow: ${run.name}`);
  lines.push(`Repository: ${input.owner}/${input.repo}`);
  lines.push(`Branch: ${run.head_branch}`);
  lines.push(`Commit: ${run.head_sha?.slice(0, 7)}`);
  lines.push(`Status: ${run.status} / ${run.conclusion ?? "pending"}`);
  lines.push(`Event: ${run.event}`);
  lines.push("");

  for (const job of jobs) {
    const status = job.conclusion ?? job.status ?? "pending";
    const emoji = status === "success" ? "✓" : status === "failure" ? "✗" : "…";
    lines.push(`${emoji} ${job.name}: ${status}`);

    for (const step of job.steps ?? []) {
      const stepStatus = step.conclusion ?? step.status ?? "pending";
      const stepEmoji = stepStatus === "success" ? "  ✓" : stepStatus === "failure" ? "  ✗" : stepStatus === "skipped" ? "  ○" : "  …";
      lines.push(`${stepEmoji} ${step.name}: ${stepStatus}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
