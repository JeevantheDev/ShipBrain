"use client";

import { Copy, Edit3, ExternalLink, RefreshCw, Save, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { usePasswordConfirmation } from "@/components/ui/usePasswordConfirmation";

type RepoSecretState = {
  id: string;
  full_name: string;
  connected_at?: string;
  created_at: string;
  setup_status: string;
  setup_pr_number?: number;
  setup_pr_url?: string;
  shipbrain_api_key_last4?: string;
  telegram_notifications_enabled?: boolean;
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
  const [telegramCode, setTelegramCode] = useState("");
  const [telegramState, setTelegramState] = useState<{ linked: boolean; username?: string; chatId?: string }>({ linked: false });
  const [telegramBusy, setTelegramBusy] = useState(false);
  const disconnectModalRef = useRef<HTMLDivElement>(null);
  const confirmInputRef = useRef<HTMLInputElement>(null);
  const { confirmPassword, PasswordConfirmModal } = usePasswordConfirmation();

  useEffect(() => {
    void loadSecrets();
    void loadTelegram();
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

  async function loadTelegram() {
    const response = await fetch("/api/telegram/verify", { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    const json = await response.json();
    setTelegramState({
      linked: Boolean(json.linked),
      username: json.telegram?.telegram_username ?? undefined,
      chatId: json.telegram?.telegram_chat_id ? String(json.telegram.telegram_chat_id) : undefined
    });
  }

  async function verifyTelegram() {
    const reauthPassword = await confirmPassword({
      title: "Confirm Telegram link",
      description: "Enter your ShipBrain password before linking Telegram to your account."
    });
    if (!reauthPassword) return;
    setTelegramBusy(true);
    setError("");
    try {
      const response = await fetch("/api/telegram/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: telegramCode, reauthPassword })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to link Telegram");
      setTelegramCode("");
      await loadTelegram();
      setSyncMessage("Telegram chat linked successfully.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to link Telegram");
    } finally {
      setTelegramBusy(false);
    }
  }

  async function testTelegram() {
    const reauthPassword = await confirmPassword({
      title: "Confirm Telegram test",
      description: "Enter your ShipBrain password before sending a Telegram test message."
    });
    if (!reauthPassword) return;
    setTelegramBusy(true);
    setError("");
    try {
      const response = await fetch("/api/telegram/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "test", reauthPassword })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to send Telegram test");
      setSyncMessage("Telegram test message sent.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to send Telegram test");
    } finally {
      setTelegramBusy(false);
    }
  }

  async function unlinkTelegram() {
    const reauthPassword = await confirmPassword({
      title: "Confirm Telegram unlink",
      description: "Enter your ShipBrain password before removing Telegram access."
    });
    if (!reauthPassword) return;
    setTelegramBusy(true);
    setError("");
    try {
      const response = await fetch("/api/telegram/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "unlink", reauthPassword })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to unlink Telegram");
      await loadTelegram();
      setSyncMessage("Telegram chat unlinked.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to unlink Telegram");
    } finally {
      setTelegramBusy(false);
    }
  }

  async function setupTelegramWebhook() {
    const reauthPassword = await confirmPassword({
      title: "Confirm Telegram webhook",
      description: "Enter your ShipBrain password before changing Telegram webhook configuration."
    });
    if (!reauthPassword) return;
    setTelegramBusy(true);
    setError("");
    try {
      const response = await fetch("/api/telegram/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reauthPassword })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to set Telegram webhook");
      setSyncMessage(`Telegram webhook set: ${json.webhookUrl}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to set Telegram webhook");
    } finally {
      setTelegramBusy(false);
    }
  }

  async function toggleTelegram(repo: RepoSecretState, enabled: boolean) {
    const reauthPassword = await confirmPassword({
      title: "Confirm Telegram alerts",
      description: "Enter your ShipBrain password before changing Telegram delivery for this repo."
    });
    if (!reauthPassword) return;
    setSavingRepoId(repo.id);
    setError("");
    try {
      const response = await fetch("/api/settings/secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId: repo.id, action: "toggle_telegram", enabled, reauthPassword })
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail ?? json.error ?? "Unable to update Telegram notifications");
      await loadSecrets();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to update Telegram notifications");
    } finally {
      setSavingRepoId(null);
    }
  }

  async function rotate(repoId: string) {
    const reauthPassword = await confirmPassword({
      title: "Confirm key rotation",
      description: "Enter your ShipBrain password before rotating this repo's API key."
    });
    if (!reauthPassword) return;
    setError("");
    const response = await fetch("/api/settings/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoId, action: "rotate_api_key", reauthPassword })
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
    const reauthPassword = await confirmPassword({
      title: "Confirm GitHub secret sync",
      description: "Enter your ShipBrain password before writing secrets to GitHub."
    });
    if (!reauthPassword) return;
    setSyncingRepoId(repoId);
    setError("");
    setSyncMessage("");
    try {
      const response = await fetch("/api/settings/secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId, action: "sync_to_github", reauthPassword })
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
    const reauthPassword = await confirmPassword({
      title: "Confirm secret update",
      description: "Enter your ShipBrain password before replacing GitHub Actions secrets."
    });
    if (!reauthPassword) return;
    setSavingRepoId(repo.id);
    setError("");
    try {
      const response = await fetch("/api/settings/secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId: repo.id, action: "update_secrets", secrets, reauthPassword })
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
    const reauthPassword = await confirmPassword({
      title: "Confirm repo disconnect",
      description: "Enter your ShipBrain password before removing this repo connection and GitHub secrets."
    });
    if (!reauthPassword) return;
    setDisconnecting(true);
    setError("");
    try {
      const response = await fetch("/api/settings/secrets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId: disconnectRepo.id, action: "disconnect", confirmation, reauthPassword })
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

      <article className="panel" style={{ marginBottom: 18 }}>
        <div className="toolbar" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="eyebrow">Telegram</div>
            <h2 style={{ marginBottom: 4 }}>Bot notifications</h2>
            <p style={{ marginBottom: 0 }}>Link your Telegram chat to receive ShipBrain release, incident, secret, and merged PR notifications.</p>
          </div>
          <span className={`status ${telegramState.linked ? "green" : "amber"}`}>
            {telegramState.linked ? "Linked" : "Not linked"}
          </span>
        </div>
        <div className="info-callout compact" style={{ marginTop: 12 }}>
          <strong>How to link</strong>
          <p>Open your Telegram bot, send <code>/start</code>, copy the verification code, then paste it below.</p>
        </div>
        <div className="toolbar" style={{ marginTop: 12, alignItems: "flex-end" }}>
          <div style={{ flex: "1 1 260px" }}>
            <label className="field-label">Verification code</label>
            <input className="input compact-input" value={telegramCode} onChange={(event) => setTelegramCode(event.target.value.toUpperCase())} placeholder="TG-ABCD-EFGH" />
          </div>
          <button className="button primary compact" disabled={telegramBusy || !telegramCode.trim()} onClick={verifyTelegram}>
            {telegramBusy ? "Linking..." : "Link Telegram"}
          </button>
          <button className="button secondary compact" disabled={telegramBusy} onClick={setupTelegramWebhook}>Set webhook</button>
          <button className="button secondary compact" disabled={telegramBusy || !telegramState.linked} onClick={testTelegram}>Send test</button>
          {telegramState.linked ? <button className="button secondary compact danger-icon" disabled={telegramBusy} onClick={unlinkTelegram}>Unlink</button> : null}
        </div>
        {telegramState.linked ? <p className="secret-helper">Linked chat {telegramState.username ? `@${telegramState.username}` : telegramState.chatId}. Enable per-repo delivery below.</p> : null}
      </article>

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
              <label className="check-row" style={{ marginTop: 0 }}>
                <input
                  type="checkbox"
                  checked={Boolean(repo.telegram_notifications_enabled)}
                  disabled={savingRepoId === repo.id}
                  onChange={(event) => toggleTelegram(repo, event.target.checked)}
                />
                <span>
                  Telegram alerts
                  <small>Route notifications for this repo to your linked chat.</small>
                </span>
              </label>
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
      <PasswordConfirmModal />
    </>
  );
}
