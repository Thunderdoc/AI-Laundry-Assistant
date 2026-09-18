import { useEffect, useRef, useState } from "react";
import { MotionButton, MotionPage, Reveal, TextEffect } from "../motion-primitives";
import { useI18n } from "../i18n";
import { FABRICS_DATA } from "../data";

type HomePageProps = {
  /** Public visitors land here before signing in; signed-in users get the full CTA. */
  isPublic: boolean;
  onPrimaryCta: () => void;
  onLibrary: (fabricKey?: string) => void;
};

/** Rotating demo shown inside the hero scanner card so the landing feels alive. */
const DEMO_SCAN = [
  { emoji: "🌱", label: "Cotton (94.2%)" },
  { emoji: "🐑", label: "Wool (91.7%)" },
  { emoji: "🎀", label: "Silk (88.3%)" },
  { emoji: "🍂", label: "Linen (93.1%)" },
  { emoji: "🏭", label: "Synthetic (90.4%)" },
];

/**
 * Evaluation numbers declared in the published training artifact.
 * They are shown as-is and labeled, never extrapolated.
 */
const LANDING_STATS: { value: number; decimals: number; suffix: string; label: string }[] = [
  { value: 6, decimals: 0, suffix: "", label: "Fabric classes (+ non-fabric rejection)" },
  { value: 3940, decimals: 0, suffix: "", label: "Curated training images" },
  { value: 282, decimals: 0, suffix: "", label: "Held-out test images" },
  { value: 79.4, decimals: 1, suffix: "%", label: "Test accuracy (artifact-declared)" },
  { value: 0.8, decimals: 2, suffix: "", label: "Macro F1 (artifact-declared)" },
  { value: 4, decimals: 0, suffix: "", label: "UI languages · °C/°F anywhere" },
];

const FEATURE_WALL: { icon: string; title: string; desc: string; tag?: string }[] = [
  { icon: "📷", title: "AI Fabric Scan", desc: "Camera or upload. Resolution and lighting pre-checks, confidence score, full probability distribution." },
  { icon: "🧾", title: "Full Care Profiles", desc: "Wash, dry, iron, detergent and bleach guidance — with the textile science behind every rule." },
  { icon: "🧪", title: "Stain Treatment Guide", desc: "Six stain types across five fabrics with step-by-step treatment protocols and safety notes." },
  { icon: "⚗️", title: "Smart Dosing Calculator", desc: "Detergent dose tuned to fabric, load size and soil level — never over-dose again." },
  { icon: "🗂️", title: "My Scans Vault", desc: "Scan history with notes, favorites, CSV export and wash reminders.", tag: "Sign in" },
  { icon: "🫧", title: "Wash-Load Planner", desc: "Mix compatible garments into one wash — the strictest conditions always win." },
  { icon: "🤖", title: "Care Assistant", desc: "Bring your own OpenAI key and ask anything about a fabric. Runs entirely in your browser.", tag: "Sign in" },
  { icon: "🔄", title: "Human-Reviewed Active Learning", desc: "Every correction is queued, reviewed by a human, then added to the next training set.", tag: "Admin" },
  { icon: "🛡️", title: "Transparent Model Card", desc: "Metrics, full confusion matrix, confidence thresholds and version history — open book." },
  { icon: "🌍", title: "EN · ES · DE · FR + °C/°F", desc: "Localize the whole experience. Temperature units follow you everywhere." },
];

function CountUp({ target, decimals, suffix, started }: { target: number; decimals: number; suffix: string; started: boolean }) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!started) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const duration = 1400;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - t0) / duration);
      setValue(target * (1 - Math.pow(1 - progress, 3)));
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [started, target]);
  return (
    <span>
      {value.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  );
}

export default function HomePage({ isPublic, onPrimaryCta, onLibrary }: HomePageProps) {
  const { t } = useI18n();

  // Rotate the hero scanner demo (skipped for reduced-motion users).
  const [demoIdx, setDemoIdx] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setDemoIdx((i) => i + 1), 3200);
    return () => window.clearInterval(id);
  }, []);
  const demo = DEMO_SCAN[demoIdx % DEMO_SCAN.length];

  // Count-up starts when the evidence band scrolls into view.
  const statsRef = useRef<HTMLDivElement | null>(null);
  const [statsVisible, setStatsVisible] = useState(false);
  useEffect(() => {
    const el = statsRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setStatsVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.25 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <MotionPage className="page-container">
          {/* Hero Section */}
          <section className="hero-grid">
            <Reveal className="hero-left">
              <span className="eyebrow">{t("hero.eyebrow")}</span>
              <h1>
                <TextEffect>{t("hero.title")}</TextEffect> <br />
                <span className="serif">{t("hero.titleSerif")}</span>
              </h1>
              <p className="lead">
                {t("hero.lead")}
              </p>
              <div className="hero-actions">
                <MotionButton whileHover={{ y: -3 }} whileTap={{ scale: .98 }} className="btn btn-primary" onClick={onPrimaryCta}>
                  {t("hero.primary")} →
                </MotionButton>
                <button className="btn btn-secondary" onClick={() => onLibrary()}>
                  {t("hero.secondary")}
                </button>
              </div>
              <div className="trust-badge">
                <span>🛡️ Computer vision assisted</span>
                <span>•</span>
                <span>Evidence-led</span>
                <span>•</span>
                <span>Care labels authoritative</span>
              </div>
            </Reveal>

            {/* Right Interactive Scanner Simulation */}
            <Reveal className="hero-right" delay={.12}>
              <div className="scanner-card">
                <div className="scanner-viewbox">
                  <div className="macro-fabric-bg">
                    <div className="fabric-grid-overlay"></div>
                    <div className="laser-scan-line"></div>
                    <div className="scan-target-box" key={`t${demoIdx}`}>{demo.emoji}</div>
                  </div>
                </div>
                <div className="scanner-confidence" aria-hidden="true"><i key={`c${demoIdx}`} /></div>
                <div className="scanner-footer">
                  <div className="scanner-pill">
                    <span className="dot"></span>
                    <span>AI Vision: <b key={`l${demoIdx}`} className="scanner-demo-label">{demo.label}</b></span>
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--sage)" }}>Quality: Verified</span>
                </div>
              </div>
            </Reveal>
          </section>

          {/* 5-Step Pipeline Section */}
          <section className="pipeline-section">
            <div className="section-header">
              <span className="eyebrow">METHODOLOGY PIPELINE</span>
              <h2>How LaundryAI Works</h2>
              <p>A transparent 5-stage computer vision and expert rule system from raw image to sustainable care.</p>
            </div>
            <div className="pipeline-grid">
              <div className="pipeline-step">
                <div className="step-num">01 / INPUT</div>
                <div className="step-title">Capture</div>
                <div className="step-desc">Upload or photograph garment with automatic resolution and lighting pre-checks.</div>
              </div>
              <div className="pipeline-step">
                <div className="step-num">02 / VISION</div>
                <div className="step-title">Feature Extract</div>
                <div className="step-desc">CNN layers analyze surface macro-texture, weave pattern, and optical luster.</div>
              </div>
              <div className="pipeline-step">
                <div className="step-num">03 / CLASSIFY</div>
                <div className="step-title">Inference & Gate</div>
                <div className="step-desc">MobileNetV2 estimates class probabilities with confidence and margin gating.</div>
              </div>
              <div className="pipeline-step">
                <div className="step-num">04 / RULE ENGINE</div>
                <div className="step-title">Care Synthesis</div>
                <div className="step-desc">Textile knowledge base generates safe wash temperature, cycle, and iron profiles.</div>
              </div>
              <div className="pipeline-step">
                <div className="step-num">05 / ACTIVE LEARN</div>
                <div className="step-title">Continuous Train</div>
                <div className="step-desc">Human feedback automatically augments training sets for periodic model retraining.</div>
              </div>
            </div>
          </section>

          {/* Inside the Vision Engine */}
          <section style={{ padding: "50px 0", borderTop: "1px solid var(--border)" }}>
            <div className="section-header">
              <span className="eyebrow">DEEP LEARNING CAPABILITIES</span>
              <h2>Inside the Vision Engine</h2>
              <p>What the computer vision model examines to distinguish delicate silks from heavy cotton twills.</p>
            </div>
            <div className="engine-grid">
              <div className="engine-card">
                <div className="engine-icon">🔍</div>
                <h4>Texture</h4>
                <p>Identifies micro-surface relief, fiber fuzziness, and roughness metrics.</p>
              </div>
              <div className="engine-card">
                <div className="engine-icon">📐</div>
                <h4>Weave Pattern</h4>
                <p>Examines plain, twill, satin, or looped knit structural patterns.</p>
              </div>
              <div className="engine-card">
                <div className="engine-icon">✨</div>
                <h4>Optical Luster</h4>
                <p>Distinguishes natural matte cottons from high-luster synthetics and silks.</p>
              </div>
              <div className="engine-card">
                <div className="engine-icon">💬</div>
                <h4>Context Notes</h4>
                <p>Combines visual cues with optional user-supplied garment details.</p>
              </div>
              <div className="engine-card">
                <div className="engine-icon">🛡️</div>
                <h4>Confidence Gate</h4>
                <p>Rejects low-certainty and non-fabric images to prevent false care guidance.</p>
              </div>
            </div>
          </section>

          {/* Supported Fabrics Showcase */}
          <section style={{ padding: "50px 0", borderTop: "1px solid var(--border)" }}>
            <div className="section-header">
              <span className="eyebrow">TEXTILE INTELLIGENCE</span>
              <h2>Supported Fabric Classes</h2>
              <p>Explore our deep-care knowledge base across natural and synthetic materials.</p>
            </div>
            <div className="fabric-showcase-grid">
              {Object.entries(FABRICS_DATA).map(([key, data]) => (
                <div className="fabric-card-preview" key={key}>
                  <div className="fabric-emoji">{data.emoji}</div>
                  <h3>{data.name}</h3>
                  <p>{data.overview}</p>
                  <button
                    className="btn btn-sage btn-sm"
                    onClick={() => onLibrary(key)}
                  >
                    View Care Spec →
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* Sustainability Highlight */}
          <section className="sustainability-banner">
            <div>
              <span className="eyebrow" style={{ color: "#28E6A3" }}>SUSTAINABILITY FIRST</span>
              <h2>Better Care. Lower Impact.</h2>
              <p>
                The right laundering conditions help garments last longer while reducing household water, energy, and microfiber pollution.
              </p>
            </div>
            <div className="impact-pills-grid">
              <div className="impact-pill">
                <b>🌡️ Lower Temperatures</b>
                <span>Saves up to 60% of washing electricity compared to hot cycles.</span>
              </div>
              <div className="impact-pill">
                <b>🌬️ Air Drying</b>
                <span>Eliminates tumble dryer energy and prevents thermal fiber wear.</span>
              </div>
              <div className="impact-pill">
                <b>🌊 Gentler Agitation</b>
                <span>Reduces mechanical friction and synthetic microfiber shedding.</span>
              </div>
              <div className="impact-pill">
                <b>⏳ Extended Garment Life</b>
                <span>Proper care prevents color fading, shrinkage, and premature disposal.</span>
              </div>
            </div>
          </section>
          {/* Evidence band — numbers declared in the published training artifact */}
          <section className="landing-numbers" ref={statsRef}>
            <div className="landing-numbers-grid">
              {LANDING_STATS.map((stat) => (
                <div className="landing-number" key={stat.label}>
                  <b>
                    <CountUp target={stat.value} decimals={stat.decimals} suffix={stat.suffix} started={statsVisible} />
                  </b>
                  <span>{stat.label}</span>
                </div>
              ))}
            </div>
            <p className="landing-numbers-note">
              Figures declared in the published training artifact (3,940 train / 282 held-out test images). The full confusion matrix, per-class precision and recall live on the Model &amp; Research page.
            </p>
          </section>

          {/* Feature wall — the working breadth of the platform */}
          <section className="feature-wall-section">
            <div className="section-header">
              <span className="eyebrow">EVERYTHING IN ONE PLATFORM</span>
              <h2>More than a scanner</h2>
              <p>Ten working capabilities — each one earns its place.</p>
            </div>
            <div className="feature-wall-grid">
              {FEATURE_WALL.map((feature) => (
                <div className="feature-card" key={feature.title}>
                  <div className="feature-icon">{feature.icon}</div>
                  <h4>{feature.title}</h4>
                  <p>{feature.desc}</p>
                  {feature.tag ? <span className="feature-tag">{feature.tag}</span> : null}
                </div>
              ))}
            </div>
          </section>

          {/* Closing CTA band */}
          <section className="landing-cta">
            <h2>{isPublic ? "See it running on your own garment" : "Ready to care better?"}</h2>
            <p>{isPublic ? "Sign in free, then scan your first garment — your history, dosing calculator and care plans live in your private workspace." : "Pick up a garment, scan it, and get the safe care profile in seconds."}</p>
            <MotionButton whileHover={{ y: -3 }} whileTap={{ scale: .98 }} className="btn btn-light" onClick={onPrimaryCta}>
              {isPublic ? "Sign in & scan free" : "Analyze a garment"} →
            </MotionButton>
          </section>

    </MotionPage>
  );
}
