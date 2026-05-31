"use client";

import { Check, ChevronDown, Copy, ExternalLink, Github, Lock, RefreshCw, Search, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePasswordConfirmation } from "@/components/ui/usePasswordConfirmation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type Repo = {
  id: number;
  full_name: string;
  default_branch: string;
  private?: boolean;
  connected?: boolean;
};

type RepoScan = {
  repo: string;
  workflowsDirectory: boolean;
  workflows: { ci: boolean; deploy: boolean; incidents: boolean; notify: boolean };
  branches: {
    develop: boolean;
    main: boolean;
    master: boolean;
    productionBranch: string | null;
    developmentBranch: string | null;
    scenario: string;
  };
  project: { packageJson: boolean; wranglerToml: boolean; node: boolean };
};

type SetupEvent = { label: string; status: "running" | "done" | "error"; detail?: string };

const activeRepoEvent = "shipbrain:active-repo";

export function RepoOnboarding() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [query, setQuery] = useState("");
  const [selectedRepo, setSelectedRepo] = useState("");
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubLogin, setGithubLogin] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [error, setError] = useState("");
  const [scan, setScan] = useState<RepoScan | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [skipIncidents, setSkipIncidents] = useState(false);
  const [enableTelegram, setEnableTelegram] = useState(false);
  const [buildOutputDir, setBuildOutputDir] = useState("dist");
  const [buildCommand, setBuildCommand] = useState("npm run build");
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupDone, setSetupDone] = useState<any>(null);
  const [setupEvents, setSetupEvents] = useState<SetupEvent[]>([]);
  const [copied, setCopied] = useState(false);
  const [customProdBranch, setCustomProdBranch] = useState("");
  const [customDevBranch, setCustomDevBranch] = useState("");
  const [branchError, setBranchError] = useState("");
  const [apiKeyHidden, setApiKeyHidden] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>([]);
  const [showEnvVars, setShowEnvVars] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const repoSearchRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { confirmPassword, PasswordConfirmModal } = usePasswordConfirmation();

  const connectedRepos = useMemo(
    () => repos.filter((repo) => selectedRepos.includes(repo.full_name)),
    [repos, selectedRepos]
  );
  const activeRepo = repos.find((repo) => repo.full_name === selectedRepo) ?? null;
  const filteredRepos = repos.filter((repo) => repo.full_name.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  const needsCustomBranches = scan?.branches.scenario === "custom_required";
  const customBranchesReady = !needsCustomBranches || Boolean(customProdBranch.trim());
  const canSubmit = Boolean(activeRepo && scan && customBranchesReady && !setupBusy);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  useEffect(() => {
    setMounted(true);
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    window.setTimeout(() => {
      repoSearchRef.current?.focus();
      const first = modalRef.current?.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      if (!repoSearchRef.current) first?.focus();
    }, 0);
  }, [modalOpen, setupDone, githubConnected]);

  async function bootstrap() {
    try {
      const supabase = getSupabaseBrowserClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.email) {
        setUserEmail(user.email);
      }
    } catch (e) {
      console.error("Failed to fetch user email during bootstrap:", e);
    }

    const connected = await loadConnection();
    if (connected) {
      await loadRepos();
    } else {
      setLoading(false);
      setModalOpen(true);
    }
  }

  async function loadConnection() {
    try {
      const response = await fetch("/api/github/connection", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Unable to check GitHub connection");
      setGithubConnected(Boolean(json.connected));
      setGithubLogin(json.githubLogin ?? "");
      return Boolean(json.connected);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to check GitHub connection");
      return false;
    }
  }

  async function connectGithub() {
    setError("");
    setLoading(true);
    try {
      const supabase = getSupabaseBrowserClient();
      
      // Auto-unlink any stale GitHub identity if it is already in Supabase Auth
      try {
        const { data: { user } } = await supabase.auth.getUser();
        const githubIdentity = user?.identities?.find((id) => id.provider === "github");
        if (githubIdentity) {
          await supabase.auth.unlinkIdentity(githubIdentity);
        }
      } catch (e) {
        console.warn("Could not check/unlink stale GitHub identity during connect:", e);
      }

      const { data, error } = await supabase.auth.linkIdentity({
        provider: "github",
        options: {
          redirectTo: `${window.location.origin}/auth/callback`,
          scopes: "repo read:org write:repo_hook workflow",
          queryParams: {
            prompt: "consent"
          }
        }
      });
      if (error) throw error;
      if (data?.url) {
        window.location.href = data.url;
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to connect GitHub");
      setLoading(false);
    }
  }

  async function disconnectGithub() {
    if (!confirm("Disconnect from GitHub? This will clear your GitHub credentials in ShipBrain.")) return;
    setLoading(true);
    setError("");
    try {
      const supabase = getSupabaseBrowserClient();
      
      // Unlink the GitHub identity from Supabase Auth if it exists
      try {
        const { data: { user } } = await supabase.auth.getUser();
        const githubIdentity = user?.identities?.find((id) => id.provider === "github");
        if (githubIdentity) {
          await supabase.auth.unlinkIdentity(githubIdentity);
        }
      } catch (e) {
        console.error("Failed to unlink GitHub identity from Supabase Auth:", e);
      }

      const response = await fetch("/api/github/connection", { method: "DELETE" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Unable to disconnect GitHub");
      setGithubConnected(false);
      setGithubLogin("");
      setRepos([]);
      setSelectedRepos([]);
      setSelectedRepo("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to disconnect GitHub");
    } finally {
      setLoading(false);
    }
  }

  async function loadRepos(preferredRepo?: string | null) {
    setLoading(true);
    setError("");
    try {
      const [response, activeResponse] = await Promise.all([
        fetch("/api/github/repos", { cache: "no-store" }),
        fetch("/api/github/active-repo", { cache: "no-store" })
      ]);
      const json = await response.json();
      if (!response.ok) {
        if (json.requiresGithub) setGithubConnected(false);
        throw new Error(json.error ?? "Unable to load repositories");
      }
      const activeJson = activeResponse.ok ? await activeResponse.json() : {};
      setRepos(json);
      const connected = json.filter((repo: Repo) => repo.connected).map((repo: Repo) => repo.full_name);
      const activeFromDb = typeof activeJson.activeRepoFullName === "string" ? activeJson.activeRepoFullName : "";
      const connectedSet = new Set(connected);
      const activeConnectedRepo = preferredRepo && connectedSet.has(preferredRepo)
        ? preferredRepo
        : activeFromDb && connectedSet.has(activeFromDb)
          ? activeFromDb
          : connected[0] ?? "";
      const fallbackRepo = json.find((repo: Repo) => repo.full_name.endsWith("/shipbrain_sandbox"))?.full_name ?? json[0]?.full_name ?? "";
      const nextSelectedRepo = activeConnectedRepo || fallbackRepo;
      setSelectedRepos(connected);
      setSelectedRepo(nextSelectedRepo);
      if (activeConnectedRepo && activeConnectedRepo !== activeFromDb) {
        await persistActiveRepo(activeConnectedRepo, false);
      }
      if (!connected.length) setModalOpen(true);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load repositories");
    } finally {
      setLoading(false);
    }
  }

  async function selectRepo(repo: Repo) {
    setSelectedRepo(repo.full_name);
    setQuery(repo.full_name);
    setSetupDone(null);
    if (repo.connected) await persistActiveRepo(repo.full_name);
    await scanRepo(repo.full_name);
  }

  async function scanRepo(repoFullName = selectedRepo) {
    if (!repoFullName) return;
    setScanLoading(true);
    setScan(null);
    setError("");
    try {
      const params = new URLSearchParams({ repo: repoFullName });
      const response = await fetch(`/api/github/repo-scan?${params.toString()}`, { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to scan repository");
      setScan(json);
      setCustomProdBranch(json.branches?.productionBranch ?? "");
      setCustomDevBranch(json.branches?.developmentBranch ?? "");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to scan repository");
    } finally {
      setScanLoading(false);
    }
  }

  async function createDevelopBranch() {
    if (!scan) return;
    setScanLoading(true);
    setError("");
    try {
      const response = await fetch("/api/github/repo-scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: scan.repo, productionBranch: scan.branches.productionBranch ?? activeRepo?.default_branch ?? "main" })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Couldn't create the branch.");
      setScan(json);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Couldn't create the branch.");
    } finally {
      setScanLoading(false);
    }
  }

  async function validateCustomBranches() {
    if (!scan) return;
    setBranchError("");
    if (!customProdBranch.trim() || /\s/.test(customProdBranch)) {
      setBranchError("Production branch is required and cannot contain spaces.");
      return;
    }
    if (customDevBranch && /\s/.test(customDevBranch)) {
      setBranchError("Development branch cannot contain spaces.");
      return;
    }
    setScanLoading(true);
    try {
      const response = await fetch("/api/github/repo-scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "validate_custom",
          repo: scan.repo,
          productionBranch: customProdBranch.trim(),
          developmentBranch: customDevBranch.trim()
        })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to validate branches.");
      setScan(json);
    } catch (nextError) {
      setBranchError(nextError instanceof Error ? nextError.message : "Unable to validate branches.");
    } finally {
      setScanLoading(false);
    }
  }

  async function submitSetup() {
    if (!activeRepo) return;
    const reauthPassword = await confirmPassword({
      title: "Confirm repo connection",
      description: "Enter your ShipBrain password before connecting a new repo, injecting secrets, and opening setup PRs."
    });
    if (!reauthPassword) return;
    setSetupBusy(true);
    setError("");
    setSetupDone(null);
    setSetupEvents([]);
    try {
      const response = await fetch("/api/github/repo-setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stream: true,
          repo: activeRepo,
          skipIncidents,
          enableTelegram,
          buildOutputDir: buildOutputDir.trim() || "dist",
          buildCommand: buildCommand.trim() || "npm run build",
          reauthPassword,
          productionBranch: customProdBranch.trim(),
          developmentBranch: customDevBranch.trim(),
          envVars: envVars.filter(e => e.key.trim()).reduce((acc, e) => ({ ...acc, [e.key.trim()]: e.value }), {} as Record<string, string>),
          forceOverwrite: true // Always regenerate workflow files during onboarding
        })
      });
      if (!response.ok || !response.body) {
        const json = await response.json().catch(() => null);
        throw new Error(json?.detail ?? json?.error ?? "Repo setup failed");
      }
      const done = await readSetupStream(response.body);
      setSetupDone(done);
      setApiKeyHidden(false);
      window.setTimeout(() => setApiKeyHidden(true), 60000);
      const nextConnectedRepos = Array.from(new Set([...selectedRepos, activeRepo.full_name]));
      setSelectedRepos(nextConnectedRepos);
      await persistActiveRepo(activeRepo.full_name);
      await loadRepos(activeRepo.full_name);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Repo setup failed");
    } finally {
      setSetupBusy(false);
    }
  }

  async function readSetupStream(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let complete: any = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "step") {
          setSetupEvents((events) => upsertSetupEvent(events, event));
        } else if (event.type === "error") {
          setSetupEvents((events) => [...events, { label: "Setup paused", status: "error", detail: event.detail ?? event.error }]);
          throw new Error(event.detail ?? event.error ?? "Repo setup failed");
        } else if (event.type === "complete") {
          complete = event.data;
        }
      }
    }
    if (!complete) throw new Error("Repo setup ended before ShipBrain received the completion event.");
    return complete;
  }

  function upsertSetupEvent(events: SetupEvent[], event: any): SetupEvent[] {
    const next = { label: String(event.label), status: event.status as SetupEvent["status"], detail: event.detail as string | undefined };
    const existingIndex = events.findIndex((item) => item.label === next.label);
    if (existingIndex === -1) return [...events, next];
    return events.map((item, index) => index === existingIndex ? next : item);
  }

  async function copyApiKey() {
    if (!setupDone?.shipbrainApiKey) return;
    await navigator.clipboard.writeText(setupDone.shipbrainApiKey);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  async function persistActiveRepo(fullName: string, notify = true) {
    const response = await fetch("/api/github/active-repo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoFullName: fullName || null })
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to save active repository");
    if (notify) {
      window.dispatchEvent(new CustomEvent(activeRepoEvent, { detail: fullName }));
    }
  }

  async function changeActiveRepo(fullName: string) {
    setSelectedRepo(fullName);
    try {
      await persistActiveRepo(fullName);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to save active repository");
    }
  }

  function manageSecrets() {
    setModalOpen(false);
    window.location.href = "/settings/secrets";
  }

  async function disconnectRepo(fullName: string) {
    if (!confirm(`Disconnect ${fullName}? This will remove all specs and CI data for this repo.`)) return;
    setLoading(true);
    try {
      const response = await fetch("/api/github/repos", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullName })
      });
      if (!response.ok) {
        const json = await response.json();
        throw new Error(json.detail ?? json.error ?? "Unable to disconnect repo");
      }
      const nextSelectedRepos = selectedRepos.filter((name) => name !== fullName);
      setSelectedRepos(nextSelectedRepos);
      if (selectedRepo === fullName) {
        const nextRepo = nextSelectedRepos[0] ?? "";
        setSelectedRepo(nextRepo);
        await persistActiveRepo(nextRepo);
      }
      await loadRepos(nextSelectedRepos[0]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to disconnect repo");
    } finally {
      setLoading(false);
    }
  }

  function handleModalKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      setModalOpen(false);
      return;
    }
    if (event.key !== "Tab" || !modalRef.current) return;
    const focusable = Array.from(
      modalRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")
    ).filter((element) => !element.hasAttribute("disabled"));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <div className="repo-selector-container" ref={dropdownRef} style={{ position: "relative" }}>
        <button
          className="pill repo-pill"
          type="button"
          onClick={() => setDropdownOpen(!dropdownOpen)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ color: "var(--text-muted)" }}><path d="M2.5 1.5h6L10 3v7.5H2.5v-9Z" stroke="currentColor" strokeWidth={1.2}/><path d="M8.5 1.5V3H10" stroke="currentColor" strokeWidth={1.2}/></svg>
          <span style={{ maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {selectedRepo || "Connect Repository"}
          </span>
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" style={{ color: "var(--text-muted)" }}><path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>

        {dropdownOpen && (
          <div
            className="dropdown-menu"
            style={{
              position: "absolute",
              top: "100%",
              left: 0,
              marginTop: 6,
              background: "var(--panel)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              zIndex: 100,
              minWidth: 260,
              padding: 4,
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)"
            }}
          >
            {connectedRepos.length ? (
              connectedRepos.map((repo) => (
                <div
                  key={repo.id}
                  className="dropdown-item"
                  style={{
                    padding: "6px 10px",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: "12.5px",
                    color: repo.full_name === selectedRepo ? "var(--text)" : "var(--text-muted)",
                    background: repo.full_name === selectedRepo ? "var(--panel-2)" : "transparent",
                    transition: "background 100ms ease, color 100ms ease"
                  }}
                  onClick={() => {
                    changeActiveRepo(repo.full_name);
                    setDropdownOpen(false);
                  }}
                  onMouseEnter={(e) => {
                    if (repo.full_name !== selectedRepo) {
                      e.currentTarget.style.background = "var(--panel-3)";
                      e.currentTarget.style.color = "var(--text)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (repo.full_name !== selectedRepo) {
                      e.currentTarget.style.background = "transparent";
                      e.currentTarget.style.color = "var(--text-muted)";
                    }
                  }}
                >
                  {repo.full_name}
                </div>
              ))
            ) : (
              <div style={{ padding: "6px 10px", color: "var(--text-muted)", fontSize: "12.5px" }}>
                {githubConnected ? "Connect repositories" : "Connect GitHub"}
              </div>
            )}
            <div style={{ height: 1, background: "var(--line-muted)", margin: "4px 0" }} />
            <div
              className="dropdown-item"
              style={{
                padding: "6px 10px",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: "12.5px",
                color: "var(--brand-dark)",
                fontWeight: 500,
                transition: "background 100ms ease"
              }}
              onClick={() => {
                setModalOpen(true);
                setDropdownOpen(false);
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--panel-3)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              Manage repositories...
            </div>
          </div>
        )}
      </div>

      {mounted && modalOpen
        ? createPortal(
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setModalOpen(false)} onKeyDown={handleModalKeyDown}>
          <div className="modal scroll-safe repo-connect-modal" ref={modalRef} onClick={(event) => event.stopPropagation()}>
            <div className="toolbar" style={{ alignItems: "flex-start", marginBottom: 14 }}>
              <Github color="var(--brand)" />
              <div>
                <h2 style={{ marginBottom: 4 }}>Connect your repo</h2>
                <p style={{ marginBottom: 0 }}>ShipBrain handles everything: CI workflows, preview deployments, and production releases. Just connect your repo.</p>
              </div>
            </div>

            {error ? <div className="error-panel" role="alert"><strong>Setup needs attention</strong><p>{error}</p></div> : null}

            {!githubConnected ? (
              <div className="split-list">
                <div className="card">
                  <strong>Step 1: GitHub integration</strong>
                  <p>Connect GitHub so ShipBrain can list repos, write GitHub Actions secrets, and open the setup PR.</p>
                  
                  <p style={{ fontSize: "11.5px", color: "var(--text-muted)", margin: "12px 0 16px", textAlign: "left", lineHeight: "1.4" }}>
                    You will be redirected to the GitHub authorization page to connect your account.
                  </p>

                  <button className="button primary" onClick={connectGithub}>
                    <Github size={16} />
                    {loading ? "Connecting..." : "Connect GitHub"}
                  </button>
                </div>
              </div>
            ) : setupDone ? (
              <SetupSuccess setup={setupDone} copied={copied} hidden={apiKeyHidden} onShow={() => setApiKeyHidden(false)} onCopy={copyApiKey} />
            ) : (
              <div className="modal-scroll-area repo-connect-flow">
                {connectedRepos.length ? (
                  <div className="repo-connect-group">
                    <div className="eyebrow">Connected repositories</div>
                    <h3>Manage existing repos</h3>
                    <div className="connected-repo-list">
                      {connectedRepos.map((repo) => (
                        <div className={`connected-repo-row ${selectedRepo === repo.full_name ? "active" : ""}`} key={repo.id}>
                          <div>
                            <strong>{repo.full_name}</strong>
                            <p>{selectedRepo === repo.full_name ? "Currently active in ShipBrain" : "Connected to ShipBrain"}</p>
                          </div>
                          <div className="toolbar">
                            <button className="button secondary compact" onClick={() => changeActiveRepo(repo.full_name)} disabled={selectedRepo === repo.full_name}>
                              {selectedRepo === repo.full_name ? "Active" : "Use"}
                            </button>
                            <button className="button secondary compact" onClick={manageSecrets}>Secrets</button>
                            <button className="button secondary compact" onClick={() => disconnectRepo(repo.full_name)} title="Disconnect repo">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="secret-helper">Use Settings &rarr; Secrets to rotate keys or disconnect a repo.</p>
                  </div>
                ) : null}

                <div className="repo-connect-group">
                  <div className="eyebrow">Repository</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <label className="field-label" style={{ margin: 0 }}>
                      {connectedRepos.length ? "Connect another repository" : "Search your repositories"}
                    </label>
                    <span style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                      Connected as <strong>{githubLogin || "GitHub User"}</strong>{" "}
                      <button 
                        type="button" 
                        onClick={disconnectGithub} 
                        style={{ 
                          background: "none", 
                          border: "none", 
                          color: "var(--red)", 
                          cursor: "pointer", 
                          textDecoration: "underline", 
                          padding: 0,
                          marginLeft: 6
                        }}
                      >
                        Disconnect
                      </button>
                    </span>
                  </div>
                  <div className="repo-combobox">
                    <Search size={16} />
                    <input ref={repoSearchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search your repositories..." />
                    <ChevronDown size={16} />
                  </div>
                  <div className="repo-options">
                    {loading ? (
                      <div className="repo-option muted">Loading repositories...</div>
                    ) : filteredRepos.length ? (
                      filteredRepos.map((repo) => (
                        <button className="repo-option" key={repo.id} onClick={() => selectRepo(repo)}>
                          <Github size={16} />
                          <span>{repo.full_name}</span>
                          {repo.private ? <Lock size={13} /> : null}
                          {selectedRepo === repo.full_name ? <Check size={16} /> : null}
                        </button>
                      ))
                    ) : (
                      <div className="repo-option muted">No repositories found. Re-connect GitHub if a repo is missing.</div>
                    )}
                  </div>
                  <button className="button secondary compact" onClick={() => loadRepos(selectedRepo)} disabled={loading}>
                    <RefreshCw size={14} />
                    Refresh repos
                  </button>
                  {scanLoading ? <ScanLoading repo={selectedRepo} /> : scan ? (
                    <ScanPanel
                      scan={scan}
                      customProdBranch={customProdBranch}
                      customDevBranch={customDevBranch}
                      branchError={branchError}
                      onProdBranch={setCustomProdBranch}
                      onDevBranch={setCustomDevBranch}
                      onValidateCustom={validateCustomBranches}
                      onCreateDevelop={createDevelopBranch}
                    />
                  ) : null}
                </div>

                <div className="repo-connect-group">
                  <div className="eyebrow">Build Settings</div>
                  <h3>Deployment configuration</h3>
                  <div className="secret-field">
                    <label className="field-label">Build Command</label>
                    <div className="secret-input-row">
                      <input type="text" value={buildCommand} onChange={(event) => setBuildCommand(event.target.value)} placeholder="npm run build" />
                    </div>
                    <p className="secret-helper">Default is <code>npm run build</code>. Change this if your repo uses a custom command such as <code>npm run pages:build</code> or <code>pnpm build</code>.</p>
                  </div>
                  <div className="secret-field">
                    <label className="field-label">Build Output Directory</label>
                    <div className="secret-input-row">
                      <input type="text" value={buildOutputDir} onChange={(event) => setBuildOutputDir(event.target.value)} placeholder="dist" />
                    </div>
                    <p className="secret-helper">Directory containing your built files. Common values: dist, build, out, .next</p>
                  </div>
                  <div className="info-callout compact">
                    <strong>Automatic deployment</strong>
                    <p>ShipBrain automatically creates a Cloudflare Pages project and handles all deployments. Your app will be available at a <code>.pages.dev</code> domain.</p>
                  </div>
                </div>

                <div className="repo-connect-group">
                  <div className="eyebrow">Environment Variables</div>
                  <h3>Project Environment Variables</h3>
                  <p className="secret-helper" style={{ marginTop: 0 }}>
                    Add environment variables that your app needs at build time. These will be set on your Cloudflare Pages project.
                  </p>
                  {showEnvVars ? (
                    <>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                        {envVars.map((env, index) => (
                          <div key={index} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <input
                              type="text"
                              placeholder="KEY"
                              value={env.key}
                              onChange={(e) => {
                                const newEnvVars = [...envVars];
                                newEnvVars[index].key = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "");
                                setEnvVars(newEnvVars);
                              }}
                              style={{ flex: 1, fontFamily: "monospace", fontSize: 12 }}
                              className="input compact"
                            />
                            <input
                              type="text"
                              placeholder="value"
                              value={env.value}
                              onChange={(e) => {
                                const newEnvVars = [...envVars];
                                newEnvVars[index].value = e.target.value;
                                setEnvVars(newEnvVars);
                              }}
                              style={{ flex: 2, fontSize: 12 }}
                              className="input compact"
                            />
                            <button
                              className="btn subtle compact"
                              onClick={() => setEnvVars(envVars.filter((_, i) => i !== index))}
                              style={{ padding: "4px 8px" }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                      <button className="button secondary compact" onClick={() => setEnvVars([...envVars, { key: "", value: "" }])}>
                        + Add variable
                      </button>
                      {envVars.length === 0 && (
                        <button className="text-link" style={{ marginLeft: 12 }} onClick={() => setShowEnvVars(false)}>
                          Hide environment variables
                        </button>
                      )}
                    </>
                  ) : (
                    <button className="button secondary compact" onClick={() => { setShowEnvVars(true); setEnvVars([{ key: "", value: "" }]); }}>
                      + Add environment variables
                    </button>
                  )}
                </div>

                <div className="repo-connect-group">
                  <div className="eyebrow">Incident alerting</div>
                  <h3>ShipBrain Incident Alerting</h3>
                  {skipIncidents ? (
                    <CollapsedSetup label="ShipBrain incident alerting" onRestore={() => setSkipIncidents(false)} />
                  ) : (
                    <>
                      <p className="secret-helper" style={{ marginTop: 0 }}>
                        Monitor workflow failures and automatically create incidents in ShipBrain. No external API keys are required.
                      </p>
                      <button className="text-link" onClick={() => setSkipIncidents(true)}>Skip incident alerting -&gt;</button>
                    </>
                  )}
                </div>

                <div className="repo-connect-group">
                  <div className="eyebrow">Telegram</div>
                  <h3>Bot notifications</h3>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={enableTelegram}
                      onChange={(event) => setEnableTelegram(event.target.checked)}
                    />
                    <span>
                      Send release, incident, secret, and merged PR notifications to my linked Telegram chat.
                      <small>Link Telegram from Settings → Secrets after creating your bot with BotFather.</small>
                    </span>
                  </label>
                </div>

                {setupBusy || setupEvents.length ? <SetupProgress events={setupEvents} /> : null}
                {error && !setupBusy ? (
                  <div className="setup-progress">
                    <div className="setup-step"><XCircle size={16} color="var(--red)" /><span>Setup paused. Fix the issue above, then retry the failed step.</span></div>
                    <button className="button secondary compact" onClick={submitSetup}>Retry this step</button>
                  </div>
                ) : null}

                <div className="modal-actions">
                  <button className="button primary full-width" disabled={!canSubmit} onClick={submitSetup}>
                    <ShieldCheck size={16} />
                    {setupBusy ? "Setting up repo..." : "Connect repo and deploy"}
                  </button>
                  <button className="text-link" onClick={() => setModalOpen(false)}>Save progress and continue later</button>
                </div>
              </div>
            )}
          </div>
        </div>,
          document.body
        )
        : null}
      <PasswordConfirmModal />
    </>
  );
}

function ScanLoading({ repo }: { repo: string }) {
  return (
    <div className="scan-card">
      <strong>Scanning {repo}...</strong>
      <div className="progress-track" style={{ marginTop: 10 }}>
        <div className="progress-fill stream" style={{ width: "70%" }} />
      </div>
      <p>checking workflow files, branches, and project type</p>
    </div>
  );
}

function ScanPanel({
  scan,
  customProdBranch,
  customDevBranch,
  branchError,
  onProdBranch,
  onDevBranch,
  onValidateCustom,
  onCreateDevelop
}: {
  scan: RepoScan;
  customProdBranch: string;
  customDevBranch: string;
  branchError: string;
  onProdBranch: (value: string) => void;
  onDevBranch: (value: string) => void;
  onValidateCustom: () => void;
  onCreateDevelop: () => void;
}) {
  const attention = scan.workflows.ci || !scan.branches.develop || scan.branches.scenario === "custom_required";
  if (scan.branches.scenario === "custom_required") {
    return (
      <div className="scan-card warning">
        <strong>No standard branches found</strong>
        <p>ShipBrain could not detect main, master, or develop. Enter the branch names for this repo.</p>
        <label className="field-label">Production branch</label>
        <input className="input" value={customProdBranch} onChange={(event) => onProdBranch(event.target.value)} placeholder="main" />
        <label className="field-label">Development branch (optional)</label>
        <input className="input" value={customDevBranch} onChange={(event) => onDevBranch(event.target.value)} placeholder="develop" />
        {branchError ? <p role="alert" style={{ color: "var(--red)" }}>{branchError}</p> : null}
        <button className="button primary compact" onClick={onValidateCustom}>Confirm branches</button>
      </div>
    );
  }

  return (
    <div className={`scan-card ${attention ? "warning" : "ok"}`}>
      <strong>{scan.repo}</strong>
      <ScanRow label="shipbrain-ci.yml" ok={!scan.workflows.ci} detail={scan.workflows.ci ? "already exists - notify companion will be created" : "will be created"} warning={scan.workflows.ci} />
      <ScanRow label="shipbrain-deploy.yml" ok={!scan.workflows.deploy} detail={scan.workflows.deploy ? "already exists - kept as-is" : "will be created"} warning={scan.workflows.deploy} />
      <ScanRow label="shipbrain-incidents.yml" ok={!scan.workflows.incidents} detail={scan.workflows.incidents ? "already exists - kept as-is" : "will be created"} warning={scan.workflows.incidents} />
      <hr />
      <ScanRow label="develop" ok={scan.branches.develop} detail={scan.branches.develop ? "preview environment" : "not found"} />
      <ScanRow label={scan.branches.productionBranch ?? "production branch"} ok={Boolean(scan.branches.productionBranch)} detail={scan.branches.productionBranch ? "production environment" : "not found"} />
      <ScanRow label="package.json" ok={scan.project.packageJson} detail={scan.project.packageJson ? "Node.js project detected" : "not found - smoke only"} />
      {scan.workflows.deploy ? (
        <div className="branch-decision">
          <strong>Existing deploy workflow kept</strong>
          <p>ShipBrain will not overwrite it. Make sure it accepts workflow_dispatch inputs named release_tag and release_sha for the approval gate.</p>
        </div>
      ) : null}
      {!scan.branches.develop && scan.branches.productionBranch ? (
        <div className="branch-decision" role="alert">
          <strong>No develop branch found</strong>
          <p>ShipBrain recommends a develop branch so preview deploys are separate from production. Create it now from {scan.branches.productionBranch}?</p>
          <button className="button primary compact" onClick={onCreateDevelop}>Create develop branch</button>
        </div>
      ) : null}
    </div>
  );
}

function ScanRow({ label, ok, detail, warning }: { label: string; ok: boolean; detail: string; warning?: boolean }) {
  return (
    <div className="scan-row">
      {warning ? <span className="status amber">!</span> : ok ? <Check size={15} color="var(--green)" /> : <XCircle size={15} color="var(--red)" />}
      <span>{label}</span>
      <small>{detail}</small>
    </div>
  );
}

function CollapsedSetup({ label, onRestore }: { label: string; onRestore: () => void }) {
  return (
    <div className="collapsed-setup">
      <span className="dot amber" /> {label} skipped &middot; <button className="text-link" onClick={onRestore}>Set up now</button>
    </div>
  );
}

function SetupProgress({ events }: { events: SetupEvent[] }) {
  return (
    <div className="setup-progress">
      {events.length ? events.map((event) => (
        <div className="setup-step" key={event.label}>
          {event.status === "done" ? <Check size={16} color="var(--green)" /> : event.status === "error" ? <XCircle size={16} color="var(--red)" /> : <RefreshCw size={16} className="spin" />}
          <span>{event.status === "done" ? event.label.replace("Creating", "Created").replace("Injecting", "Injected").replace("Setting", "Set") : event.label}</span>
          {event.detail ? <small>{event.detail}</small> : null}
        </div>
      )) : (
        <div className="setup-step">
          <RefreshCw size={16} className="spin" />
          <span>Starting setup...</span>
        </div>
      )}
    </div>
  );
}

function SetupSuccess({ setup, copied, hidden, onShow, onCopy }: { setup: any; copied: boolean; hidden: boolean; onShow: () => void; onCopy: () => void }) {
  const [deployStarted, setDeployStarted] = useState(false);
  const [deployLoading, setDeployLoading] = useState(false);
  const [deployError, setDeployError] = useState("");

  async function startFirstDeploy() {
    setDeployLoading(true);
    setDeployError("");
    try {
      const response = await fetch("/api/deployments/start-initial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoFullName: setup.repoFullName || setup.repo,
          branch: "develop"
        })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to start deployment");
      setDeployStarted(true);
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : "Unable to start deployment");
    } finally {
      setDeployLoading(false);
    }
  }

  return (
    <div className="modal-scroll-area repo-connect-flow">
      <div className="success-panel">
        <strong>Your repo is connected!</strong>
        <p>ShipBrain has set up CI, preview deployments, and production releases for your repo.</p>
        {setup.pr?.html_url ? <a className="button primary compact" href={setup.pr.html_url} target="_blank" rel="noreferrer">Review setup PR on GitHub <ExternalLink size={14} /></a> : <span className="status green">Workflows already configured</span>}
      </div>

      {setup.cloudflareProjectUrl ? (
        <div className="info-callout">
          <strong>Cloudflare Pages Project Created</strong>
          <p style={{ marginBottom: 8 }}>Your app will be available at:</p>
          <code style={{ display: "block", padding: "8px 12px", background: "var(--panel-2)", borderRadius: 4, fontSize: 13, marginBottom: 12 }}>
            {setup.cloudflareProjectUrl}
          </code>
          {setup.pr?.html_url ? (
            <p className="secret-helper" style={{ marginTop: 0, marginBottom: 0 }}>
              Merge the setup PR above to activate workflows, then push to <code>develop</code> to trigger your first deployment.
            </p>
          ) : deployStarted ? (
            <div className="success-panel" style={{ padding: "10px 14px" }}>
              <strong style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <RefreshCw size={14} className="spin" />
                Deployment started!
              </strong>
              <p style={{ margin: "4px 0 0", fontSize: 12 }}>
                Check the <a href="/ci" style={{ color: "var(--brand)" }}>CI Monitor</a> to track progress.
              </p>
            </div>
          ) : (
            <>
              <p className="secret-helper" style={{ marginTop: 0, marginBottom: 10 }}>
                Workflows are ready. Start your first preview deployment:
              </p>
              <button
                className="button primary"
                onClick={startFirstDeploy}
                disabled={deployLoading}
                style={{ width: "100%" }}
              >
                {deployLoading ? <RefreshCw size={14} className="spin" style={{ marginRight: 6 }} /> : null}
                {deployLoading ? "Starting deployment..." : "Start Preview Deployment"}
              </button>
              {deployError && <p style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{deployError}</p>}
            </>
          )}
        </div>
      ) : null}

      <div className="api-key-reveal" aria-live="polite">
        <strong>Your ShipBrain API key</strong>
        <p>Use this in application code to raise incidents programmatically. This is shown only once.</p>
        {hidden ? (
          <div className="api-key-box obscured">
            <code>Hidden for security</code>
            <button className="button secondary compact" onClick={onShow}>Show again</button>
          </div>
        ) : (
          <div className="api-key-box">
            <code>{setup.shipbrainApiKey}</code>
            <button className="button secondary compact" onClick={onCopy}>
              <Copy size={14} />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </div>

      <div className="info-callout">
        <strong>Next steps</strong>
        <ul className="compact-list" style={{ marginTop: 8 }}>
          <li>Merge the setup PR to activate workflows</li>
          <li>Push to <code>develop</code> to trigger preview deployments</li>
          <li>Create a release PR to deploy to production</li>
        </ul>
      </div>
    </div>
  );
}
