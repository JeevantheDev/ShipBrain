import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { LandingBody } from "@/components/landing/LandingBody";
import releaseMng from "@/public/release-mng.svg"
import "./landing.css";
import Image from "next/image";

export const metadata: Metadata = {
  title: "ShipBrain | AI-powered production command center",
  description: "Ship software at AI speed, with humans still in charge. ShipBrain turns engineering tasks into reviewed PRs, explains failing CI, and triages production incidents."
};

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // If already logged in, redirect directly to dashboard
  if (user) {
    redirect("/dashboard");
  }

  return (
    <LandingBody>
      {/* ============ TOP BAR ============ */}
      <header className="lp-top">
        <div className="container lp-top-inner">
          <Link href="#" className="wordmark">
            <div className="brand-mark">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect
                  x="1"
                  y="2"
                  width="4"
                  height="2"
                  rx="0.5"
                  fill="#e6edf3"
                />
                <rect
                  x="6"
                  y="2"
                  width="7"
                  height="2"
                  rx="0.5"
                  fill="#7d8590"
                />
                <rect
                  x="1"
                  y="6"
                  width="9"
                  height="2"
                  rx="0.5"
                  fill="#e6edf3"
                />
                <rect
                  x="11"
                  y="6"
                  width="2"
                  height="2"
                  rx="0.5"
                  fill="#a371f7"
                />
                <rect
                  x="1"
                  y="10"
                  width="6"
                  height="2"
                  rx="0.5"
                  fill="#e6edf3"
                />
                <rect
                  x="8"
                  y="10"
                  width="5"
                  height="2"
                  rx="0.5"
                  fill="#7d8590"
                />
              </svg>
            </div>
            <div>
              <strong style={{ fontSize: 16, letterSpacing: "-0.01em" }}>
                ship
                <em style={{ fontStyle: "normal", color: "var(--ai-purple)" }}>
                  brain
                </em>
              </strong>
            </div>
          </Link>
          {/* <nav className="lp-nav">
            <a href="#product">product</a>
            <span className="sep">·</span>
            <a href="#gates">gates</a>
            <span className="sep">·</span>
            <a href="#demo">demo</a>
            <span className="sep">·</span>
            <a href="#team">team</a>
          </nav> */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <Link
              href="/login"
              className="btn-cta ghost"
              style={{
                height: "32px",
                padding: "0 14px",
                fontSize: "12px",
                fontFamily: "'JetBrains Mono', monospace",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Sign In
            </Link>
            <a href="#demo" className="demo-btn">
              <span className="tri"></span>
              watch the demo
            </a>
          </div>
        </div>
      </header>

      {/* ============ HERO ============ */}
      <section className="section hero">
        <div className="container hero-inner">
          {/* <span className="mono-label eyebrow">{"// hackathon · 2026"}</span> */}
          <br />
          <br />
          <h1 className="hero-h">
            Ship software at AI&nbsp;speed,
            <br />
            with humans still in charge.
          </h1>
          <p className="hero-sub">
            ShipBrain turns an engineering task into a reviewed pull request,
            explains failing CI clearly, and drafts the post-mortem before the
            incident is closed — but never acts without you pressing confirm.
          </p>
          <div className="cta-row">
            <Link href="/login" className="btn-cta">
              Get Started →
            </Link>
            <a href="#demo" className="btn-cta ghost">
              See the demo
            </a>
            {/* <a href="https://github.com/JeevantheDev/ShipBrain" className="text-link" target="_blank" rel="noopener noreferrer">GitHub <span className="arr">↗</span></a> */}
          </div>
          <div className="hero-caption">
            <span className="mono-label">scroll to see the four moves</span>
            <span className="v-bar"></span>
            <span className="mono-label">↓</span>
          </div>
        </div>
      </section>

      {/* ============ SECTION 01 — Problem ============ */}
      <section className="section">
        <div className="container">
          <header className="section-head">
            <span className="mono-label">01 / the problem</span>
            <h2 className="section-h">
              Engineers spend more time on the loop than the work.
            </h2>
          </header>

          <div className="narrow">
            <p className="body-p">
              Most of an engineer&apos;s day isn&apos;t writing code. It&apos;s
              reading tickets, breaking them into tasks, opening PRs,
              babysitting CI, decoding stack traces at 2am, and writing
              post-mortems that nobody reads.
            </p>
            <p className="body-p">
              The AI tools that exist either do too little (autocomplete) or too
              much (autonomous agents that ship broken code while you sleep).
              Neither is the right shape for production software.
            </p>
          </div>

          {/* <blockquote className="pull-quote">
            &ldquo;The right shape is: AI proposes, human approves, system acts.&rdquo;
          </blockquote> */}
        </div>
      </section>

      {/* ============ SECTION 02 — Product ============ */}
      <section className="section" id="product">
        <div className="container">
          <header className="section-head">
            <span className="mono-label">02 / the product</span>
            <h2 className="section-h">Four moves. Every one of them gated.</h2>
          </header>

          <div className="narrow">
            <p className="body-p">
              ShipBrain is a console that sits next to GitHub. It does four
              things — and pauses for your approval before each one matters.
            </p>
          </div>

          <div className="moves-grid">
            <article className="move-card">
              <span className="mono-label">move · 01</span>
              <h3 className="move-card-title">
                Spec <em>→</em> PR
              </h3>
              <p className="body">
                Paste a task or a plain-language spec. ShipBrain breaks it into
                actionable tasks, scaffolds the files, and prepares a draft PR.
                You review the plan, hit confirm, and the PR opens on GitHub.
              </p>
              <div className="move-card-foot">
                gated before opening · default to draft
              </div>
            </article>

            <article className="move-card">
              <span className="mono-label">move · 02</span>
              <h3 className="move-card-title">
                Red CI, <em>explained</em>
              </h3>
              <p className="body">
                When a build fails, ShipBrain reads the logs and tells you what
                broke, in the same language you&apos;d use in Slack. Suggests a
                fix. If CI passes, the deploy button unlocks — but still waits
                for your confirm.
              </p>
              <div className="move-card-foot">
                gated before deploy · 3-second undo window
              </div>
            </article>

            <article className="move-card">
              <span className="mono-label">move · 03</span>
              <h3 className="move-card-title">
                Incidents, <em>analyzed</em>
              </h3>
              <p className="body">
                A webhook fires or you paste an alert. ShipBrain proposes a root
                cause with a confidence score and a fix you can apply. Nothing
                runs until you confirm — and you can cancel mid-countdown.
              </p>
              <div className="move-card-foot">
                gated before fix applies · rollback steps included
              </div>
            </article>

            <article className="move-card">
              <span className="mono-label">move · 04</span>
              <h3 className="move-card-title">
                Post-mortems, <em>drafted</em>
              </h3>
              <p className="body">
                When an incident resolves, the post-mortem is already written —
                timeline, impact, root cause, action items. You edit and file.
                Stops the &ldquo;we&apos;ll write it tomorrow&rdquo; doom loop.
              </p>
              <div className="move-card-foot">
                editable markdown · copy or download
              </div>
            </article>
          </div>
        </div>
      </section>

      {/* ============ SECTION 03 — Bet / Gates ============ */}
      <section className="section" id="gates">
        <div className="container">
          <header className="section-head">
            <span className="mono-label">03 / the bet</span>
            <h2 className="section-h">The whole product is one design idea.</h2>
          </header>

          <div className="narrow">
            <p className="body-p">
              We think autonomous agents are the wrong abstraction for shipping
              code. The valuable thing isn&apos;t an AI that acts on your behalf
              — it&apos;s an AI that does the boring 80% and hands you a clean
              decision.
            </p>
            <p className="body-p">
              So ShipBrain has one component used in three places: the{" "}
              <span className="light">approval gate</span>. Same shape every
              time. Same muscle memory. The button you press to ship a PR feels
              identical to the one you press to apply an incident fix.
            </p>
          </div>

          <div className="gate-cycle">
            {/* 3-stage indicator */}
            <div className="gate-steps" id="gateSteps">
              <div className="gate-step active" data-step="0">
                <span className="num">1</span>
                <span className="step-label">Create Draft PR</span>
                <span className="track" aria-hidden="true"></span>
              </div>
              <div className="gate-step" data-step="1">
                <span className="num">2</span>
                <span className="step-label">CI &amp; deploy</span>
                <span className="track" aria-hidden="true"></span>
              </div>
              <div className="gate-step" data-step="2">
                <span className="num">3</span>
                <span className="step-label">Release action</span>
                <span className="track" aria-hidden="true"></span>
              </div>
            </div>

            {/* single live gate that morphs through each stage */}
            <div className="gate-live" id="gateLive">
              {/* phase: default */}
              <button
                className="gate-phase gate-default show"
                data-phase="default"
                type="button"
              >
                <span className="gate-default-label">Create Draft PR</span>
              </button>

              {/* phase: reviewing */}
              <div className="gate-phase gate-review" data-phase="review">
                <div className="gate-review-row">
                  <span className="gate-summary">
                    <span className="muted gate-summary-pre">
                      Will open Draft PR to
                    </span>
                    <span className="repo gate-summary-target">
                      acme/api-server : main
                    </span>
                  </span>
                  <div className="gate-btns">
                    <button className="gate-btn ghost" type="button">
                      Cancel
                    </button>
                    <button className="gate-btn primary" type="button">
                      Confirm
                    </button>
                  </div>
                </div>
                <div className="gate-progress" aria-hidden="true">
                  <div className="bar"></div>
                </div>
              </div>

              {/* phase: done */}
              <div className="gate-phase gate-done" data-phase="done">
                <div className="gate-done-left">
                  <span className="gate-check" aria-hidden="true">
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                      <path
                        d="M2.5 6.5l2.2 2.2L9.5 3.8"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span className="done-text">
                    PR #42 created on{" "}
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: "13px",
                      }}
                    >
                      acme/api-server
                    </span>
                  </span>
                </div>
                <a href="#" className="link gate-done-link">
                  view on GitHub →
                </a>
              </div>
            </div>
          </div>

          <div className="gate-caption" id="gateCaption">
            same gate <span className="sep">·</span>{" "}
            <span className="now">create draft pr</span>
          </div>
        </div>
      </section>

      <section className="section" id="releasegate">
        <div className="container">
          <header className="section-head">
            <span className="mono-label">05 / release orchestration</span>
            <h2 className="section-h">Every release, one timeline.</h2>
          </header>

          <div className="narrow">
            <p className="body-p">
              Before ShipBrain, releases lived in flat lists — CI failures
              buried between shipped features, no urgency, no visibility.
              ShipBrain replaces the list with a trace board: every release
              moves through columns, every blocked release surfaces immediately,
              and every phase transition requires a human confirm.
            </p>
          </div>
          <Image
             src={releaseMng}
            alt="ShipBrain Release Trace Board — before and after comparison"
            // style="width:100%;border-radius:4px;display:block;"
            style={{ width: "100%", borderRadius: "4px", display: "block" }}
          />
        </div>
      </section>

      {/* ============ SECTION 05 — Demo ============ */}
      <section className="section" id="demo">
        <div className="container">
          <header className="section-head">
            <span className="mono-label">05 / the demo</span>
            <h2 className="section-h">Two minutes. our moves. One ticket.</h2>
          </header>

          <div className="narrow">
            <p className="body-p">
              Watch ShipBrain take a real engineering task, open a PR, hit a CI
              failure, explain the issue, suggest a fix, pass CI, deploy,
              trigger a simulated incident, identify the root cause, and draft
              the post-mortem.
            </p>
            <p className="body-p">
              Every gate is real. Every confirm is a real click. Nothing is
              mocked.
            </p>
          </div>

          <div
            className="player"
            role="button"
            tabIndex={0}
            aria-label="Play 2-minute demo"
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
        </div>
      </section>

      {/* ============ CONTACT / FOOTER ============ */}
      <section className="section contact">
        <div className="container">
          <header className="section-head">
            <span className="mono-label">{"// the inbox is open"}</span>
            <h2 className="section-h">Want to break it? Please do.</h2>
          </header>

          {/* <div className="narrowest">
            <p className="body-p">
              This is a hackathon build. It has bugs. We&apos;d rather hear about them than not. Open an issue, send an email, find us on the demo floor.
            </p>
          </div> */}

          <div className="contact-links">
            <div className="contact-row">
              <span className="label">email</span>
              <span className="sep-dot">·</span>
              <a href="mailto:jeevanjyotipy@gmail.com" className="val">
                jeevanjyotipy@gmail.com
              </a>
            </div>
            <div className="contact-row">
              <span className="label">github</span>
              <span className="sep-dot">·</span>
              <a
                href="https://github.com/JeevantheDev/ShipBrain"
                className="val"
                target="_blank"
                rel="noopener noreferrer"
              >
                github.com/JeevantheDev/ShipBrain
              </a>
            </div>
            <div className="contact-row">
              <span className="label">demo</span>
              <span className="sep-dot">·</span>
              <Link href="/login" className="val">
                shipbrain.pages.dev
              </Link>
            </div>
          </div>

          <div className="footer-line">
            © 2026 · shipbrain · built in a weekend with{" "}
            <em className="serif">
              too much coffee and a healthy fear of autonomy
            </em>
          </div>
        </div>
      </section>
    </LandingBody>
  );
}
