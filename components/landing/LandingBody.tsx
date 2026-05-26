"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface LandingBodyProps {
  children: React.ReactNode;
}

export function LandingBody({ children }: LandingBodyProps) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Enable scrollable body for landing page
    document.body.classList.add("landing-active");

    return () => {
      // Clean up body class when navigating away
      document.body.classList.remove("landing-active");
    };
  }, []);

  const handleCopy = () => {
    const code = `AI_PROVIDER=anthropic
AI_MODEL=claude-sonnet-4.6

# swap to:
AI_PROVIDER=openai
AI_MODEL=gpt-4.1`;

    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handlePlayDemo = () => {
    // Redirect to login/dashboard when attempting to play the interactive demo
    router.push("/login");
  };

  return (
    <div className="landing-page-wrapper">
      {/* Expose copy and demo handlers to descendants via normal HTML events or selectors */}
      <div 
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.classList.contains("copy-btn")) {
            handleCopy();
          } else if (target.closest(".player")) {
            handlePlayDemo();
          }
        }}
      >
        {children}
      </div>

      {/* Scoped styles specifically for copy notification */}
      {copied && (
        <div style={{
          position: "fixed",
          bottom: "24px",
          right: "24px",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          color: "var(--text)",
          padding: "12px 18px",
          borderRadius: "6px",
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "12px",
          zIndex: 100,
          boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
          animation: "fade-in 150ms ease-out"
        }}>
          ✓ Scoped configuration copied to clipboard
        </div>
      )}
    </div>
  );
}
