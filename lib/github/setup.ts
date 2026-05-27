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
    wranglerToml: boolean;
    node: boolean;
  };
};

type WorkflowInput = {
  devBranch?: string | null;
  prodBranch: string;
  includeCloudflare: boolean;
  includeIncidents: boolean;
  ciExists: boolean;
  deployExists: boolean;
  incidentsExists: boolean;
  packageJson: boolean;
  buildOutputDir: string;
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
    wranglerToml
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
    exists(() => octokit.repos.getContent({ owner, repo, path: "wrangler.toml" }))
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
      wranglerToml,
      node: packageJson
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

  // Include preview workflow if Cloudflare is enabled and develop branch exists
  if (input.includeCloudflare && input.devBranch) {
    files[".github/workflows/shipbrain-preview.yml"] = shipbrainPreviewWorkflow(input);
  }

  // Include production workflow (handles both normal releases and hotfixes with reverse sync)
  if (input.includeCloudflare && !input.deployExists) {
    files[".github/workflows/shipbrain-production.yml"] = shipbrainProductionWorkflow(input);
  }

  // Unified notification workflow (combines CI notify + incident alerting)
  files[".github/workflows/shipbrain-notify.yml"] = shipbrainNotifyWorkflow(input);

  return files;
}

function installSteps(packageJson: boolean) {
  return packageJson
    ? `      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test --if-present
`
    : `      - name: No package.json detected
        run: echo "No Node package.json found; smoke check only."
`;
}

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
 * Preview deployment workflow - dedicated workflow for Cloudflare Pages preview
 * Triggered via workflow_dispatch from ShipBrain or on push to develop
 * Build logs stream in real-time, env vars are injected from Cloudflare project settings
 */
function shipbrainPreviewWorkflow(input: WorkflowInput) {
  const outputDir = input.buildOutputDir || "dist";
  return `name: ShipBrain Preview Deploy

on:
  push:
    branches:
      - ${input.devBranch || "develop"}
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
    name: Deploy to Cloudflare Pages Preview
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.branch || github.ref }}

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: |
          echo "::group::Installing dependencies"
          npm ci
          echo "::endgroup::"

      - name: Build application
        run: |
          echo "::group::Running build"
          npm run build
          echo "::endgroup::"
          echo "Build completed successfully"

      - name: Install Wrangler
        run: npm install -g wrangler

      - name: Deploy to Cloudflare Pages
        id: deploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          echo "::group::Deploying to Cloudflare Pages"
          DEPLOY_OUTPUT=$(mktemp)
          wrangler pages deploy ${outputDir} \\
            --project-name="\${{ secrets.CF_PROJECT_NAME }}" \\
            --branch="\${{ inputs.branch || '${input.devBranch || "develop"}' }}" \\
            --commit-hash="$GITHUB_SHA" | tee "$DEPLOY_OUTPUT"
          echo "::endgroup::"

          # Extract deployment URL from output
          DEPLOY_URL=$(grep -oE 'https://[a-zA-Z0-9._-]+\\.pages\\.dev' "$DEPLOY_OUTPUT" | tail -1)
          echo "url=$DEPLOY_URL" >> $GITHUB_OUTPUT
          echo ""
          echo "=========================================="
          echo "Preview deployed: $DEPLOY_URL"
          echo "=========================================="

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
              \\"branch\\": \\"\${{ inputs.branch || '${input.devBranch || "develop"}' }}\\",
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
 * Build logs stream in real-time, env vars are injected from Cloudflare project settings
 */
function shipbrainProductionWorkflow(input: WorkflowInput) {
  const devBranch = input.devBranch || "develop";
  const outputDir = input.buildOutputDir || "dist";
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
      CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ inputs.release_tag }}
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Verify release SHA
        run: |
          echo "::group::Verifying release SHA"
          ACTUAL=$(git rev-parse HEAD)
          EXPECTED="$SHIPBRAIN_RELEASE_SHA"
          if [ "$ACTUAL" != "$EXPECTED" ]; then
            echo "::error::SHA mismatch - deploy blocked"
            echo "Expected : $EXPECTED"
            echo "Actual   : $ACTUAL"
            exit 1
          fi
          echo "SHA verified: $SHIPBRAIN_RELEASE_SHA"
          echo "::endgroup::"
          echo ""
          echo "=========================================="
          echo "Deploying release: $SHIPBRAIN_RELEASE_TAG"
          echo "=========================================="

      - name: Install dependencies
        run: |
          echo "::group::Installing dependencies"
          npm ci
          echo "::endgroup::"

      - name: Build application
        run: |
          echo "::group::Running production build"
          npm run build
          echo "::endgroup::"
          echo "Build completed successfully"

      - name: Install Wrangler
        run: npm install -g wrangler

      - name: Deploy to Cloudflare Pages Production
        id: deploy
        run: |
          echo "::group::Deploying to Cloudflare Pages Production"
          DEPLOY_OUTPUT=$(mktemp)
          wrangler pages deploy ${outputDir} \\
            --project-name="\${{ secrets.CF_PROJECT_NAME }}" \\
            --branch="main" \\
            --commit-hash="$SHIPBRAIN_RELEASE_SHA" | tee "$DEPLOY_OUTPUT"
          echo "::endgroup::"

          # Extract deployment URL from output
          DEPLOY_URL=$(grep -oE 'https://[a-zA-Z0-9._-]+\\.pages\\.dev' "$DEPLOY_OUTPUT" | tail -1)
          echo "url=$DEPLOY_URL" >> $GITHUB_OUTPUT
          echo ""
          echo "=========================================="
          echo "Production deployed: $DEPLOY_URL"
          echo "Tag: $SHIPBRAIN_RELEASE_TAG"
          echo "=========================================="

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
              \\"deploy_url\\": \\"\${{ steps.deploy.outputs.url }}\\",
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
 * Uses ShipBrain's built-in incident management (no PagerDuty required)
 */
function shipbrainNotifyWorkflow(input: WorkflowInput) {
  const incidentJobs = input.includeIncidents ? `
  incident:
    name: ShipBrain Incident Alert (on failure)
    runs-on: ubuntu-latest
    if: github.event.workflow_run.conclusion == 'failure'
    steps:
      - name: Create ShipBrain incident
        env:
          SHIPBRAIN_API_URL: \${{ secrets.SHIPBRAIN_API_URL }}
          SHIPBRAIN_API_KEY: \${{ secrets.SHIPBRAIN_API_KEY }}
        run: |
          if [ -z "$SHIPBRAIN_API_URL" ] || [ -z "$SHIPBRAIN_API_KEY" ]; then
            echo "ShipBrain secrets missing; incident creation skipped."
            exit 0
          fi
          # Use workflow name + branch as incidentId so auto-resolve can match it
          WORKFLOW_KEY=$(echo "\${{ github.event.workflow_run.name }}-\${{ github.event.workflow_run.head_branch }}" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')
          curl --fail-with-body -sS -X POST "$SHIPBRAIN_API_URL/api/webhooks/incidents" \\
            -H "Authorization: Bearer $SHIPBRAIN_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"source\\": \\"github-workflow\\",
              \\"repo\\": \\"$GITHUB_REPOSITORY\\",
              \\"title\\": \\"[\${{ github.repository }}] \${{ github.event.workflow_run.name }} failed\\",
              \\"severity\\": \\"high\\",
              \\"service\\": \\"\${{ github.event.workflow_run.name }}\\",
              \\"environment\\": \\"production\\",
              \\"logs\\": \\"Workflow: \${{ github.event.workflow_run.name }}\\\\nBranch: \${{ github.event.workflow_run.head_branch }}\\\\nCommit: \${{ github.event.workflow_run.head_sha }}\\\\nRun URL: \${{ github.event.workflow_run.html_url }}\\\\nActor: \${{ github.event.workflow_run.triggering_actor.login }}\\",
              \\"branch\\": \\"\${{ github.event.workflow_run.head_branch }}\\",
              \\"commit\\": \\"\${{ github.event.workflow_run.head_sha }}\\",
              \\"incidentId\\": \\"github-workflow-$WORKFLOW_KEY\\"
            }"

  auto-resolve:
    name: Auto-resolve on success
    runs-on: ubuntu-latest
    if: github.event.workflow_run.conclusion == 'success'
    steps:
      - name: Notify ShipBrain of success (for auto-resolve)
        env:
          SHIPBRAIN_API_URL: \${{ secrets.SHIPBRAIN_API_URL }}
          SHIPBRAIN_API_KEY: \${{ secrets.SHIPBRAIN_API_KEY }}
        run: |
          if [ -z "$SHIPBRAIN_API_URL" ] || [ -z "$SHIPBRAIN_API_KEY" ]; then
            exit 0
          fi
          # Use same workflow name + branch pattern to match incident
          WORKFLOW_KEY=$(echo "\${{ github.event.workflow_run.name }}-\${{ github.event.workflow_run.head_branch }}" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')
          curl --fail-with-body -sS -X POST "$SHIPBRAIN_API_URL/api/webhooks/incidents/resolve" \\
            -H "Authorization: Bearer $SHIPBRAIN_API_KEY" \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"repo\\": \\"$GITHUB_REPOSITORY\\",
              \\"incidentId\\": \\"github-workflow-$WORKFLOW_KEY\\",
              \\"resolution\\": \\"Workflow succeeded on retry\\"
            }"
` : "";

  return `name: ShipBrain Notify

on:
  workflow_run:
    workflows: ["ShipBrain CI", "ShipBrain Preview Deploy", "ShipBrain Production Deploy"]
    types: [completed]
    branches: [develop, main]

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
${incidentJobs}`;
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
    let sha: string | undefined;
    try {
      const { data } = (await octokit.repos.getContent({
        owner,
        repo,
        path,
        ref: branch
      })) as any;
      if (data && !Array.isArray(data) && data.sha) {
        sha = data.sha;
      }
    } catch (error: any) {
      if (error.status !== 404) {
        throw error;
      }
    }

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      branch,
      message: `chore: add ${path}`,
      content: Buffer.from(content).toString("base64"),
      ...(sha ? { sha } : {})
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
