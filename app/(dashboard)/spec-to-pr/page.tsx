"use client";

import { Copy, ExternalLink, FileText, GitPullRequest, Play, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ApprovalGate } from "@/components/approval-gate/ApprovalGate";
import { CloseDraftPrModal } from "@/components/pr-sync/CloseDraftPrModal";
import { SpecEditor } from "@/components/spec-editor/SpecEditor";

type SpecResult = {
  tasks: Array<{ title: string; description: string; files: string[]; estimatedLines?: number }>;
  prTitle: string;
  prBody: string;
  suggestedBranch: string;
  suggestedReviewers: string[];
  scaffold: Record<string, string>;
  pr?: { number: number; html_url: string; draft: boolean };
};

type ApiError = {
  error?: string;
  detail?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
};

type FlowStage = "idle" | "sample" | "planning" | "review" | "creating_pr" | "ready" | "failed" | "cancelled";
type BranchCheck = "idle" | "checking" | "available" | "exists" | "error";
type BaseBranchCheck = "idle" | "checking" | "exists" | "missing" | "error";
type RecentPrStatus = "pending_pr" | "draft_created" | "failed" | "rejected" | "closed" | "merged";
type RecentPrRun = {
  id: string;
  repo: string;
  spec: string;
  branchName: string;
  baseBranch: string;
  result: SpecResult;
  status: RecentPrStatus;
  ciStatus?: string;
  ciConclusion?: string | null;
  latestCiRunId?: string;
  featureHeadSha?: string;
  featureLastSyncedAt?: string;
  mergeableState?: string;
  hasMergeConflicts?: boolean;
  deploymentStatus?: string;
  deploymentApprovedAt?: string;
  updatedAt: string;
  error?: string;
};

const recentPrStorageKey = "shipbrain:recent-pr-runs";
const selectedPrStorageKey = "shipbrain:selected-pr-run";

const flowCopy: Record<FlowStage, { percent: number; label: string; note: string; estimate: string }> = {
  idle: {
    percent: 0,
    label: "Waiting for a ticket",
    note: "Paste a ticket or load the sample ticket to begin.",
    estimate: "Not started"
  },
  sample: {
    percent: 8,
    label: "Sample ticket loaded",
    note: "Review or edit the sample, then generate the AI plan.",
    estimate: "Next step: 20-45 sec"
  },
  planning: {
    percent: 35,
    label: "Gemini is decomposing the ticket",
    note: "Do not close this browser tab. ShipBrain is creating the developer handoff plan.",
    estimate: "Usually 20-45 sec"
  },
  review: {
    percent: 65,
    label: "AI plan ready for approval",
    note: "Review the generated tasks before allowing ShipBrain to touch GitHub.",
    estimate: "Waiting for your approval"
  },
  creating_pr: {
    percent: 85,
    label: "Creating GitHub Draft PR",
    note: "Do not close this browser tab. ShipBrain is creating the feature branch, committing the handoff note, and opening a Draft PR.",
    estimate: "Usually 20-60 sec"
  },
  ready: {
    percent: 100,
    label: "Draft PR created",
    note: "Open the PR link, let the development review happen, then merge into develop when ready.",
    estimate: "Complete"
  },
  failed: {
    percent: 70,
    label: "Workflow paused",
    note: "The AI plan is preserved. Fix the issue, then retry Draft PR creation.",
    estimate: "Waiting for action"
  },
  cancelled: {
    percent: 60,
    label: "Approval cancelled",
    note: "The AI plan is preserved. You can retry Draft PR creation when ready.",
    estimate: "Waiting for action"
  }
};

const sampleTicket = `# Ticket: Update Cartlane checkout heading color

Context:
The sandbox repo represents Cartlane, a mock ecommerce checkout application used for the ShipBrain E2E demo. We need a very small visual change so the full flow can be tested safely: ShipBrain creates the feature branch and Draft PR into develop, the developer can continue work on that same feature branch, GitHub preserves PR history, the developer merges into develop after review, CI/dev validation runs, CI Monitor gates production approval, ShipBrain creates a release tag, Vercel deploys production, and incident investigation can still use the release context if checkout latency spikes after release.

Change the main checkout heading color in the sandbox app. ShipBrain should only create the feature branch, Draft PR, and developer handoff note. The actual index.html color change will be committed manually by the developer on the same feature branch after the PR is created.

Requirements:
- Create a Draft PR that clearly tells the developer to update the primary checkout heading color in index.html
- Do not change index.html automatically from ShipBrain
- Keep the existing layout, checkout modal, release refresh icon, and incident alert flow unchanged
- Use a clear, readable color that still fits the Cartlane checkout design
- Keep the implementation lightweight and dependency-free

Acceptance criteria:
- Draft PR targets the develop branch and contains only a ShipBrain handoff note, not the final app source change
- Developer continues work on the ShipBrain-created feature branch so all commits stay attached to the same PR history
- Developer manually commits the heading color change to index.html on the same feature branch
- Developer can review the PR, mark it ready, and merge it into develop outside ShipBrain
- CI runs once for the PR lifecycle and the develop validation path, not once per generated file
- Manager can approve production deployment in ShipBrain CI Monitor only after green CI and after the PR is merged
- Approval creates the release tag from the merged PR commit, dispatches the Vercel production deploy workflow, and updates Dashboard current version
- Vercel production deployment exposes the approved release tag through /api/release
- If the deployed checkout triggers a production alert, ShipBrain Incident Commander can investigate the incident with release/version context and connect it back to the feature branch history, Draft PR, CI run, deployment audit, and release tag

Suggested implementation notes:
- Prefer changing only CSS in index.html
- ShipBrain-codegen: handoff-only
- Do not modify server.mjs, api routes, workflows, or Vercel config
- Do not change the checkout behavior`;

const quickPrTemplates = [
  {
    id: "test-color-change",
    label: "TEST: Heading color change",
    baseBranch: "develop",
    sourceBranch: undefined,
    ticket: `# TEST: Update checkout heading color

## Summary
Change the main checkout heading color in index.html for testing the ShipBrain E2E flow.

## Change Request
- **File:** index.html
- **Current:** color: #333 (dark gray)
- **New:** color: #0066cc (blue)

## Requirements
- [ ] Update the heading color in the CSS
- [ ] Keep existing layout unchanged
- [ ] No other file changes needed

## Acceptance Criteria
- [ ] Heading displays in new color
- [ ] No visual regressions
- [ ] Page loads correctly

## Notes
This is a simple test change to validate the full ShipBrain workflow:
1. Spec-to-PR creates Draft PR
2. Developer commits the color change
3. PR merged to develop
4. CI Monitor validates
5. Manager approves production deploy

---
ShipBrain-codegen: handoff-only`
  },
  {
    id: "feature",
    label: "Feature: New functionality",
    baseBranch: "develop",
    sourceBranch: undefined,
    ticket: `# Feature: [Feature Name]

## Summary
Brief description of the feature to be implemented.

## User Story
As a [type of user], I want [goal] so that [benefit].

## Requirements
- [ ] Requirement 1
- [ ] Requirement 2
- [ ] Requirement 3

## Acceptance Criteria
- [ ] Criteria 1
- [ ] Criteria 2
- [ ] Criteria 3

## Technical Notes
- Implementation approach
- Dependencies or integrations
- Performance considerations

## Out of Scope
- Items explicitly not included in this feature

---
ShipBrain-codegen: handoff-only`
  },
  {
    id: "bugfix",
    label: "Bug Fix: Issue resolution",
    baseBranch: "develop",
    sourceBranch: undefined,
    ticket: `# Bug Fix: [Bug Title]

## Problem Description
Clear description of the bug and its impact.

## Steps to Reproduce
1. Step 1
2. Step 2
3. Step 3

## Expected Behavior
What should happen.

## Actual Behavior
What is happening instead.

## Environment
- Browser/Device:
- Version:
- OS:

## Proposed Fix
Brief description of the solution approach.

## Testing Plan
- [ ] Test case 1
- [ ] Test case 2
- [ ] Regression test

---
ShipBrain-codegen: handoff-only`
  },
  {
    id: "refactor",
    label: "Refactor: Code improvement",
    baseBranch: "develop",
    sourceBranch: undefined,
    ticket: `# Refactor: [Component/Module Name]

## Current State
Description of the current implementation and its issues.

## Proposed Changes
- Change 1
- Change 2
- Change 3

## Benefits
- Improved maintainability
- Better performance
- Cleaner code structure

## Risk Assessment
- Low/Medium/High risk areas
- Mitigation strategies

## Testing Strategy
- [ ] Unit tests updated
- [ ] Integration tests pass
- [ ] No functional changes

## Rollback Plan
Steps to revert if issues arise.

---
ShipBrain-codegen: handoff-only`
  },
  {
    id: "develop-to-prod",
    label: "Release: Develop to production",
    baseBranch: "main",
    sourceBranch: "develop",
    ticket: `# Release: Promote develop to production

## Summary
Create a production release PR from develop branch to main.

## Pre-release Checklist
- [ ] All features complete and tested
- [ ] CI pipeline passing on develop
- [ ] Code review completed
- [ ] Documentation updated
- [ ] No known critical bugs

## Release Notes
### New Features
- Feature 1
- Feature 2

### Bug Fixes
- Fix 1
- Fix 2

### Breaking Changes
- None / List changes

## Post-release Verification
- [ ] Production deployment successful
- [ ] Smoke tests passing
- [ ] Monitoring alerts normal

---
ShipBrain-codegen: handoff-only
Source branch: develop
Destination branch: main`
  },
  {
    id: "documentation",
    label: "Docs: Documentation update",
    baseBranch: "develop",
    sourceBranch: undefined,
    ticket: `# Documentation: [Topic]

## Purpose
What documentation needs to be added or updated.

## Sections to Update
- [ ] README
- [ ] API documentation
- [ ] User guide
- [ ] Code comments

## Content Outline
1. Section 1
2. Section 2
3. Section 3

## Review Checklist
- [ ] Technical accuracy verified
- [ ] Examples tested and working
- [ ] Grammar and spelling checked
- [ ] Links validated

---
ShipBrain-codegen: handoff-only`
  }
] as const;

export default function SpecToPrPage() {
  const [spec, setSpec] = useState("");
  const [repo, setRepo] = useState("JeevantheDev/shipbrain_sandbox");
  const [result, setResult] = useState<SpecResult | null>(null);
  const [status, setStatus] = useState("Idle");
  const [gateOpen, setGateOpen] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);
  const [error, setError] = useState("");
  const [prRetryAvailable, setPrRetryAvailable] = useState(false);
  const [flowStage, setFlowStage] = useState<FlowStage>("idle");
  const [livePercent, setLivePercent] = useState(0);
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("develop");
  const [branchCheck, setBranchCheck] = useState<BranchCheck>("idle");
  const [branchMessage, setBranchMessage] = useState("");
  const [baseBranchCheck, setBaseBranchCheck] = useState<BaseBranchCheck>("idle");
  const [baseBranchMessage, setBaseBranchMessage] = useState("");
  const [recentRuns, setRecentRuns] = useState<RecentPrRun[]>([]);
  const [currentRunId, setCurrentRunId] = useState("");
  const [historyWarning, setHistoryWarning] = useState("");
  const [closeRun, setCloseRun] = useState<RecentPrRun | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeError, setCloseError] = useState("");
  const [quickTemplateId, setQuickTemplateId] = useState("");
  const [retryCountdown, setRetryCountdown] = useState(0);
  // Detect release PR mode: either from template selection OR from branch names (develop → main)
  const useExistingSourceBranch = quickTemplateId === "develop-to-prod" || (branchName === "develop" && baseBranch === "main");
  const flow = flowCopy[flowStage];
  const displayedPercent = flowStage === "planning" || flowStage === "creating_pr" ? livePercent : flow.percent;

  const scaffoldText = useMemo(() => {
    if (!result) return "";
    return Object.entries(result.scaffold)
      .map(([filename, content]) => `// ${filename}\n${content}`)
      .join("\n\n");
  }, [result]);

  useEffect(() => {
    const savedRepo = window.localStorage.getItem("shipbrain:selectedRepo");
    if (savedRepo) setRepo(savedRepo);
    void loadRecentRuns();
    const interval = window.setInterval(() => void loadRecentRuns(), 30000);
    return () => window.clearInterval(interval);
  }, []);

  async function loadRecentRuns() {
    try {
      const response = await fetch("/api/spec-runs", { cache: "no-store" });
      if (response.ok) {
        const serverRuns = (await response.json()) as RecentPrRun[];
        const merged = mergeRecentRuns(serverRuns);
        setRecentRuns(merged);
        setHistoryWarning("");
        const selectedId = window.localStorage.getItem(selectedPrStorageKey);
        const selected = merged.find((run) => run.id === selectedId);
        if (selected) {
          loadRecentRun(selected);
          window.localStorage.removeItem(selectedPrStorageKey);
        }
        return;
      }
      const json = await response.json().catch(() => ({}));
      if (json.detail) setHistoryWarning(json.detail);
    } catch {
      // Local fallback below keeps the resume flow usable during setup.
    }

    const saved = window.localStorage.getItem(recentPrStorageKey);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as RecentPrRun[];
      const recent = parsed.slice(0, 5);
      setRecentRuns(recent);
      const selectedId = window.localStorage.getItem(selectedPrStorageKey);
      const selected = recent.find((run) => run.id === selectedId);
      if (selected) {
        loadRecentRun(selected);
        window.localStorage.removeItem(selectedPrStorageKey);
      }
    } catch {
      window.localStorage.removeItem(recentPrStorageKey);
    }
  }

  function mergeRecentRuns(serverRuns: RecentPrRun[]) {
    if (serverRuns.length === 0) {
      window.localStorage.removeItem(recentPrStorageKey);
      window.localStorage.removeItem(selectedPrStorageKey);
      return [];
    }

    const saved = window.localStorage.getItem(recentPrStorageKey);
    const localRuns = saved ? safeParseRuns(saved) : [];
    const byId = new Map<string, RecentPrRun>();
    [...localRuns, ...serverRuns].forEach((run) => byId.set(run.id, { ...run, baseBranch: run.baseBranch ?? "develop" }));
    const merged = Array.from(byId.values())
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 5);
    window.localStorage.setItem(recentPrStorageKey, JSON.stringify(merged));
    return merged;
  }

  function safeParseRuns(value: string): RecentPrRun[] {
    try {
      return (JSON.parse(value) as RecentPrRun[]).map((run) => ({ ...run, baseBranch: run.baseBranch ?? "develop" }));
    } catch {
      return [];
    }
  }

  async function persistRecentRun(run: RecentPrRun) {
    setRecentRuns((items) => {
      const next = [run, ...items.filter((item) => item.id !== run.id)].slice(0, 5);
      window.localStorage.setItem(recentPrStorageKey, JSON.stringify(next));
      return next;
    });

    try {
      const isLocal = run.id.startsWith("pr-run-");
      const response = await fetch("/api/spec-runs", {
        method: isLocal ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(run)
      });
      if (!response.ok) return;
      const saved = (await response.json()) as RecentPrRun;
      setCurrentRunId(saved.id);
      setRecentRuns((items) => {
        const next = [saved, ...items.filter((item) => item.id !== run.id && item.id !== saved.id)].slice(0, 5);
        window.localStorage.setItem(recentPrStorageKey, JSON.stringify(next));
        return next;
      });
    } catch {
      // Local fallback has already been written.
    }
  }

  function updateRecentRun(status: RecentPrStatus, nextResult = result, nextError = error) {
    if (!currentRunId || !nextResult) return;
    const run: RecentPrRun = {
      id: currentRunId,
      repo,
      spec,
      branchName: branchName.trim() || nextResult.suggestedBranch,
      baseBranch: baseBranch.trim() || "develop",
      result: nextResult,
      status,
      updatedAt: new Date().toISOString(),
      error: nextError || undefined
    };
    void persistRecentRun(run);
  }

  function loadRecentRun(run: RecentPrRun) {
    setSpec(run.spec);
    setResult(run.result);
    setBranchName(run.branchName);
    setBaseBranch(run.baseBranch ?? "develop");
    setCurrentRunId(run.id);
    setError(run.error ?? "");
    setPrRetryAvailable(run.status !== "draft_created" && run.status !== "merged" && run.status !== "closed");
    setStatus(statusLabel(run));
    setFlowStage(run.status === "draft_created" || run.status === "merged" ? "ready" : run.status === "failed" || run.status === "closed" ? "failed" : run.status === "rejected" ? "cancelled" : "review");
  }

  function statusLabel(runOrStatus: RecentPrRun | RecentPrStatus) {
    const status = typeof runOrStatus === "string" ? runOrStatus : runOrStatus.status;
    if (typeof runOrStatus !== "string" && runOrStatus.hasMergeConflicts) return "Merge conflicts";
    if (status === "draft_created") return "Draft PR ready";
    if (status === "failed") return "Failed";
    if (status === "rejected") return "Rejected";
    if (status === "closed") return "Closed on GitHub";
    if (status === "merged") return "Merged";
    return "Review task list";
  }

  function recentStatusLabel(run: RecentPrRun) {
    if (run.hasMergeConflicts) return "Merge conflicts";
    if (run.status === "draft_created") return "Draft PR ready";
    if (run.status === "failed") return "Needs retry";
    if (run.status === "rejected") return "Rejected";
    if (run.status === "closed") return "Closed on GitHub";
    if (run.status === "merged") return "Merged";
    return "Pending PR";
  }

  function ciLabel(run: RecentPrRun) {
    if (run.hasMergeConflicts) return "Resolve conflicts in GitHub";
    if (run.deploymentStatus === "approved") return "Deploy approved";
    if (run.deploymentStatus === "rejected") return "Deploy rejected";
    if (run.ciConclusion === "success") return "CI passed";
    if (run.ciConclusion) return "CI failed";
    if (run.ciStatus) return `CI ${run.ciStatus}`;
    return "CI pending";
  }

  async function deleteRecentRun(id: string) {
    const run = recentRuns.find((item) => item.id === id);
    if (run?.result.pr && run.status === "draft_created") {
      setCloseRun(run);
      setCloseError("");
      return;
    }

    const next = recentRuns.filter((run) => run.id !== id);
    setRecentRuns(next);
    window.localStorage.setItem(recentPrStorageKey, JSON.stringify(next));
    if (currentRunId === id) {
      setCurrentRunId("");
    }
    if (!id.startsWith("pr-run-")) {
      await fetch(`/api/spec-runs?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    }
  }

  async function closeDraftPrRun(input: { comment: string; deleteBranch: boolean }) {
    if (!closeRun) return;
    setCloseBusy(true);
    setError("");
    setCloseError("");
    try {
      const response = await fetch("/api/spec-runs/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: closeRun.id, comment: input.comment, deleteBranch: input.deleteBranch })
      });
      const json = await response.json();
      if (!response.ok) throw new Error([json.error, json.detail].filter(Boolean).join(" "));
      const next = recentRuns.map((item) => item.id === closeRun.id ? { ...item, status: "closed" as RecentPrStatus, error: "Closed from ShipBrain and synced to GitHub.", updatedAt: new Date().toISOString() } : item);
      setRecentRuns(next);
      window.localStorage.setItem(recentPrStorageKey, JSON.stringify(next));
      if (currentRunId === closeRun.id) {
        setStatus("Closed on GitHub");
        setFlowStage("failed");
      }
      setCloseRun(null);
    } catch (nextError) {
      setCloseError(nextError instanceof Error ? nextError.message : "Unable to close the Draft PR on GitHub.");
    } finally {
      setCloseBusy(false);
    }
  }

  useEffect(() => {
    if (flowStage !== "planning" && flowStage !== "creating_pr") return;
    const ceiling = flowStage === "planning" ? 58 : 94;
    const interval = window.setInterval(() => {
      setLivePercent((current) => Math.min(current + 3, ceiling));
    }, 900);
    return () => window.clearInterval(interval);
  }, [flowStage]);

  useEffect(() => {
    if (retryCountdown <= 0) return;
    const timeout = window.setTimeout(() => setRetryCountdown((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearTimeout(timeout);
  }, [retryCountdown]);

  function retryDelay(error: ApiError) {
    return Math.max(5, Math.min(Number(error.retryAfterSeconds ?? 30), 90));
  }

  useEffect(() => {
    if (useExistingSourceBranch) {
      setBranchCheck("available");
      setBranchMessage("Deployment PR mode: existing source branch is allowed and required.");
      return;
    }

    if (!branchName.trim()) {
      setBranchCheck("idle");
      setBranchMessage("");
      return;
    }

    setBranchCheck("checking");
    setBranchMessage("Checking branch availability...");
    const timeout = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ repo, branch: branchName.trim() });
        const response = await fetch(`/api/github/branch?${params.toString()}`, { cache: "no-store" });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "Unable to check branch");
        if (json.available) {
          setBranchCheck("available");
          setBranchMessage("Branch name is available.");
        } else {
          setBranchCheck("exists");
          setBranchMessage("Branch already exists. Change the name before creating the Draft PR.");
        }
      } catch (error) {
        setBranchCheck("error");
        setBranchMessage(error instanceof Error ? error.message : "Unable to check branch");
      }
    }, 450);

    return () => window.clearTimeout(timeout);
  }, [branchName, repo, useExistingSourceBranch]);

  useEffect(() => {
    if (!baseBranch.trim()) {
      setBaseBranchCheck("idle");
      setBaseBranchMessage("");
      return;
    }

    setBaseBranchCheck("checking");
    setBaseBranchMessage("Checking destination branch...");
    const timeout = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ repo, branch: baseBranch.trim() });
        const response = await fetch(`/api/github/branch?${params.toString()}`, { cache: "no-store" });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "Unable to check destination branch");
        if (json.exists) {
          setBaseBranchCheck("exists");
          setBaseBranchMessage("Destination branch exists.");
        } else {
          setBaseBranchCheck("missing");
          setBaseBranchMessage("Destination branch does not exist. Choose an existing integration branch such as develop.");
        }
      } catch (error) {
        setBaseBranchCheck("error");
        setBaseBranchMessage(error instanceof Error ? error.message : "Unable to check destination branch");
      }
    }, 450);

    return () => window.clearTimeout(timeout);
  }, [baseBranch, repo]);

  async function generate(retryAttempt = 0) {
    setError("");
    setPrRetryAvailable(false);
    setRetryCountdown(0);
    setFlowStage("idle");
    if (!spec.trim()) {
      setError("Paste a ticket or spec before generating a PR.");
      setFlowStage("failed");
      return;
    }

    setStatus("Decomposing spec and generating scaffold...");
    setFlowStage("planning");
    setLivePercent(18);
    const response = await fetch("/api/ai/spec-to-pr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawSpec: spec, repoFullName: repo, createPr: false })
    });
    const json = await response.json();
    if (!response.ok) {
      const apiError = json as ApiError;
      if (apiError.retryable && retryAttempt < 1) {
        const seconds = retryDelay(apiError);
        setRetryCountdown(seconds);
        setStatus(`Gemini quota cooling down. Retrying in ${seconds}s...`);
        setError([apiError.error, apiError.detail].filter(Boolean).join(" "));
        setPrRetryAvailable(true);
        setFlowStage("failed");
        window.setTimeout(() => void generate(retryAttempt + 1), seconds * 1000);
        return;
      }
      setError(
        [apiError.error ?? "Unable to generate tasks.", apiError.detail]
          .filter(Boolean)
          .join(" ")
      );
      setStatus("Failed");
      setFlowStage("failed");
      return;
    }
    setResult(json);
    const template = quickPrTemplates.find((item) => item.id === quickTemplateId);
    setBranchName(template?.sourceBranch ?? json.suggestedBranch);
    const runId = `pr-run-${Date.now()}`;
    setCurrentRunId(runId);
    void persistRecentRun({
      id: runId,
      repo,
      spec,
      branchName: template?.sourceBranch ?? json.suggestedBranch,
      baseBranch,
      result: json,
      status: "pending_pr",
      updatedAt: new Date().toISOString()
    });
    setStatus("Review task list");
    setLivePercent(65);
    setFlowStage("review");
  }

  function requestDraftPrApproval() {
    if (!result) return;
    if (!branchName.trim()) {
      setError("Choose a feature branch name before creating the Draft PR.");
      setFlowStage("failed");
      return;
    }
    if (!baseBranch.trim()) {
      setError("Choose a destination branch before creating the Draft PR.");
      setFlowStage("failed");
      return;
    }
    if (baseBranchCheck === "missing") {
      setError("The destination branch does not exist. Choose an existing integration branch such as develop before creating the Draft PR.");
      setFlowStage("failed");
      return;
    }
    if (baseBranchCheck === "checking") {
      setError("ShipBrain is still checking the destination branch. Wait a moment, then create the Draft PR.");
      return;
    }
    if (branchCheck === "exists" && !useExistingSourceBranch) {
      setError("This feature branch already exists. Change the branch name and wait for the availability check before retrying.");
      setFlowStage("failed");
      setPrRetryAvailable(true);
      return;
    }
    if (branchCheck === "checking") {
      setError("ShipBrain is still checking whether this branch exists. Wait a moment, then create the Draft PR.");
      return;
    }
    setError("");
    setGateOpen(true);
  }

  async function approvePr(note: string, retryAttempt = 0) {
    if (!result) return;
    setGateOpen(false);
    setPrRetryAvailable(false);
    setRetryCountdown(0);
    setStatus("Creating GitHub Draft PR...");
    setFlowStage("creating_pr");
    setLivePercent(72);
    const response = await fetch("/api/ai/spec-to-pr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rawSpec: spec,
        repoFullName: repo,
        createPr: true,
        approvalNote: note,
        plan: result,
        branchOverride: branchName.trim(),
        baseBranchOverride: baseBranch.trim(),
        useExistingSourceBranch
      })
    });
    const json = await response.json();
    if (!response.ok) {
      const apiError = json as ApiError;
      if (apiError.retryable && retryAttempt < 1) {
        const seconds = retryDelay(apiError);
        setRetryCountdown(seconds);
        setStatus(`Gemini quota cooling down. Retrying Draft PR in ${seconds}s...`);
        setError([apiError.error, apiError.detail].filter(Boolean).join(" "));
        setPrRetryAvailable(true);
        setFlowStage("failed");
        window.setTimeout(() => void approvePr(note, retryAttempt + 1), seconds * 1000);
        return;
      }
      setError(
        [apiError.error ?? "Unable to create Draft PR.", apiError.detail]
          .filter(Boolean)
          .join(" ")
      );
      setStatus("Failed");
      setPrRetryAvailable(true);
      setFlowStage("failed");
      updateRecentRun("failed", result, [apiError.error ?? "Unable to create Draft PR.", apiError.detail].filter(Boolean).join(" "));
      return;
    }
    const nextResult = { ...json, suggestedBranch: branchName.trim() };
    setResult(nextResult);
    setStatus("Draft PR ready");
    setPrRetryAvailable(false);
    setLivePercent(100);
    setFlowStage("ready");
    updateRecentRun("draft_created", nextResult, "");
    setSuccessOpen(true);
  }

  function useQuickTemplate(templateId: string) {
    const template = quickPrTemplates.find((item) => item.id === templateId);
    if (!template) return;
    setQuickTemplateId(templateId);
    setSpec(template.ticket);
    setResult(null);
    setBranchName(template.sourceBranch ?? "");
    setBaseBranch(template.baseBranch);
    setCurrentRunId("");
    setError("");
    setPrRetryAvailable(false);
    setStatus(`${template.label} loaded`);
    setFlowStage("sample");
  }

  function retryDraftPr() {
    if (retryCountdown > 0) return;
    setError("");
    requestDraftPrApproval();
  }

  const activeRecentRuns = recentRuns.filter((run) => run.status !== "closed" && run.status !== "merged").slice(0, 5);
  const syncedRecentRuns = recentRuns.filter((run) => run.status === "closed" || run.status === "merged").slice(0, 1);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">Pillar 1</div>
          <h1>Spec-to-PR</h1>
          <p>Decompose a ticket, inspect the developer handoff, then approve Draft PR creation for {repo}.</p>
        </div>
        <span className="status green">{status}</span>
      </div>

      {error ? (
        <div className="error-panel" role="alert" style={{ marginBottom: 16 }}>
          <strong>Generation needs another pass</strong>
          <p>{error}</p>
          {prRetryAvailable && result ? (
            <button className="button primary" style={{ marginTop: 10 }} disabled={retryCountdown > 0} onClick={retryDraftPr}>
              <GitPullRequest size={16} />
              {retryCountdown > 0 ? `Retry available in ${retryCountdown}s` : "Retry Draft PR creation"}
            </button>
          ) : null}
        </div>
      ) : null}

      {activeRecentRuns.length || syncedRecentRuns.length ? (
        <section className="recent-pr-strip recent-pr-overview" aria-label="Recent AI PRs">
          <div className="toolbar recent-pr-overview-header">
            <div>
              <strong>Recent AI PRs</strong>
              <p>Resume a saved plan or retry a Draft PR without rebuilding the ticket.</p>
            </div>
            <span className="status green">Latest {activeRecentRuns.length}/5</span>
          </div>
          {activeRecentRuns.length ? (
            <div className="recent-pr-list overview">
              {activeRecentRuns.map((run) => (
                <div className="recent-pr-row" key={run.id}>
                  <button className="recent-pr-item" onClick={() => loadRecentRun(run)}>
                    <span>{run.result.prTitle}</span>
                    <small>{run.branchName} → {run.baseBranch ?? "develop"}</small>
                    <em>{recentStatusLabel(run)}</em>
                    <small>{ciLabel(run)}</small>
                  </button>
                  <button className="icon-button danger-icon" aria-label="Delete recent PR" title="Delete" onClick={() => deleteRecentRun(run.id)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {syncedRecentRuns.map((run) => (
            <button className="recent-pr-closed-link" key={run.id} onClick={() => loadRecentRun(run)}>
              <span>{recentStatusLabel(run)} · PR #{run.result.pr?.number ?? "synced"}</span>
              <strong>View synced record</strong>
            </button>
          ))}
        </section>
      ) : historyWarning ? (
        <div className="error-panel" role="alert" style={{ marginBottom: 16 }}>
          <strong>Recent PR history needs Supabase setup</strong>
          <p>{historyWarning}</p>
        </div>
      ) : null}

      <section className="grid two spec-workspace">
        <div className="panel spec-column">
          <div className="toolbar" style={{ marginBottom: 14 }}>
            <button className="button primary" onClick={() => void generate()}>
              <Play size={16} />
              Generate PR
            </button>
            <label className="quick-template-select" aria-label="Quick PR template">
              <FileText size={16} />
              <select
                value={quickTemplateId}
                onChange={(event) => useQuickTemplate(event.target.value)}
              >
                <option value="">Quick PR templates</option>
                {quickPrTemplates.map((template) => (
                  <option key={template.id} value={template.id}>{template.label}</option>
                ))}
              </select>
            </label>
          </div>
          <SpecEditor value={spec} onChange={setSpec} />
        </div>

        <aside className="panel spec-column">
          <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <h2 style={{ marginBottom: 0 }}>AI Plan</h2>
            {result?.pr ? (
              <a className="button primary compact" href={result.pr.html_url} target="_blank" rel="noreferrer">
                <GitPullRequest size={15} />
                PR #{result.pr.number}
                <ExternalLink size={14} />
              </a>
            ) : result ? (
              <button className="button primary compact" onClick={requestDraftPrApproval}>
                <GitPullRequest size={15} />
                Create Draft PR
              </button>
            ) : null}
          </div>
          <div className={`progress-panel in-plan ${flowStage === "planning" || flowStage === "creating_pr" ? "streaming" : ""}`}>
            <div className="toolbar" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{flow.label}</strong>
                <p>{flow.note}</p>
              </div>
              <span className="status amber">{flow.estimate}</span>
            </div>
            <div className="progress-track" aria-label={`Spec-to-PR progress ${flow.percent}%`}>
              <div className="progress-fill" style={{ width: `${displayedPercent}%` }} />
            </div>
            <div className="progress-meta">
              <span>{displayedPercent}% complete</span>
              <span>{flowStage === "planning" || flowStage === "creating_pr" ? "Keep this tab open" : status}</span>
            </div>
          </div>
          {!result ? <p>Generated tasks, reviewer chips, developer handoff, and PR link appear here.</p> : null}
          {result ? (
            <div className="split-list">
              <div className="card">
                <strong>{result.prTitle}</strong>
                {useExistingSourceBranch ? (
                  <div className="toolbar" style={{ marginTop: 10 }}>
                    <span className="status green">Deployment PR</span>
                    <span className="status amber">{branchName || "develop"} → {baseBranch || "main"}</span>
                    <span className="status green">Existing source branch allowed</span>
                  </div>
                ) : null}
                {currentRunId ? (
                  <div className="toolbar" style={{ marginTop: 10 }}>
                    {(() => {
                      const activeRun = recentRuns.find((run) => run.id === currentRunId);
                      return activeRun ? (
                        <>
                          <span className="status amber">{ciLabel(activeRun)}</span>
                          <span className={`status ${activeRun.deploymentStatus === "approved" ? "green" : "amber"}`}>
                            Deploy {activeRun.deploymentStatus ?? "not requested"}
                          </span>
                          {activeRun.result.pr && activeRun.status === "draft_created" ? (
                            <button className="button danger compact" onClick={() => setCloseRun(activeRun)}>
                              Close PR + delete branch
                            </button>
                          ) : null}
                        </>
                      ) : null;
                    })()}
                  </div>
                ) : null}
                {currentRunId ? (() => {
                  const activeRun = recentRuns.find((run) => run.id === currentRunId);
                  return activeRun?.hasMergeConflicts ? (
                    <div className="error-panel" role="alert" style={{ marginTop: 12 }}>
                      <strong>Merge conflicts detected</strong>
                      <p>
                        GitHub says this PR cannot be merged cleanly into {activeRun.baseBranch ?? "the destination branch"}.
                        Resolve conflicts in GitHub or on the source branch, then refresh ShipBrain before approving deployment.
                      </p>
                    </div>
                  ) : null;
                })() : null}
                <label className="field-label" htmlFor="base-branch">Destination branch</label>
                <div className="toolbar" style={{ marginTop: 8 }}>
                  <input
                    id="base-branch"
                    className="input"
                    value={baseBranch}
                    onChange={(event) => setBaseBranch(event.target.value)}
                    placeholder="develop"
                  />
                </div>
                {baseBranchMessage ? (
                  <p className={`branch-check ${baseBranchCheck === "exists" ? "available" : baseBranchCheck === "missing" ? "exists" : baseBranchCheck}`} style={{ marginBottom: 0 }}>
                    {baseBranchMessage}
                  </p>
                ) : null}
                <label className="field-label" htmlFor="feature-branch">{useExistingSourceBranch ? "Source branch" : "Feature branch"}</label>
                <div className="toolbar" style={{ marginTop: 8 }}>
                  <input
                    id="feature-branch"
                    className="input"
                    value={branchName}
                    onChange={(event) => setBranchName(event.target.value)}
                    placeholder="feat/my-feature-branch"
                  />
                  {!useExistingSourceBranch ? <button className="button secondary" onClick={() => setBranchName(`${result.suggestedBranch}-${Date.now().toString().slice(-4)}`)}>
                    <RefreshCw size={16} />
                    Make unique
                  </button> : null}
                </div>
                {branchMessage ? (
                  <p className={`branch-check ${branchCheck}`} style={{ marginBottom: 0 }}>
                    {branchMessage}
                  </p>
                ) : null}
              </div>
              {result.tasks.map((task, index) => (
                <article className="card" key={task.title}>
                  <span className="status green">Task {index + 1}</span>
                  <h3 style={{ marginTop: 10 }}>{task.title}</h3>
                  <p>{task.description}</p>
                  <p style={{ marginBottom: 0 }}>{task.files.join(", ")}</p>
                </article>
              ))}
              <div className="toolbar">
                {result.suggestedReviewers.map((reviewer) => (
                  <span className="status amber" key={reviewer}>
                    @{reviewer}
                  </span>
                ))}
              </div>
              <pre className="code-view" style={{ maxHeight: 240 }}>{scaffoldText}</pre>
              {result.pr ? (
                <a className="button primary" href={result.pr.html_url} target="_blank" rel="noreferrer">
                  <GitPullRequest size={16} />
                  Draft PR #{result.pr.number}
                  <ExternalLink size={16} />
                </a>
              ) : (
                <div className="toolbar">
                  <button className="button secondary" onClick={() => navigator.clipboard.writeText(scaffoldText)}>
                    <Copy size={16} />
                    Copy scaffold
                  </button>
                  {prRetryAvailable ? (
                    <button className="button primary" onClick={requestDraftPrApproval}>
                      <GitPullRequest size={16} />
                      Retry Draft PR creation
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </aside>
      </section>

      <ApprovalGate
        open={gateOpen}
        title="Approve Draft PR creation"
        description={useExistingSourceBranch ? `ShipBrain will open a GitHub Draft PR from existing source branch ${branchName || "develop"} into ${baseBranch || "main"}. No intermediate feature branch or handoff commit will be created for this promotion.` : `ShipBrain will create feature branch ${branchName || result?.suggestedBranch || "pending"}, commit a developer handoff note, and open a GitHub Draft PR into ${baseBranch || "develop"}. The developer should continue work on that same branch so PR history stays intact.`}
        entityType="spec"
        entityId={branchName || result?.suggestedBranch || "pending"}
        onApprove={approvePr}
        onReject={() => {
          setGateOpen(false);
          setStatus("Cancelled");
          setFlowStage("cancelled");
          updateRecentRun("rejected", result, "Draft PR creation was rejected by the user.");
        }}
        onClose={() => setGateOpen(false)}
      />
      {successOpen && result?.pr ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setSuccessOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>Draft PR created successfully</h2>
            <p>
              ShipBrain opened Draft PR #{result.pr.number} from <strong>{branchName}</strong> into <strong>{baseBranch}</strong>. {useExistingSourceBranch ? "Review and merge the promotion PR when production approval is ready." : "Continue developer commits on this same feature branch, then review and merge when ready."}
            </p>
            <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: 16 }}>
              <button className="button secondary" onClick={() => setSuccessOpen(false)}>Close</button>
              <a className="button primary" href={result.pr.html_url} target="_blank" rel="noreferrer">
                <GitPullRequest size={16} />
                Open Draft PR
                <ExternalLink size={16} />
              </a>
            </div>
          </div>
        </div>
      ) : null}
      <CloseDraftPrModal
        open={Boolean(closeRun)}
        prNumber={closeRun?.result.pr?.number}
        branchName={closeRun?.branchName ?? ""}
        title={closeRun?.result.prTitle ?? "Draft PR"}
        busy={closeBusy}
        error={closeError}
        onClose={() => {
          if (closeBusy) return;
          setCloseRun(null);
          setCloseError("");
        }}
        onConfirm={closeDraftPrRun}
      />
    </>
  );
}
