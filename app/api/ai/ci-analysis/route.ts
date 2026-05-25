import { NextResponse } from "next/server";
import { analyzeCiFailure } from "@/lib/ai/chains/ci-analyzer";
import { fetchWorkflowLogs } from "@/lib/github/workflow-logs";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Try to fetch actual GitHub logs if we have the run ID and repo
    let enrichedLogs = body.logs;
    let failedSteps: Array<{ jobName: string; stepName: string; conclusion: string }> = [];

    if (body.id && body.repo) {
      try {
        const { owner, repo } = splitRepo(body.repo);
        const runId = parseInt(body.id, 10);

        if (!isNaN(runId)) {
          const logsResult = await fetchWorkflowLogs({ owner, repo, runId });
          enrichedLogs = logsResult.logs;
          failedSteps = logsResult.failedSteps;
        }
      } catch (logsError) {
        // If log fetching fails, continue with basic logs
        console.error("Failed to fetch GitHub logs:", logsError);
      }
    }

    const analysis = await analyzeCiFailure({
      ...body,
      logs: enrichedLogs,
      failedSteps
    });

    return NextResponse.json(analysis);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "CI analysis failed" }, { status: 500 });
  }
}
