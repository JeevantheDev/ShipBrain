import { redirect } from "next/navigation";
import Link from "next/link";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { LandingBody } from "@/components/landing/LandingBody";
import "./landing.css";

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const supabase = getSupabaseServerClient();
  const {
    data: { user }
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
            <span className="glyph">◆</span>
            shipbrain
          </Link>
          <nav className="lp-nav">
            <a href="#product">product</a>
            <span className="sep">·</span>
            <a href="#gates">gates</a>
            <span className="sep">·</span>
            <a href="#demo">demo</a>
            <span className="sep">·</span>
            <a href="#team">team</a>
          </nav>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <Link href="/login" className="btn-cta ghost" style={{ height: "32px", padding: "0 14px", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: "0.05em" }}>
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
          <span className="mono-label eyebrow">{"// hackathon · 2026"}</span>
          <h1 className="hero-h">
            Ship software at <em>AI&nbsp;speed</em>,<br />
            with humans <em>still in charge</em>.
          </h1>
          <p className="hero-sub">
            ShipBrain turns a Jira ticket into a reviewed pull request, explains your red CI in plain English, and drafts the post-mortem before the incident is closed — but never <em>acts</em> without you pressing confirm.
          </p>
          <div className="cta-row">
            <Link href="/login" className="btn-cta">Get Started →</Link>
            <a href="#demo" className="btn-cta ghost">See the demo</a>
            <a href="https://github.com/JeevantheDev/ShipBrain" className="text-link" target="_blank" rel="noopener noreferrer">GitHub <span className="arr">↗</span></a>
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
              Engineers spend <em>more time on the loop</em> than the work.
            </h2>
          </header>

          <div className="narrow">
            <p className="body-p">
              Most of an engineer&apos;s day isn&apos;t writing code. It&apos;s reading tickets, breaking them into tasks, opening PRs, babysitting CI, decoding stack traces at 2am, and writing post-mortems that nobody reads.
            </p>
            <p className="body-p">
              The AI tools that exist either do too little (autocomplete) or too much (autonomous agents that ship broken code while you sleep). Neither is the right shape for production software.
            </p>
          </div>

          <blockquote className="pull-quote">
            &ldquo;The right shape is: AI proposes, human approves, system acts.&rdquo;
          </blockquote>
        </div>
      </section>

      {/* ============ SECTION 02 — Product ============ */}
      <section className="section" id="product">
        <div className="container">
          <header className="section-head">
            <span className="mono-label">02 / the product</span>
            <h2 className="section-h">
              Four moves. Every one of them <em>gated</em>.
            </h2>
          </header>

          <div className="narrow">
            <p className="body-p">
              ShipBrain is a console that sits next to GitHub. It does four things — and pauses for your approval before each one matters.
            </p>
          </div>

          <div className="moves-grid">
            <article className="move-card">
              <span className="mono-label">move · 01</span>
              <h3 className="move-card-title">Spec <em>→</em> PR</h3>
              <p className="body">Paste a Jira ticket or a paragraph of English. ShipBrain decomposes it into tasks, scaffolds the files, and prepares a draft PR. You review the plan, hit confirm, and the PR opens on GitHub.</p>
              <div className="move-card-foot">gated before opening · default to draft</div>
            </article>

            <article className="move-card">
              <span className="mono-label">move · 02</span>
              <h3 className="move-card-title">Red CI, <em>explained</em></h3>
              <p className="body">When a build fails, ShipBrain reads the logs and tells you what broke, in the same language you&apos;d use in Slack. Suggests a fix. If CI passes, the deploy button unlocks — but still waits for your confirm.</p>
              <div className="move-card-foot">gated before deploy · 3-second undo window</div>
            </article>

            <article className="move-card">
              <span className="mono-label">move · 03</span>
              <h3 className="move-card-title">Incidents, <em>analyzed</em></h3>
              <p className="body">A webhook fires or you paste an alert. ShipBrain proposes a root cause with a confidence score and a fix you can apply. Nothing runs until you confirm — and you can cancel mid-countdown.</p>
              <div className="move-card-foot">gated before fix applies · rollback steps included</div>
            </article>

            <article className="move-card">
              <span className="mono-label">move · 04</span>
              <h3 className="move-card-title">Post-mortems, <em>drafted</em></h3>
              <p className="body">When an incident resolves, the post-mortem is already written — timeline, impact, root cause, action items. You edit and file. Stops the &ldquo;we&apos;ll write it tomorrow&rdquo; doom loop.</p>
              <div className="move-card-foot">editable markdown · copy or download</div>
            </article>
          </div>
        </div>
      </section>

      {/* ============ SECTION 03 — Bet / Gates ============ */}
      <section className="section" id="gates">
        <div className="container">
          <header className="section-head">
            <span className="mono-label">03 / the bet</span>
            <h2 className="section-h">
              The whole product is <em>one design idea</em>.
            </h2>
          </header>

          <div className="narrow">
            <p className="body-p">
              We think autonomous agents are the wrong abstraction for shipping code. The valuable thing isn&apos;t an AI that acts on your behalf — it&apos;s an AI that does the boring 80% and hands you a clean decision.
            </p>
            <p className="body-p">
              So ShipBrain has one component used in three places: the <span className="light">approval gate</span>. Same shape every time. Same muscle memory. The button you press to ship a PR feels identical to the one you press to apply an incident fix.
            </p>
          </div>

          <div className="gate-stack">
            {/* State 1 */}
            <button className="gate-default" type="button">Create Draft PR</button>

            {/* State 2 */}
            <div className="gate gate-review">
              <div className="gate-review-row">
                <span className="gate-summary">
                  <span className="muted">Will open Draft PR to </span>
                  <span className="repo">acme/api-server</span>
                  <span className="muted">:</span>
                  <span className="repo">main</span>
                </span>
                <div className="gate-btns">
                  <button className="gate-btn ghost" type="button">Cancel</button>
                  <button className="gate-btn primary" type="button">Confirm</button>
                </div>
              </div>
              <div className="gate-progress" aria-hidden="true"></div>
            </div>

            {/* State 3 */}
            <div className="gate-done">
              <div className="gate-done-left">
                <span className="gate-check" aria-hidden="true">
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6.5l2.2 2.2L9.5 3.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </span>
                <span>PR #42 created on <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "13px" }}>acme/api-server</span></span>
              </div>
              <a href="#" className="link">view on GitHub →</a>
            </div>
          </div>

          <div className="gate-caption">
            default <span className="sep">·</span> reviewing <span className="sep">·</span> done
          </div>
        </div>
      </section>

      {/* ============ SECTION 04 — Model-agnostic ============ */}
      <section className="section">
        <div className="container">
          <header className="section-head">
            <span className="mono-label">04 / model-agnostic</span>
            <h2 className="section-h">
              Swap the brain. <em>Keep the gates.</em>
            </h2>
          </header>

          <div className="narrow">
            <p className="body-p">
              ShipBrain talks to Claude by default, but the provider is one line in <span className="light" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "15px" }}>.env</span>. Anthropic, OpenAI, a local model — change the brain, every approval gate, prompt, and workflow stays identical.
            </p>
          </div>

          <div className="codeblock">
            <button className="copy-btn" type="button">copy</button>
            <span className="key">AI_PROVIDER</span>=<span className="val">anthropic</span><br />
            <span className="key">AI_MODEL</span>=<span className="val">claude-sonnet-4.6</span><br />
            <br />
            <span className="comment"># swap to:</span><br />
            <span className="key">AI_PROVIDER</span>=<span className="val">openai</span><br />
            <span className="key">AI_MODEL</span>=<span className="val">gpt-4.1</span>
          </div>
        </div>
      </section>

      {/* ============ SECTION 05 — Demo ============ */}
      <section className="section" id="demo">
        <div className="container">
          <header className="section-head">
            <span className="mono-label">05 / the demo</span>
            <h2 className="section-h">
              Two minutes. <em>Four moves.</em> One ticket.
            </h2>
          </header>

          <div className="narrow">
            <p className="body-p">
              Watch ShipBrain take a real Jira ticket, open a PR, fail CI, explain the failure, suggest a fix, pass CI, deploy, page itself with a fake incident, find the root cause, and draft the post-mortem.
            </p>
            <p className="body-p">
              Every gate is real. Every confirm is a real click. Nothing is mocked.
            </p>
          </div>

          <div className="player" role="button" tabIndex={0} aria-label="Play 2-minute demo">
            <div className="player-bg" aria-hidden="true"></div>
            <div className="player-center">
              <div className="play-circle" aria-hidden="true">
                <span className="play-tri"></span>
              </div>
              <span className="player-label">Play the 2-minute demo</span>
            </div>
            <span className="player-foot">runs in your browser <span className="dot">·</span> no signup</span>
          </div>
        </div>
      </section>

      {/* ============ SECTION 06 — Is / Isn't ============ */}
      <section className="section">
        <div className="container">
          <header className="section-head">
            <span className="mono-label">06 / honest disclosures</span>
            <h2 className="section-h">
              What it <em>is</em>. What it <em>isn&apos;t</em>.
            </h2>
          </header>

          <div className="is-isnt">
            <div className="is-list">
              <div className="col-h is">it is</div>
              <ul>
                <li>A console for one engineer or a small team</li>
                <li>A wrapper around your existing GitHub + CI + alerting</li>
                <li>A demonstration that approval gates beat autonomy</li>
                <li>Open source, MIT licensed</li>
                <li>A hackathon submission, built in a weekend</li>
              </ul>
            </div>
            <div className="is-list">
              <div className="col-h isnt">it isn&apos;t</div>
              <ul>
                <li>An autonomous agent</li>
                <li>A replacement for code review</li>
                <li>Production-ready for your Fortune 500</li>
                <li>A startup (yet)</li>
                <li>Magic <span className="muted">— it makes mistakes, which is exactly why the gates exist</span></li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ============ SECTION 07 — Team ============ */}
      <section className="section" id="team">
        <div className="container">
          <header className="section-head">
            <span className="mono-label">07 / team</span>
            <h2 className="section-h">
              Built by <em>1 engineer</em>, in <em>48 hours</em>.
            </h2>
          </header>

          <div className="narrow">
            <p className="body-p">Hackathon team. Find us on the demo floor.</p>
          </div>

          <div className="team-row" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
            <article className="team-card">
              <span className="team-avatar">JD</span>
              <div>
                <div className="team-name" style={{ fontWeight: 600 }}>Jeevan Jyoti Dash</div>
                <div className="team-role" style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>Full Stack Architect</div>
                <a href="https://github.com/JeevantheDev" className="team-link" target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", marginTop: "8px" }}>@JeevantheDev</a>
              </div>
            </article>

            <article className="team-card">
              <span className="team-avatar">SB</span>
              <div>
                <div className="team-name" style={{ fontWeight: 600 }}>ShipBrain AI</div>
                <div className="team-role" style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px" }}>Mechanical Operator</div>
                <span className="team-role" style={{ display: "inline-block", marginTop: "8px", color: "var(--ai-purple)" }}>Autonomous Agent</span>
              </div>
            </article>
          </div>
        </div>
      </section>

      {/* ============ CONTACT / FOOTER ============ */}
      <section className="section contact">
        <div className="container">
          <header className="section-head">
            <span className="mono-label">{"// the inbox is open"}</span>
            <h2 className="section-h">
              Want to break it? <em>Please do.</em>
            </h2>
          </header>

          <div className="narrowest">
            <p className="body-p">
              This is a hackathon build. It has bugs. We&apos;d rather hear about them than not. Open an issue, send an email, find us on the demo floor.
            </p>
          </div>

          <div className="contact-links">
            <div className="contact-row">
              <span className="label">email</span>
              <span className="sep-dot">·</span>
              <a href="mailto:jeevanjyotipy@gmail.com" className="val">jeevanjyotipy@gmail.com</a>
            </div>
            <div className="contact-row">
              <span className="label">github</span>
              <span className="sep-dot">·</span>
              <a href="https://github.com/JeevantheDev/ShipBrain" className="val" target="_blank" rel="noopener noreferrer">github.com/JeevantheDev/ShipBrain</a>
            </div>
            <div className="contact-row">
              <span className="label">demo</span>
              <span className="sep-dot">·</span>
              <Link href="/login" className="val">shipbrain.pages.dev</Link>
            </div>
          </div>

          <div className="footer-line">
            © 2026 · shipbrain · built in a weekend with <em className="serif">too much coffee and a healthy fear of autonomy</em>
          </div>
        </div>
      </section>
    </LandingBody>
  );
}
