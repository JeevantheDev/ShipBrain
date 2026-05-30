"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { GitPullRequest, GitBranch, Clock, CheckCircle, XCircle, Loader2, ExternalLink } from "lucide-react";

type SpecDetails = {
  id: string;
  title?: string;
  prNumber?: number | null;
  prUrl?: string | null;
  status?: string;
  repoFullName?: string;
  branchName?: string;
  baseBranch?: string;
  previewUrl?: string | null;
  releaseTag?: string | null;
  updatedAt?: string;
};

type SpecCitationProps = {
  specId: string;
  children: React.ReactNode;
};

// Cache for spec details to avoid repeated fetches
const specCache = new Map<string, SpecDetails | null>();

export function SpecCitation({ specId, children }: SpecCitationProps) {
  const [isHovering, setIsHovering] = useState(false);
  const [spec, setSpec] = useState<SpecDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const fetchSpec = useCallback(async () => {
    // Check cache first
    if (specCache.has(specId)) {
      setSpec(specCache.get(specId) || null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/specs/${specId}`);
      if (!response.ok) {
        throw new Error("Spec not found");
      }
      const data = await response.json();
      const specDetails: SpecDetails = {
        id: data.id,
        title: data.decomposed_tasks?.prTitle || data.title || `Spec ${specId.slice(0, 8)}`,
        prNumber: data.pr_number,
        prUrl: data.pr_url,
        status: data.status,
        repoFullName: data.repo_full_name,
        branchName: data.branch_name,
        baseBranch: data.base_branch,
        previewUrl: data.preview_url,
        releaseTag: data.release_tag,
        updatedAt: data.updated_at,
      };
      specCache.set(specId, specDetails);
      setSpec(specDetails);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load spec");
      specCache.set(specId, null);
    } finally {
      setLoading(false);
    }
  }, [specId]);

  const handleMouseEnter = () => {
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovering(true);
      if (!spec && !loading && !error) {
        fetchSpec();
      }
    }, 200); // Small delay to prevent accidental triggers
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    setIsHovering(false);
  };

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  const getStatusIcon = (status?: string) => {
    switch (status) {
      case "merged":
        return <CheckCircle size={12} className="status-icon merged" />;
      case "failed":
        return <XCircle size={12} className="status-icon failed" />;
      default:
        return <Clock size={12} className="status-icon pending" />;
    }
  };

  const getStatusLabel = (status?: string) => {
    switch (status) {
      case "merged": return "Merged";
      case "draft": return "Draft";
      case "open": return "Open";
      case "closed": return "Closed";
      case "failed": return "Failed";
      default: return status || "Unknown";
    }
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return "";
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  return (
    <span
      ref={triggerRef}
      className="spec-citation-trigger"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {isHovering && (
        <div ref={tooltipRef} className="spec-citation-tooltip">
          {loading ? (
            <div className="spec-citation-loading">
              <Loader2 size={14} className="spin" />
              <span>Loading spec details...</span>
            </div>
          ) : error ? (
            <div className="spec-citation-error">
              <XCircle size={14} />
              <span>{error}</span>
            </div>
          ) : spec ? (
            <div className="spec-citation-content">
              <div className="spec-citation-header">
                {spec.prNumber ? (
                  <a
                    href={spec.prUrl || `https://github.com/${spec.repoFullName}/pull/${spec.prNumber}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="spec-citation-pr-link"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <GitPullRequest size={14} />
                    <span>PR #{spec.prNumber}</span>
                    <ExternalLink size={10} />
                  </a>
                ) : (
                  <span className="spec-citation-no-pr">No PR yet</span>
                )}
                <span className={`spec-citation-status ${spec.status}`}>
                  {getStatusIcon(spec.status)}
                  {getStatusLabel(spec.status)}
                </span>
              </div>

              {spec.title && (
                <div className="spec-citation-title">{spec.title}</div>
              )}

              <div className="spec-citation-meta">
                {spec.repoFullName && (
                  <span className="spec-citation-repo">{spec.repoFullName}</span>
                )}
                {spec.branchName && (
                  <span className="spec-citation-branch">
                    <GitBranch size={11} />
                    {spec.branchName}
                    {spec.baseBranch && <span className="spec-citation-base"> → {spec.baseBranch}</span>}
                  </span>
                )}
              </div>

              {spec.releaseTag && (
                <div className="spec-citation-release">
                  Release: <code>{spec.releaseTag}</code>
                </div>
              )}

              {spec.previewUrl && (
                <a
                  href={spec.previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="spec-citation-preview"
                  onClick={(e) => e.stopPropagation()}
                >
                  Preview: {spec.previewUrl}
                </a>
              )}

              {spec.updatedAt && (
                <div className="spec-citation-time">
                  Updated {formatDate(spec.updatedAt)}
                </div>
              )}
            </div>
          ) : (
            <div className="spec-citation-empty">
              <span>Spec {specId.slice(0, 8)}...</span>
            </div>
          )}
        </div>
      )}
    </span>
  );
}

// Helper to detect if a string is a UUID (spec ID)
export function isSpecId(text: string): boolean {
  // Match full UUID or short UUID (8 chars)
  const fullUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const shortUuid = /^[0-9a-f]{8}$/i;
  return fullUuid.test(text) || shortUuid.test(text);
}

// Clear the spec cache (useful when specs are updated)
export function clearSpecCache(specId?: string) {
  if (specId) {
    specCache.delete(specId);
  } else {
    specCache.clear();
  }
}
