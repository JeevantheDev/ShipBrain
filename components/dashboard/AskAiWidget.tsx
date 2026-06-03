"use client";

import { useEffect, useState } from "react";
import { 
  ArrowUpRight, 
  X,
  GitPullRequest, 
  Terminal, 
  Layers, 
  BookOpen, 
  CheckCircle2, 
  Rocket,
  ShieldCheck
} from "lucide-react";

type ReleaseItem = {
  releaseTag: string;
};

type CardItem = {
  label: string;
  prompt: string;
  icon: React.ReactNode;
};

export function AskAiWidget() {
  const [activeRepoFullName, setActiveRepoFullName] = useState<string | null>(null);
  const [releases, setReleases] = useState<ReleaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Read dismiss state on mount
    const isDismissed = window.localStorage.getItem("shipbrain:dismiss-ask-ai") === "true";
    setDismissed(isDismissed);

    async function fetchData() {
      try {
        const [repoRes, releaseRes] = await Promise.all([
          fetch("/api/github/active-repo", { cache: "no-store" }),
          fetch("/api/releases/history?limit=1", { cache: "no-store" })
        ]);
        
        if (repoRes.ok) {
          const repoData = await repoRes.json();
          setActiveRepoFullName(repoData.activeRepoFullName);
        }
        
        if (releaseRes.ok) {
          const releaseData = await releaseRes.json();
          setReleases(releaseData);
        }
      } catch (err) {
        console.error("Error loading Ask AI recommendations:", err);
      } finally {
        setLoading(false);
      }
    }
    
    void fetchData();
    
    const handleRefetch = () => {
      void fetchData();
    };
    window.addEventListener("shipbrain-refetch", handleRefetch);
    return () => {
      window.removeEventListener("shipbrain-refetch", handleRefetch);
    };
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    window.localStorage.setItem("shipbrain:dismiss-ask-ai", "true");
  };

  if (loading || !activeRepoFullName || dismissed) {
    return null;
  }

  const latestRelease = releases[0];
  const hasReleases = releases.length > 0 && latestRelease?.releaseTag;

  const handbookCards: CardItem[] = [
    {
      label: "ShipBrain Action Guide",
      prompt: `Using the ShipBrain AI Action Handbook, explain what ShipBrain can automate for ${activeRepoFullName} and what still needs manual approval or GitHub-side work.`,
      icon: <BookOpen size={12} style={{ color: "var(--ai-purple)" }} />
    },
    {
      label: "Setup & Manual Checklist",
      prompt: `Using the ShipBrain AI Action Handbook, show the GitHub, Cloudflare, incident integration, and manual merge/setup checklist I should verify for ${activeRepoFullName}.`,
      icon: <ShieldCheck size={12} style={{ color: "var(--green)" }} />
    }
  ];

  const contextCards: CardItem[] = hasReleases
    ? [
        {
          label: "Generate Release Handbook",
          prompt: `Prepare a release handbook based on the recent production release tag ${latestRelease.releaseTag}.`,
          icon: <BookOpen size={12} style={{ color: "var(--ai-purple)" }} />
        },
        {
          label: `Verify Release Live Status (${latestRelease.releaseTag})`,
          prompt: `Verify status of the production release tag ${latestRelease.releaseTag} and check the live URL.`,
          icon: <CheckCircle2 size={12} style={{ color: "var(--green)" }} />
        },
        {
          label: "Summarize Latest Release",
          prompt: `Provide a summary of the commits and features included in release ${latestRelease.releaseTag}.`,
          icon: <Rocket size={12} style={{ color: "var(--brand)" }} />
        }
      ]
    : [
        {
          label: "Plan a New Feature",
          prompt: "Help me plan a new draft PR plan for my connected repository.",
          icon: <GitPullRequest size={12} style={{ color: "var(--ai-purple)" }} />
        },
        {
          label: "Check CI Run Status",
          prompt: "Show me the current status of my repository's workflow runs.",
          icon: <Terminal size={12} style={{ color: "var(--brand)" }} />
        },
        {
          label: "Explain Release Gating",
          prompt: "Explain how ShipBrain's release gating and tag-and-deploy logic works.",
          icon: <Layers size={12} style={{ color: "var(--text-muted)" }} />
        }
      ];
  const cards = [...handbookCards, ...contextCards];

  const handleCardClick = (prompt: string) => {
    window.dispatchEvent(
      new CustomEvent("shipbrain-open-chat", {
        detail: { prompt }
      })
    );
  };

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "8px 24px",
      background: "var(--panel-2)",
      borderBottom: "1px solid var(--line)",
      margin: "-28px -28px 24px -28px",
      backgroundClip: "padding-box",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <span style={{ 
          fontSize: "12px", 
          fontWeight: 600, 
          color: "var(--text)",
          marginRight: "4px"
        }}>
          Ask AI
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {cards.map((card, index) => (
            <button
              key={index}
              type="button"
              className="ask-ai-badge"
              onClick={() => handleCardClick(card.prompt)}
              style={{
                padding: "4px 12px",
                fontSize: "11.5px",
                borderRadius: "16px",
                background: "transparent",
                borderColor: "rgba(255, 255, 255, 0.15)",
                color: "var(--text-secondary)",
              }}
            >
              {card.icon}
              <span>{card.label}</span>
              <ArrowUpRight size={11} className="arrow-icon" style={{ marginLeft: "2px" }} />
            </button>
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        style={{
          background: "transparent",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          padding: "4px",
          transition: "color 0.15s ease",
          outline: "none",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
        aria-label="Dismiss recommendations"
      >
        <X size={14} />
      </button>
    </div>
  );
}
