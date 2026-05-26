"use client";

import { Copy, ExternalLink, FileText, GitPullRequest, Loader2, Play, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ApprovalGate } from "@/components/approval-gate/ApprovalGate";
import { CloseDraftPrModal } from "@/components/pr-sync/CloseDraftPrModal";

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
    label: "Awaiting Input",
    note: "Provide a spec on the left and choose a recipe to start planning.",
    estimate: "Idle"
  },
  sample: {
    percent: 8,
    label: "Recipe loaded",
    note: "Review or edit the spec, then generate the AI plan.",
    estimate: "Ready"
  },
  planning: {
    percent: 35,
    label: "Decomposing ticket...",
    note: "Do not close this tab. ShipBrain is creating the developer handoff plan.",
    estimate: "Planning"
  },
  review: {
    percent: 65,
    label: "AI plan ready for approval",
    note: "Review the generated tasks before allowing ShipBrain to touch GitHub.",
    estimate: "Awaiting approval"
  },
  creating_pr: {
    percent: 85,
    label: "Creating GitHub Draft PR...",
    note: "Creating the feature branch, committing the handoff, and opening a Draft PR.",
    estimate: "Deploying plan"
  },
  ready: {
    percent: 100,
    label: "Draft PR created",
    note: "Open the PR link, let the development review happen, then merge to develop.",
    estimate: "Complete"
  },
  failed: {
    percent: 70,
    label: "Workflow paused",
    note: "The AI plan is preserved. Fix the issue, then retry Draft PR creation.",
    estimate: "Failed"
  },
  cancelled: {
    percent: 60,
    label: "Approval cancelled",
    note: "The AI plan is preserved. You can retry Draft PR creation when ready.",
    estimate: "Cancelled"
  }
};

const quickPrTemplates = [
  {
    id: "test-color-change",
    label: "Heading color change",
    prefix: "test",
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
    label: "New functionality",
    prefix: "feature",
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

---
ShipBrain-codegen: handoff-only`
  },
  {
    id: "bugfix",
    label: "Issue resolution",
    prefix: "bug fix",
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

## Proposed Fix
Brief description of the solution approach.

---
ShipBrain-codegen: handoff-only`
  },
  {
    id: "refactor",
    label: "Code improvement",
    prefix: "refactor",
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

---
ShipBrain-codegen: handoff-only`
  },
  {
    id: "develop-to-prod",
    label: "Develop → production",
    prefix: "release",
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

---
ShipBrain-codegen: handoff-only
Source branch: develop
Destination branch: main`
  },
  {
    id: "documentation",
    label: "Documentation update",
    prefix: "docs",
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

  // Compute stats for editor
  const lineCount = useMemo(() => {
    return spec.split("\n").length;
  }, [spec]);

  const wordCount = useMemo(() => {
    return spec.trim() === "" ? 0 : spec.trim().split(/\s+/).length;
  }, [spec]);

  const tokenCount = useMemo(() => {
    return Math.round(wordCount * 1.3);
  }, [wordCount]);

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
      // Local fallback keeps the resume flow usable
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

  function applyQuickTemplate(templateId: string) {
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
      <header className="page-head">
        <div>
          <div className="eyebrow mono">
            <span className="bar"></span>
            <span className="pillar-tag">Pillar 01</span>
            Spec-to-PR
          </div>
          <h1>Convert specifications directly into reviewable Pull Requests.</h1>
          <div className="sub">
            Deploying changes to <span className="repo">{repo}</span>. Paste a ticket, feature spec, or choose a template below.
          </div>
        </div>
        <div className="head-meta mono">
          <span className={`status-pill ${flowStage === "ready" ? "passed" : flowStage === "failed" ? "danger" : ""}`}>
            <span className="dot"></span>
            {flowStage}
          </span>
          <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>{status}</span>
        </div>
      </header>

      {error ? (
        <div className="error-panel" role="alert" style={{ marginBottom: 16 }}>
          <strong>Generation needs attention</strong>
          <p>{error}</p>
          {prRetryAvailable && result ? (
            <button className="button primary compact" style={{ marginTop: 10 }} disabled={retryCountdown > 0} onClick={retryDraftPr}>
              <GitPullRequest size={14} style={{ marginRight: 6 }} />
              {retryCountdown > 0 ? `Retry available in ${retryCountdown}s` : "Retry Draft PR creation"}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Editor toolbar */}
      <div className="editor-toolbar">
        <div className="toolbar-left">
          <button className="select" type="button">
            <span className="select-label">Repo</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 1.5h6L10 3v7.5H2.5v-9Z" stroke="currentColor" strokeWidth="1.2"/>
              <path d="M8.5 1.5V3H10" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
            {repo}
          </button>
          <span className="branch-chip">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ marginRight: 4 }}>
              <circle cx="3" cy="2.5" r="1.2" stroke="currentColor" strokeWidth="1.1"/>
              <circle cx="3" cy="9.5" r="1.2" stroke="currentColor" strokeWidth="1.1"/>
              <circle cx="9" cy="6" r="1.2" stroke="currentColor" strokeWidth="1.1"/>
              <path d="M3 4v4M4.2 9.5C7 9.5 7.8 8 7.8 7" stroke="currentColor" strokeWidth="1.1"/>
            </svg>
            base: {baseBranch}
          </span>
          <span className="branch-chip" style={{ color: "var(--ai-purple)", borderColor: "rgba(163, 113, 247, 0.3)" }}>
            <span style={{ color: "var(--ai-purple)", marginRight: 4 }}>◆</span>
            google
          </span>
        </div>

        <div className="toolbar-right">
          <button className="ghost-btn" type="button" onClick={() => applyQuickTemplate("test-color-change")}>
            <span>Load sample ticket</span>
          </button>
          <button className="btn-primary" type="button" disabled={!spec.trim() || flowStage === "planning" || flowStage === "creating_pr"} onClick={() => void generate()}>
            {flowStage === "planning" ? <Loader2 size={12} className="spin" /> : <Play size={12} style={{ marginRight: 4 }} />}
            Generate PR
            <span className="kbd-inline">⌘⏎</span>
          </button>
        </div>
      </div>

      {/* Workspace */}
      <section className="workspace">
        {/* LEFT column */}
        <div className="stack">
          {/* Recent AI PRs */}
          {(activeRecentRuns.length > 0 || syncedRecentRuns.length > 0) && (
            <div className="panel">
              <header className="panel-head">
                <h2>
                  Recent AI PRs
                  <span className="badge-count">Latest {activeRecentRuns.length}/5</span>
                </h2>
              </header>
              <p className="panel-desc">Resume a saved plan or retry a Draft PR without rebuilding the ticket.</p>

              {activeRecentRuns.map((run) => (
                <div className="resume-row" key={run.id}>
                  <div className="pr-icon" title={recentStatusLabel(run)}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="3.5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.2"/>
                      <circle cx="3.5" cy="10.5" r="1.6" stroke="currentColor" stroke-width="1.2"/>
                      <circle cx="10.5" cy="10.5" r="1.6" stroke="currentColor" stroke-width="1.2"/>
                      <path d="M3.5 5v4M5 10.5h4M8 3 10 5 8 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <div>
                    <div className="resume-title">
                      <span className="status-pill">
                        <span className="dot"></span>
                        {recentStatusLabel(run)}
                      </span>
                      <span style={{ marginLeft: 6 }}>{run.result.prTitle}</span>
                    </div>
                    <div className="resume-meta">{run.branchName} → {run.baseBranch ?? "develop"} · {ciLabel(run)}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn subtle" type="button" onClick={() => loadRecentRun(run)}>Resume</button>
                    <button className="btn subtle" style={{ color: "var(--red)" }} type="button" onClick={() => deleteRecentRun(run.id)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}

              {syncedRecentRuns.map((run) => (
                <div className="resume-row" key={run.id}>
                  <div className="pr-icon" style={{ color: "var(--success)", background: "rgba(63, 185, 80, 0.12)", borderColor: "rgba(63, 185, 80, 0.3)" }}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="m3 6.5 2 2 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <div>
                    <div className="resume-title">
                      <span className="status-pill passed">
                        <span className="dot"></span>
                        synced
                      </span>
                      <span style={{ marginLeft: 6 }}>{run.result.prTitle}</span>
                    </div>
                    <div className="resume-meta">PR #{run.result.pr?.number ?? "merged"}</div>
                  </div>
                  <button className="btn subtle" type="button" onClick={() => loadRecentRun(run)}>View synced record</button>
                </div>
              ))}
            </div>
          )}

          {historyWarning && (
            <div className="error-panel" role="alert" style={{ marginBottom: 16 }}>
              <strong>History synchronization needs attention</strong>
              <p>{historyWarning}</p>
            </div>
          )}

          {/* Code Editor Card */}
          <div className="editor-card">
            <div className="editor-tabs">
              <div className="editor-tab active">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ marginRight: 6 }}>
                  <path d="M3 1.5h4.5L9.5 3.5V10.5H3v-9Z" stroke="currentColor" strokeWidth="1.1"/>
                </svg>
                <span>ticket.md</span>
                {spec.trim() && <span className="dot-unsaved"></span>}
              </div>
              <div className="editor-tab add" title="New tab">+</div>
              <div className="editor-meta mono">
                <span>markdown</span>
                <span>·</span>
                <span>utf-8</span>
              </div>
            </div>

            <div className="editor-body">
              <div className="gutter">
                {Array.from({ length: Math.max(12, lineCount) }).map((_, i) => (
                  <span className={`ln ${i === 0 ? "active" : ""}`} key={i}>{i + 1}</span>
                ))}
              </div>
              <div className="editor-text" style={{ padding: 0 }}>
                <textarea
                  className="mono"
                  value={spec}
                  onChange={(e) => setSpec(e.target.value)}
                  placeholder="Paste a Jira ticket, GitHub issue, or plain English spec…"
                  style={{
                    width: "100%",
                    height: "100%",
                    minHeight: "300px",
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "13px",
                    lineHeight: "20px",
                    padding: "12px 16px",
                    resize: "none"
                  }}
                />

                {!spec.trim() && (
                  <div className="examples">
                    <span className="ex-label mono">try:</span>
                    <button className="ex-chip" type="button" onClick={() => applyQuickTemplate("test-color-change")}>
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ marginRight: 4 }}>
                        <path d="M2 2h8v8H2z" stroke="currentColor" strokeWidth="1.1"/>
                        <path d="M4 5h4M4 7h3" stroke="currentColor" strokeWidth="1.1"/>
                      </svg>
                      test-color-change
                    </button>
                    <button className="ex-chip" type="button" onClick={() => applyQuickTemplate("feature")}>
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ marginRight: 4 }}>
                        <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.1"/>
                        <path d="M6 4v2.5l1.5 1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                      </svg>
                      feature-template
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="editor-foot mono">
              <div className="left">
                <span>ln {lineCount} · col 1</span>
                <span>{wordCount} words</span>
                <span>{tokenCount} tokens</span>
              </div>
              <div className="right">
                <span>autosave on</span>
                <span style={{ color: "var(--green)" }}>●</span>
              </div>
            </div>
          </div>

          {/* Quick PR templates */}
          <div className="panel">
            <header className="panel-head">
              <h2>
                Quick PR recipes
                <span className="badge-count">{quickPrTemplates.length}</span>
              </h2>
              <div className="tools">
                <span className="sub-h2">click to prefill the editor</span>
              </div>
            </header>

            <div className="templates-grid">
              {quickPrTemplates.map((template) => (
                <button
                  className="tpl"
                  type="button"
                  key={template.id}
                  onClick={() => applyQuickTemplate(template.id)}
                >
                  <span className={`tpl-icon ${template.prefix}`}>
                    {template.prefix === "test" && (
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path d="M5 1v3.5L1.5 11A1 1 0 0 0 2.4 12.5h9.2A1 1 0 0 0 12.5 11L9 4.5V1M4.5 1h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                    {template.prefix === "feature" && (
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path d="M7 1 8.5 5.5 13 7l-4.5 1.5L7 13l-1.5-4.5L1 7l4.5-1.5L7 1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                      </svg>
                    )}
                    {template.prefix === "bug fix" && (
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <rect x="4" y="4" width="6" height="7" rx="3" stroke="currentColor" strokeWidth="1.2"/>
                        <path d="M5 3.5 4 2M9 3.5 10 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                      </svg>
                    )}
                    {template.prefix === "refactor" && (
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path d="M2 4h7l-2-2M12 10H5l2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                    {template.prefix === "release" && (
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path d="M3 11.5 9.5 5l-1-1L2 10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                    {template.prefix === "docs" && (
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path d="M3 1.5h6L11.5 4v8.5H3v-11Z" stroke="currentColor" strokeWidth="1.2"/>
                      </svg>
                    )}
                  </span>
                  <span className="tpl-text">
                    <span className="tpl-prefix">{template.prefix}</span>
                    <span className="tpl-title">{template.label}</span>
                  </span>
                  <svg className="tpl-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M3 6h6M6 3l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT column — AI Plan status */}
        <div className="ai-plan">
          <header className="ai-plan-head">
            <h2>AI Workspace Plan</h2>
            {result?.pr ? (
              <a className="btn primary compact" href={result.pr.html_url} target="_blank" rel="noreferrer">
                <GitPullRequest size={12} style={{ marginRight: 4 }} />
                PR #{result.pr.number}
              </a>
            ) : result ? (
              <button className="btn primary compact" onClick={requestDraftPrApproval}>
                <GitPullRequest size={12} style={{ marginRight: 4 }} />
                Create Draft PR
              </button>
            ) : null}
          </header>

          <div className="progress-strip">
            <div className="progress-meta">
              <span className={`progress-pct ${displayedPercent === 0 ? "zero" : ""}`}>
                {displayedPercent}%
              </span>
              <span className="progress-status">{flow.label}</span>
            </div>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${displayedPercent}%`,
                  height: "100%",
                  background: flowStage === "failed" ? "var(--red)" : "var(--brand)",
                  transition: "width 0.4s ease"
                }}
              />
            </div>
            <div className="progress-label">{flow.note}</div>
          </div>

          <div className="plan-body">
            {!result ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", minHeight: "260px" }}>
                <div className="status-pill" style={{ marginBottom: 12 }}>
                  <span className="dot"></span>
                  Awaiting Input
                </div>
                <div style={{ maxWidth: "260px", textAlign: "center", color: "var(--text-muted)" }}>
                  <strong style={{ color: "var(--text)", display: "block", marginBottom: "6px" }}>Ready to generate</strong>
                  Provide a spec on the left and choose a recipe to start planning.
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <div className="plan-handoff-title mono" style={{ fontSize: "11px", textTransform: "uppercase" }}>
                    Proposed Branch Handoff
                  </div>
                  <div className="card" style={{ padding: "12px", border: "1px solid var(--line)" }}>
                    <strong style={{ display: "block", fontSize: "13.5px", marginBottom: "8px" }}>
                      {result.prTitle}
                    </strong>

                    <label className="field-label" htmlFor="base-branch" style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "10px", display: "block" }}>
                      Destination branch
                    </label>
                    <input
                      id="base-branch"
                      className="input compact"
                      value={baseBranch}
                      onChange={(event) => setBaseBranch(event.target.value)}
                      placeholder="develop"
                      style={{ width: "100%", marginTop: "4px", fontSize: "12.5px" }}
                    />
                    {baseBranchMessage && (
                      <p style={{ fontSize: "11px", color: baseBranchCheck === "exists" ? "var(--green)" : "var(--yellow)", marginTop: "4px", marginBottom: "12px" }}>
                        {baseBranchMessage}
                      </p>
                    )}

                    <label className="field-label" htmlFor="feature-branch" style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "10px", display: "block" }}>
                      {useExistingSourceBranch ? "Source branch" : "Feature branch"}
                    </label>
                    <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                      <input
                        id="feature-branch"
                        className="input compact"
                        value={branchName}
                        onChange={(event) => setBranchName(event.target.value)}
                        placeholder="feat/heading-color"
                        style={{ flex: 1, fontSize: "12.5px" }}
                      />
                      {!useExistingSourceBranch && (
                        <button className="btn" type="button" onClick={() => setBranchName(`${result.suggestedBranch}-${Date.now().toString().slice(-4)}`)}>
                          <RefreshCw size={12} />
                        </button>
                      )}
                    </div>
                    {branchMessage && (
                      <p style={{ fontSize: "11px", color: branchCheck === "available" ? "var(--green)" : "var(--yellow)", marginTop: "4px", marginBottom: "0" }}>
                        {branchMessage}
                      </p>
                    )}
                  </div>
                </div>

                <div>
                  <div className="plan-handoff-title mono" style={{ fontSize: "11px", textTransform: "uppercase" }}>
                    Decomposed Tasks
                  </div>
                  <div className="plan-stages">
                    {result.tasks.map((task, idx) => (
                      <div className="stage" key={idx}>
                        <div className="stage-num">{idx + 1}</div>
                        <div className="stage-name">{task.title}</div>
                        <div className="stage-meta">{task.files[0]}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {result.suggestedReviewers.length > 0 && (
                  <div>
                    <div className="plan-handoff-title mono" style={{ fontSize: "11px", textTransform: "uppercase", marginBottom: "6px" }}>
                      Suggested Reviewers
                    </div>
                    <div style={{ display: "flex", gap: "6px" }}>
                      {result.suggestedReviewers.map((reviewer) => (
                        <span className="status-pill passed" key={reviewer}>
                          @{reviewer}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className="plan-handoff-title mono" style={{ fontSize: "11px", textTransform: "uppercase", marginBottom: "6px" }}>
                    Developer Handoff Note
                  </div>
                  <pre className="code-view" style={{ maxHeight: "160px", fontSize: "11.5px", padding: "10px", background: "var(--panel-2)", border: "1px solid var(--line)" }}>
                    {scaffoldText}
                  </pre>
                </div>

                <div style={{ marginTop: "auto", display: "flex", gap: "8px" }}>
                  <button className="btn" style={{ flex: 1 }} onClick={() => navigator.clipboard.writeText(scaffoldText)}>
                    <Copy size={12} style={{ marginRight: 6 }} />
                    Copy Scaffold
                  </button>
                  {result.pr ? (
                    <a className="btn primary" style={{ flex: 1, justifyContent: "center" }} href={result.pr.html_url} target="_blank" rel="noreferrer">
                      <GitPullRequest size={12} style={{ marginRight: 6 }} />
                      Open Draft PR
                    </a>
                  ) : (
                    <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={requestDraftPrApproval}>
                      <GitPullRequest size={12} style={{ marginRight: 6 }} />
                      Create Draft PR
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
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
