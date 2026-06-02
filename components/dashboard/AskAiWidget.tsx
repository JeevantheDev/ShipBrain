"use client";

import { useEffect, useState } from "react";
import { 
  Sparkles, 
  ArrowUpRight, 
  GitPullRequest, 
  Terminal, 
  Layers, 
  BookOpen, 
  CheckCircle2, 
  Rocket 
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

  useEffect(() => {
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

  if (loading || !activeRepoFullName) {
    return null;
  }

  const latestRelease = releases[0];
  const hasReleases = releases.length > 0 && latestRelease?.releaseTag;

  const cards: CardItem[] = hasReleases
    ? [
        {
          label: "Generate Release Handbook",
          prompt: `Prepare a release handbook based on the recent production release tag ${latestRelease.releaseTag}.`,
          icon: <BookOpen size={13} style={{ color: "var(--ai-purple)" }} />
        },
        {
          label: `Verify Release Live Status (${latestRelease.releaseTag})`,
          prompt: `Verify status of the production release tag ${latestRelease.releaseTag} and check the live URL.`,
          icon: <CheckCircle2 size={13} style={{ color: "var(--green)" }} />
        },
        {
          label: "Summarize Latest Release",
          prompt: `Provide a summary of the commits and features included in release ${latestRelease.releaseTag}.`,
          icon: <Rocket size={13} style={{ color: "var(--brand)" }} />
        }
      ]
    : [
        {
          label: "Plan a New Feature",
          prompt: "Help me plan a new draft PR plan for my connected repository.",
          icon: <GitPullRequest size={13} style={{ color: "var(--ai-purple)" }} />
        },
        {
          label: "Check CI Run Status",
          prompt: "Show me the current status of my repository's workflow runs.",
          icon: <Terminal size={13} style={{ color: "var(--brand)" }} />
        },
        {
          label: "Explain Release Gating",
          prompt: "Explain how ShipBrain's release gating and tag-and-deploy logic works.",
          icon: <Layers size={13} style={{ color: "var(--text-muted)" }} />
        }
      ];

  const handleCardClick = (prompt: string) => {
    window.dispatchEvent(
      new CustomEvent("shipbrain-open-chat", {
        detail: { prompt }
      })
    );
  };

  return (
    <section className="panel ask-ai-section">
      <header className="panel-head" style={{ marginBottom: 12 }}>
        <h2 style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Sparkles size={15} className="text-ai" style={{ color: "var(--ai-purple)", animation: "pulse 2s infinite ease-in-out" }} />
          Ask AI Recommendations
        </h2>
      </header>
      <div className="ask-ai-badge-list">
        {cards.map((card, index) => (
          <button
            key={index}
            type="button"
            className="ask-ai-badge"
            onClick={() => handleCardClick(card.prompt)}
          >
            {card.icon}
            <span>{card.label}</span>
            <ArrowUpRight size={13} className="arrow-icon" />
          </button>
        ))}
      </div>
    </section>
  );
}
