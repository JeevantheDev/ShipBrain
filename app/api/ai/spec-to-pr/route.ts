import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { generateScaffold } from "@/lib/ai/chains/code-scaffold";
import { decomposeSpec, specPlanSchema } from "@/lib/ai/chains/spec-decompose";
import { createDraftPR } from "@/lib/github/pr";

export const runtime = "nodejs";

function splitRepo(repoFullName: string) {
  const [owner = "test", repo = "repo"] = repoFullName.includes("/") ? repoFullName.split("/") : ["test", repoFullName];
  return { owner, repo };
}

function getGitHubError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/Resource not accessible by personal access token/i.test(message)) {
    return {
      error: "GitHub token cannot create the Draft PR.",
      detail:
        "Your personal access token can read repository code, but ShipBrain needs write access to create a branch and commit files. Update the fine-grained token for JeevantheDev/shipbrain_sandbox with Repository permissions: Contents read/write, Pull requests read/write, Actions read/write, Workflows read/write, and Metadata read."
    };
  }

  if (/Reference already exists/i.test(message)) {
    return {
      error: "GitHub branch already exists.",
      detail: "The generated branch name already exists in the repository. Change the ticket slightly or delete the previous generated branch before approving again."
    };
  }

  return null;
}

function getGeminiRetryError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!/429|Too Many Requests|Quota exceeded|retry/i.test(message)) return null;

  const retryDelayMatch =
    message.match(/retryDelay"?\s*:?\s*"?(\d+(?:\.\d+)?)s/i) ??
    message.match(/retry in (\d+(?:\.\d+)?)s/i);
  const retryAfterSeconds = retryDelayMatch ? Math.ceil(Number(retryDelayMatch[1])) : 30;

  return {
    error: "Gemini quota is cooling down.",
    detail: `ShipBrain reached the Gemini free-tier request limit. I will retry this step in about ${retryAfterSeconds} seconds. You can also wait a moment and retry manually.`,
    retryable: true,
    retryAfterSeconds
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.rawSpec?.trim()) {
      return NextResponse.json({ error: "rawSpec is required" }, { status: 400 });
    }

    const plan = body.plan ? specPlanSchema.parse(body.plan) : await decomposeSpec(body.rawSpec, body.repoFullName ?? "shipbrain-sandbox");
    const handoffOnly = /shipbrain-codegen:\s*handoff-only/i.test(body.rawSpec ?? "") || /shipbrain-codegen:\s*handoff-only/i.test(plan.prBody ?? "");
    const scaffold = handoffOnly
      ? await generateScaffold({
          ...plan,
          prBody: `${plan.prBody}\n\nShipBrain-codegen: handoff-only`
        })
      : body.plan?.scaffold ?? (await generateScaffold(plan));
    const response = { ...plan, scaffold };

    if (!body.createPr) {
      return NextResponse.json(response);
    }

    const { owner, repo } = splitRepo(body.repoFullName ?? "shipbrain-sandbox");
    const branch = typeof body.branchOverride === "string" && body.branchOverride.trim() ? body.branchOverride.trim() : plan.suggestedBranch;
    const base = typeof body.baseBranchOverride === "string" && body.baseBranchOverride.trim() ? body.baseBranchOverride.trim() : "develop";
    const promotionFooter = body.useExistingSourceBranch
      ? [
          "",
          "## ShipBrain release automation",
          "",
          `This PR promotes the existing source branch \`${branch}\` into \`${base}\`. The GitHub Files changed tab is the source of truth for the production payload; ShipBrain did not create placeholder app changes for this release PR.`,
          "",
          "After this PR is reviewed and merged, ShipBrain only marks it as pending production deployment. Production starts exclusively from CI Monitor when a manager approves the unique release tag and clicks the tag-and-deploy action."
        ].join("\n")
      : "";
    const pr = await createDraftPR({
      owner,
      repo,
      base,
      branch,
      title: plan.prTitle,
      body: `${plan.prBody}${promotionFooter}\n\nApproval note: ${body.approvalNote ?? ""}`,
      files: scaffold,
      reviewers: plan.suggestedReviewers,
      useExistingHead: Boolean(body.useExistingSourceBranch)
    });

    return NextResponse.json({ ...response, pr });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: "ShipBrain could not safely understand the AI plan.",
          detail: "The model returned a plan with missing fields. Try again, or make the ticket more specific about files and acceptance criteria."
        },
        { status: 422 }
      );
    }

    const githubError = getGitHubError(error);
    if (githubError) {
      return NextResponse.json(githubError, { status: 403 });
    }

    const geminiRetryError = getGeminiRetryError(error);
    if (geminiRetryError) {
      return NextResponse.json(geminiRetryError, { status: 429 });
    }

    return NextResponse.json(
      {
        error: "ShipBrain could not complete the Draft PR workflow.",
        detail: error instanceof Error ? error.message : "Unexpected server error"
      },
      { status: 500 }
    );
  }
}
