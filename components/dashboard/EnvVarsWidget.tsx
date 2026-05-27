"use client";

import { Edit2, Loader2, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

type EnvVar = {
  key: string;
  value: string;
  type?: string;
};

type EditingVar = {
  key: string;
  newValue: string;
};

const selectedRepoKey = "shipbrain:selectedRepo";

export function EnvVarsWidget() {
  const [repo, setRepo] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [redeploying, setRedeploying] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showRedeployPrompt, setShowRedeployPrompt] = useState(false);
  const [lastSavedEnv, setLastSavedEnv] = useState<"preview" | "production" | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectUrl, setProjectUrl] = useState("");
  const [previewVars, setPreviewVars] = useState<EnvVar[]>([]);
  const [productionVars, setProductionVars] = useState<EnvVar[]>([]);
  const [activeTab, setActiveTab] = useState<"preview" | "production">("preview");
  const [newVars, setNewVars] = useState<{ key: string; value: string }[]>([]);
  const [editingVar, setEditingVar] = useState<EditingVar | null>(null);

  useEffect(() => {
    const savedRepo = window.localStorage.getItem(selectedRepoKey);
    if (savedRepo) {
      setRepo(savedRepo);
    }

    // Listen for storage changes (when repo is changed in another component)
    const handleStorage = (e: StorageEvent) => {
      if (e.key === selectedRepoKey && e.newValue) {
        setRepo(e.newValue);
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    if (repo) {
      void loadEnvVars();
    }
  }, [repo]);

  async function loadEnvVars() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/env-vars?repo=${encodeURIComponent(repo)}`, { cache: "no-store" });
      const json = await response.json();

      // Handle "Repository not found" gracefully - repo not connected yet
      if (!response.ok && (json.error === "Repository not found" || response.status === 404)) {
        setProjectName("");
        setProjectUrl("");
        setPreviewVars([]);
        setProductionVars([]);
        // Don't show error - just show empty state
        setLoading(false);
        return;
      }

      if (!response.ok && json.error && !json.envVars) {
        throw new Error(json.error);
      }
      setProjectName(json.projectName || "");
      setProjectUrl(json.projectUrl || "");
      setPreviewVars(json.envVars?.preview || []);
      setProductionVars(json.envVars?.production || []);
    } catch (e) {
      // Don't show error for common cases like repo not connected
      const errorMsg = e instanceof Error ? e.message : "Unable to load environment variables";
      if (errorMsg.includes("not found") || errorMsg.includes("not connected")) {
        setProjectName("");
        setProjectUrl("");
        setPreviewVars([]);
        setProductionVars([]);
      } else {
        setError(errorMsg);
      }
    } finally {
      setLoading(false);
    }
  }

  function addNewVar() {
    setNewVars([...newVars, { key: "", value: "" }]);
  }

  function updateNewVar(index: number, field: "key" | "value", value: string) {
    const updated = [...newVars];
    updated[index][field] = field === "key" ? value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") : value;
    setNewVars(updated);
  }

  function removeNewVar(index: number) {
    setNewVars(newVars.filter((_, i) => i !== index));
  }

  function startEditing(envVar: EnvVar) {
    setEditingVar({ key: envVar.key, newValue: "" });
  }

  function cancelEditing() {
    setEditingVar(null);
  }

  async function saveEditedVar() {
    if (!editingVar || !editingVar.newValue.trim()) {
      setError("Please enter a new value");
      return;
    }

    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const response = await fetch("/api/env-vars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo,
          envVars: { [editingVar.key]: editingVar.newValue },
          environment: activeTab
        })
      });

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json.error || "Unable to update environment variable");
      }

      setSuccess(`Updated ${editingVar.key} in ${activeTab} environment`);
      setEditingVar(null);
      setLastSavedEnv(activeTab);
      setShowRedeployPrompt(true);
      await loadEnvVars();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to update environment variable");
    } finally {
      setSaving(false);
    }
  }

  async function saveNewVars() {
    // Filter out empty keys
    const varsToSave = newVars.filter(v => v.key.trim() && v.value.trim());
    if (varsToSave.length === 0) {
      setError("Add at least one environment variable with both key and value");
      return;
    }

    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const envVarsObj = varsToSave.reduce((acc, v) => {
        acc[v.key.trim()] = v.value;
        return acc;
      }, {} as Record<string, string>);

      const response = await fetch("/api/env-vars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo,
          envVars: envVarsObj,
          environment: activeTab
        })
      });

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json.error || "Unable to save environment variables");
      }

      setSuccess(`Added ${varsToSave.length} variable(s) to ${activeTab} environment`);
      setNewVars([]);
      setLastSavedEnv(activeTab);
      setShowRedeployPrompt(true);
      await loadEnvVars();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save environment variables");
    } finally {
      setSaving(false);
    }
  }

  async function triggerRedeploy() {
    if (!lastSavedEnv) return;
    setRedeploying(true);
    setError("");

    try {
      const response = await fetch("/api/environments/redeploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo,
          environment: lastSavedEnv,
          branch: lastSavedEnv === "preview" ? "develop" : "main"
        })
      });

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json.detail ?? json.error ?? "Failed to trigger redeploy");
      }

      setSuccess(`Redeployment started for ${lastSavedEnv}. Changes will be live after the build completes.`);
      setShowRedeployPrompt(false);

      // Clear success after 5 seconds
      setTimeout(() => setSuccess(""), 5000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to trigger redeploy");
    } finally {
      setRedeploying(false);
    }
  }

  function dismissRedeployPrompt() {
    setShowRedeployPrompt(false);
    setLastSavedEnv(null);
    // Clear success after dismissing
    setTimeout(() => setSuccess(""), 3000);
  }

  const currentVars = activeTab === "preview" ? previewVars : productionVars;

  if (!repo) {
    return (
      <div className="panel">
        <header className="panel-head">
          <h2>Environment Variables</h2>
        </header>
        <div className="empty-state" style={{ border: "none", background: "transparent", padding: "20px 14px" }}>
          <p style={{ color: "var(--text-muted)", fontSize: "13px", margin: 0 }}>
            Connect a repository to manage environment variables.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="panel">
        <header className="panel-head">
          <h2>Environment Variables</h2>
          <span className="badge-count">loading</span>
        </header>
        <div className="loading-state" style={{ border: "none", background: "transparent", padding: "20px 0" }}>
          <Loader2 size={16} className="spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <header className="panel-head">
        <h2>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ marginRight: 6 }}>
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
            <path d="M5 6h6M5 8h4M5 10h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          Environment Variables
          {projectName && (
            <span className="badge-count" style={{ marginLeft: 8 }}>{projectName}</span>
          )}
        </h2>
        <div className="tools">
          {projectUrl && (
            <a href={`https://dash.cloudflare.com`} target="_blank" rel="noreferrer" className="ghost-btn" style={{ fontSize: "11px" }}>
              Cloudflare
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" style={{ marginLeft: 4 }}>
                <path d="M4 2h6v6M10 2 4 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </a>
          )}
        </div>
      </header>

      <div className="env-tabs" style={{ display: "flex", gap: 8, padding: "0 14px", marginBottom: 12 }}>
        <button
          className={`env-tab ${activeTab === "preview" ? "active" : ""}`}
          onClick={() => { setActiveTab("preview"); setEditingVar(null); }}
          style={{
            padding: "6px 12px",
            fontSize: "12px",
            fontWeight: 500,
            border: "1px solid var(--line)",
            borderRadius: 4,
            background: activeTab === "preview" ? "var(--brand)" : "transparent",
            color: activeTab === "preview" ? "white" : "var(--text-muted)",
            cursor: "pointer",
            transition: "all 100ms ease"
          }}
        >
          Preview
          <span style={{ marginLeft: 6, opacity: 0.7 }}>({previewVars.length})</span>
        </button>
        <button
          className={`env-tab ${activeTab === "production" ? "active" : ""}`}
          onClick={() => { setActiveTab("production"); setEditingVar(null); }}
          style={{
            padding: "6px 12px",
            fontSize: "12px",
            fontWeight: 500,
            border: "1px solid var(--line)",
            borderRadius: 4,
            background: activeTab === "production" ? "var(--brand)" : "transparent",
            color: activeTab === "production" ? "white" : "var(--text-muted)",
            cursor: "pointer",
            transition: "all 100ms ease"
          }}
        >
          Production
          <span style={{ marginLeft: 6, opacity: 0.7 }}>({productionVars.length})</span>
        </button>
      </div>

      {error && (
        <div className="error-panel" role="alert" style={{ margin: "0 14px 12px" }}>
          <strong>Error</strong>
          <p>{error}</p>
        </div>
      )}

      {success && (
        <div style={{
          margin: "0 14px 12px",
          padding: "10px 14px",
          background: "rgba(63, 185, 80, 0.1)",
          border: "1px solid var(--green)",
          borderRadius: 6,
          fontSize: "13px",
          color: "var(--green)"
        }}>
          {success}
        </div>
      )}

      {showRedeployPrompt && lastSavedEnv && (
        <div style={{
          margin: "0 14px 12px",
          padding: "12px 14px",
          background: "var(--panel-2)",
          border: "1px solid var(--brand)",
          borderRadius: 6
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <RefreshCw size={14} style={{ color: "var(--brand)" }} />
            <strong style={{ fontSize: "13px", color: "var(--text)" }}>Redeploy to apply changes?</strong>
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 10px" }}>
            Environment variables have been saved. Redeploy {lastSavedEnv} to apply the changes.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn primary"
              onClick={triggerRedeploy}
              disabled={redeploying}
              style={{ flex: 1 }}
            >
              {redeploying ? (
                <Loader2 size={12} className="spin" style={{ marginRight: 4 }} />
              ) : (
                <RefreshCw size={12} style={{ marginRight: 4 }} />
              )}
              Redeploy {lastSavedEnv === "preview" ? "Preview" : "Production"}
            </button>
            <button
              className="btn"
              onClick={dismissRedeployPrompt}
              disabled={redeploying}
            >
              Later
            </button>
          </div>
        </div>
      )}

      <div className="env-var-list" style={{ padding: "0 14px 14px" }}>
        {currentVars.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              Existing Variables
              <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 8 }}>
                (click edit to update value)
              </span>
            </div>
            {currentVars.map((envVar) => (
              <div
                key={envVar.key}
                className="env-var-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 12px",
                  background: "var(--panel-2)",
                  borderRadius: 6,
                  marginBottom: 6,
                  fontSize: "13px"
                }}
              >
                {editingVar?.key === envVar.key ? (
                  // Editing mode
                  <>
                    <code style={{ minWidth: 120, fontFamily: "var(--font-mono)", color: "var(--brand-dark)" }}>
                      {envVar.key}
                    </code>
                    <input
                      type="text"
                      placeholder="Enter new value..."
                      value={editingVar.newValue}
                      onChange={(e) => setEditingVar({ ...editingVar, newValue: e.target.value })}
                      autoFocus
                      style={{
                        flex: 1,
                        padding: "6px 10px",
                        fontSize: "12px",
                        fontFamily: "var(--font-mono)",
                        background: "var(--panel)",
                        border: "1px solid var(--brand)",
                        borderRadius: 4,
                        color: "var(--text)"
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEditedVar();
                        if (e.key === "Escape") cancelEditing();
                      }}
                    />
                    <button
                      className="ghost-btn"
                      onClick={saveEditedVar}
                      disabled={saving}
                      title="Save"
                      style={{ padding: 6, color: "var(--green)" }}
                    >
                      {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                    </button>
                    <button
                      className="ghost-btn"
                      onClick={cancelEditing}
                      title="Cancel"
                      style={{ padding: 6, color: "var(--red)" }}
                    >
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  // View mode
                  <>
                    <code style={{ flex: 1, fontFamily: "var(--font-mono)", color: "var(--brand-dark)" }}>
                      {envVar.key}
                    </code>
                    <code style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)" }}>
                      ••••••••
                    </code>
                    <button
                      className="ghost-btn"
                      onClick={() => startEditing(envVar)}
                      title="Edit value"
                      style={{ padding: 6 }}
                    >
                      <Edit2 size={14} />
                    </button>
                  </>
                )}
              </div>
            ))}
            <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: "8px 0 0" }}>
              Values are encrypted and cannot be revealed. Click edit to set a new value.
            </p>
          </div>
        )}

        {currentVars.length === 0 && newVars.length === 0 && (
          <div className="empty-state" style={{ border: "none", background: "transparent", padding: "16px 0", textAlign: "center" }}>
            <p style={{ color: "var(--text-muted)", fontSize: "13px", margin: 0 }}>
              {projectName
                ? `No environment variables configured for ${activeTab}.`
                : "Connect a repository first to manage environment variables."}
            </p>
          </div>
        )}

        <div style={{ marginTop: currentVars.length > 0 ? 16 : 0 }}>
          {newVars.length > 0 && (
            <div className="eyebrow" style={{ marginBottom: 8 }}>Add New Variables</div>
          )}

          {newVars.map((newVar, index) => (
            <div
              key={index}
              className="env-var-input-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8
              }}
            >
              <input
                type="text"
                placeholder="KEY_NAME"
                value={newVar.key}
                onChange={(e) => updateNewVar(index, "key", e.target.value)}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  fontSize: "13px",
                  fontFamily: "var(--font-mono)",
                  background: "var(--panel-2)",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  color: "var(--text)"
                }}
              />
              <input
                type="text"
                placeholder="value"
                value={newVar.value}
                onChange={(e) => updateNewVar(index, "value", e.target.value)}
                style={{
                  flex: 2,
                  padding: "8px 12px",
                  fontSize: "13px",
                  fontFamily: "var(--font-mono)",
                  background: "var(--panel-2)",
                  border: "1px solid var(--line)",
                  borderRadius: 4,
                  color: "var(--text)"
                }}
              />
              <button
                className="ghost-btn"
                onClick={() => removeNewVar(index)}
                title="Remove"
                style={{ padding: 6 }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={addNewVar}>
              <Plus size={14} style={{ marginRight: 4 }} />
              Add Variable
            </button>
            {newVars.length > 0 && (
              <button className="btn primary" onClick={saveNewVars} disabled={saving}>
                {saving && <Loader2 size={12} className="spin" style={{ marginRight: 4 }} />}
                <Save size={14} style={{ marginRight: 4 }} />
                Save to {activeTab === "preview" ? "Preview" : "Production"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
