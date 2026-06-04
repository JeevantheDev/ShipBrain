"use client";

import { useEffect, useRef } from "react";
import "./ChatMockup.css";

const BOT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="16" height="11" rx="2"/><path d="M9 8V5h6v3M9 13h.01M15 13h.01"/></svg>`;
const USER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>`;
const FOUNDRY_BADGE = `<span class="cm-foundry-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 6v12a2 2 0 002 2h12a2 2 0 002-2V6M9 11h6"/></svg>Foundry IQ</span>`;

export function ChatMockup() {
  const bodyRef       = useRef<HTMLDivElement>(null);
  const gateRef       = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLDivElement>(null);
  const statusElRef   = useRef<HTMLDivElement>(null);
  const statusStripRef= useRef<HTMLDivElement>(null);
  const fieldRef      = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const body        = bodyRef.current!;
    const gate        = gateRef.current!;
    const confirmBtn  = confirmBtnRef.current!;
    const statusEl    = statusElRef.current!;
    const statusStrip = statusStripRef.current!;
    const field       = fieldRef.current!;

    let cancelled = false;
    const pending: ReturnType<typeof setTimeout>[] = [];

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        if (cancelled) { resolve(); return; }
        const id = setTimeout(resolve, ms);
        pending.push(id);
      });

    function scrollDown() { body.scrollTop = body.scrollHeight; }

    function makeRow(side: "bot" | "user") {
      const row = document.createElement("div");
      row.className = "cm-row " + side;
      const av = document.createElement("div");
      av.className = "cm-avatar " + side;
      av.innerHTML = side === "bot" ? BOT_SVG : USER_SVG;
      const bub = document.createElement("div");
      bub.className = "cm-bubble " + side;
      if (side === "bot") { row.appendChild(av); row.appendChild(bub); }
      else                { row.appendChild(bub); row.appendChild(av); }
      body.appendChild(row);
      requestAnimationFrame(() => row.classList.add("in"));
      return bub;
    }

    async function userMsg(text: string) {
      if (cancelled) return;
      const bub = makeRow("user");
      bub.innerHTML = '<div class="cm-lbl">YOU</div><div class="txt caret"></div>';
      const txt = bub.querySelector<HTMLElement>(".txt")!;
      // 30 = 14px padding×2 + 1px border×2; start at label-minimum width
      bub.style.width = "56px";
      scrollDown();
      await sleep(250);
      for (const ch of text) {
        if (cancelled) return;
        txt.textContent += ch;
        bub.style.width = `${Math.min(txt.scrollWidth + 30, 300)}px`;
        scrollDown();
        await sleep(24);
      }
      txt.classList.remove("caret");
      // Clear inline width so text wraps naturally at final size
      bub.style.transition = "none";
      bub.style.width = "";
      await sleep(350);
    }

    async function botTyping(ms = 1100) {
      if (cancelled) return null;
      const bub = makeRow("bot");
      bub.innerHTML = '<div class="cm-typing"><span></span><span></span><span></span></div>';
      scrollDown();
      await sleep(ms);
      return bub;
    }

    async function botMsg(
      html: string,
      { foundry = false, typingMs = 1100 } = {},
    ) {
      if (cancelled) return;
      const bub = await botTyping(typingMs);
      if (!bub || cancelled) return;
      const lbl = "SHIPBRAIN AI" + (foundry ? "  " + FOUNDRY_BADGE : "");
      bub.innerHTML = `<div class="cm-lbl">${lbl}</div>` + html;
      scrollDown();
      await sleep(700);
    }

    function setStatus(text: string, pending = false) {
      statusEl.textContent = text;
      statusEl.classList.toggle("pending", pending);
    }

    async function reset() {
      body.classList.add("fading");
      await sleep(450);
      if (cancelled) return;
      body.innerHTML = "";
      gate.classList.remove("show");
      statusStrip.classList.remove("show");
      confirmBtn.classList.remove("pulse", "pressed");
      setStatus("Ready", false);
      field.textContent = "Ask about PRs, deployments, or request an action…";
      body.classList.remove("fading");
      await sleep(300);
    }

    async function sequence() {
      while (!cancelled) {
        await reset();
        if (cancelled) return;
        await sleep(500);

        // 1 — user creates PR
        await userMsg('Create Draft PR using "Issue resolution" recipe');
        if (cancelled) return;

        // 2 — bot: PR created
        await botMsg(
          '<div class="cm-b-title">Draft PR Created Successfully!</div>' +
          '<ul class="cm-b-list">' +
            '<li>PR: <a class="cm-link">#2</a></li>' +
            '<li>Branch: <span class="cm-tag">bugfix-bug-title</span></li>' +
            '<li>Files: 0 files generated</li>' +
          "</ul>" +
          '<div class="cm-b-foot">The PR is ready for review on GitHub.</div>',
        );
        if (cancelled) return;
        statusStrip.classList.add("show");
        await sleep(1400);
        if (cancelled) return;
        statusStrip.classList.remove("show");
        await sleep(400);

        // 3 — user: deploy
        await userMsg("deploy PR #2 to preview");
        if (cancelled) return;

        // 4 — bot: proposes deploy
        await botMsg(
          'I\'ll deploy <span class="cm-tag">PR #2</span> to the preview environment. ' +
          "Would you like me to proceed? Type <b>confirm</b> or <b>cancel</b>.",
        );
        if (cancelled) return;

        // 5 — gate slides up
        setStatus("Action pending", true);
        field.textContent = "Use the buttons above to confirm or cancel the action.";
        gate.classList.add("show");
        await sleep(900);
        if (cancelled) return;

        // 6 — confirm pulse → press
        confirmBtn.classList.add("pulse");
        await sleep(1400);
        if (cancelled) return;
        confirmBtn.classList.remove("pulse");
        confirmBtn.classList.add("pressed");
        await sleep(260);
        if (cancelled) return;
        confirmBtn.classList.remove("pressed");
        await sleep(200);
        if (cancelled) return;
        gate.classList.remove("show");
        await sleep(450);
        if (cancelled) return;

        // 7 — bot: deployment started
        await botMsg(
          '<div class="cm-b-title"><span class="cm-check">✓</span>Preview Deployment Started!</div>' +
          '<ul class="cm-b-list">' +
            "<li>Environment: Preview / Develop</li>" +
            '<li>Workflow: <a class="cm-link">View on GitHub</a></li>' +
          "</ul>",
          { typingMs: 1300 },
        );
        if (cancelled) return;
        setStatus("Ready", false);

        // 8 — user: preview URL
        await userMsg("url to see preview deployment");
        if (cancelled) return;

        // 9 — bot: live URL (Foundry IQ)
        await botMsg(
          'The preview deployment for your merged <span class="cm-tag">PR #2</span> is live at:' +
          '<div style="margin-top:8px"><span class="cm-url">https://develop.sb-amitkroutthedev-test-sandbox-two.pages.dev</span></div>' +
          '<div class="cm-b-foot">You can check the deployed changes there.</div>',
          { foundry: true, typingMs: 1300 },
        );
        if (cancelled) return;

        await sleep(3800);
      }
    }

    sequence();

    return () => {
      cancelled = true;
      pending.forEach(clearTimeout);
    };
  }, []);

  return (
    <div className="chat-mockup">
      <div className="cm-panel">
        {/* HEADER */}
        <div className="cm-header">
          <div>
            <div className="cm-h-title">ShipBrain AI</div>
            <div className="cm-h-status" ref={statusElRef}>Ready</div>
          </div>
          <div className="cm-h-icons">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
            </svg>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M12 5v14M5 12h14"/>
            </svg>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M6 6l12 12M18 6L6 18"/>
            </svg>
          </div>
        </div>

        {/* BODY — messages injected here by useEffect */}
        <div className="cm-body" ref={bodyRef} />

        {/* STATUS STRIP */}
        <div className="cm-status-strip" ref={statusStripRef}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M5 12l5 5L20 7"/>
          </svg>
          <span>Action completed successfully</span>
        </div>

        {/* GATE */}
        <div className="cm-gate" ref={gateRef}>
          <div className="cm-gate-pr">
            <div>
              <div className="cm-gate-pr-title">Bug Fix: Issue resolution</div>
              <div className="cm-gate-pr-sub">#2 · bugfix-bug-title</div>
            </div>
            <div className="cm-merged">MERGED</div>
          </div>
          <div className="cm-gate-action">
            <div className="cm-ga-left">
              <svg
                className="cm-bolt"
                width="20" height="20"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M13 2L3 14h7l-1 8 10-12h-7z"/>
              </svg>
              <div>
                <div className="cm-ga-t">Deploy to Preview</div>
                <div className="cm-ga-s">Ready to execute</div>
              </div>
            </div>
            <div className="cm-gate-btns">
              <div className="cm-btn cancel">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path d="M6 6l12 12M18 6L6 18"/>
                </svg>
                Cancel
              </div>
              <div className="cm-btn confirm" ref={confirmBtnRef}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path d="M5 12l5 5L20 7"/>
                </svg>
                Confirm
              </div>
            </div>
          </div>
        </div>

        {/* INPUT */}
        <div className="cm-input">
          <div className="cm-field" ref={fieldRef}>
            Ask about PRs, deployments, or request an action…
          </div>
          <div className="cm-send">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 11l18-8-8 18-2-7-8-3z"/>
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}
