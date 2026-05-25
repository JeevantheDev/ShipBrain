import sodium from "libsodium-wrappers";
import { getOctokit } from "@/lib/github/client";

export type RepoScan = {
  repo: string;
  workflowsDirectory: boolean;
  workflows: Record<"ci" | "preview" | "production" | "notify" | "deploy" | "incidents", boolean>;
  branches: {
    develop: boolean;
    main: boolean;
    master: boolean;
    productionBranch: string | null;
    developmentBranch: string | null;
    scenario: "develop_main" | "main_only" | "master" | "custom_required";
  };
  project: {
    packageJson: boolean;
    vercelJson: boolean;
    node: boolean;
    vercel: boolean;
  };
};

type WorkflowInput = {
  devBranch?: string | null;
  prodBranch: string;
  includeVercel: boolean;
  includeIncidents: boolean;
  ciExists: boolean;
  deployExists: boolean;
  incidentsExists: boolean;
  packageJson: boolean;
};

function splitRepo(repoFullName: string) {
  const [owner, repo] = repoFullName.split("/");
  return { owner, repo };
}

async function exists<T>(fn: () => Promise<T>) {
  try {
    await fn();
    return true;
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
    if (status === 404) return false;
    throw error;
  }
}

export async function scanRepository(repoFullName: string, token?: string): Promise<RepoScan> {
  const octokit = getOctokit(token);
  const { owner, repo } = splitRepo(repoFullName);
  const [
    workflowsDirectory,
    ci,
    preview,
    production,
    notify,
    deploy,
    incidents,
    develop,
    main,
    master,
    packageJson,
    vercelJson
  ] = await Promise.all([
    exists(() => octokit.repos.getContent({ owner, repo, path: ".github/workflows" })),
    // New workflow files
    exists(() => octokit.repos.getContent({ owner, repo, path: ".github/workflows/shipbrain-ci.yml" })),
    exists(() => octokit.repos.getContent({ owner, repo, path: ".github/workflows/shipbrain-preview.yml" })),
    exists(() => octokit.repos.getContent({ owner, repo, path: ".github/workflows/shipbrain-production.yml" })),
    exists(() => octokit.repos.getContent({ owner, repo, path: ".github/workflows/shipbrain-notify.yml" })),
    // Legacy workflow files (for backwards compatibility)
    exists(() => octokit.repos.getContent({ owner, repo, path: ".github/workflows/shipbrain-deploy.yml" })),
    exists(() => octokit.repos.getContent({ owner, repo, path: ".github/workflows/shipbrain-incidents.yml" })),
    // Branches
    exists(() => octokit.git.getRef({ owner, repo, ref: "heads/develop" })),
    exists(() => octokit.git.getRef({ owner, repo, ref: "heads/main" })),
    exists(() => octokit.git.getRef({ owner, repo, ref: "heads/master" })),
    // Project files
    exists(() => octokit.repos.getContent({ owner, repo, path: "package.json" })),
    exists(() => octokit.repos.getContent({ owner, repo, path: "vercel.json" }))
  ]);

  const productionBranch = main ? "main" : master ? "master" : null;
  const developmentBranch = develop ? "develop" : null;
  const scenario = develop && productionBranch
    ? productionBranch === "master" ? "master" : "develop_main"
    : productionBranch
      ? productionBranch === "master" ? "master" : "main_only"
      : "custom_required";

  return {
    repo: repoFullName,
    workflowsDirectory,
    workflows: { ci, preview, production, notify, deploy, incidents },
    branches: {
      develop,
      main,
      master,
      productionBranch,
      developmentBranch,
      scenario
    },
    project: {
      packageJson,
      vercelJson,
      node: packageJson,
      vercel: vercelJson
    }
  };
}

export async function createDevelopBranchFromProduction(repoFullName: string, prodBranch: string, token?: string) {
  const octokit = getOctokit(token);
  const { owner, repo } = splitRepo(repoFullName);
  const { data: baseRef } = await octokit.git.getRef({ owner, repo, ref: `heads/${prodBranch}` });
  await octokit.git.createRef({
    owner,
    repo,
    ref: "refs/heads/develop",
    sha: baseRef.object.sha
  });
}

export async function putActionsSecret(repoFullName: string, name: string, value: string, token?: string) {
  const octokit = getOctokit(token);
  const { owner, repo } = splitRepo(repoFullName);
  const { data: key } = await octokit.actions.getRepoPublicKey({ owner, repo });
  await sodium.ready;
  const encrypted = sodium.crypto_box_seal(value, sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL));
  const encryptedValue = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
  await octokit.actions.createOrUpdateRepoSecret({
    owner,
    repo,
    secret_name: name,
    encrypted_value: encryptedValue,
    key_id: key.key_id
  });
}

export async function deleteActionsSecret(repoFullName: string, name: string, token?: string) {
  const octokit = getOctokit(token);
  const { owner, repo } = splitRepo(repoFullName);
  try {
    await octokit.actions.deleteRepoSecret({
      owner,
      repo,
      secret_name: name
    });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
    if (status !== 404) throw error;
  }
}

export async function branchExists(repoFullName: string, branch: string, token?: string) {
  if (!branch.trim() || /\s/.test(branch)) return false;
  const octokit = getOctokit(token);
  const { owner, repo } = splitRepo(repoFullName);
  return exists(() => octokit.git.getRef({ owner, repo, ref: `heads/${branch}` }));
}

function branchList(input: WorkflowInput) {
  return input.devBranch ? `[${input.devBranch}, ${input.prodBranch}]` : `[${input.prodBranch}]`;
}

export function workflowFiles(input: WorkflowInput) {
  const files: Record<string, string> = {};

  // Always include the minimal CI workflow (smoke test only)
  if (!input.ciExists) {
    files[".github/workflows/shipbrain-ci.yml"] = shipbrainCiWorkflowMinimal(input);
  }

  // Include preview workflow if Vercel is enabled and develop branch exists
  if (input.includeVercel && input.devBranch) {
    files[".github/workflows/shipbrain-preview.yml"] = shipbrainPreviewWorkflow(input);
  }

  // Include production workflow (handles both normal releases and hotfixes with reverse sync)
  if (input.includeVercel && !input.deployExists) {
    files[".github/workflows/shipbrain-production.yml"] = shipbrainProductionWorkflow(input);
  }

  // Unified notification workflow (combines CI notify + incident alerting)
  files[".github/workflows/shipbrain-notify.yml"] = shipbrainNotifyWorkflow(input);

  return files;
}

function installSteps(packageJson: boolean) {
  return packageJson
    ? `      - name: Install dependencies\n        run: npm ci\n\n      - name: Run tests\n        run: npm test --if-present\n`
    : `      - name: No package.json detected\n        run: echo "No Node package.json found; smoke check only."\n`;
}

// ============================================================================
// NEW SIMPLIFIED WORKFLOW ARCHITECTURE
// ============================================================================

/**
 * Minimal CI workflow - JUST smoke tests, no deployments
 * Clean and simple - tests only run on PR and push
 */
function shipbrainCiWorkflowMinimal(input: WorkflowInput) {
  const branches = branchList(input);
  return `name: ShipBrain CI

on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]
    branches: ${branches}
  push:
    branches: ${branches}
  workflow_dispatch:
    inputs:
      force_fail:
        description: Trigger a deliberate failure for testing
        required: false
        default: "false"
        type: choice
        options:
          - "false"
          - "true"

concurrency:
  group: shipbrain-ci-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  smoke:
    name: Smoke test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - name: Print context
        run: |
          echo "Branch : $GITHUB_REF_NAME"
          echo "SHA    : $GITHUB_SHA"
          echo "Event  : $GITHUB_EVENT_NAME"
          echo "PR     : \${{ github.event.pull_request.number || 'n/a' }}"
      - name: Force-fail escape hatch
        run: |
          if [ "\${{ github.event_name }}" = "workflow_dispatch" ] && [ "\${{ inputs.force_fail }}" = "true" ]; then
            echo "Force-fail requested for testing"
            exit 1
          fi
${installSteps(input.packageJson)}`;
}

/**
 * Preview deployment workflow - dedicated workflow for Vercel preview
 * Triggered via workflow_dispatch from ShipBrain
 */
function shipbrainPreviewWorkflow(input: WorkflowInput) {
  return `name: ShipBrain Preview Deploy

on:
  workflow_dispatch:
    inputs:
      source_pr_number:
        description: PR number to attach preview metadata to
        required: false
        type: string
      branch:
        description: Branch to deploy (defaults to develop)
        required: false
        default: "${input.devBranch || "develop"}"
        type: string

concurrency:
  group: shipbrain-preview
  cancel-in-progress: false

jobs:
  preview:
    name: Deploy to Vercel Preview
    runs-on: ubuntu-latest
    env:
      VERCEL_ORG_ID: \${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: \${{ secrets.VERCEL_PROJECT_ID }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.branch }}
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - name: Pull Vercel Preview environment
        run: npx vercel@latest pull --yes --environment=preview --token="\${{ secrets.VERCEL_TOKEN }}"
      - name: Build Preview artifact
        run: npx vercel@latest build --token="\${{ secrets.VERCEL_TOKEN }}"
      - name: Deploy to Preview
        id: deploy
        run: |
          OUTPUT=$(npx vercel@latest deploy --prebuilt --token="\${{ secrets.VERCEL_TOKEN }}" 2>&1)
          echo "Vercel output:"
          echo "$OUTPUT"
          DEPLOY_URL=$(echo "$OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\\.vercel\\.app' | tail -1)
          echo "Extracted URL: $DEPLOY_URL"
          echo "url=$DEPLOY_URL" >> $GITHUB_OUTPUT
      - name: Notify ShipBrain
        if: always()
        continue-on-error: true
        env:
          SHIPBRAIN_API_URL: \${{ secrets.SHIPBRAIN_API_URL }}
          SHIPBRAIN_API_KEY: \${{ secrets.SHIPBRAIN_API_KEY }}
        run: |
          if [ -z "$SHIPBRAIN_API_URL" ] || [ -z "$SHIPBRAIN_API_KEY" ]; then
            echo "ShipBrain secrets missing; notification skipped."
            exit 0
          fi
          curl --fail-with-body -sS -X POST "$SHIPBRAIN_API_URL/api/deployments/preview" \\
            -H "Authorization: Bearer $SHIPBRAIN_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"repo\\": \\"$GITHUB_REPOSITORY\\",
              \\"sha\\": \\"$GITHUB_SHA\\",
              \\"branch\\": \\"\${{ inputs.branch }}\\",
              \\"pr_number\\": \\"\${{ inputs.source_pr_number }}\\",
              \\"environment\\": \\"preview\\",
              \\"status\\": \\"\${{ job.status }}\\",
              \\"preview_url\\": \\"\${{ steps.deploy.outputs.url }}\\",
              \\"run_url\\": \\"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\\"
            }"
`;
}

/**
 * Production deployment workflow - handles normal releases AND hotfixes
 * Includes built-in reverse sync for hotfixes (main → develop)
 */
function shipbrainProductionWorkflow(input: WorkflowInput) {
  const devBranch = input.devBranch || "develop";
  return `name: ShipBrain Production Deploy

on:
  workflow_dispatch:
    inputs:
      release_tag:
        description: Release tag (e.g., release-v2024.01.15-1430)
        required: true
        type: string
      release_sha:
        description: Merge commit SHA for the release
        required: true
        type: string
      is_hotfix:
        description: Is this a hotfix deployment?
        required: false
        default: "false"
        type: choice
        options:
          - "false"
          - "true"
      reverse_sync:
        description: After hotfix, sync changes back to develop?
        required: false
        default: "true"
        type: choice
        options:
          - "true"
          - "false"

concurrency:
  group: shipbrain-production
  cancel-in-progress: false

jobs:
  deploy:
    name: Deploy to Production
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    env:
      SHIPBRAIN_RELEASE_TAG: \${{ inputs.release_tag }}
      SHIPBRAIN_RELEASE_SHA: \${{ inputs.release_sha }}
      VERCEL_ORG_ID: \${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: \${{ secrets.VERCEL_PROJECT_ID }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.release_tag }}
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Verify release SHA
        run: |
          ACTUAL=$(git rev-parse HEAD)
          EXPECTED="$SHIPBRAIN_RELEASE_SHA"
          if [ "$ACTUAL" != "$EXPECTED" ]; then
            echo "SHA mismatch - deploy blocked"
            echo "Expected : $EXPECTED"
            echo "Actual   : $ACTUAL"
            exit 1
          fi
          echo "SHA verified - deploying $SHIPBRAIN_RELEASE_TAG"
      - name: Pull Vercel Production environment
        run: npx vercel@latest pull --yes --environment=production --token="\${{ secrets.VERCEL_TOKEN }}"
      - name: Build Production artifact
        run: npx vercel@latest build --prod --token="\${{ secrets.VERCEL_TOKEN }}"
      - name: Deploy to Production
        run: |
          npx vercel@latest deploy --prebuilt --prod \\
            --token="\${{ secrets.VERCEL_TOKEN }}" \\
            --env SHIPBRAIN_RELEASE_TAG="$SHIPBRAIN_RELEASE_TAG"
      - name: Notify ShipBrain
        if: always()
        continue-on-error: true
        env:
          SHIPBRAIN_API_URL: \${{ secrets.SHIPBRAIN_API_URL }}
          SHIPBRAIN_API_KEY: \${{ secrets.SHIPBRAIN_API_KEY }}
        run: |
          if [ -z "$SHIPBRAIN_API_URL" ] || [ -z "$SHIPBRAIN_API_KEY" ]; then
            echo "ShipBrain secrets missing; notification skipped."
            exit 0
          fi
          curl --fail-with-body -sS -X POST "$SHIPBRAIN_API_URL/api/deployments/result" \\
            -H "Authorization: Bearer $SHIPBRAIN_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"repo\\": \\"$GITHUB_REPOSITORY\\",
              \\"tag\\": \\"$SHIPBRAIN_RELEASE_TAG\\",
              \\"sha\\": \\"$SHIPBRAIN_RELEASE_SHA\\",
              \\"status\\": \\"\${{ job.status }}\\",
              \\"is_hotfix\\": \\"\${{ inputs.is_hotfix }}\\",
              \\"run_url\\": \\"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\\"
            }"

  reverse-sync:
    name: Sync hotfix to develop
    runs-on: ubuntu-latest
    needs: deploy
    if: inputs.is_hotfix == 'true' && inputs.reverse_sync == 'true'
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${input.prodBranch}
          fetch-depth: 0
          token: \${{ secrets.GITHUB_TOKEN }}
      - name: Create reverse sync PR
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

          SYNC_BRANCH="shipbrain/reverse-sync-\${{ inputs.release_tag }}"

          # Create branch from main/master
          git checkout -b "$SYNC_BRANCH"

          # Push the branch
          git push origin "$SYNC_BRANCH"

          # Create PR to sync main → develop
          gh pr create \\
            --base "${devBranch}" \\
            --head "$SYNC_BRANCH" \\
            --title "chore: sync \${{ inputs.release_tag }} hotfix to ${devBranch}" \\
            --body "## Reverse Sync

          This PR syncs the hotfix **\${{ inputs.release_tag }}** from \`${input.prodBranch}\` back to \`${devBranch}\`.

          **Why?** After a hotfix is deployed to production, the fix needs to be merged back to ${devBranch} to prevent regression.

          ---
          _Created automatically by ShipBrain_"

          echo "Reverse sync PR created successfully"
      - name: Notify ShipBrain of reverse sync
        continue-on-error: true
        env:
          SHIPBRAIN_API_URL: \${{ secrets.SHIPBRAIN_API_URL }}
          SHIPBRAIN_API_KEY: \${{ secrets.SHIPBRAIN_API_KEY }}
        run: |
          if [ -z "$SHIPBRAIN_API_URL" ] || [ -z "$SHIPBRAIN_API_KEY" ]; then
            exit 0
          fi
          curl --fail-with-body -sS -X POST "$SHIPBRAIN_API_URL/api/deployments/reverse-sync" \\
            -H "Authorization: Bearer $SHIPBRAIN_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"repo\\": \\"$GITHUB_REPOSITORY\\",
              \\"release_tag\\": \\"\${{ inputs.release_tag }}\\",
              \\"sync_branch\\": \\"shipbrain/reverse-sync-\${{ inputs.release_tag }}\\",
              \\"status\\": \\"\${{ job.status }}\\"
            }"
`;
}

/**
 * Unified notification workflow - handles both CI notifications and incident alerting
 * Watches ShipBrain workflows only (not all workflows)
 */
function shipbrainNotifyWorkflow(input: WorkflowInput) {
  return `name: ShipBrain Notify

on:
  workflow_run:
    workflows: ["ShipBrain CI", "ShipBrain Preview Deploy", "ShipBrain Production Deploy"]
    types: [completed]

jobs:
  notify:
    name: Notify ShipBrain
    runs-on: ubuntu-latest
    steps:
      - name: Send notification to ShipBrain
        continue-on-error: true
        env:
          SHIPBRAIN_API_URL: \${{ secrets.SHIPBRAIN_API_URL }}
          SHIPBRAIN_API_KEY: \${{ secrets.SHIPBRAIN_API_KEY }}
        run: |
          if [ -z "$SHIPBRAIN_API_URL" ] || [ -z "$SHIPBRAIN_API_KEY" ]; then
            echo "ShipBrain secrets missing; notification skipped."
            exit 0
          fi
          curl --fail-with-body -sS -X POST "$SHIPBRAIN_API_URL/api/ci/webhook" \\
            -H "Authorization: Bearer $SHIPBRAIN_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"repo\\": \\"$GITHUB_REPOSITORY\\",
              \\"sha\\": \\"\${{ github.event.workflow_run.head_sha }}\\",
              \\"branch\\": \\"\${{ github.event.workflow_run.head_branch }}\\",
              \\"run_id\\": \\"\${{ github.event.workflow_run.id }}\\",
              \\"status\\": \\"\${{ github.event.workflow_run.conclusion }}\\",
              \\"workflow_name\\": \\"\${{ github.event.workflow_run.name }}\\",
              \\"run_url\\": \\"\${{ github.event.workflow_run.html_url }}\\"
            }"

  alert:
    name: PagerDuty Alert (on failure)
    runs-on: ubuntu-latest
    if: github.event.workflow_run.conclusion == 'failure'
    steps:
      - name: Send PagerDuty alert
        run: |
          if [ -z "\${{ secrets.PAGERDUTY_ROUTING_KEY }}" ]; then
            echo "PagerDuty routing key not configured; alert skipped."
            exit 0
          fi
          curl -s -X POST https://events.pagerduty.com/v2/enqueue \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"routing_key\\": \\"\${{ secrets.PAGERDUTY_ROUTING_KEY }}\\",
              \\"event_action\\": \\"trigger\\",
              \\"dedup_key\\": \\"\${{ github.event.workflow_run.id }}\\",
              \\"payload\\": {
                \\"summary\\": \\"[\${{ github.repository }}] \${{ github.event.workflow_run.name }} failed\\",
                \\"severity\\": \\"error\\",
                \\"source\\": \\"\${{ github.repository }}\\",
                \\"custom_details\\": {
                  \\"repo\\": \\"\${{ github.repository }}\\",
                  \\"commit_sha\\": \\"\${{ github.event.workflow_run.head_sha }}\\",
                  \\"branch\\": \\"\${{ github.event.workflow_run.head_branch }}\\",
                  \\"run_url\\": \\"\${{ github.event.workflow_run.html_url }}\\",
                  \\"actor\\": \\"\${{ github.event.workflow_run.triggering_actor.login }}\\"
                }
              }
            }"

  resolve:
    name: PagerDuty Resolve (on success)
    runs-on: ubuntu-latest
    if: github.event.workflow_run.conclusion == 'success'
    steps:
      - name: Resolve PagerDuty incident
        run: |
          if [ -z "\${{ secrets.PAGERDUTY_ROUTING_KEY }}" ]; then
            exit 0
          fi
          curl -s -X POST https://events.pagerduty.com/v2/enqueue \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"routing_key\\": \\"\${{ secrets.PAGERDUTY_ROUTING_KEY }}\\",
              \\"event_action\\": \\"resolve\\",
              \\"dedup_key\\": \\"\${{ github.event.workflow_run.id }}\\"
            }"
`;
}

function shipbrainCiWorkflow(input: WorkflowInput) {
  const branches = branchList(input);
  const previewJob = input.includeVercel && input.devBranch ? `
  preview:
    name: Vercel preview deploy
    runs-on: ubuntu-latest
    needs: smoke
    if: >
      needs.smoke.outputs.passed == 'true' &&
      (
        (github.event_name == 'pull_request' && github.base_ref == '${input.devBranch}') ||
        (github.event_name == 'push' && github.ref == 'refs/heads/${input.devBranch}') ||
        (github.event_name == 'workflow_dispatch' && inputs.deploy_preview == 'true')
      )
    env:
      VERCEL_ORG_ID: \${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: \${{ secrets.VERCEL_PROJECT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - name: Pull Vercel Preview environment settings
        run: npx vercel@latest pull --yes --environment=preview --token="\${{ secrets.VERCEL_TOKEN }}"
      - name: Build Vercel Preview artifact
        run: npx vercel@latest build --token="\${{ secrets.VERCEL_TOKEN }}"
      - name: Deploy to Vercel Preview
        id: deploy
        run: |
          OUTPUT=$(npx vercel@latest deploy --prebuilt --token="\${{ secrets.VERCEL_TOKEN }}" 2>&1)
          echo "Vercel output:"
          echo "$OUTPUT"
          DEPLOY_URL=$(echo "$OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\\.vercel\\.app' | tail -1)
          echo "Extracted URL: $DEPLOY_URL"
          echo "url=$DEPLOY_URL" >> $GITHUB_OUTPUT
          BRANCH_ALIAS=$(npx vercel@latest alias --token="\${{ secrets.VERCEL_TOKEN }}" ls 2>/dev/null | grep ${input.devBranch} | head -1 | awk '{print $1}' || echo "")
          echo "branch_alias=$BRANCH_ALIAS" >> $GITHUB_OUTPUT
      - name: Comment preview URL on PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const url = "\${{ steps.deploy.outputs.url }}";
            const sha = context.sha.slice(0, 7);
            const branch = "\${{ github.head_ref }}";
            const body = [
              "### Vercel Preview - dev environment",
              "",
              \`**Preview URL:** \${url}\`,
              \`**Branch:** \\\`\${branch}\\\`\`,
              \`**SHA:** \\\`\${sha}\\\`\`,
              "",
              "> This preview uses Vercel **Preview** environment variables.",
              "> Production variables are not used here.",
              "",
              "_Deployed by ShipBrain_"
            ].join("\\n");
            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
            });
            const existing = comments.find(c => c.user.login === 'github-actions[bot]' && c.body.includes('Vercel Preview - dev environment'));
            if (existing) {
              await github.rest.issues.updateComment({ owner: context.repo.owner, repo: context.repo.repo, comment_id: existing.id, body });
            } else {
              await github.rest.issues.createComment({ owner: context.repo.owner, repo: context.repo.repo, issue_number: context.issue.number, body });
            }
      - name: Notify ShipBrain - preview deployed
        continue-on-error: true
        env:
          SHIPBRAIN_API_URL: \${{ secrets.SHIPBRAIN_API_URL }}
          SHIPBRAIN_API_KEY: \${{ secrets.SHIPBRAIN_API_KEY }}
        run: |
          if [ -z "$SHIPBRAIN_API_URL" ] || [ -z "$SHIPBRAIN_API_KEY" ]; then
            echo "ShipBrain callback secrets are missing; preview notification skipped."
            exit 0
          fi
          curl --fail-with-body -sS -X POST "$SHIPBRAIN_API_URL/api/deployments/preview" \\
            -H "Authorization: Bearer $SHIPBRAIN_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"repo\\": \\"$GITHUB_REPOSITORY\\",
              \\"sha\\": \\"$GITHUB_SHA\\",
              \\"branch\\": \\"$GITHUB_REF_NAME\\",
              \\"event_type\\": \\"\${{ github.event_name }}\\",
              \\"pr_number\\": \\"\${{ github.event.pull_request.number || inputs.source_pr_number }}\\",
              \\"environment\\": \\"preview\\",
              \\"preview_url\\": \\"\${{ steps.deploy.outputs.url }}\\",
              \\"branch_alias\\": \\"\${{ steps.deploy.outputs.branch_alias }}\\"
            }"
` : "";

  return `name: ShipBrain CI

on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize]
    branches: ${branches}
  push:
    branches: ${branches}
  workflow_dispatch:
    inputs:
      force_fail:
        description: Trigger a deliberate ShipBrain CI failure for E2E testing
        required: false
        default: "false"
        type: choice
        options:
          - "false"
          - "true"
      deploy_preview:
        description: Deploy the current ref to the Vercel Preview environment
        required: false
        default: "false"
        type: choice
        options:
          - "false"
          - "true"
      source_pr_number:
        description: ShipBrain source PR number to attach preview metadata to
        required: false
        default: ""

concurrency:
  group: shipbrain-ci-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  smoke:
    name: Smoke test
    runs-on: ubuntu-latest
    outputs:
      passed: \${{ steps.result.outputs.passed }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - name: Print context
        run: |
          echo "Branch : $GITHUB_REF_NAME"
          echo "SHA    : $GITHUB_SHA"
          echo "Event  : $GITHUB_EVENT_NAME"
          echo "PR     : \${{ github.event.pull_request.number || 'n/a' }}"
      - name: Force-fail escape hatch
        run: |
          if [ "\${{ github.event_name }}" = "workflow_dispatch" ] && [ "\${{ inputs.force_fail }}" = "true" ]; then
            echo "Manual ShipBrain force-fail requested for E2E testing"
            exit 1
          fi
          if [ "\${SHIPBRAIN_FORCE_FAIL:-false}" = "true" ]; then
            echo "SHIPBRAIN_FORCE_FAIL=true - failing for ShipBrain CI test"
            exit 1
          fi
${installSteps(input.packageJson)}
      - name: Set result output
        id: result
        if: always()
        run: echo "passed=\${{ job.status == 'success' }}" >> $GITHUB_OUTPUT
      - name: Notify ShipBrain - CI result
        if: always()
        continue-on-error: true
        env:
          SHIPBRAIN_API_URL: \${{ secrets.SHIPBRAIN_API_URL }}
          SHIPBRAIN_API_KEY: \${{ secrets.SHIPBRAIN_API_KEY }}
        run: |
          if [ -z "$SHIPBRAIN_API_URL" ] || [ -z "$SHIPBRAIN_API_KEY" ]; then
            echo "ShipBrain callback secrets are missing; CI notification skipped."
            exit 0
          fi
          curl --fail-with-body -sS -X POST "$SHIPBRAIN_API_URL/api/ci/webhook" \\
            -H "Authorization: Bearer $SHIPBRAIN_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"repo\\": \\"$GITHUB_REPOSITORY\\",
              \\"sha\\": \\"$GITHUB_SHA\\",
              \\"branch\\": \\"$GITHUB_REF_NAME\\",
              \\"pr_number\\": \\"\${{ github.event.pull_request.number }}\\",
              \\"run_id\\": \\"$GITHUB_RUN_ID\\",
              \\"status\\": \\"\${{ job.status }}\\",
              \\"environment\\": \\"dev\\",
              \\"run_url\\": \\"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\\"
            }"
${previewJob}`;
}

function shipbrainDeployWorkflow() {
  return `name: ShipBrain Vercel Production Deploy

on:
  workflow_dispatch:
    inputs:
      release_tag:
        description: Release tag approved in ShipBrain
        required: true
        type: string
      release_sha:
        description: Merge commit SHA for the approved release
        required: true
        type: string

concurrency:
  group: shipbrain-vercel-prod
  cancel-in-progress: false

jobs:
  deploy-production:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      deployments: write
    env:
      SHIPBRAIN_RELEASE_TAG: \${{ inputs.release_tag }}
      SHIPBRAIN_RELEASE_SHA: \${{ inputs.release_sha }}
      VERCEL_ORG_ID: \${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: \${{ secrets.VERCEL_PROJECT_ID }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.release_tag }}
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Verify release SHA
        run: |
          ACTUAL=$(git rev-parse HEAD)
          EXPECTED="$SHIPBRAIN_RELEASE_SHA"
          if [ "$ACTUAL" != "$EXPECTED" ]; then
            echo "SHA mismatch - deploy blocked"
            echo "Expected : $EXPECTED"
            echo "Actual   : $ACTUAL"
            exit 1
          fi
          echo "SHA verified - deploying $SHIPBRAIN_RELEASE_TAG at $SHIPBRAIN_RELEASE_SHA"
      - name: Stamp ShipBrain release version
        run: |
          node - <<'NODE'
          const fs = require('fs');
          const tag = process.env.SHIPBRAIN_RELEASE_TAG;
          const files = ['index.html', 'api/release.js', 'api/trigger-incident.js', 'server.mjs'];
          const pattern = /cart-v[\\d.]+[-\\w.]*|hotfix-v[\\d.]+[-\\w.]*|shipbrain-v[\\d.]+[-\\w.]*|cart-local-dev/g;
          for (const file of files) {
            if (!fs.existsSync(file)) continue;
            const src = fs.readFileSync(file, 'utf8');
            const out = src.replace(pattern, tag);
            if (out !== src) fs.writeFileSync(file, out);
          }
          NODE
      - name: Pull Vercel project settings
        run: npx vercel@latest pull --yes --environment=production --token="\${{ secrets.VERCEL_TOKEN }}"
      - name: Build Vercel artifact
        run: npx vercel@latest build --prod --token="\${{ secrets.VERCEL_TOKEN }}"
      - name: Deploy to Vercel production
        run: |
          npx vercel@latest deploy --prebuilt --prod \\
            --token="\${{ secrets.VERCEL_TOKEN }}" \\
            --env SHIPBRAIN_RELEASE_TAG="$SHIPBRAIN_RELEASE_TAG" \\
            --env PAGERDUTY_ROUTING_KEY="\${{ secrets.PAGERDUTY_ROUTING_KEY }}"
      - name: Notify ShipBrain - deploy result
        if: always()
        continue-on-error: true
        env:
          SHIPBRAIN_API_URL: \${{ secrets.SHIPBRAIN_API_URL }}
          SHIPBRAIN_API_KEY: \${{ secrets.SHIPBRAIN_API_KEY }}
        run: |
          if [ -z "$SHIPBRAIN_API_URL" ] || [ -z "$SHIPBRAIN_API_KEY" ]; then
            echo "ShipBrain callback secrets are missing; deployment notification skipped."
            exit 0
          fi
          curl --fail-with-body -sS -X POST "$SHIPBRAIN_API_URL/api/deployments/result" \\
            -H "Authorization: Bearer $SHIPBRAIN_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"repo\\": \\"$GITHUB_REPOSITORY\\",
              \\"tag\\": \\"$SHIPBRAIN_RELEASE_TAG\\",
              \\"sha\\": \\"$SHIPBRAIN_RELEASE_SHA\\",
              \\"status\\": \\"\${{ job.status }}\\",
              \\"run_url\\": \\"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\\"
            }"
`;
}

function shipbrainIncidentsWorkflow() {
  return `name: ShipBrain incident alerting

on:
  workflow_run:
    workflows: ["ShipBrain CI", "ShipBrain Vercel Production Deploy"]
    types: [completed]
  workflow_dispatch:

jobs:
  alert:
    runs-on: ubuntu-latest
    if: >
      (github.event.workflow_run.conclusion == 'failure' &&
       github.event.workflow_run.name != 'ShipBrain incident alerting') ||
      github.event_name == 'workflow_dispatch'
    steps:
      - name: Send PagerDuty alert
        run: |
          curl -s -X POST https://events.pagerduty.com/v2/enqueue \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"routing_key\\": \\"\${{ secrets.PAGERDUTY_ROUTING_KEY }}\\",
              \\"event_action\\": \\"trigger\\",
              \\"dedup_key\\": \\"\${{ github.event.workflow_run.id || github.run_id }}\\",
              \\"payload\\": {
                \\"summary\\": \\"[\${{ github.repository }}] \${{ github.event.workflow_run.name || github.workflow }} failed\\",
                \\"severity\\": \\"error\\",
                \\"source\\": \\"\${{ github.repository }}\\",
                \\"custom_details\\": {
                  \\"repo\\": \\"\${{ github.repository }}\\",
                  \\"commit_sha\\": \\"\${{ github.event.workflow_run.head_sha || github.sha }}\\",
                  \\"branch\\": \\"\${{ github.event.workflow_run.head_branch || github.ref_name }}\\",
                  \\"run_url\\": \\"\${{ github.event.workflow_run.html_url || github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}\\",
                  \\"actor\\": \\"\${{ github.event.workflow_run.triggering_actor.login || github.actor }}\\"
                }
              }
            }"
  resolve:
    runs-on: ubuntu-latest
    if: github.event.workflow_run.conclusion == 'success'
    steps:
      - name: Resolve PagerDuty incident
        run: |
          curl -s -X POST https://events.pagerduty.com/v2/enqueue \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"routing_key\\": \\"\${{ secrets.PAGERDUTY_ROUTING_KEY }}\\",
              \\"event_action\\": \\"resolve\\",
              \\"dedup_key\\": \\"\${{ github.event.workflow_run.id }}\\"
            }"
`;
}

function shipbrainCiNotifyWorkflow() {
  return `name: ShipBrain CI notify

on:
  workflow_run:
    workflows: ["*"]
    types: [completed]

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - name: Notify ShipBrain
        continue-on-error: true
        env:
          SHIPBRAIN_API_URL: \${{ secrets.SHIPBRAIN_API_URL }}
          SHIPBRAIN_API_KEY: \${{ secrets.SHIPBRAIN_API_KEY }}
        run: |
          if [ -z "$SHIPBRAIN_API_URL" ] || [ -z "$SHIPBRAIN_API_KEY" ]; then
            echo "ShipBrain callback secrets are missing; CI notification skipped."
            exit 0
          fi
          curl --fail-with-body -sS -X POST "$SHIPBRAIN_API_URL/api/ci/webhook" \\
            -H "Authorization: Bearer $SHIPBRAIN_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"repo\\": \\"$GITHUB_REPOSITORY\\",
              \\"sha\\": \\"\${{ github.event.workflow_run.head_sha }}\\",
              \\"branch\\": \\"\${{ github.event.workflow_run.head_branch }}\\",
              \\"run_id\\": \\"\${{ github.event.workflow_run.id }}\\",
              \\"status\\": \\"\${{ github.event.workflow_run.conclusion }}\\",
              \\"workflow_name\\": \\"\${{ github.event.workflow_run.name }}\\",
              \\"run_url\\": \\"\${{ github.event.workflow_run.html_url }}\\"
            }"
`;
}

export async function openSetupPullRequest(input: {
  repoFullName: string;
  base: string;
  files: Record<string, string>;
  token?: string;
}) {
  const octokit = getOctokit(input.token);
  const { owner, repo } = splitRepo(input.repoFullName);
  const branch = `shipbrain/setup-${Date.now().toString(36)}`;
  const { data: baseRef } = await octokit.git.getRef({ owner, repo, ref: `heads/${input.base}` });
  await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseRef.object.sha });

  for (const [path, content] of Object.entries(input.files)) {
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      branch,
      message: `chore: add ${path}`,
      content: Buffer.from(content).toString("base64")
    });
  }

  const fileList = Object.keys(input.files).map((file) => `- \`${file}\``).join("\n");
  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title: "chore: add ShipBrain CI, deploy gate, and incident alerting",
    head: branch,
    base: input.base,
    draft: false,
    body: `## ShipBrain setup

This PR adds or complements ShipBrain automation:

${fileList || "- No workflow files were missing."}

Review and merge to activate the pipelines. ShipBrain never overwrites existing workflow files.`
  });

  return { branch, number: pr.number, html_url: pr.html_url };
}
