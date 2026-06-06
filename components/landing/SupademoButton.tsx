"use client";

import Script from "next/script";

const DEMO_ID = "cmq2mr4pr0xycqm6uu08slusj";

function openDemo() {
  (window as any).Supademo?.open(DEMO_ID);
}

export function SupademoNavButton() {
  return (
    <>
      <Script src="https://script.supademo.com/supademo.js" strategy="lazyOnload" />
      <button type="button" className="demo-btn" onClick={openDemo}>
        <span className="tri"></span>
        watch the demo
      </button>
    </>
  );
}

export function SupademoCTAButton() {
  return (
    <button type="button" className="btn-cta ghost" onClick={openDemo}>
      See the demo
    </button>
  );
}

export function SupademoPlayer() {
  return (
    <div
      className="player"
      role="button"
      tabIndex={0}
      aria-label="Play 2-minute demo"
      onClick={openDemo}
      onKeyDown={(e) => e.key === "Enter" && openDemo()}
    >
      <div className="player-bg" aria-hidden="true"></div>
      <div className="player-center">
        <div className="play-circle" aria-hidden="true">
          <span className="play-tri"></span>
        </div>
        <span className="player-label">Play the 2-minute demo</span>
      </div>
      <span className="player-foot">
        runs in your browser <span className="dot">·</span> no signup
      </span>
    </div>
  );
}
