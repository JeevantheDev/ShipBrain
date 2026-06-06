"use client";

import { useEffect, useState } from "react";

interface LandingBodyProps {
  children: React.ReactNode;
}

export function LandingBody({ children }: LandingBodyProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const stages = [
      {
        label: "Create Draft PR",
        pre: "Will open Draft PR to",
        target: "acme/api-server : main",
        confirm: "Confirm",
        doneText: 'PR #42 created on <span style="font-family:\'JetBrains Mono\',monospace;font-size:13px;">acme/api-server</span>',
        link: "view on GitHub →",
        caption: "create draft pr",
      },
      {
        label: "Deploy to production",
        pre: "Will deploy preview build to",
        target: "prod · cart-v2026.05.25",
        confirm: "Deploy",
        doneText: 'Deployed <span style="font-family:\'JetBrains Mono\',monospace;font-size:13px;">cart-v2026.05.25</span> to prod',
        link: "open deployment →",
        caption: "ci &amp; deploy",
      },
      {
        label: "Create Release PR",
        pre: "Will promote",
        target: "develop → main",
        confirm: "Release",
        doneText: 'Release PR #44 opened · <span style="font-family:\'JetBrains Mono\',monospace;font-size:13px;">develop → main</span>',
        link: "view release →",
        caption: "release action",
      },
    ];

    const live = document.getElementById("gateLive");
    const steps = [...document.querySelectorAll("#gateSteps .gate-step")] as HTMLElement[];
    const captionEl = document.getElementById("gateCaption");
    const section = document.getElementById("gates");

    if (!live || !steps.length || !captionEl || !section) return;

    const elDefault = live.querySelector<HTMLElement>('[data-phase="default"]')!;
    const elReview  = live.querySelector<HTMLElement>('[data-phase="review"]')!;
    const elDone    = live.querySelector<HTMLElement>('[data-phase="done"]')!;
    const defLabel  = live.querySelector<HTMLElement>(".gate-default-label")!;
    const pre       = live.querySelector<HTMLElement>(".gate-summary-pre")!;
    const target    = live.querySelector<HTMLElement>(".gate-summary-target")!;
    const confirmBtn= live.querySelector<HTMLElement>(".gate-btn.primary")!;
    const doneText  = live.querySelector<HTMLElement>(".done-text")!;
    const doneLink  = live.querySelector<HTMLElement>(".gate-done-link")!;
    const bar       = live.querySelector<HTMLElement>(".gate-progress .bar")!;
    const check     = live.querySelector<HTMLElement>(".gate-check")!;

    const showPhase = (el: HTMLElement) => {
      [elDefault, elReview, elDone].forEach(p => p.classList.toggle("show", p === el));
    };

    let idx = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const clearTimers = () => { timers.forEach(clearTimeout); timers.length = 0; };
    const after = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    function runStage(i: number) {
      clearTimers();
      const s = stages[i];
      defLabel.textContent = s.label;
      pre.textContent = s.pre;
      target.textContent = s.target;
      confirmBtn.textContent = s.confirm;
      doneText.innerHTML = s.doneText;
      doneLink.innerHTML = s.link;
      if (captionEl) captionEl.innerHTML = `same gate <span class="sep">·</span> <span class="now">${s.caption}</span>`;

      steps.forEach((st, n) => {
        st.classList.toggle("active", n === i);
        st.classList.toggle("done", n < i);
      });

      bar.style.transition = "none";
      bar.style.width = "0%";
      showPhase(elDefault);
      elDefault.classList.remove("click-pulse");

      after(950, () => {
        void elDefault.offsetWidth;
        elDefault.classList.add("click-pulse");
      });
      after(1350, () => {
        showPhase(elReview);
        void bar.offsetWidth;
        bar.style.transition = "width 1900ms cubic-bezier(.4,0,.2,1)";
        bar.style.width = "100%";
      });
      after(3050, () => {
        confirmBtn.classList.remove("flash");
        void confirmBtn.offsetWidth;
        confirmBtn.classList.add("flash");
      });
      after(3350, () => {
        showPhase(elDone);
        check.classList.remove("pop");
        void check.offsetWidth;
        check.classList.add("pop");
        steps.forEach((st, n) => {
          if (n === i) { st.classList.remove("active"); st.classList.add("done"); }
        });
      });
      after(5000, () => {
        idx = (i + 1) % stages.length;
        if (idx === 0) steps.forEach(st => st.classList.remove("done"));
        runStage(idx);
      });
    }

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (reduced.matches) {
      steps.forEach(st => st.classList.add("done"));
      steps[0].classList.add("active");
      showPhase(elReview);
      bar.style.width = "50%";
    } else {
      let visible = true;
      runStage(0);
      const io = new IntersectionObserver((entries) => {
        entries.forEach(e => {
          const inView = e.isIntersecting || e.intersectionRatio > 0;
          if (inView && !visible) { visible = true; runStage(idx); }
          else if (!inView && visible) { visible = false; clearTimers(); }
        });
      }, { threshold: 0 });
      io.observe(section);
      return () => { clearTimers(); io.disconnect(); };
    }
  }, []);

  useEffect(() => {
    document.body.classList.add("landing-active");

    const onScroll = () => {
      const header = document.querySelector(".lp-top") as HTMLElement | null;
      if (!header) return;
      if (window.scrollY > 0) {
        header.classList.add("lp-top--scrolled");
      } else {
        header.classList.remove("lp-top--scrolled");
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      document.body.classList.remove("landing-active");
      window.removeEventListener("scroll", onScroll);
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

  return (
    <div className="landing-page-wrapper">
      <div
        onClick={(e) => {
          const target = e.target as HTMLElement;
          if (target.classList.contains("copy-btn")) {
            handleCopy();
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
