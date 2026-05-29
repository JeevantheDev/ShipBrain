import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { generateScaffold } from "@/lib/ai/chains/code-scaffold";
import { decomposeSpec, specPlanSchema } from "@/lib/ai/chains/spec-decompose";
import { createDraftPR } from "@/lib/github/pr";
import { createOrUpdateTrace } from "@/lib/orchestrator";
import { DEFAULT_SPEC_PR_RECIPES } from "@/lib/spec-recipes";
import { getSupabaseServerClient } from "@/lib/supabase/server";

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

function getAiRetryError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!/429|Too Many Requests|Quota exceeded|retry/i.test(message)) return null;

  const retryDelayMatch =
    message.match(/retryDelay"?\s*:?\s*"?(\d+(?:\.\d+)?)s/i) ??
    message.match(/retry in (\d+(?:\.\d+)?)s/i);
  const retryAfterSeconds = retryDelayMatch ? Math.ceil(Number(retryDelayMatch[1])) : 30;

  return {
    error: "AI provider quota is cooling down.",
    detail: `ShipBrain reached the active AI provider request limit. I will retry this step in about ${retryAfterSeconds} seconds. You can also wait a moment and retry manually.`,
    retryable: true,
    retryAfterSeconds
  };
}

export async function POST(request: Request) {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  try {
    const body = await request.json();

    // Support recipeId as alternative to rawSpec
    let rawSpec = body.rawSpec?.trim();
    let baseBranchFromRecipe: string | undefined;
    let sourceBranchFromRecipe: string | undefined;

    if (!rawSpec && body.recipeId) {
      const recipe = DEFAULT_SPEC_PR_RECIPES.find(r => r.id === body.recipeId);
      if (recipe) {
        rawSpec = recipe.ticket;
        baseBranchFromRecipe = recipe.baseBranch;
        sourceBranchFromRecipe = recipe.sourceBranch;
      }
    }

    if (!rawSpec) {
      return NextResponse.json({ error: "rawSpec or recipeId is required" }, { status: 400 });
    }

    const plan = body.plan ? specPlanSchema.parse(body.plan) : await decomposeSpec(rawSpec, body.repoFullName ?? "shipbrain-sandbox");
    const handoffOnly = /shipbrain-codegen:\s*handoff-only/i.test(rawSpec) || /shipbrain-codegen:\s*handoff-only/i.test(plan.prBody ?? "");
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
    const branch = typeof body.branchOverride === "string" && body.branchOverride.trim()
      ? body.branchOverride.trim()
      : sourceBranchFromRecipe || plan.suggestedBranch;
    const base = typeof body.baseBranchOverride === "string" && body.baseBranchOverride.trim()
      ? body.baseBranchOverride.trim()
      : baseBranchFromRecipe || "develop";
    const useExistingSourceBranch = body.useExistingSourceBranch || Boolean(sourceBranchFromRecipe);
    const promotionFooter = useExistingSourceBranch
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
      useExistingHead: useExistingSourceBranch
    });

    await createOrUpdateTrace({
      repoFullName: body.repoFullName ?? "shipbrain-sandbox",
      type: useExistingSourceBranch ? "release" : "feature",
      title: plan.prTitle,
      description: rawSpec,
      status: "draft",
      sourceBranch: branch,
      targetBranch: base,
      draftPrNumber: pr.number,
      draftPrUrl: pr.html_url,
      source: "manual",
      actor: "ShipBrain",
      eventType: "pr_opened",
      details: { createdFrom: "spec-to-pr", useExistingSourceBranch: Boolean(body.useExistingSourceBranch) }
    }).catch((traceError) => {
      console.error("release trace creation failed", traceError);
    });

    // Save to specs table for Recent AI PRs
    const repoFullName = body.repoFullName ?? `${owner}/${repo}`;
    if (user) {
      const { error: specError } = await supabase
        .from("specs")
        .insert({
          user_id: user.id,
          raw_spec: rawSpec,
          decomposed_tasks: plan,
          scaffold_code: scaffold,
          status: "draft_created",
          repo_full_name: repoFullName,
          branch_name: branch,
          base_branch: base,
          pr_number: pr.number,
          pr_url: pr.html_url,
          updated_at: new Date().toISOString()
        });

      if (specError) {
        console.error("spec save failed:", specError.message, specError.details);
      } else {
        console.log("spec saved successfully for PR #" + pr.number);
      }

      // Create notification
      const { error: notifyError } = await supabase
        .from("notifications")
        .insert({
          user_id: user.id,
          type: "pr_created",
          title: "Draft PR Created",
          body: `Created draft PR #${pr.number}: ${plan.prTitle}`,
          href: pr.html_url,
          severity: "info",
          repo_full_name: repoFullName,
          metadata: { prNumber: pr.number, branch, baseBranch: base }
        });

      if (notifyError) {
        console.error("notification creation failed:", notifyError.message);
      }
    } else {
      console.warn("No authenticated user found - spec will not be saved to Recent AI PRs");
    }

    return NextResponse.json({
      ...response,
      pr,
      warning: "reviewerWarning" in pr ? pr.reviewerWarning : undefined
    });
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

    const aiRetryError = getAiRetryError(error);
    if (aiRetryError) {
      return NextResponse.json(aiRetryError, { status: 429 });
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
