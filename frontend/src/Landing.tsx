import { useClerk, useUser } from "@clerk/clerk-react";
import { BrainBlob, MarbleBlob, ScribbleUnderline, Sparkle, StickerStar, Ribbon, ThoughtTrail } from "./art";

const clerkConfigured = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);

export function Landing() {
  return (
    <div className="landing-root paper-bg">
      <MarbleBlob color="var(--butter-soft)" size={520} rot={20} style={{ top: -120, right: -120 }} />
      <MarbleBlob color="var(--pistachio-soft)" size={420} rot={-10} style={{ top: 360, left: -160 }} />
      <MarbleBlob color="var(--tomato-soft)" size={360} rot={15} style={{ top: 1080, right: -80 }} />
      <MarbleBlob color="var(--plum-soft)" size={420} rot={-20} style={{ top: 1480, left: -120 }} />

      <nav className="landing-nav">
        <a className="brand" href="/">
          <BrainBlob size={42} color="var(--tomato)" />
          <span className="brand-word">stimli</span>
        </a>
        <div className="nav-links">
          <a href="#why">Why pretest</a>
          <a href="#signals">The signals</a>
          <a href="#inputs">Inputs</a>
          <a href="#report">Report</a>
          <a href="/legal">Trust</a>
        </div>
        <div className="nav-actions">
          {clerkConfigured ? <LandingSignInButton /> : null}
          <a className="btn cream" href="/app">Open the workbench →</a>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="dot" style={{ background: "var(--tomato)" }} />
            Creative pretesting · brain-aware
          </span>
          <h1 className="hero-title">
            Know which ad
            <br />
            <span className="hl-tomato">a real brain</span>
            <br />
            will{" "}
            <span style={{ position: "relative", display: "inline-block" }}>
              love.
              <ScribbleUnderline
                color="var(--tomato)"
                width={140}
                style={{ position: "absolute", left: 0, bottom: "-0.18em" }}
              />
            </span>
          </h1>
          <p className="hero-sub">
            Drop in two scripts, landing pages, audio cuts or rough videos. Stimli braids each one
            into a thought-trail, then tells you which to ship and what to tighten — before a
            dollar of media spend goes live.
          </p>
          <div className="hero-actions">
            <a className="btn primary" href="/app">
              <Sparkle color="var(--butter)" size={18} style={{ marginRight: 4 }} />
              Run a comparison
            </a>
            <a className="btn cream" href="#report">See a sample report</a>
          </div>
          <div className="hero-trust">
            <span><span className="swatch" style={{ background: "var(--tomato)" }} />Real TRIBE brain models</span>
            <span><span className="swatch" style={{ background: "var(--pistachio)" }} />Private uploads</span>
            <span><span className="swatch" style={{ background: "var(--butter)" }} />Free to start</span>
          </div>
        </div>

        <div className="hero-art">
          <div className="brain-stage">
            <svg viewBox="0 0 600 600" className="hero-ribbons" preserveAspectRatio="none" aria-hidden="true" focusable="false">
              <path d="M 30 320 Q 180 240 320 320 T 580 320" stroke="var(--tomato)" strokeWidth="12" fill="none" strokeLinecap="round" opacity="0.55" />
              <path d="M 30 360 Q 180 290 320 360 T 580 360" stroke="var(--pistachio)" strokeWidth="10" fill="none" strokeLinecap="round" opacity="0.55" />
              <path d="M 30 400 Q 180 340 320 400 T 580 400" stroke="var(--butter)" strokeWidth="9" fill="none" strokeLinecap="round" opacity="0.55" />
              <path d="M 30 440 Q 180 390 320 440 T 580 440" stroke="var(--plum)" strokeWidth="8" fill="none" strokeLinecap="round" opacity="0.55" />
            </svg>

            <div className="hero-brain bob slow" style={{ ["--rot" as string]: "-4deg" } as React.CSSProperties}>
              <BrainBlob size={300} color="var(--hero-brain)" eyes mouth />
            </div>

            <div className="orbit-blob bob fast" style={{ top: "2%", left: "4%", ["--rot" as string]: "-8deg" } as React.CSSProperties}>
              <BrainBlob size={82} color="var(--pistachio)" />
              <span className="orbit-label">Memory</span>
            </div>
            <div className="orbit-blob bob slow" style={{ top: "0%", right: "6%", ["--rot" as string]: "12deg" } as React.CSSProperties}>
              <BrainBlob size={92} color="var(--butter)" />
              <span className="orbit-label">Attention</span>
            </div>
            <div className="orbit-blob bob" style={{ bottom: "6%", right: "4%", ["--rot" as string]: "-12deg" } as React.CSSProperties}>
              <BrainBlob size={78} color="var(--plum)" />
              <span className="orbit-label">Load</span>
            </div>
            <div className="orbit-blob bob" style={{ bottom: "2%", left: "6%", ["--rot" as string]: "10deg" } as React.CSSProperties}>
              <BrainBlob size={70} color="var(--tomato)" />
              <span className="orbit-label">Hook</span>
            </div>

            <div className="sticker-callout" style={{ top: "34%", right: "10px" }}>
              <StickerStar color="var(--butter)" size={128} rot={-12} />
              <div className="sticker-bubble">
                <strong>92%</strong>
                <span>confidence</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="proof-strip" id="why">
        <div className="proof-cell">
          <strong>$8.4k</strong>
          <span>avoidable spend flagged before launch</span>
        </div>
        <span className="proof-divider">✺</span>
        <div className="proof-cell">
          <strong>14&thinsp;pts</strong>
          <span>average winner delta on benchmark</span>
        </div>
        <span className="proof-divider">✺</span>
        <div className="proof-cell">
          <strong>0:03</strong>
          <span>first-hook window scored on its own</span>
        </div>
        <span className="proof-divider">✺</span>
        <div className="proof-cell">
          <strong>5 modes</strong>
          <span>script · page · image · audio · video</span>
        </div>
      </section>

      <section className="signals" id="signals">
        <div className="section-head">
          <span className="kicker">02 — the four signals</span>
          <h2>
            Four colors. Four kinds of evidence.{" "}
            <span className="hl-pist">No dashboards.</span>
          </h2>
          <p>
            Every decision is a short story told across four signals: the moment a viewer commits,
            what they'll remember tomorrow, where their eyes actually land, and how hard their
            brain had to work to get there.
          </p>
        </div>
        <div className="signals-grid">
          {[
            { c: "var(--tomato)", n: "Hook", v: "86", t: "The first three seconds build enough tension that the viewer keeps watching." },
            { c: "var(--pistachio)", n: "Memory", v: "82", t: "A distinctive phrase and the visual proof both echo back at the close." },
            { c: "var(--butter)", n: "Attention", v: "78", t: "Eyes track the logo and the offer before the proof claim arrives." },
            { c: "var(--plum)", n: "Load", v: "41", t: "Variant B overloads the offer reveal with too many claims at once." }
          ].map((s, i) => (
            <article
              key={s.n}
              className="signal-card"
              style={{
                ["--accent" as string]: s.c,
                transform: `rotate(${[-1.5, 1, -1, 1.5][i]}deg)`
              } as React.CSSProperties}
            >
              <div className="signal-head">
                <BrainBlob size={56} color={s.c} />
                <div>
                  <span className="signal-name">{s.n}</span>
                  <strong className="signal-val">{s.v}</strong>
                </div>
              </div>
              <p>{s.t}</p>
              <Ribbon color={s.c} width={260} height={40} amp={10} freq={5 + i} thickness={6} phase={i} />
            </article>
          ))}
        </div>
      </section>

      <section className="inputs-section" id="inputs">
        <div className="section-head">
          <span className="kicker">03 — bring anything</span>
          <h2>Hand us whatever you've got.</h2>
          <p>
            Script, landing page, static ad, voiceover, rough cut — Stimli reads the messy
            inputs growth teams actually have on hand and grades them on the same brain-aware
            timeline.
          </p>
        </div>
        <div className="inputs-grid">
          {[
            ["Script", "Hook tension · claim order · offer clarity", "var(--tomato-soft)"],
            ["Landing page", "Page promise · proof density · CTA", "var(--pistachio-soft)"],
            ["Static ad", "Brand cue · visual density · CTA placement", "var(--butter-soft)"],
            ["Audio", "Pacing · memory cues · cognitive load", "var(--plum-soft)"],
            ["Video", "Attention timeline · edit moments · hook beat", "var(--tomato-soft)"]
          ].map(([n, t, bg], i) => (
            <article
              key={n}
              className="input-card"
              style={{ background: bg, transform: `rotate(${[-1.5, 1, -1, 1, -0.5][i]}deg)` }}
            >
              <div className="input-num">{String(i + 1).padStart(2, "0")}</div>
              <strong>{n}</strong>
              <p>{t}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="report-preview" id="report">
        <div className="section-head">
          <span className="kicker">04 — the report</span>
          <h2>One page. One answer. The edit list.</h2>
          <p>
            The winner, the score deltas, the timeline evidence, and the edits to make before launch — packaged
            into a single artifact you can share with creative, growth and the founder.
          </p>
        </div>

        <div className="report-card-wrap">
          <div className="report-card-tilt">
            <div className="report-card-inner">
              <header>
                <span className="kicker">Decision report · Lumina · Q3</span>
                <h3>Ship Variant A. Tighten the CTA before launch.</h3>
              </header>
              <div className="report-mid">
                <div className="report-score">
                  <span>Confidence</span>
                  <strong>
                    92<small>%</small>
                  </strong>
                </div>
                <div className="report-trail">
                  <ThoughtTrail width={460} height={120} intensity={0.9} baseFreq={4} />
                </div>
              </div>
              <ul className="report-edits">
                <li>
                  <span className="dot" style={{ background: "var(--tomato)" }} />
                  Move the offer into the first three seconds.
                </li>
                <li>
                  <span className="dot" style={{ background: "var(--butter)" }} />
                  Land the brand cue before the proof claim.
                </li>
                <li>
                  <span className="dot" style={{ background: "var(--pistachio)" }} />
                  Swap the generic close for a starter-kit CTA.
                </li>
              </ul>
            </div>
          </div>
          <StickerStar color="var(--tomato)" size={84} rot={-14} style={{ position: "absolute", top: -34, left: -34 }} />
        </div>
      </section>

      <section className="final-cta">
        <div className="cta-inner">
          <h2>Pretest before you spend.</h2>
          <p>First comparison runs in under sixty seconds. No card, no setup.</p>
          <a className="btn primary" href="/app">Open the workbench →</a>
        </div>
        <div className="cta-blobs">
          <div className="bob" style={{ ["--rot" as string]: "-12deg" } as React.CSSProperties}>
            <BrainBlob size={120} color="var(--pistachio)" />
          </div>
          <div className="bob slow" style={{ ["--rot" as string]: "8deg" } as React.CSSProperties}>
            <BrainBlob size={150} color="var(--butter)" eyes mouth />
          </div>
          <div className="bob fast" style={{ ["--rot" as string]: "-4deg" } as React.CSSProperties}>
            <BrainBlob size={104} color="var(--plum)" />
          </div>
        </div>
      </section>

      <footer className="landing-foot">
        <span>© 2026 Stimli · pretest, don't guess</span>
        <a href="/legal">Trust & license</a>
      </footer>
    </div>
  );
}

function LandingSignInButton() {
  const { isLoaded, isSignedIn } = useUser();
  const clerk = useClerk();
  if (isLoaded && isSignedIn) {
    return (
      <a className="btn ghost" href="/app">
        Open app
      </a>
    );
  }
  return (
    <button
      type="button"
      className="btn ghost"
      onClick={() => clerk?.openSignIn({ forceRedirectUrl: "/app" })}
    >
      Sign in
    </button>
  );
}
