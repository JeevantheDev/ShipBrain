"use client";

import { Check, ChevronDown, Copy, ExternalLink, Eye, EyeOff, Github, Lock, RefreshCw, Search, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  project: { packageJson: boolean; vercelJson: boolean; node: boolean; vercel: boolean };
};

type VerifyState = "idle" | "verifying" | "verified" | "error";
type SetupEvent = { label: string; status: "running" | "done" | "error"; detail?: string };

const selectedRepoKey = "shipbrain:selectedRepo";
const connectedReposKey = "shipbrain:connectedRepos";
const vercelDashboardUrl = "https://vercel.com/dashboard";

function safeVercelSettingsUrl(value?: string | null) {
  if (!value || value.includes("/dashboard/project/")) return vercelDashboardUrl;
  return value;
}

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
  const [error, setError] = useState("");
  const [scan, setScan] = useState<RepoScan | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [skipVercel, setSkipVercel] = useState(false);
  const [skipIncidents, setSkipIncidents] = useState(false);
  const [vercelToken, setVercelToken] = useState("");
  const [vercelOrgId, setVercelOrgId] = useState("");
  const [vercelProjectId, setVercelProjectId] = useState("");
  const [vercelSettingsUrl, setVercelSettingsUrl] = useState("");
  const [pagerDutyRoutingKey, setPagerDutyRoutingKey] = useState("");
  const [vercelTokenState, setVercelTokenState] = useState<VerifyState>("idle");
  const [vercelProjectState, setVercelProjectState] = useState<VerifyState>("idle");
  const [pagerDutyState, setPagerDutyState] = useState<VerifyState>("idle");
  const [secretError, setSecretError] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupDone, setSetupDone] = useState<any>(null);
  const [setupEvents, setSetupEvents] = useState<SetupEvent[]>([]);
  const [copied, setCopied] = useState(false);
  const [customProdBranch, setCustomProdBranch] = useState("");
  const [customDevBranch, setCustomDevBranch] = useState("");
  const [branchError, setBranchError] = useState("");
  const [apiKeyHidden, setApiKeyHidden] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const repoSearchRef = useRef<HTMLInputElement>(null);

  const connectedRepos = useMemo(
    () => repos.filter((repo) => selectedRepos.includes(repo.full_name)),
    [repos, selectedRepos]
  );
  const activeRepo = repos.find((repo) => repo.full_name === selectedRepo) ?? null;
  const filteredRepos = repos.filter((repo) => repo.full_name.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  const vercelVerified = skipVercel || (vercelTokenState === "verified" && vercelProjectState === "verified");
  const incidentsVerified = skipIncidents || pagerDutyState === "verified";
  const needsCustomBranches = scan?.branches.scenario === "custom_required";
  const customBranchesReady = !needsCustomBranches || Boolean(customProdBranch.trim());
  const canSubmit = Boolean(activeRepo && scan && customBranchesReady && vercelVerified && incidentsVerified && !setupBusy);

  useEffect(() => {
    setMounted(true);
    const savedRepo = window.localStorage.getItem(selectedRepoKey);
    const savedRepos = safeParseRepos(window.localStorage.getItem(connectedReposKey));
    setSelectedRepo(savedRepo ?? savedRepos[0] ?? "");
    setSelectedRepos(savedRepos);
    void bootstrap(savedRepo, savedRepos);
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    window.setTimeout(() => {
      repoSearchRef.current?.focus();
      const first = modalRef.current?.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      if (!repoSearchRef.current) first?.focus();
    }, 0);
  }, [modalOpen, setupDone, githubConnected]);

  function safeParseRepos(value: string | null) {
    if (!value) return [];
    try {
      return JSON.parse(value) as string[];
    } catch {
      return [];
    }
  }

  async function bootstrap(savedRepo?: string | null, savedRepos: string[] = []) {
    const connected = await loadConnection();
    if (connected) {
      await loadRepos(savedRepo, savedRepos);
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
      const response = await fetch("/api/github/connection", { method: "POST" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to connect GitHub");
      setGithubConnected(true);
      setGithubLogin(json.githubLogin ?? "");
      await loadRepos();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to connect GitHub");
      setLoading(false);
    }
  }

  async function loadRepos(savedRepo?: string | null, savedRepos: string[] = selectedRepos) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/github/repos", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) {
        if (json.requiresGithub) setGithubConnected(false);
        throw new Error(json.error ?? "Unable to load repositories");
      }
      setRepos(json);
      const connected = json.filter((repo: Repo) => repo.connected).map((repo: Repo) => repo.full_name);
      const nextSelectedRepos = connected.length ? connected : savedRepos;
      const nextSelectedRepo = savedRepo ?? nextSelectedRepos[0] ?? json.find((repo: Repo) => repo.full_name.endsWith("/shipbrain_sandbox"))?.full_name ?? json[0]?.full_name ?? "";
      setSelectedRepos(nextSelectedRepos);
      setSelectedRepo(nextSelectedRepo);
      window.localStorage.setItem(connectedReposKey, JSON.stringify(nextSelectedRepos));
      window.localStorage.setItem(selectedRepoKey, nextSelectedRepo);
      if (!nextSelectedRepos.length) setModalOpen(true);
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
    window.localStorage.setItem(selectedRepoKey, repo.full_name);
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

  async function verify(type: "vercel_token" | "vercel_project" | "pagerduty") {
    setSecretError("");
    const setState = type === "vercel_token" ? setVercelTokenState : type === "vercel_project" ? setVercelProjectState : setPagerDutyState;
    setState("verifying");
    try {
      const response = await fetch("/api/integrations/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, vercelToken, vercelOrgId, vercelProjectId, pagerDutyRoutingKey })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Verification failed");
      if (type === "vercel_project" && json.settingsUrl) setVercelSettingsUrl(safeVercelSettingsUrl(json.settingsUrl));
      setState("verified");
    } catch (nextError) {
      setState("error");
      setSecretError(nextError instanceof Error ? nextError.message : "Verification failed");
    }
  }

  async function submitSetup() {
    if (!activeRepo) return;
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
          skipVercel,
          skipIncidents,
          vercelToken,
          vercelOrgId,
          vercelProjectId,
          vercelSettingsUrl,
          pagerDutyRoutingKey,
          productionBranch: customProdBranch.trim(),
          developmentBranch: customDevBranch.trim()
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
      window.localStorage.setItem(connectedReposKey, JSON.stringify(nextConnectedRepos));
      await loadRepos(activeRepo.full_name, nextConnectedRepos);
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

  function changeActiveRepo(fullName: string) {
    setSelectedRepo(fullName);
    window.localStorage.setItem(selectedRepoKey, fullName);
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
      window.localStorage.setItem(connectedReposKey, JSON.stringify(nextSelectedRepos));
      if (selectedRepo === fullName) {
        const nextRepo = nextSelectedRepos[0] ?? "";
        setSelectedRepo(nextRepo);
        window.localStorage.setItem(selectedRepoKey, nextRepo);
      }
      await loadRepos(nextSelectedRepos[0], nextSelectedRepos);
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
      <div className="toolbar">
        <select
          className="select"
          style={{ maxWidth: 360 }}
          value={selectedRepo}
          onChange={(event) => changeActiveRepo(event.target.value)}
          disabled={!connectedRepos.length}
        >
          {connectedRepos.length ? (
            connectedRepos.map((repo) => (
              <option key={repo.id} value={repo.full_name}>
                {repo.full_name}
              </option>
            ))
          ) : (
            <option>{githubConnected ? "Connect repositories" : "Connect GitHub"}</option>
          )}
        </select>
        <button className="button secondary compact" onClick={() => setModalOpen(true)}>
          Manage
        </button>
      </div>

      {mounted && modalOpen
        ? createPortal(
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setModalOpen(false)} onKeyDown={handleModalKeyDown}>
          <div className="modal scroll-safe repo-connect-modal" ref={modalRef} onClick={(event) => event.stopPropagation()}>
            <div className="toolbar" style={{ alignItems: "flex-start", marginBottom: 14 }}>
              <Github color="var(--brand)" />
              <div>
                <h2 style={{ marginBottom: 4 }}>Connect your repo</h2>
                <p style={{ marginBottom: 0 }}>ShipBrain scans your repo, injects secrets, and opens one PR for CI, deploy gate, and incident alerting.</p>
              </div>
            </div>

            {error ? <div className="error-panel" role="alert"><strong>Setup needs attention</strong><p>{error}</p></div> : null}

            {!githubConnected ? (
              <div className="split-list">
                <div className="card">
                  <strong>Step 1: GitHub integration</strong>
                  <p>Connect GitHub so ShipBrain can list repos, write GitHub Actions secrets, and open the setup PR.</p>
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
                    <p className="secret-helper">Use Settings → Secrets to rotate keys, replace GitHub Actions secrets, confirm Vercel preview setup, or disconnect a repo.</p>
                  </div>
                ) : null}

                <div className="repo-connect-group">
                  <div className="eyebrow">Repository</div>
                  <label className="field-label">{connectedRepos.length ? "Connect another repository" : "Search your repositories"}</label>
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
                  <button className="button secondary compact" onClick={() => loadRepos(selectedRepo, selectedRepos)} disabled={loading}>
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
                  <div className="eyebrow">Deployment</div>
                  <h3>Vercel deployment</h3>
                  {skipVercel ? (
                    <CollapsedSetup label="Vercel deployment" onRestore={() => setSkipVercel(false)} />
                  ) : (
                    <>
                      <SecretField label="VERCEL_TOKEN" value={vercelToken} setValue={setVercelToken} state={vercelTokenState} visible={showSecrets} onVerify={() => verify("vercel_token")} helper="vercel.com/account/tokens -> Create -> copy token" link="https://vercel.com/account/tokens" />
                      <SecretField label="VERCEL_ORG_ID" value={vercelOrgId} setValue={setVercelOrgId} state={vercelProjectState} visible={showSecrets} helper="Vercel project -> Settings -> General -> Team ID or Account ID" link={safeVercelSettingsUrl(vercelSettingsUrl)} />
                      <SecretField label="VERCEL_PROJECT_ID" value={vercelProjectId} setValue={setVercelProjectId} state={vercelProjectState} visible={showSecrets} onVerify={() => verify("vercel_project")} helper="Same Settings -> General page -> Project ID" link={safeVercelSettingsUrl(vercelSettingsUrl)} />
                      <button className="button secondary compact" onClick={() => setShowSecrets((value) => !value)}>
                        {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
                        {showSecrets ? "Hide secrets" : "Show while editing"}
                      </button>
                      <button className="text-link" onClick={() => setSkipVercel(true)}>Skip Vercel setup -&gt;</button>
                    </>
                  )}
                </div>

                <div className="repo-connect-group">
                  <div className="eyebrow">Incident alerting</div>
                  <h3>PagerDuty alerting</h3>
                  {skipIncidents ? (
                    <CollapsedSetup label="Incident alerting" onRestore={() => setSkipIncidents(false)} />
                  ) : (
                    <>
                      <SecretField label="PAGERDUTY_ROUTING_KEY" value={pagerDutyRoutingKey} setValue={setPagerDutyRoutingKey} state={pagerDutyState} visible={showSecrets} onVerify={() => verify("pagerduty")} helper="PagerDuty -> Services -> service -> Integrations -> Events API V2 key" link="https://app.pagerduty.com/services" />
                      <p className="secret-helper">Verify sends and immediately resolves a low-severity PagerDuty test event so the routing key is checked against the real Events API.</p>
                      <button className="text-link" onClick={() => setSkipIncidents(true)}>Skip incident alerting -&gt;</button>
                    </>
                  )}
                </div>

                {secretError ? <div className="error-panel" role="alert"><strong>Verification failed</strong><p>{secretError}</p></div> : null}

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
                    {setupBusy ? "Setting up repo..." : "Connect repo and open PR"}
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
      <ScanRow label="develop" ok={scan.branches.develop} detail={scan.branches.develop ? "dev environment" : "not found"} />
      <ScanRow label={scan.branches.productionBranch ?? "production branch"} ok={Boolean(scan.branches.productionBranch)} detail={scan.branches.productionBranch ? "prod environment" : "not found"} />
      <ScanRow label="package.json" ok={scan.project.packageJson} detail={scan.project.packageJson ? "Node.js project detected" : "not found - smoke only"} />
      <ScanRow label="vercel.json" ok={scan.project.vercelJson} detail={scan.project.vercelJson ? "Vercel project confirmed" : "not found"} />
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

function SecretField(props: {
  label: string;
  value: string;
  setValue: (value: string) => void;
  state: VerifyState;
  visible: boolean;
  onVerify?: () => void;
  helper: string;
  link: string;
}) {
  return (
    <div className={`secret-field ${props.state}`}>
      <label className="field-label">{props.label}</label>
      <div className="secret-input-row">
        <input type={props.visible ? "text" : "password"} value={props.value} onChange={(event) => props.setValue(event.target.value)} placeholder="Paste your token" />
        {props.state === "verified" ? <span className="status green">Verified</span> : props.onVerify ? <button className="button secondary compact" onClick={props.onVerify} disabled={!props.value || props.state === "verifying"}>{props.state === "verifying" ? "Verifying..." : "Verify"}</button> : null}
      </div>
      <p className="secret-helper">
        {props.helper} <a href={props.link} target="_blank" rel="noreferrer">Open <ExternalLink size={11} /></a>
      </p>
    </div>
  );
}

function CollapsedSetup({ label, onRestore }: { label: string; onRestore: () => void }) {
  return (
    <div className="collapsed-setup">
      <span className="dot amber" /> {label} skipped · <button className="text-link" onClick={onRestore}>Set up now</button>
    </div>
  );
}

function SetupProgress({ events }: { events: SetupEvent[] }) {
  return (
    <div className="setup-progress">
      {events.length ? events.map((event) => (
        <div className="setup-step" key={event.label}>
          {event.status === "done" ? <Check size={16} color="var(--green)" /> : event.status === "error" ? <XCircle size={16} color="var(--red)" /> : <RefreshCw size={16} className="spin" />}
          <span>{event.status === "done" ? event.label.replace("Injecting", "Injected") : event.label}</span>
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
  const vercelSettingsUrl = safeVercelSettingsUrl(setup.repo?.setup_metadata?.vercelSettingsUrl);
  return (
    <div className="modal-scroll-area repo-connect-flow">
      <div className="success-panel">
        <strong>ShipBrain setup PR opened</strong>
        <p>Next step: review and merge the PR to activate the workflows.</p>
        {setup.pr?.html_url ? <a className="button primary compact" href={setup.pr.html_url} target="_blank" rel="noreferrer">View PR on GitHub <ExternalLink size={14} /></a> : <span className="status green">Workflows already configured</span>}
      </div>
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
        <strong>One more step before preview deploys work</strong>
        <p>Set dev environment variables in Vercel's Preview environment. Production variables are separate and are not used by preview builds.</p>
        <a className="button secondary compact" href={vercelSettingsUrl} target="_blank" rel="noreferrer">Open Vercel settings <ExternalLink size={14} /></a>
      </div>
    </div>
  );
}
