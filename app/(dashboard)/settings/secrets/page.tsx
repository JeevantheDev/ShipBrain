"use client";

import { Copy, Edit3, ExternalLink, RefreshCw, Save, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { KeyboardEvent, useEffect, useRef, useState } from "react";

type RepoSecretState = {
  id: string;
  full_name: string;
  connected_at?: string;
  created_at: string;
  setup_status: string;
  setup_pr_number?: number;
  setup_pr_url?: string;
  shipbrain_api_key_last4?: string;
  setup_metadata?: { injectedSecrets?: string[]; skipCloudflare?: boolean; skipIncidents?: boolean; cloudflareProjectName?: string; apiUrl?: string };
};

const allSecrets = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_PROJECT_NAME", "SHIPBRAIN_API_KEY", "SHIPBRAIN_API_URL"];
const editableSecrets = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_PROJECT_NAME", "SHIPBRAIN_API_URL"];
const cloudflareDashboardUrl = "https://dash.cloudflare.com";

export default function SecretsPage() {
  const [repos, setRepos] = useState<RepoSecretState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revealedKey, setRevealedKey] = useState("");
  const [copied, setCopied] = useState(false);
  const [disconnectRepo, setDisconnectRepo] = useState<RepoSecretState | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const [editingRepoId, setEditingRepoId] = useState<string | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, Record<string, string>>>({});
  const [savingRepoId, setSavingRepoId] = useState<string | null>(null);
  const [syncingRepoId, setSyncingRepoId] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState("");
  const disconnectModalRef = useRef<HTMLDivElement>(null);
  const confirmInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadSecrets();
  }, []);

  useEffect(() => {
    if (disconnectRepo) window.setTimeout(() => confirmInputRef.current?.focus(), 0);
  }, [disconnectRepo]);

  function handleDisconnectKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") setDisconnectRepo(null);
    if (event.key !== "Tab" || !disconnectModalRef.current) return;
    const focusable = Array.from(
      disconnectModalRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")
    );
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

  async function loadSecrets() {
    setLoading(true);
    try {
      const response = await fetch("/api/settings/secrets", { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to load secrets");
      setRepos(json);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to load secrets");
    } finally {
      setLoading(false);
    }
  }

  async function rotate(repoId: string) {
    setError("");
    const response = await fetch("/api/settings/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId, action: "rotate_api_key" })
    });
    const json = await response.json();
    if (!response.ok) {
      setError(json.detail ?? json.error ?? "Unable to rotate API key");
      return;
    }
    setRevealedKey(json.shipbrainApiKey);
    await loadSecrets();
  }

  async function syncToGitHub(repoId: string) {
    setSyncingRepoId(repoId);
    setError("");
    setSyncMessage("");
    try {
      const response = await fetch("/api/settings/secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId, action: "sync_to_github" })
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json.detail ?? json.error ?? "Unable to sync secrets to GitHub");
      }
      setRevealedKey(json.shipbrainApiKey);
      setSyncMessage(`Synced to GitHub: ${json.apiUrl}`);
      await loadSecrets();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to sync secrets to GitHub");
    } finally {
      setSyncingRepoId(null);
    }
  }

  function setupStatusLabel(repo: RepoSecretState) {
    if (repo.setup_status === "merged") return "Setup merged";
    if (repo.setup_status === "closed") return "Setup closed";
    if (repo.setup_status === "already_configured") return "Configured";
    if (repo.setup_status === "pr_opened") return "PR open";
    return repo.setup_status.replace(/_/g, " ");
  }

  function setupStatusClass(repo: RepoSecretState) {
    if (repo.setup_status === "merged" || repo.setup_status === "already_configured") return "green";
    if (repo.setup_status === "closed") return "amber";
    return "blue";
  }

  function startEditing(repo: RepoSecretState) {
    setEditingRepoId(repo.id);
    setSecretDrafts((drafts) => ({
      ...drafts,
      [repo.id]: {
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_ACCOUNT_ID: "",
        CF_PROJECT_NAME: "",
        SHIPBRAIN_API_URL: repo.setup_metadata?.apiUrl ?? ""
      }
    }));
  }

  function updateDraft(repoId: string, secret: string, value: string) {
    setSecretDrafts((drafts) => ({
      ...drafts,
      [repoId]: {
        ...(drafts[repoId] ?? {}),
        [secret]: value
      }
    }));
  }

  async function saveSecrets(repo: RepoSecretState) {
    const draft = secretDrafts[repo.id] ?? {};
    const secrets = Object.fromEntries(
      Object.entries(draft).filter(([, value]) => value.trim().length > 0)
    );
    if (!Object.keys(secrets).length) {
      setError("Enter at least one changed secret value before saving.");
      return;
    }
    setSavingRepoId(repo.id);
    setError("");
    try {
      const response = await fetch("/api/settings/secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId: repo.id, action: "update_secrets", secrets })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to save secrets");
      setEditingRepoId(null);
      setSecretDrafts((drafts) => ({ ...drafts, [repo.id]: {} }));
      await loadSecrets();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to save secrets");
    } finally {
      setSavingRepoId(null);
    }
  }

  async function copyKey() {
    if (!revealedKey) return;
    await navigator.clipboard.writeText(revealedKey);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  async function disconnect() {
    if (!disconnectRepo) return;
    setDisconnecting(true);
    setError("");
    try {
      const response = await fetch("/api/settings/secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId: disconnectRepo.id, action: "disconnect", confirmation })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to disconnect repository");
      setDisconnectRepo(null);
      setConfirmation("");
      await loadSecrets();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to disconnect repository");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>Secrets</h1>
          <p>Review injected GitHub Actions secrets per connected repo. Secret values are never shown, except one-time ShipBrain API key reveals.</p>
        </div>
      </div>

      {error ? <div className="error-panel" role="alert"><strong>Secrets need attention</strong><p>{error}</p></div> : null}
      {syncMessage ? <div className="success-panel" role="status"><strong>Secrets synced</strong><p>{syncMessage}</p></div> : null}
      {revealedKey ? (
        <div className="api-key-reveal" aria-live="polite">
          <strong>Your new ShipBrain API key</strong>
          <p>This is shown once. Use it in application code for `/api/incidents/raise`.</p>
          <div className="api-key-box">
            <code>{revealedKey}</code>
            <button className="button secondary compact" onClick={copyKey}><Copy size={14} />{copied ? "Copied" : "Copy"}</button>
          </div>
        </div>
      ) : null}

      <div className="split-list">
        {loading ? (
          <div className="loading-state"><span className="loading-spinner" /><p>Loading connected repo secrets...</p></div>
        ) : repos.length ? repos.map((repo) => (
          <article className="panel" key={repo.id}>
            <div className="toolbar" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h2 style={{ marginBottom: 4 }}>{repo.full_name}</h2>
                <p style={{ marginBottom: 0 }}>Connected {new Date(repo.connected_at ?? repo.created_at).toLocaleString()}</p>
              </div>
              <span className={`status ${setupStatusClass(repo)}`}>{setupStatusLabel(repo)}</span>
            </div>
            <div className="secret-table">
              <div className="secret-table-head"><span>Secret</span><span>Status</span><span>Value</span></div>
              {allSecrets.map((secret) => {
                const injected = repo.setup_metadata?.injectedSecrets?.includes(secret) || (secret === "SHIPBRAIN_API_KEY" && repo.shipbrain_api_key_last4);
                const editable = editableSecrets.includes(secret);
                const editing = editingRepoId === repo.id && editable;
                return (
                  <div className="secret-table-row" key={secret}>
                    <span>{secret}</span>
                    <span className={`status ${injected ? "green" : "amber"}`}>{injected ? "Active" : "Skipped"}</span>
                    <span>
                      {secret === "SHIPBRAIN_API_KEY" ? (
                        repo.shipbrain_api_key_last4 ? `rotatable key ending ${repo.shipbrain_api_key_last4}` : "Generated by ShipBrain"
                      ) : editing ? (
                        <input
                          className="input compact-input"
                          type="password"
                          value={secretDrafts[repo.id]?.[secret] ?? ""}
                          onChange={(event) => updateDraft(repo.id, secret, event.target.value)}
                          placeholder={secret === "SHIPBRAIN_API_URL" ? "Public ShipBrain callback URL" : "Paste new value"}
                        />
                      ) : (
                        editable ? "Hidden - edit to replace" : secret.startsWith("SHIPBRAIN") ? "ShipBrain managed" : "Hidden"
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="toolbar" style={{ marginTop: 14 }}>
              {editingRepoId === repo.id ? (
                <>
                  <button className="button primary compact" onClick={() => saveSecrets(repo)} disabled={savingRepoId === repo.id}>
                    <Save size={14} />
                    {savingRepoId === repo.id ? "Saving..." : "Save secret changes"}
                  </button>
                  <button className="button secondary compact" onClick={() => setEditingRepoId(null)}>Cancel</button>
                </>
              ) : (
                <button className="button secondary compact" onClick={() => startEditing(repo)}>
                  <Edit3 size={14} />
                  Edit secrets
                </button>
              )}
              <button className="button secondary compact" onClick={() => rotate(repo.id)}>
                <RefreshCw size={14} />
                Rotate SHIPBRAIN_API_KEY
              </button>
              <button
                className="button primary compact"
                onClick={() => syncToGitHub(repo.id)}
                disabled={syncingRepoId === repo.id}
              >
                <Upload size={14} />
                {syncingRepoId === repo.id ? "Syncing..." : "Sync to GitHub"}
              </button>
              {repo.setup_pr_url ? (
                <a className="button secondary compact" href={repo.setup_pr_url} target="_blank" rel="noreferrer">
                  Setup PR
                  <ExternalLink size={14} />
                </a>
              ) : null}
              {!repo.setup_metadata?.skipCloudflare ? (
                <a className="button secondary compact" href={cloudflareDashboardUrl} target="_blank" rel="noreferrer">
                  Cloudflare
                  <ExternalLink size={14} />
                </a>
              ) : null}
              <span className={`status ${repo.setup_metadata?.cloudflareProjectName ? "green" : "amber"}`}>
                <ShieldCheck size={14} />
                Cloudflare {repo.setup_metadata?.cloudflareProjectName ? "configured" : "pending"}
              </span>
              <button className="button secondary compact danger-icon" onClick={() => setDisconnectRepo(repo)}>
                <Trash2 size={14} />
                Disconnect repo
              </button>
            </div>
          </article>
        )) : (
          <div className="empty-state">
            <strong>No connected repos</strong>
            <p>Use the repo manager in the top bar to connect a repository and inject ShipBrain secrets.</p>
          </div>
        )}
      </div>

      {disconnectRepo ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setDisconnectRepo(null)} onKeyDown={handleDisconnectKeyDown}>
          <div className="modal" ref={disconnectModalRef} onClick={(event) => event.stopPropagation()}>
            <div className="toolbar" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <h2>Disconnect {disconnectRepo.full_name}?</h2>
                <p>ShipBrain will remove injected GitHub secrets, delete the local routing entry, and stop monitoring this repo. Workflow files stay in GitHub for manual review.</p>
              </div>
              <button className="icon-button" onClick={() => setDisconnectRepo(null)} aria-label="Close"><X size={16} /></button>
            </div>
            <ul className="compact-list">
              <li>Remove all injected GitHub Actions secrets</li>
              <li>Delete the ShipBrain repo connection</li>
              <li>Stop CI, deployment, and incident monitoring for this repo</li>
            </ul>
            <label className="field-label">Type the repo name to confirm</label>
            <input ref={confirmInputRef} className="input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={disconnectRepo.full_name} />
            <div className="toolbar modal-actions" style={{ justifyContent: "space-between" }}>
              <button className="button secondary" onClick={() => setDisconnectRepo(null)}>Cancel</button>
              <button className="button primary" disabled={confirmation !== disconnectRepo.full_name || disconnecting} onClick={disconnect}>
                {disconnecting ? "Disconnecting..." : "Disconnect repo"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
