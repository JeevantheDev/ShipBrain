"use client";

import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type Release = {
  specId: string;
  repoFullName: string;
  releaseTag: string;
  releaseSha: string;
  deployedAt: string;
  productionUrl?: string;
  title: string;
  status: string;
};

type RollbackSelectorProps = {
  repoFullName: string;
  currentTag?: string;
  traceId?: string;
  onRollback?: (targetTag: string) => void;
  disabled?: boolean;
};

function dateLabel(value?: string | null) {
  if (!value) return "n/a";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function RollbackSelector({ repoFullName, currentTag, traceId, onRollback, disabled }: RollbackSelectorProps) {
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const loadReleases = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/releases/history?repo=${encodeURIComponent(repoFullName)}&limit=20`);
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Failed to load releases");
        return;
      }
      // Filter out the current tag
      const filtered = (data as Release[]).filter((r) => r.releaseTag !== currentTag);
      setReleases(filtered);
    } catch {
      setError("Failed to load releases");
    } finally {
      setLoading(false);
    }
  }, [repoFullName, currentTag]);

  useEffect(() => {
    loadReleases();
  }, [loadReleases]);

  async function handleRollback() {
    if (!selectedTag) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/deployments/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetReleaseTag: selectedTag,
          repoFullName,
          traceId
        })
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Rollback failed");
        return;
      }
      setShowConfirm(false);
      setSelectedTag("");
      onRollback?.(selectedTag);
    } catch {
      setError("Rollback request failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="rollback-selector-loading">Loading releases...</div>;
  }

  if (!releases.length) {
    return <div className="rollback-selector-empty">No previous releases available for rollback.</div>;
  }

  const selectedRelease = releases.find((r) => r.releaseTag === selectedTag);

  return (
    <div className="rollback-selector">
      <div className="rollback-selector-head">
        <span>Rollback target</span>
        <small>{releases.length} previous {releases.length === 1 ? "release" : "releases"}</small>
      </div>
      <div className="rollback-selector-row">
        <select
          className="rollback-select"
          value={selectedTag}
          onChange={(e) => setSelectedTag(e.target.value)}
          disabled={disabled || submitting}
        >
          <option value="">Select a release to rollback to...</option>
          {releases.map((release) => (
            <option key={release.releaseTag} value={release.releaseTag}>
              {release.releaseTag} - {release.title.slice(0, 40)} ({dateLabel(release.deployedAt)})
            </option>
          ))}
        </select>
        <button
          className="btn compact warning"
          type="button"
          disabled={!selectedTag || disabled || submitting}
          onClick={() => setShowConfirm(true)}
        >
          <RotateCcw size={13} />
          Rollback
        </button>
      </div>

      {showConfirm && selectedRelease && (
        <div className="rollback-confirm-modal">
          <div className="rollback-confirm-content">
            <h3>Confirm Rollback</h3>
            <p>
              You are about to rollback production to:
            </p>
            <div className="rollback-target-info">
              <strong>{selectedRelease.releaseTag}</strong>
              <span>{selectedRelease.title}</span>
              <span className="mono">{dateLabel(selectedRelease.deployedAt)}</span>
            </div>
            {currentTag && (
              <p className="rollback-warning">
                This will replace the current release <code>{currentTag}</code> with the selected version.
              </p>
            )}
            <div className="rollback-confirm-actions">
              <button
                className="btn compact ghost"
                type="button"
                onClick={() => setShowConfirm(false)}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                className="btn compact danger"
                type="button"
                onClick={handleRollback}
                disabled={submitting}
              >
                {submitting ? "Rolling back..." : "Confirm Rollback"}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
