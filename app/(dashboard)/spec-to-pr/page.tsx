"use client";

import { Copy, ExternalLink, FileText, GitPullRequest, Loader2, Play, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApprovalGate } from "@/components/approval-gate/ApprovalGate";
import { CloseDraftPrModal } from "@/components/pr-sync/CloseDraftPrModal";
import { RichTextEditor } from "@/components/spec-editor/RichTextEditor";
import { InputModal } from "@/components/ui/InputModal";
import { Toast, useToast } from "@/components/ui/Toast";
import { DEFAULT_SPEC_PR_RECIPES, type SpecPrRecipe } from "@/lib/spec-recipes";

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
const selectedSpecRecipeStorageKey = "shipbrain:selected-spec-pr-recipe";

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

export default function SpecToPrPage() {
  const aiPlanRef = useRef<HTMLDivElement | null>(null);
  const [spec, setSpec] = useState("");
  const [repo, setRepo] = useState("JeevantheDev/shipbrain_sandbox");
  const [result, setResult] = useState<SpecResult | null>(null);
  const [status, setStatus] = useState("Idle");
  const [isConfirmingPr, setIsConfirmingPr] = useState(false);
  const [gateCountdown, setGateCountdown] = useState(3.0);
  const [prTitle, setPrTitle] = useState("");
  const [reviewers, setReviewers] = useState<string[]>([]);
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
  const [quickPrTemplates, setQuickPrTemplates] = useState<SpecPrRecipe[]>(DEFAULT_SPEC_PR_RECIPES);
  const [retryCountdown, setRetryCountdown] = useState(0);

  // Modal states for styled prompts
  const [branchModal, setBranchModal] = useState<{ open: boolean; defaultValue: string }>({ open: false, defaultValue: "" });
  const [baseModal, setBaseModal] = useState<{ open: boolean; defaultValue: string }>({ open: false, defaultValue: "" });
  const [taskEditModal, setTaskEditModal] = useState<{ open: boolean; taskIndex: number; defaultValue: string }>({ open: false, taskIndex: -1, defaultValue: "" });

  // Toast notifications
  const { toast, showToast, hideToast } = useToast();

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

  const selectedQuickTemplate = useMemo(
    () => quickPrTemplates.find((item) => item.id === quickTemplateId),
    [quickPrTemplates, quickTemplateId]
  );
  const sampleTemplateId = useMemo(
    () => quickPrTemplates.find((item) => item.isSample)?.id ?? quickPrTemplates[0]?.id ?? "",
    [quickPrTemplates]
  );
  const useExistingSourceBranch = Boolean(selectedQuickTemplate?.sourceBranch) || (branchName === "develop" && baseBranch === "main");
  const flow = flowCopy[flowStage];
  const displayedPercent = flowStage === "planning" || flowStage === "creating_pr" ? livePercent : flow.percent;

  const scaffoldText = useMemo(() => {
    if (!result || !result.scaffold) return "";
    return Object.entries(result.scaffold)
      .map(([filename, content]) => `// ${filename}\n${content}`)
      .join("\n\n");
  }, [result]);

  useEffect(() => {
    let cancelled = false;
    async function loadActiveRepo() {
      const response = await fetch("/api/github/active-repo", { cache: "no-store" }).catch(() => null);
      if (!response?.ok) return;
      const json = await response.json();
      if (!cancelled && json.activeRepoFullName) setRepo(json.activeRepoFullName);
    }
    function handleActiveRepo(event: Event) {
      const nextRepo = (event as CustomEvent<string>).detail;
      if (nextRepo) setRepo(nextRepo);
    }
    async function loadRecipes() {
      const response = await fetch("/api/spec-recipes", { cache: "no-store" }).catch(() => null);
      if (!response?.ok) return;
      const json = await response.json().catch(() => ({}));
      if (!cancelled && Array.isArray(json.recipes) && json.recipes.length > 0) {
        setQuickPrTemplates(json.recipes);
      }
    }
    void loadActiveRepo();
    void loadRecipes();
    void loadRecentRuns();
    const interval = window.setInterval(() => void loadRecentRuns(), 30000);
    window.addEventListener("shipbrain:active-repo", handleActiveRepo);
    const handleRefetch = () => {
      void loadActiveRepo();
      void loadRecipes();
      void loadRecentRuns();
    };
    window.addEventListener("shipbrain-refetch", handleRefetch);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("shipbrain:active-repo", handleActiveRepo);
      window.removeEventListener("shipbrain-refetch", handleRefetch);
    };
  }, []);

  useEffect(() => {
    function consumeSelectedRecipe(recipeId: string | null) {
      if (!recipeId) return;
      if (!quickPrTemplates.some((item) => item.id === recipeId)) return;
      applyQuickTemplate(recipeId);
      window.localStorage.removeItem(selectedSpecRecipeStorageKey);
    }

    consumeSelectedRecipe(window.localStorage.getItem(selectedSpecRecipeStorageKey));

    function handleSelectedRecipe(event: Event) {
      consumeSelectedRecipe((event as CustomEvent<string>).detail);
    }

    window.addEventListener("shipbrain:select-spec-pr-recipe", handleSelectedRecipe);
    return () => window.removeEventListener("shipbrain:select-spec-pr-recipe", handleSelectedRecipe);
  }, [quickPrTemplates]);

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
    setPrTitle(run.result.prTitle);
    setReviewers(run.result.suggestedReviewers || []);
    setIsConfirmingPr(false);
    setBranchName(run.branchName);
    setBaseBranch(run.baseBranch ?? "develop");
    setCurrentRunId(run.id);
    setError(run.error ?? "");
    setPrRetryAvailable(run.status !== "draft_created" && run.status !== "merged" && run.status !== "closed");
    setStatus(statusLabel(run));
    setFlowStage(run.status === "draft_created" || run.status === "merged" ? "ready" : run.status === "failed" || run.status === "closed" ? "failed" : run.status === "rejected" ? "cancelled" : "review");
  }

  function viewSyncedRecord(run: RecentPrRun) {
    loadRecentRun(run);
    showToast(`${recentStatusLabel(run)} record loaded`, "success");
    window.requestAnimationFrame(() => {
      aiPlanRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
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

  function canManageRecentRun(run: RecentPrRun) {
    return run.status === "pending_pr" || run.status === "draft_created";
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

  // Countdown timer for inline approval gate
  useEffect(() => {
    if (!isConfirmingPr) return;
    if (gateCountdown <= 0) {
      setIsConfirmingPr(false);
      void approvePr("");
      return;
    }
    const interval = window.setInterval(() => {
      setGateCountdown((current) => {
        const next = Math.max(0, parseFloat((current - 0.1).toFixed(1)));
        return next;
      });
    }, 100);
    return () => window.clearInterval(interval);
  }, [isConfirmingPr, gateCountdown]);

  // Keyboard shortcuts: ⌘⏎ (Generate PR) and ⌘Z/Esc (Cancel approval)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (spec.trim() && flowStage !== "planning" && flowStage !== "creating_pr" && !isConfirmingPr) {
          void generate();
        }
      }
      if (((e.metaKey || e.ctrlKey) && e.key === "z") || e.key === "Escape") {
        if (isConfirmingPr) {
          e.preventDefault();
          setIsConfirmingPr(false);
          setStatus("Cancelled");
          setFlowStage("cancelled");
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [spec, flowStage, isConfirmingPr]);

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
        setStatus(`AI provider quota cooling down. Retrying in ${seconds}s...`);
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
    setPrTitle(json.prTitle);
    setReviewers(json.suggestedReviewers);
    const template = selectedQuickTemplate;
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
    setGateCountdown(3.0);
    setIsConfirmingPr(true);
  }

  async function approvePr(note: string, retryAttempt = 0) {
    if (!result) return;
    setIsConfirmingPr(false);
    setGateOpen(false);
    setPrRetryAvailable(false);
    setRetryCountdown(0);
    setStatus("Creating GitHub Draft PR...");
    setFlowStage("creating_pr");
    setLivePercent(72);
    
    // Use the modified prTitle and reviewers if they have changed from defaults
    const finalPlan = {
      ...result,
      prTitle: prTitle.trim() || result.prTitle,
      suggestedReviewers: reviewers.length > 0 ? reviewers : result.suggestedReviewers
    };

    const response = await fetch("/api/ai/spec-to-pr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        rawSpec: spec,
        repoFullName: repo,
        createPr: true,
        approvalNote: note,
        plan: finalPlan,
        branchOverride: branchName.trim(),
        baseBranchOverride: baseBranch.trim(),
        useExistingSourceBranch,
        specId: currentRunId
      })
    });
    const json = await response.json();
    if (!response.ok) {
      const apiError = json as ApiError;
      if (apiError.retryable && retryAttempt < 1) {
        const seconds = retryDelay(apiError);
        setRetryCountdown(seconds);
        setStatus(`AI provider quota cooling down. Retrying Draft PR in ${seconds}s...`);
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
      updateRecentRun("failed", finalPlan, [apiError.error ?? "Unable to create Draft PR.", apiError.detail].filter(Boolean).join(" "));
      return;
    }
    const nextResult = { ...json, suggestedBranch: branchName.trim() };
    setResult(nextResult);
    setStatus(json.warning ? "Draft PR ready - reviewers skipped" : "Draft PR ready");
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
    setPrTitle("");
    setReviewers([]);
    setIsConfirmingPr(false);
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

  const activeRecentRuns = recentRuns.filter(canManageRecentRun).slice(0, 5);
  const syncedRecentRuns = recentRuns.filter((run) => !canManageRecentRun(run)).slice(0, 3);

  const uniqueFilesCount = useMemo(() => {
    if (!result || !result.tasks) return 0;
    const files = new Set<string>();
    result.tasks.forEach((t) => t.files.forEach((f) => files.add(f)));
    return files.size;
  }, [result]);

  const totalLoc = useMemo(() => {
    if (!result || !result.tasks) return 0;
    return result.tasks.reduce((sum, t) => sum + (t.estimatedLines ?? t.files.length * 30 + 10), 0);
  }, [result]);

  const estMin = useMemo(() => {
    if (!result || !result.tasks) return 0;
    return Math.max(2, Math.round(totalLoc / 12));
  }, [result, totalLoc]);

  return (
    <>
      <header className="page-head">
        <div>
          <div className="eyebrow mono">
            <span className="bar"></span>
            <span className="pillar-tag">Pillar 01</span>
            Spec-to-PR
          </div>
          <h1>Spec-to-PR</h1>
          <p className="sub">
            Decompose a ticket, inspect the developer handoff, then approve Draft PR creation for{" "}
            <span className="repo">{repo}</span>.
          </p>
        </div>
        <div className="head-meta mono">
          <span className={`status-pill ${flowStage === "ready" ? "passed" : flowStage === "failed" ? "failed" : flowStage === "planning" || flowStage === "creating_pr" ? "running" : flowStage === "review" ? "analyzing" : ""}`}>
            <span className="dot"></span>
            {isConfirmingPr ? "awaiting confirm" : flowStage === "idle" ? "idle" : flowStage === "sample" ? "recipe loaded" : flowStage === "planning" ? "decomposing" : flowStage === "review" ? "plan ready" : flowStage === "creating_pr" ? "creating pr" : flowStage === "ready" ? "pr ready" : flowStage === "failed" ? "failed" : "cancelled"}
          </span>
          <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>{isConfirmingPr ? `${gateCountdown}s left` : status}</span>
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

      <div className="editor-toolbar">
        <div className="toolbar-left">
        </div>

        <div className="toolbar-right">
          <button className="ghost-btn" type="button" disabled={!sampleTemplateId || flowStage === "planning" || flowStage === "creating_pr" || isConfirmingPr} style={{ opacity: (!sampleTemplateId || flowStage === "planning" || flowStage === "creating_pr" || isConfirmingPr) ? 0.5 : 1 }} onClick={() => applyQuickTemplate(sampleTemplateId)}>
            <span>Load sample ticket</span>
          </button>
          {isConfirmingPr || flowStage === "creating_pr" ? (
            <button className="btn-locked" type="button" disabled>
              <svg className="lock-ico" width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ marginRight: 6 }}>
                <rect x="2.5" y="5.5" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.2"/>
                <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" stroke="currentColor" stroke-width="1.2"/>
              </svg>
              <span className="running-label">
                <span className="top">Generate PR</span>
                <span className="bottom">{isConfirmingPr ? "awaiting gate confirm…" : "creating PR…"}</span>
              </span>
            </button>
          ) : (
            <button className="btn-primary" type="button" disabled={!spec.trim() || flowStage === "planning"} onClick={() => void generate()}>
              {flowStage === "planning" ? <Loader2 size={12} className="spin" style={{ marginRight: 4 }} /> : <Play size={12} style={{ marginRight: 4 }} />}
              Generate PR
              <span className="kbd-inline" style={{ marginLeft: 6 }}>⌘⏎</span>
            </button>
          )}
        </div>
      </div>

      <section className="workspace">
        <div className="stack">
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
                <div className="resume-row" key={run.id} style={{ borderColor: currentRunId === run.id ? "var(--brand)" : undefined }}>
                  <div className="pr-icon" title={recentStatusLabel(run)}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <circle cx="3.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.2"/>
                      <circle cx="3.5" cy="10.5" r="1.6" stroke="currentColor" stroke-width="1.2"/>
                      <circle cx="10.5" cy="10.5" r="1.6" stroke="currentColor" stroke-width="1.2"/>
                      <path d="M3.5 5v4M5 10.5h4M8 3 10 5 8 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </div>
                  <div>
                    <div className="resume-title">
                      <span className={`status-pill ${run.status === "draft_created" ? "passed" : ""}`}>
                        <span className="dot"></span>
                        {recentStatusLabel(run)}
                      </span>
                      <span style={{ marginLeft: 6 }}><strong>{run.result.prTitle}</strong></span>
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
                <div className="resume-row" key={run.id} style={{ borderColor: currentRunId === run.id ? "var(--brand)" : undefined }}>
                  <div className="pr-icon" style={{ color: "var(--success)", background: "rgba(63, 185, 80, 0.12)", borderColor: "rgba(63, 185, 80, 0.3)" }}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="m3 6.5 2 2 4-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
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
                    <div className="resume-meta">
                      PR #{run.result.pr?.number ?? "n/a"} · {recentStatusLabel(run)}
                    </div>
                  </div>
                  <button className="btn subtle" type="button" onClick={() => viewSyncedRecord(run)}>View synced record</button>
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

          <div className="editor-card">
            <div className="editor-tabs">
              <div className="editor-tab active">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ marginRight: 6 }}>
                  <path d="M3 1.5h4.5L9.5 3.5V10.5H3v-9Z" stroke="currentColor" strokeWidth="1.1"/>
                </svg>
                <span>ticket.md</span>
                {result ? (
                  <span className="dot-saved" title="saved"></span>
                ) : spec.trim() ? (
                  <span className="dot-unsaved"></span>
                ) : null}
              </div>
              <div className="editor-meta mono">
                {result ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span className="ready-pill">
                      <span className="dot"></span>
                      plan ready · {result.tasks?.length ?? 0} tasks
                    </span>
                  </div>
                ) : (
                  <>
                    <span>rich text</span>
                    <span>·</span>
                    <span>utf-8</span>
                  </>
                )}
              </div>
            </div>

            <RichTextEditor
              value={spec}
              onChange={setSpec}
              placeholder="Paste a GitHub issue, or plain English spec…"
            />
          </div>

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
                        <path d="M5 1v3.5L1.5 11A1 1 0 0 0 2.4 12.5h9.2A1 1 0 0 0 12.5 11L9 4.5V1M4.5 1h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" stroke-linejoin="round"/>
                      </svg>
                    )}
                    {template.prefix === "feature" && (
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path d="M7 1 8.5 5.5 13 7l-4.5 1.5L7 13l-1.5-4.5L1 7l4.5-1.5L7 1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                      </svg>
                    )}
                    {template.prefix === "bug fix" && (
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <rect x="4" y="4" width="6" height="7" rx="3" stroke="currentColor" stroke-width="1.2"/>
                        <path d="M5 3.5 4 2M9 3.5 10 2" stroke="currentColor" stroke-width="1.2" strokeLinecap="round"/>
                      </svg>
                    )}
                    {template.prefix === "refactor" && (
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path d="M2 4h7l-2-2M12 10H5l2 2" stroke="currentColor" stroke-width="1.2" strokeLinecap="round" stroke-linejoin="round"/>
                      </svg>
                    )}
                    {template.prefix === "release" && (
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path d="M3 11.5 9.5 5l-1-1L2 10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    )}
                    {template.prefix === "docs" && (
                      <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path d="M3 1.5h6L11.5 4v8.5H3v-11Z" stroke="currentColor" stroke-width="1.2"/>
                      </svg>
                    )}
                  </span>
                  <span className="tpl-text">
                    <span className="tpl-prefix">{template.prefix}</span>
                    <span className="tpl-title">{template.label}</span>
                  </span>
                  <svg className="tpl-arrow" width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M3 6h6M6 3l3 3-3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="ai-plan" ref={aiPlanRef}>
          <header className="ai-plan-head">
            <h2>AI Plan</h2>
            <span className={`status-pill ${result ? "passed" : ""}`}>
              <span className="dot"></span>
              {result ? "plan ready" : "idle"}
            </span>
          </header>

          <div className="progress-strip">
            <div className="progress-meta">
              <span className={`progress-pct ${!result ? "zero" : ""}`}>
                {result ? "100%" : `${displayedPercent}%`}
              </span>
              <span className="progress-status" style={{ color: result ? "var(--success)" : "var(--text-muted)" }}>
                <span className="dot" style={{ background: result ? "var(--success)" : "var(--text-muted)" }}></span>
                {result ? `${result.tasks?.length ?? 0} of ${result.tasks?.length ?? 0} steps generated` : flow.label}
              </span>
            </div>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: result ? "100%" : `${displayedPercent}%`,
                  height: "100%",
                  background: result ? "var(--success)" : flowStage === "failed" ? "var(--red)" : "var(--brand)",
                  transition: "width 0.4s ease"
                }}
              />
            </div>
            <div className="progress-label">
              {result ? (
                <>
                  <span className="stat-num">~{totalLoc}</span> lines · <span className="stat-num">{uniqueFilesCount}</span> files touched · est. <span className="stat-num">~{estMin} min</span> to scaffold
                </>
              ) : (
                flow.note
              )}
            </div>
          </div>

          <div className="plan-body">
            {!result ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", minHeight: "360px" }}>
                <div className="plan-empty-title">Waiting for a ticket</div>
                <div className="plan-empty-desc">Paste a ticket or load the sample ticket to begin.</div>

                <div className="plan-stages" style={{ width: "100%", opacity: 0.4 }}>
                  <div className="stage">
                    <span className="stage-num">1</span>
                    <span className="stage-name">Decompose into tasks</span>
                    <span className="stage-meta">ai</span>
                  </div>
                  <div className="stage">
                    <span className="stage-num">2</span>
                    <span className="stage-name">Assign reviewer chips</span>
                    <span className="stage-meta">ai</span>
                  </div>
                  <div className="stage">
                    <span className="stage-num">3</span>
                    <span className="stage-name">Developer handoff</span>
                    <span className="stage-meta">human</span>
                  </div>
                  <div className="stage">
                    <span className="stage-num">4</span>
                    <span className="stage-name">Approve Draft PR</span>
                    <span className="stage-meta">gated</span>
                  </div>
                </div>

                <div className="plan-handoff-title mono" style={{ fontSize: 11, alignSelf: "flex-start", width: "100%" }}>Developer handoff preview</div>
                <div className="placeholder-skel" style={{ width: "100%" }}>
                  <span className="skel-line s-90"></span>
                  <span className="skel-line s-65"></span>
                  <span className="skel-line s-80"></span>
                  <span className="skel-line s-45"></span>
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>

                {/* Create Draft PR button at the top */}
                <div className="gate-zone" style={{ marginBottom: 8 }}>
                  <div className="gate-zone-label mono">
                    <span>Create Draft PR</span>
                    <span className={`gate-state ${result?.pr ? "passed" : ""}`}>
                      {result?.pr ? (
                        <>✓ created</>
                      ) : isConfirmingPr ? (
                        <>
                          <span className="live-dot"></span>reviewing · {gateCountdown}s left
                        </>
                      ) : (
                        <>ready</>
                      )}
                    </span>
                  </div>

                  {result?.pr ? (
                    <div className="gate-done" style={{ borderRadius: "4px" }}>
                      <div className="gate-done-left">
                        <span className="gate-check" aria-hidden="true">
                          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                            <path d="M2.5 6.5l2.2 2.2L9.5 3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </span>
                        <span>PR #{result.pr.number} created on <span style={{ fontFamily: "monospace", fontSize: "12.5px" }}>{repo}</span></span>
                      </div>
                      <a href={result.pr.html_url || `https://github.com/${repo}/pull/${result.pr.number}`} target="_blank" rel="noreferrer" className="link">
                        view on GitHub →
                      </a>
                    </div>
                  ) : isConfirmingPr ? (
                    <div className="gate" role="group" aria-label="Approval gate">
                      <div className="gate-summary-row">
                        <span className="gate-summary">
                          <span className="muted">Will open Draft PR to</span>{" "}
                          <span className="repo">{repo}</span>
                          <span className="muted">:</span>
                          <span className="repo">{baseBranch}</span>
                        </span>
                        <div className="gate-btns">
                          <button className="gate-btn ghost" type="button" onClick={() => setIsConfirmingPr(false)}>Cancel</button>
                          <button className="gate-btn primary" type="button" onClick={() => {
                            setIsConfirmingPr(false);
                            void approvePr("");
                          }}>
                            Confirm
                            <span className="countdown">{gateCountdown}s</span>
                          </button>
                        </div>
                      </div>
                      <div className="gate-progress" aria-hidden="true">
                        <div style={{
                          height: "100%",
                          width: `${((3.0 - gateCountdown) / 3.0) * 100}%`,
                          background: "var(--brand)",
                          transition: "width 0.1s linear"
                        }} />
                      </div>
                      <div className="gate-foot">
                        <span className="what-happens">opens · drafts only · reviewers not tagged yet</span>
                        <span className="undo-hint mono" style={{ fontSize: "10.5px", letterSpacing: "0.04em", textTransform: "uppercase" }}>⌘Z to cancel</span>
                      </div>
                    </div>
                  ) : (
                    <button className="gate-default" type="button" onClick={requestDraftPrApproval} style={{ width: "100%" }}>
                      <GitPullRequest size={14} style={{ marginRight: 6 }} />
                      Create Draft PR
                    </button>
                  )}
                </div>

                <div>
                  <div className="section-label mono" style={{ fontSize: "11px", marginBottom: "6px" }}>
                    <span>Pull request</span>
                    <span className="count">editable</span>
                  </div>
                  <div className="pr-form">
                    <div className="pr-title-wrap">
                      <span className="pr-title-prefix">title</span>
                      <input 
                        className="pr-title-input" 
                        type="text" 
                        value={prTitle} 
                        onChange={(e) => setPrTitle(e.target.value)} 
                        aria-label="PR title" 
                      />
                      <span className="pr-edit-ico" title="Edit title" aria-label="Edit title">
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                          <path d="M2 9.5V10h.5l5-5L7 4.5 2 9.5ZM7.5 4l1 1L10 3.5 9 2.5 7.5 4Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
                        </svg>
                      </span>
                    </div>
                    <div className="pr-chips-row">
                      <span className="pr-chip" onClick={() => setBranchModal({ open: true, defaultValue: branchName })}>
                        <span className="chip-label">branch</span>
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                          <circle cx="3" cy="2.5" r="1.2" stroke="currentColor" strokeWidth="1.1"/>
                          <circle cx="3" cy="9.5" r="1.2" stroke="currentColor" stroke-width="1.1"/>
                          <circle cx="9" cy="6" r="1.2" stroke="currentColor" stroke-width="1.1"/>
                          <path d="M3 4v4M4.2 9.5C7 9.5 7.8 8 7.8 7" stroke="currentColor" stroke-width="1.1"/>
                        </svg>
                        {branchName}
                        <span className="x" style={{ fontSize: "12px", marginLeft: "4px" }}>⋯</span>
                      </span>

                      <span className="pr-chip" onClick={() => setBaseModal({ open: true, defaultValue: baseBranch })}>
                        <span className="chip-label">base</span>
                        {baseBranch}
                        <span className="x" style={{ fontSize: "12px", marginLeft: "4px" }}>⋯</span>
                      </span>

                      {reviewers.map((reviewer) => (
                        <span className="pr-chip" key={reviewer}>
                          <span className="chip-label">reviewer</span>
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                            <circle cx="6" cy="4.5" r="2" stroke="currentColor" stroke-width="1.1"/>
                            <path d="M2.5 10.5c0-1.7 1.6-3 3.5-3s3.5 1.3 3.5 3" stroke="currentColor" stroke-width="1.1"/>
                          </svg>
                          @{reviewer}
                          <span className="x" title="Remove reviewer" onClick={(e) => {
                            e.stopPropagation();
                            setReviewers(reviewers.filter((r) => r !== reviewer));
                          }}>×</span>
                        </span>
                      ))}
                    </div>

                    {/* Branch validation status */}
                    {!useExistingSourceBranch && branchCheck !== "idle" && (
                      <div className="branch-validation-status" style={{
                        marginTop: "8px",
                        padding: "6px 10px",
                        borderRadius: "4px",
                        fontSize: "11px",
                        fontFamily: "'JetBrains Mono', monospace",
                        background: branchCheck === "available" ? "rgba(63, 185, 80, 0.1)" : branchCheck === "exists" ? "rgba(248, 81, 73, 0.1)" : branchCheck === "checking" ? "rgba(47, 129, 247, 0.1)" : "rgba(139, 148, 158, 0.1)",
                        color: branchCheck === "available" ? "var(--green)" : branchCheck === "exists" ? "var(--red)" : branchCheck === "checking" ? "var(--brand)" : "var(--text-muted)",
                        border: `1px solid ${branchCheck === "available" ? "rgba(63, 185, 80, 0.3)" : branchCheck === "exists" ? "rgba(248, 81, 73, 0.3)" : branchCheck === "checking" ? "rgba(47, 129, 247, 0.3)" : "var(--line)"}`
                      }}>
                        {branchCheck === "checking" && <span style={{ marginRight: "6px" }}>⏳</span>}
                        {branchCheck === "available" && <span style={{ marginRight: "6px" }}>✓</span>}
                        {branchCheck === "exists" && <span style={{ marginRight: "6px" }}>✗</span>}
                        {branchMessage}
                      </div>
                    )}

                    {/* Base branch validation status */}
                    {baseBranchCheck !== "idle" && baseBranchCheck !== "exists" && (
                      <div className="branch-validation-status" style={{
                        marginTop: "6px",
                        padding: "6px 10px",
                        borderRadius: "4px",
                        fontSize: "11px",
                        fontFamily: "'JetBrains Mono', monospace",
                        background: baseBranchCheck === "missing" ? "rgba(248, 81, 73, 0.1)" : baseBranchCheck === "checking" ? "rgba(47, 129, 247, 0.1)" : "rgba(139, 148, 158, 0.1)",
                        color: baseBranchCheck === "missing" ? "var(--red)" : baseBranchCheck === "checking" ? "var(--brand)" : "var(--text-muted)",
                        border: `1px solid ${baseBranchCheck === "missing" ? "rgba(248, 81, 73, 0.3)" : baseBranchCheck === "checking" ? "rgba(47, 129, 247, 0.3)" : "var(--line)"}`
                      }}>
                        {baseBranchCheck === "checking" && <span style={{ marginRight: "6px" }}>⏳</span>}
                        {baseBranchCheck === "missing" && <span style={{ marginRight: "6px" }}>✗</span>}
                        {baseBranchMessage}
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <div className="section-label mono" style={{ fontSize: "11px", marginBottom: "6px" }}>
                    <span>Tasks</span>
                    <span className="count">{result.tasks?.length ?? 0} · ~{totalLoc} LOC</span>
                  </div>
                  <div className="task-list">
                    {(result.tasks || []).map((task, idx) => {
                      const fileCount = task.files.length;
                      const estLines = task.estimatedLines ?? (fileCount * 30 + 10);
                      return (
                        <article className="task" key={idx}>
                          <div className="task-row1">
                            <span className="task-num">{idx + 1}</span>
                            <span className="task-title">{task.title}</span>
                            <span className="task-loc">~{estLines} lines</span>
                            <button className="task-edit" type="button" aria-label="Edit task" onClick={() => {
                              setTaskEditModal({ open: true, taskIndex: idx, defaultValue: task.title });
                            }}>
                              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                                <path d="M2 9.5V10h.5l5-5L7 4.5 2 9.5ZM7.5 4l1 1L10 3.5 9 2.5 7.5 4Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
                              </svg>
                            </button>
                          </div>
                          <p className="task-desc">{task.description}</p>
                          <div className="task-files">
                            {task.files.map((file) => {
                              const isNew = result.scaffold && result.scaffold[file] !== undefined;
                              return (
                                <span className={`task-file ${isNew ? "new" : "modify"}`} key={file}>
                                  <span className="ftype">{isNew ? "new" : "mod"}</span>
                                  {file}
                                </span>
                              );
                            })}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="plan-handoff-title mono" style={{ fontSize: "11px", textTransform: "uppercase", marginBottom: "6px" }}>
                    Developer Handoff Preview
                  </div>
                  <pre className="code-view" style={{ maxHeight: "140px", overflowY: "auto", fontSize: "11.5px", padding: "10px", background: "var(--panel-2)", border: "1px solid var(--line)" }}>
                    {scaffoldText}
                  </pre>
                  <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                    <button className="btn" style={{ flex: 1 }} onClick={() => {
                      void navigator.clipboard.writeText(scaffoldText);
                      showToast("Developer handoff note copied to clipboard!", "success");
                    }}>
                      <Copy size={12} style={{ marginRight: 6 }} />
                      Copy Scaffold
                    </button>
                  </div>
                </div>

              </div>
            )}
          </div>
        </div>
      </section>

      {successOpen && result?.pr ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setSuccessOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h2>Draft PR created successfully</h2>
            <p>
              ShipBrain opened Draft PR #{result.pr.number} from <strong>{branchName}</strong> into <strong>{baseBranch}</strong>. {useExistingSourceBranch ? "Review and merge the promotion PR when production approval is ready." : "Continue developer commits on this same feature branch, then review and merge when ready."}
            </p>
            <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: 16 }}>
              <button className="button secondary" onClick={() => setSuccessOpen(false)}>Close</button>
              <a className="button primary" href={result.pr.html_url || `https://github.com/${repo}/pull/${result.pr.number}`} target="_blank" rel="noreferrer">
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

      {/* Branch name input modal */}
      <InputModal
        open={branchModal.open}
        title="Edit Branch Name"
        label="Feature branch name"
        placeholder="feature/my-feature"
        defaultValue={branchModal.defaultValue}
        confirmLabel="Update"
        onClose={() => setBranchModal({ open: false, defaultValue: "" })}
        onConfirm={(value) => {
          if (value.trim()) setBranchName(value.trim());
          setBranchModal({ open: false, defaultValue: "" });
        }}
      />

      {/* Base branch input modal */}
      <InputModal
        open={baseModal.open}
        title="Edit Destination Branch"
        label="Destination branch"
        placeholder="develop"
        defaultValue={baseModal.defaultValue}
        confirmLabel="Update"
        onClose={() => setBaseModal({ open: false, defaultValue: "" })}
        onConfirm={(value) => {
          if (value.trim()) setBaseBranch(value.trim());
          setBaseModal({ open: false, defaultValue: "" });
        }}
      />

      {/* Task title edit modal */}
      <InputModal
        open={taskEditModal.open}
        title="Edit Task Title"
        label="Task title"
        placeholder="Enter task title"
        defaultValue={taskEditModal.defaultValue}
        confirmLabel="Save"
        onClose={() => setTaskEditModal({ open: false, taskIndex: -1, defaultValue: "" })}
        onConfirm={(value) => {
          if (result && result.tasks && taskEditModal.taskIndex >= 0) {
            const updatedTasks = [...result.tasks];
            updatedTasks[taskEditModal.taskIndex] = { ...updatedTasks[taskEditModal.taskIndex], title: value };
            setResult({ ...result, tasks: updatedTasks });
          }
          setTaskEditModal({ open: false, taskIndex: -1, defaultValue: "" });
        }}
      />

      {/* Toast notifications */}
      <Toast
        open={toast.open}
        message={toast.message}
        type={toast.type}
        onClose={hideToast}
      />
    </>
  );
}

function renderFormattedSpec(text: string) {
  return text.split("\n").map((line, idx) => {
    let content: ReactNode = line;

    if (line.startsWith("# ")) {
      content = <span className="h1">{line}</span>;
    } else if (line.startsWith("## ")) {
      content = <span className="h2">{line}</span>;
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      const rest = line.substring(2);
      content = (
        <>
          <span className="bullet">- </span>
          {renderInlineCode(rest)}
        </>
      );
    } else {
      content = renderInlineCode(line);
    }

    return (
      <div key={idx} style={{ minHeight: "1.45em" }}>
        {content}
      </div>
    );
  });
}

function renderInlineCode(text: string) {
  const parts = text.split("`");
  return parts.map((part, idx) => {
    if (idx % 2 === 1) {
      return (
        <span key={idx} className="code-inline">
          {part}
        </span>
      );
    }
    return renderSpecMeta(part);
  });
}

function renderSpecMeta(text: string) {
  const tokens = text.split(/(\bType:\s*\w+|\bPriority:\s*\w+|\bReporter:\s*\S+@\S+|\b\d+\b)/gi);
  return tokens.map((token, idx) => {
    if (/^Type:\s*/i.test(token) || /^Priority:\s*/i.test(token)) {
      return <span key={idx} className="label-key">{token}</span>;
    }
    if (/^Reporter:\s*/i.test(token)) {
      return (
        <span key={idx}>
          <span className="label-key">Reporter: </span>
          <span className="muted">{token.replace(/^Reporter:\s*/i, "")}</span>
        </span>
      );
    }
    if (/^\d+$/.test(token)) {
      return <span key={idx} className="num">{token}</span>;
    }
    if (token === "·") {
      return <span key={idx} className="muted"> · </span>;
    }
    return token;
  });
}
