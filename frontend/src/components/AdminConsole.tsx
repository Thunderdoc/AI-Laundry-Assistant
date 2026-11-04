import { Fragment, useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { useReducedMotion } from "motion/react";
import { MotionPanel } from "../motion-primitives";
import {
  IconBasket,
  IconCheckCircle,
  IconChip,
  IconDatabase,
  IconGrid,
  IconList,
  IconProfile,
  IconRefresh,
  IconScanFrame,
  IconShield,
  type IconProps,
} from "./CareSymbols";
import {
  API,
  apiFetch,
  type AdminAuditEntry,
  type AdminFeedbackItem,
  type AdminHealth,
  type AdminUser,
  type DatasetStats,
  type SignedInUser,
} from "../lib";

type AdminAnalytics = {
  days: number;
  scan_count: number;
  fabric_distribution: Record<string, number>;
  confidence: { average: number | null; buckets: Record<string, number> };
  daily_trend: { date: string; count: number }[];
};

type Section = "overview" | "dataset" | "model" | "scans" | "feedback" | "users" | "audit";

const CONFIDENCE_BUCKETS: [string, string][] = [
  ["Excellent · 90–100%", "90-100"],
  ["High · 75–89%", "75-89"],
  ["Medium · 50–74%", "50-74"],
  ["Low · 0–49%", "0-49"],
];

const CLASS_ORDER = ["cotton", "polyester", "denim", "wool", "silk", "non_fabric"];

/** Fill every day of the window so the trend line is continuous, not sparse. */
function buildTrend(trend: { date: string; count: number }[], days = 30): { date: string; count: number }[] {
  const byDate = new Map(trend.map((point) => [point.date, point.count]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const out: { date: string; count: number }[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setDate(day.getDate() - offset);
    const key = day.toISOString().slice(0, 10);
    out.push({ date: key, count: byDate.get(key) ?? 0 });
  }
  return out;
}

/** Pure-SVG area chart — no chart library, scales to its container. The line
 * draws itself in on mount (pathLength normalises the dash maths); the
 * global reduced-motion rule collapses the animation to instant. */
function TrendChart({ series }: { series: { date: string; count: number }[] }) {
  const w = 720;
  const h = 190;
  const padX = 8;
  const padTop = 14;
  const padBottom = 10;
  const max = Math.max(1, ...series.map((day) => day.count));
  const n = series.length;
  const x = (index: number) => padX + (index * (w - padX * 2)) / Math.max(1, n - 1);
  const y = (count: number) => padTop + (1 - count / max) * (h - padTop - padBottom);
  const line = series.map((day, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(day.count).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${(h - padBottom).toFixed(1)} L${x(0).toFixed(1)},${(h - padBottom).toFixed(1)} Z`;
  const formatTick = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
  return (
    <div className="admin-trend-chart">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Daily scan volume, last 30 days">
        {[1, 0.5, 0].map((fraction) => (
          <line key={fraction} x1={padX} x2={w - padX} y1={y(max * fraction)} y2={y(max * fraction)} className="trend-gridline" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={area} className="trend-area" />
        <path d={line} className="trend-line" fill="none" vectorEffect="non-scaling-stroke" pathLength={1} />
      </svg>
      <div className="trend-axis" aria-hidden="true">
        <span>{formatTick(series[0].date)}</span>
        <span>{formatTick(series[Math.floor((n - 1) / 2)].date)}</span>
        <span>{formatTick(series[n - 1].date)}</span>
      </div>
    </div>
  );
}

/** Animated number: counts up once when a real value first arrives; later
 * refreshes land instantly so the console never replays theatre on a poll.
 * Reduced motion (and the global CSS rule) shows the final value at once. */
function CountUp({ value, decimals = 0, suffix = "" }: { value: number | null | undefined; decimals?: number; suffix?: string }) {
  const reduceMotion = useReducedMotion();
  const animatedOnce = useRef(false);
  const [display, setDisplay] = useState<number | null>(null);
  useEffect(() => {
    if (value == null || !Number.isFinite(value)) return;
    if (reduceMotion || animatedOnce.current) {
      animatedOnce.current = true;
      setDisplay(value);
      return;
    }
    animatedOnce.current = true;
    let raf = 0;
    const start = performance.now();
    const duration = 900;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(value * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduceMotion]);
  if (value == null || display == null) return <>—</>;
  return <>{display.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{suffix}</>;
}

/** Label / animated bar / value row used by dataset balance, confidence
 * health, fabric mix and per-class metrics. The fill transitions from 0 to
 * its share the first time the row mounts (i.e. when its view opens). */
function BarRow({ label, share, value, note, warn = false }: { label: string; share: number; value: string; note?: string; warn?: boolean }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const pct = Math.max(0, Math.min(100, share * 100));
  return (
    <div className={`console-bar-row ${warn ? "warn" : ""}`}>
      <span className="console-bar-label">{label}</span>
      <div className="console-bar" role="presentation"><i style={{ width: mounted ? `${Math.max(pct, 1.5)}%` : "0%" }} /></div>
      <b className="console-bar-value">{value}</b>
      {note && <small className="console-bar-note">{note}</small>}
    </div>
  );
}

function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="console-skeleton" role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, index) => <span key={index} style={{ width: `${88 - index * 13}%` }} />)}
    </div>
  );
}

function AdminFeedbackPreview({ item }: { item: AdminFeedbackItem }) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    let active = true;
    void apiFetch(`${API}/admin/feedback/${encodeURIComponent(item.fabric)}/${encodeURIComponent(item.file)}/image`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Preview unavailable");
        objectUrl = URL.createObjectURL(await response.blob());
        if (active) setSource(objectUrl);
      })
      .catch(() => { if (active) setFailed(true); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.fabric, item.file]);
  if (failed) return <div className="admin-preview-placeholder">Preview unavailable</div>;
  if (!source) return <div className="admin-preview-placeholder">Loading image…</div>;
  return <img className="admin-feedback-preview" src={source} alt={`Submitted ${item.fabric} feedback`} />;
}


const SECTION_META: Record<Section, { title: string; blurb: string }> = {
  overview: { title: "Operations overview", blurb: "The numbers an operator checks first — scans, review load, people and data." },
  dataset: { title: "Dataset & balance", blurb: "The training corpus the model learns from: per-class counts, balance and verified contributions." },
  model: { title: "Model & release", blurb: "The deployed model's measured performance, its promotion policy and the training pipeline state." },
  scans: { title: "All scans", blurb: "Every recorded garment analysis across the platform, with the user's verdict where they gave one." },
  feedback: { title: "Feedback review", blurb: "User-corrected labels waiting for a decision. Approved images join the training dataset." },
  users: { title: "Users & roles", blurb: "The account directory. Administrator access is granted here — and only here." },
  audit: { title: "Audit log", blurb: "The recorded trail of administrative actions on this platform." },
};

export default function AdminConsole({ user, datasetStats }: { user: SignedInUser; datasetStats?: DatasetStats }) {
  const [adminOverview, setAdminOverview] = useState<any>(null);
  const [adminFeedback, setAdminFeedback] = useState<AdminFeedbackItem[]>([]);
  const [adminScans, setAdminScans] = useState<any[]>([]);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminAudit, setAdminAudit] = useState<AdminAuditEntry[]>([]);
  const [adminHealth, setAdminHealth] = useState<AdminHealth | null>(null);
  const [adminMessage, setAdminMessage] = useState("");
  const [adminErrors, setAdminErrors] = useState<Record<string, string>>({});
  const [adminPanelLoading, setAdminPanelLoading] = useState<Record<string, boolean>>({});
  const [reviewQuery, setReviewQuery] = useState("");
  const [scanQuery, setScanQuery] = useState("");
  const [scanFilter, setScanFilter] = useState<"all" | "corrected" | "confirmed">("all");
  const [userQuery, setUserQuery] = useState("");
  const [adminLoading, setAdminLoading] = useState(false);
  const [section, setSection] = useState<Section>("overview");
  const [adminRefreshKey, setAdminRefreshKey] = useState(0);
  const [adminLastUpdated, setAdminLastUpdated] = useState<string>("");
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);
  const [reviewFocus, setReviewFocus] = useState(0);
  // Dataset / model surfaces (redesign): dedicated read models for the
  // Dataset and Model sections, seeded from the prop main.tsx already loads.
  const [datasetData, setDatasetData] = useState<DatasetStats | null>(datasetStats ?? null);
  const [modelManifest, setModelManifest] = useState<any>(null);
  const [modelInfo, setModelInfo] = useState<any>(null);
  const [governance, setGovernance] = useState<any>(null);
  const [retrainStatus, setRetrainStatus] = useState<any>(null);

  // Users are loaded lazily: the Firebase user directory is the heaviest admin
  // call. Overview needs the real count for its KPI card, so the directory
  // loads when Overview or Users is open — the call itself is unchanged.
  const [usersLoaded, setUsersLoaded] = useState(false);
  useEffect(() => {
    if ((section !== "users" && section !== "overview") || usersLoaded) return;
    let cancelled = false;
    setAdminPanelLoading((current) => ({ ...current, users: true }));
    const done = () => { if (!cancelled) setAdminPanelLoading((current) => ({ ...current, users: false })); };
    void apiFetch(`${API}/admin/users`)
      .then(async (response) => {
        if (cancelled) return;
        if (response.ok) {
          const data = await response.json();
          setAdminUsers(data.users || []);
          setUsersLoaded(true);
        } else {
          const failure = await response.json().catch(() => ({}));
          setAdminErrors((current) => ({ ...current, users: failure.detail || "User directory temporarily unavailable." }));
        }
      })
      .catch(() => {
        if (!cancelled) setAdminErrors((current) => ({ ...current, users: "User directory temporarily unavailable." }));
      })
      .finally(done);
    return () => { cancelled = true; };
  }, [section, usersLoaded]);

  useEffect(() => {
    if (!user.is_admin) return;
    let timer: number | undefined;
    const refreshAdminOverview = async () => {
      setAdminLoading(true);
      setAdminMessage("");
      setAdminPanelLoading({ overview: true, feedback: true, scans: true, audit: true, health: true, dataset: true, model: true });
      const [healthResponse, overviewResponse, feedbackResponse, scansResponse, auditResponse, analyticsResponse, datasetResponse, metricsResponse, infoResponse, governanceResponse, retrainResponse] = await Promise.all([
        fetch(`${API}/health`, { cache: "no-store" }).catch(() => null),
        apiFetch(`${API}/admin/overview`).catch(() => null),
        apiFetch(`${API}/admin/feedback`).catch(() => null),
        apiFetch(`${API}/admin/scans`).catch(() => null),
        apiFetch(`${API}/admin/audit-log`).catch(() => null),
        apiFetch(`${API}/admin/analytics?days=30`).catch(() => null),
        apiFetch(`${API}/dataset/stats`).catch(() => null),
        apiFetch(`${API}/model/metrics`).catch(() => null),
        apiFetch(`${API}/model/info`).catch(() => null),
        apiFetch(`${API}/admin/model/governance`).catch(() => null),
        apiFetch(`${API}/retrain/status`).catch(() => null),
      ]);
      const nextErrors: Record<string, string> = {};
      if (healthResponse?.ok) setAdminHealth(await healthResponse.json());
      else nextErrors.health = "Health endpoint unavailable.";
      if (overviewResponse && overviewResponse.ok) {
        const overview = await overviewResponse.json();
        setAdminOverview(overview);
        setAdminMessage((overview.warnings || []).join(" "));
      } else {
        const failure = overviewResponse ? await overviewResponse.json().catch(() => ({})) : {};
        nextErrors.overview = failure.detail || (overviewResponse ? `Operations API returned ${overviewResponse.status}.` : "Operations API unreachable.");
      }
      if (feedbackResponse && feedbackResponse.ok) {
        setAdminFeedback((await feedbackResponse.json()).items || []);
      } else {
        const failure = feedbackResponse ? await feedbackResponse.json().catch(() => ({})) : {};
        nextErrors.feedback = failure.detail || "Feedback review queue temporarily unavailable.";
      }
      if (scansResponse && scansResponse.ok) {
        setAdminScans((await scansResponse.json()).items || []);
      } else {
        const failure = scansResponse ? await scansResponse.json().catch(() => ({})) : {};
        nextErrors.scans = failure.detail || "Scan history temporarily unavailable.";
      }
      if (auditResponse && auditResponse.ok) {
        const audit = await auditResponse.json();
        setAdminAudit(audit.items || audit.events || []);
      } else if (auditResponse?.status !== 404) {
        nextErrors.audit = "Audit history temporarily unavailable.";
      }
      if (analyticsResponse && analyticsResponse.ok) {
        setAnalytics(await analyticsResponse.json());
      }
      // Dataset & model read models: failures here stay silent because the
      // overview payload carries fallbacks for both sections.
      if (datasetResponse && datasetResponse.ok) {
        setDatasetData(await datasetResponse.json());
      }
      if (metricsResponse && metricsResponse.ok) {
        const payload = await metricsResponse.json();
        if (payload?.available && payload.metrics) setModelManifest(payload.metrics);
      }
      if (infoResponse && infoResponse.ok) {
        setModelInfo(await infoResponse.json());
      }
      if (governanceResponse && governanceResponse.ok) {
        setGovernance(await governanceResponse.json());
      }
      if (retrainResponse && retrainResponse.ok) {
        setRetrainStatus(await retrainResponse.json());
      }
      setAdminErrors(nextErrors);
      setAdminPanelLoading({});
      setAdminLastUpdated(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      setAdminLoading(false);
    };
    void refreshAdminOverview().catch(() => {
      setAdminLoading(false);
      setAdminPanelLoading({});
    });
    // Conditional loop: it polls only while the model-training job is active.
    if (adminOverview?.retraining?.status === "running") {
      timer = window.setInterval(() => void refreshAdminOverview().catch(() => undefined), 5000);
    }
    return () => { if (timer) window.clearInterval(timer); };
  }, [user.is_admin, adminOverview?.retraining?.status, adminRefreshKey]);

  const approveItem = useCallback(async (item: AdminFeedbackItem) => {
    const response = await apiFetch(`${API}/admin/feedback/${encodeURIComponent(item.fabric)}/${encodeURIComponent(item.file)}/approve`, { method: "POST" });
    if (response.ok) setAdminFeedback((items) => items.filter((candidate) => candidate.file !== item.file));
    else setAdminMessage("Could not approve this feedback item.");
  }, []);
  const rejectItem = useCallback(async (item: AdminFeedbackItem) => {
    if (!window.confirm("Reject this feedback image?")) return;
    const response = await apiFetch(`${API}/admin/feedback/${encodeURIComponent(item.fabric)}/${encodeURIComponent(item.file)}`, { method: "DELETE" });
    if (response.ok) setAdminFeedback((items) => items.filter((candidate) => candidate.file !== item.file));
    else setAdminMessage("Could not reject this feedback item.");
  }, []);

  const normalizedReviewQuery = reviewQuery.trim().toLowerCase();
  const filteredFeedback = adminFeedback.filter((item) =>
    !normalizedReviewQuery || [item.fabric, item.original_fabric, item.filename, item.file].some((value) => String(value || "").toLowerCase().includes(normalizedReviewQuery))
  );
  const normalizedScanQuery = scanQuery.trim().toLowerCase();
  const filteredScans = adminScans.filter((scan) => {
    const matchesQuery = !normalizedScanQuery || [scan.fabric, scan.note, scan.owner_uid, scan.id].some((value) => String(value || "").toLowerCase().includes(normalizedScanQuery));
    const corrected = Boolean(scan.user_feedback && !scan.user_feedback.was_correct);
    const confirmed = Boolean(scan.user_feedback?.was_correct);
    return matchesQuery && (scanFilter === "all" || (scanFilter === "corrected" && corrected) || (scanFilter === "confirmed" && confirmed));
  });
  const filteredUsers = adminUsers.filter((account) =>
    !userQuery.trim() || [account.name, account.email, account.uid].some((value) => String(value || "").toLowerCase().includes(userQuery.trim().toLowerCase()))
  );

  // Keyboard-first review: arrows move focus, A/Enter approve, R rejects.
  useEffect(() => {
    if (section !== "feedback") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      const list = filteredFeedback;
      if (!list.length) return;
      if (event.key === "ArrowDown" || event.key === "j") {
        event.preventDefault();
        setReviewFocus((focus) => (focus + 1) % list.length);
      } else if (event.key === "ArrowUp" || event.key === "k") {
        event.preventDefault();
        setReviewFocus((focus) => (focus - 1 + list.length) % list.length);
      } else if (event.key === "a" || event.key === "A" || event.key === "Enter") {
        event.preventDefault();
        if (list[reviewFocus]) void approveItem(list[reviewFocus]);
      } else if (event.key === "r" || event.key === "R") {
        if (list[reviewFocus]) void rejectItem(list[reviewFocus]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [section, filteredFeedback, reviewFocus, approveItem, rejectItem]);

  useEffect(() => {
    setReviewFocus(0);
  }, [section, reviewQuery]);

  useEffect(() => {
    document.querySelector(".admin-review-row.review-focused")?.scrollIntoView({ block: "nearest" });
  }, [reviewFocus]);
  const trendSeries = buildTrend(analytics?.daily_trend || []);

  // Derived dataset/model views — fetched read models first, overview
  // fallbacks second, so a section never renders blank on a partial outage.
  const dataset: DatasetStats | null = datasetData ?? adminOverview?.dataset ?? null;
  const datasetClasses = CLASS_ORDER.filter((name) => dataset?.classes?.[name]).map((name) => [name, dataset!.classes[name]] as [string, { total: number; user_verified: number }]);
  const datasetMax = Math.max(1, ...datasetClasses.map(([, item]) => Number(item.total) || 0));
  const manifest = modelManifest ?? adminOverview?.model_metrics ?? null;
  const headlineAccuracy = modelManifest?.test_accuracy ?? adminOverview?.model_metrics?.test_accuracy ?? null;
  const headlineF1 = modelManifest?.macro_f1 ?? adminOverview?.model_metrics?.macro_f1 ?? null;
  const splitCounts = retrainStatus?.configuration?.split_counts ?? adminOverview?.training_configuration?.split_counts ?? null;
  const persistenceLabel = (() => {
    const backend = String(adminOverview?.persistence?.backend || "");
    if (backend === "firebase") return "Firebase cloud";
    if (backend === "supabase") return "Supabase cloud";
    if (!backend) return "checking";
    return "Local";
  })();

  const NAV: { key: Section; label: string; icon: ComponentType<IconProps>; badge?: number | null }[] = [
    { key: "overview", label: "Overview", icon: IconGrid },
    { key: "dataset", label: "Dataset", icon: IconDatabase },
    { key: "model", label: "Model", icon: IconChip },
    { key: "scans", label: "Scans", icon: IconScanFrame, badge: adminScans.length || null },
    { key: "feedback", label: "Feedback review", icon: IconCheckCircle, badge: adminFeedback.length || null },
    { key: "users", label: "Users", icon: IconProfile, badge: usersLoaded ? adminUsers.length : null },
    { key: "audit", label: "Audit log", icon: IconList },
  ];


  return (
    <main className="admin-page">
      <div className="console-shell">
        {/* Console sidebar — identity, section navigation, live status */}
        <aside className="console-sidebar">
          <div className="console-brand">
            <span className="console-brand-mark" aria-hidden>🧺</span>
            <div>
              <b>LaundryAI Console</b>
              <small>Administration</small>
            </div>
          </div>

          <nav className="console-nav" role="tablist" aria-label="Admin sections">
            {NAV.map(({ key, label, icon: Icon, badge }) => (
              <button
                type="button"
                key={key}
                role="tab"
                aria-selected={section === key}
                className={section === key ? "active" : ""}
                onClick={() => setSection(key)}
              >
                <Icon size={18} />
                <span>{label}</span>
                {badge != null && <em className="console-nav-badge">{badge}</em>}
              </button>
            ))}
          </nav>

          <div className="console-side-status" role="status">
            <span className={`console-status-line ${adminOverview?.model_ready ? "ok" : "warn"}`}>
              <i aria-hidden /> Inference {adminOverview == null ? "checking" : adminOverview.model_ready ? "online" : "down"}
            </span>
            <span className={`console-status-line ${adminHealth?.status === "ok" ? "ok" : adminHealth ? "warn" : "pending"}`}>
              <i aria-hidden /> API {adminHealth?.status || "checking"}
            </span>
            <span className="console-status-line pending">
              <i aria-hidden /> Data · {persistenceLabel}
            </span>
          </div>

          <div className="console-side-foot">
            <div className="console-identity">
              <span>Signed in as</span>
              <strong>{user.name || "Administrator"}</strong>
              <small>{user.email || user.uid}</small>
            </div>
            <button type="button" className="console-refresh" disabled={adminLoading} onClick={() => setAdminRefreshKey((value) => value + 1)}>
              <IconRefresh size={14} /> {adminLoading ? "Refreshing…" : "Refresh"}
            </button>
            <small className="console-synced">{adminLastUpdated ? `Synced ${adminLastUpdated}` : "Waiting for first sync"}</small>
          </div>
        </aside>

        <div className="console-main">
          <header className="console-viewhead">
            <span className="admin-eyebrow">ADMIN CONSOLE</span>
            <h1 className="font-serif">{SECTION_META[section].title}</h1>
            <p>{SECTION_META[section].blurb}</p>
          </header>

          {adminMessage && <div className="admin-alert">{adminMessage}</div>}
          {Object.keys(adminErrors).length > 0 && (
            <div className="admin-inline-error" role="alert">
              <b>Some admin data is unavailable</b>
              <span>{Object.entries(adminErrors).map(([area, message]) => `${area}: ${message}`).join(" ")}</span>
              <button type="button" onClick={() => setAdminRefreshKey((value) => value + 1)}>Retry</button>
            </div>
          )}

          <MotionPanel panelKey={`${section}-${adminRefreshKey}`} className={`console-view ${adminLoading ? "is-refreshing" : ""}`}>
            {section === "overview" && (
              <>
                <section className="console-kpis" aria-label="Key numbers">
                  <button type="button" className={`console-kpi attention ${adminFeedback.length ? "has-items" : ""}`} onClick={() => setSection("feedback")}>
                    <span>Pending reviews</span>
                    <b>{adminPanelLoading.feedback ? "…" : <CountUp value={adminFeedback.length} />}</b>
                    <small>{adminFeedback.length ? "Awaiting your approval →" : "Queue is clear"}</small>
                  </button>
                  <div className="console-kpi">
                    <span>Total scans</span>
                    <b>{adminPanelLoading.overview ? "…" : <CountUp value={adminOverview?.total_scans ?? null} />}</b>
                    <small>Recorded analyses</small>
                  </div>
                  <div className="console-kpi">
                    <span>Registered users</span>
                    <b>{adminPanelLoading.users && !usersLoaded ? "…" : <CountUp value={usersLoaded ? adminUsers.length : null} />}</b>
                    <small>Firebase directory</small>
                  </div>
                  <button type="button" className="console-kpi" onClick={() => setSection("dataset")}>
                    <span>Dataset samples</span>
                    <b>{adminPanelLoading.dataset && !dataset ? "…" : <CountUp value={dataset?.total_samples ?? null} />}</b>
                    <small>{dataset ? `${dataset.user_contributed} user-verified →` : "Training corpus"}</small>
                  </button>
                </section>

                <div className="console-grid">
                  <section className="console-card console-wide">
                    <div className="admin-section-heading">
                      <div><span className="admin-eyebrow">ACTIVITY</span><h2>Scans — last 30 days</h2></div>
                      <span className="admin-count">{analytics ? `${analytics.scan_count} scans` : "No scan data yet"}</span>
                    </div>
                    {adminPanelLoading.overview && !analytics ? <Skeleton lines={4} /> : trendSeries.some((day) => day.count > 0) ? (
                      <>
                        <TrendChart series={trendSeries} />
                        <div className="trend-chips">
                          <span><b>{analytics?.scan_count ?? 0}</b> scans in window</span>
                          <span><b>{Math.max(...trendSeries.map((day) => day.count))}</b> peak day</span>
                          <span><b>{trendSeries.filter((day) => day.count > 0).length}</b> active days</span>
                        </div>
                      </>
                    ) : <p className="admin-empty">Scan activity will appear after the API records scans.</p>}
                  </section>

                  <section className="console-card">
                    <div className="admin-section-heading">
                      <div><span className="admin-eyebrow">TRUST</span><h2>Confidence health</h2></div>
                      <span className="admin-count">{analytics?.confidence?.average != null ? `avg ${analytics.confidence.average}%` : "No data"}</span>
                    </div>
                    {analytics && analytics.scan_count > 0 ? (
                      <div className="console-bars">
                        {CONFIDENCE_BUCKETS.map(([label, key]) => (
                          <BarRow key={key} label={label} share={(analytics.confidence.buckets[key] || 0) / Math.max(1, ...CONFIDENCE_BUCKETS.map(([, k]) => analytics.confidence.buckets[k] || 0))} value={String(analytics.confidence.buckets[key] || 0)} />
                        ))}
                      </div>
                    ) : <p className="admin-empty">Confidence data appears after the first scan.</p>}
                  </section>

                  <section className="console-card">
                    <div className="admin-section-heading">
                      <div><span className="admin-eyebrow">MIX</span><h2>Fabrics — last 30 days</h2></div>
                      <span className="admin-count">{analytics?.scan_count ?? 0} scans</span>
                    </div>
                    {analytics && Object.values(analytics.fabric_distribution).some((value) => value > 0) ? (
                      <div className="console-bars">
                        {Object.entries(analytics.fabric_distribution).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]).map(([label, value]) => (
                          <BarRow key={label} label={label.replace("_", " ")} share={value / Math.max(1, ...Object.values(analytics.fabric_distribution))} value={String(value)} />
                        ))}
                      </div>
                    ) : <p className="admin-empty">Fabric mix appears after the first scan.</p>}
                  </section>

                  <section className="console-card">
                    <div className="admin-section-heading">
                      <div><span className="admin-eyebrow">MODEL</span><h2>Deployed model</h2></div>
                      <span className="admin-count">{adminOverview?.model_metrics?.version || "deployed"}</span>
                    </div>
                    <div className="console-mini-metrics">
                      <div><span>Test accuracy</span><b>{headlineAccuracy != null ? <CountUp value={headlineAccuracy * 100} decimals={2} suffix="%" /> : "—"}</b></div>
                      <div><span>Macro F1</span><b>{headlineF1 != null ? <CountUp value={headlineF1 * 100} decimals={2} suffix="%" /> : "—"}</b></div>
                      <div><span>Feedback records</span><b>{adminOverview ? <CountUp value={adminOverview.feedback_records ?? 0} /> : "—"}</b></div>
                    </div>
                    <button type="button" className="console-text-link" onClick={() => setSection("model")}>Open model & release →</button>
                  </section>

                  <section className="console-card">
                    <div className="admin-section-heading">
                      <div><span className="admin-eyebrow">DATASET</span><h2>Class balance</h2></div>
                      <span className="admin-count">{dataset ? `${dataset.total_samples.toLocaleString()} samples` : "No data"}</span>
                    </div>
                    {datasetClasses.length ? (
                      <div className="console-bars">
                        {datasetClasses.slice(0, 4).map(([label, item]) => (
                          <BarRow key={label} label={label.replace("_", " ")} share={(Number(item.total) || 0) / datasetMax} value={Number(item.total).toLocaleString()} />
                        ))}
                      </div>
                    ) : <p className="admin-empty">Dataset statistics are unavailable right now.</p>}
                    <button type="button" className="console-text-link" onClick={() => setSection("dataset")}>Open dataset & balance →</button>
                  </section>
                </div>

                <section className="console-card">
                  <div className="admin-section-heading">
                    <div><span className="admin-eyebrow">ACCOUNTABILITY</span><h2>Recent admin activity</h2></div>
                    <button type="button" className="console-text-link" onClick={() => setSection("audit")}>Open audit log →</button>
                  </div>
                  {adminPanelLoading.audit && !adminAudit.length ? <Skeleton lines={3} /> : adminAudit.length ? <div className="admin-audit-list">
                    {adminAudit.slice(0, 5).map((entry, index) => (
                      <div className="admin-audit-row" key={entry.id || `${entry.action}-${index}`}>
                        <span className="admin-audit-icon"><IconShield size={13} /></span>
                        <div><strong>{entry.action || "Administrative event"}</strong><small>{entry.detail || entry.actor || "Recorded by the platform"}{entry.created_at ? ` · ${new Date(entry.created_at).toLocaleString()}` : ""}</small></div>
                      </div>
                    ))}
                  </div> : <p className="admin-empty">No admin actions recorded yet.</p>}
                </section>
              </>
            )}

            {section === "dataset" && (
              <>
                <section className="console-kpis" aria-label="Dataset totals">
                  <div className="console-kpi">
                    <span>Total samples</span>
                    <b>{adminPanelLoading.dataset && !dataset ? "…" : <CountUp value={dataset?.total_samples ?? null} />}</b>
                    <small>Training corpus</small>
                  </div>
                  <div className="console-kpi">
                    <span>User-verified</span>
                    <b>{dataset ? <CountUp value={dataset.user_contributed} /> : "—"}</b>
                    <small>Approved through review</small>
                  </div>
                  <div className="console-kpi">
                    <span>Classes</span>
                    <b>{dataset ? <CountUp value={datasetClasses.length} /> : "—"}</b>
                    <small>Fabric categories</small>
                  </div>
                  <div className="console-kpi">
                    <span>Largest class</span>
                    <b className="console-kpi-word">{datasetClasses.length ? datasetClasses.reduce((a, b) => (b[1].total > a[1].total ? b : a))[0].replace("_", " ") : "—"}</b>
                    <small>{datasetClasses.length ? `${Math.max(...datasetClasses.map(([, item]) => item.total)).toLocaleString()} samples` : "No data"}</small>
                  </div>
                </section>

                {splitCounts && (
                  <section className="console-card console-split-card">
                    <div className="admin-section-heading">
                      <div><span className="admin-eyebrow">SPLITS</span><h2>On-disk dataset splits</h2></div>
                      <span className="admin-count">{(splitCounts.train + splitCounts.val + splitCounts.test).toLocaleString()} images</span>
                    </div>
                    <div className="console-split">
                      {(["train", "val", "test"] as const).map((split) => (
                        <div key={split}>
                          <span>{split}</span>
                          <b><CountUp value={splitCounts[split]} /></b>
                          <div className="console-bar"><i style={{ width: `${(splitCounts[split] / Math.max(1, splitCounts.train + splitCounts.val + splitCounts.test)) * 100}%` }} /></div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section className="console-card">
                  <div className="admin-section-heading">
                    <div><span className="admin-eyebrow">BALANCE</span><h2>Per-class training counts</h2></div>
                    <span className="admin-count">{dataset?.total_samples?.toLocaleString() ?? 0} samples</span>
                  </div>
                  {adminPanelLoading.dataset && !dataset ? <Skeleton lines={6} /> : datasetClasses.length ? (
                    <div className="console-bars">
                      {datasetClasses.map(([label, item]) => {
                        const total = Number(item.total) || 0;
                        const weak = datasetMax > 0 && total < datasetMax * 0.35;
                        return (
                          <BarRow
                            key={label}
                            label={label.replace("_", " ")}
                            share={total / datasetMax}
                            value={total.toLocaleString()}
                            warn={weak}
                            note={`${dataset?.total_samples ? Math.round((total / dataset.total_samples) * 100) : 0}% of corpus · ${item.user_verified} verified`}
                          />
                        );
                      })}
                    </div>
                  ) : <p className="admin-empty">Dataset statistics are unavailable right now.</p>}
                  {governance?.warnings?.length > 0 && (
                    <div className="console-warnings" role="note">
                      <b>Balance warnings</b>
                      {governance.warnings.map((warning: string) => <span key={warning}>{warning}</span>)}
                    </div>
                  )}
                </section>
              </>
            )}


            {section === "model" && (
              <>
                <section className="console-card console-model-head">
                  <div className="console-model-id">
                    <span className="admin-eyebrow">DEPLOYED MODEL</span>
                    <h2>{modelInfo?.architecture || manifest?.architecture || "MobileNetV2 transfer learning"}</h2>
                    <p>{modelInfo?.limitation || "Ambiguous or low-confidence inputs are rejected as unknown rather than guessed."}</p>
                    <div className="console-chips">
                      {(modelInfo?.classes || manifest?.classes || CLASS_ORDER).map((name: string) => <span key={name}>{name.replace("_", " ")}</span>)}
                    </div>
                  </div>
                  <div className="console-model-facts">
                    <span className={`console-status-line ${adminOverview?.model_ready ? "ok" : "warn"}`}><i aria-hidden /> {adminOverview == null ? "Checking" : adminOverview.model_ready ? "Ready" : "Not ready"}</span>
                    <div><span>Version</span><b>{adminOverview?.model_metrics?.version || "deployed"}</b></div>
                    <div><span>Input size</span><b>{manifest?.input_size ? `${manifest.input_size} × ${manifest.input_size}` : "224 × 224"}</b></div>
                    <div><span>Acceptance gates</span><b>{modelInfo?.acceptance_thresholds ? `${modelInfo.acceptance_thresholds.min_confidence}% conf · ${modelInfo.acceptance_thresholds.min_margin}% margin` : manifest?.min_confidence != null ? `${Math.round(manifest.min_confidence * 100)}% conf · ${Math.round((manifest.min_margin || 0) * 100)}% margin` : "—"}</b></div>
                  </div>
                </section>

                <section className="console-kpis" aria-label="Model metrics">
                  <div className="console-kpi">
                    <span>Test accuracy</span>
                    <b>{headlineAccuracy != null ? <CountUp value={headlineAccuracy * 100} decimals={2} suffix="%" /> : "—"}</b>
                    <small>Held-out test split</small>
                  </div>
                  <div className="console-kpi">
                    <span>Macro F1</span>
                    <b>{headlineF1 != null ? <CountUp value={headlineF1 * 100} decimals={2} suffix="%" /> : "—"}</b>
                    <small>Mean of per-class F1</small>
                  </div>
                  <div className="console-kpi">
                    <span>Validation accuracy</span>
                    <b>{manifest?.val_accuracy != null ? <CountUp value={manifest.val_accuracy * 100} decimals={2} suffix="%" /> : "—"}</b>
                    <small>{manifest?.val_images ? `${manifest.val_images} validation images` : "Validation split"}</small>
                  </div>
                  <div className="console-kpi">
                    <span>Test images</span>
                    <b>{manifest?.test_images != null ? <CountUp value={manifest.test_images} /> : adminOverview?.model_metrics?.test_images ?? "—"}</b>
                    <small>Held out from training</small>
                  </div>
                </section>

                {manifest?.per_class_metrics && (
                  <section className="console-card">
                    <div className="admin-section-heading">
                      <div><span className="admin-eyebrow">PER-CLASS</span><h2>Precision, recall & F1</h2></div>
                      <span className="admin-count">Held-out test</span>
                    </div>
                    <div className="console-table-wrap">
                      <table className="console-table">
                        <thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>F1</th><th>Support</th></tr></thead>
                        <tbody>
                          {CLASS_ORDER.filter((name) => manifest.per_class_metrics[name]).map((name) => {
                            const row = manifest.per_class_metrics[name];
                            const cell = (v: number | null) => v == null ? "—" : (
                              <span className="console-metric-cell">
                                <span className="console-bar"><i style={{ width: `${Math.round(v * 100)}%` }} /></span>
                                {(v * 100).toFixed(1)}%
                              </span>
                            );
                            return (
                              <tr key={name}>
                                <td className="console-table-class">{name.replace("_", " ")}</td>
                                <td>{cell(row.precision)}</td>
                                <td>{cell(row.recall)}</td>
                                <td>{row.f1_score == null ? "—" : `${(row.f1_score * 100).toFixed(1)}%`}</td>
                                <td>{row.support || "—"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {manifest.per_class_metrics.non_fabric && manifest.per_class_metrics.non_fabric.support === 0 && (
                      <p className="console-table-note">Non-fabric was not scored on the held-out split (0 support) — it is gated by the acceptance thresholds instead.</p>
                    )}
                  </section>
                )}

                {manifest?.confusion_matrix?.matrix && (
                  <section className="console-card">
                    <div className="admin-section-heading">
                      <div><span className="admin-eyebrow">ERRORS</span><h2>Confusion matrix</h2></div>
                      <span className="admin-count">Rows: actual · Columns: predicted</span>
                    </div>
                    <div className="console-table-wrap">
                      <div className="console-matrix" style={{ gridTemplateColumns: `96px repeat(${manifest.confusion_matrix.classes.length}, minmax(44px, 1fr))` }}>
                        <span className="console-matrix-corner" />
                        {manifest.confusion_matrix.classes.map((name: string) => <span className="console-matrix-head" key={`h-${name}`}>{name.replace("_", " ")}</span>)}
                        {manifest.confusion_matrix.matrix.map((row: number[], r: number) => (
                          <Fragment key={`row-${r}`}>
                            <span className="console-matrix-head row">{manifest.confusion_matrix.classes[r].replace("_", " ")}</span>
                            {row.map((value: number, c: number) => {
                              const maxCell = Math.max(1, ...manifest.confusion_matrix.matrix.flat());
                              return <span key={`${r}-${c}`} className={`console-matrix-cell ${r === c ? "diag" : ""}`} style={{ background: `rgba(85, 210, 163, ${(0.04 + (value / maxCell) * 0.5).toFixed(3)})` }}>{value}</span>;
                            })}
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  </section>
                )}

                <div className="console-grid">
                  <section className="console-card">
                    <div className="admin-section-heading">
                      <div><span className="admin-eyebrow">GOVERNANCE</span><h2>Promotion policy</h2></div>
                      <span className="admin-count">{governance?.promotion_policy?.automatic_promotion ? "Automatic" : "Manual review"}</span>
                    </div>
                    {governance?.promotion_policy ? (
                      <>
                        <p className="console-policy-rule">{governance.promotion_policy.rule}</p>
                        <div className="console-chips">
                          {(governance.promotion_policy.required_checks || []).map((check: string) => <span key={check}>{check}</span>)}
                        </div>
                        <p className="console-policy-note">Automatic promotion is {governance.promotion_policy.automatic_promotion ? "enabled" : "off"} — no candidate reaches production without an administrator's explicit, reviewed deployment.</p>
                      </>
                    ) : <p className="admin-empty">Governance policy is unavailable right now.</p>}
                  </section>

                  <section className="console-card">
                    <div className="admin-section-heading">
                      <div><span className="admin-eyebrow">TRAINING</span><h2>Retraining pipeline</h2></div>
                      <span className="admin-count">{String(retrainStatus?.status || adminOverview?.retraining?.status || "idle")}</span>
                    </div>
                    <p className="console-policy-rule">{retrainStatus?.message || adminOverview?.retraining?.message || "Approved feedback becomes a versioned dataset; candidates are trained offline and released only through the gate."}</p>
                    <div className="console-training-meta">
                      <span>Mode <b>{String(adminOverview?.training_mode || retrainStatus?.mode || "review_only").replace(/_/g, " ")}</b></span>
                      {splitCounts && <span>Dataset splits <b>{splitCounts.train.toLocaleString()} / {splitCounts.val} / {splitCounts.test}</b></span>}
                    </div>
                    {adminOverview?.training_available ? <button className="btn btn-primary" type="button" onClick={async () => {
                      if (!window.confirm("Dispatch GPU training from approved feedback?")) return;
                      setAdminMessage("Dispatching the reviewed dataset to the training worker…");
                      try {
                        const response = await apiFetch(`${API}/retrain`, { method: "POST" });
                        const data = await response.json();
                        if (!response.ok) throw new Error(data.detail || "Could not start retraining.");
                        setAdminMessage(data.message || "Retraining started.");
                        setAdminOverview((current: any) => ({ ...current, retraining: { status: "running", message: data.message } }));
                      } catch (error) {
                        setAdminMessage(error instanceof Error ? error.message : "Could not start retraining.");
                      }
                    }}>{adminOverview?.training_mode === "external_gpu" ? "Dispatch GPU training" : "Start reviewed training"}</button> : <div className="training-disabled"><b>Training is in review-only mode</b><span>Predictions and approved feedback continue to work. Train approved batches on the local RTX GPU, then use the release gate before deploying a candidate.</span></div>}
                    {adminOverview?.retraining?.status === "running" && <MotionPanel panelKey="training-running" className="admin-live-status"><span className="live-dot" /> Model training is running. Status refreshes automatically.</MotionPanel>}
                    {adminOverview?.retraining?.status === "completed" && <MotionPanel panelKey="training-completed" className="admin-live-status"><span className="live-dot" /> Candidate ready. Review its metrics before promotion.</MotionPanel>}
                  </section>
                </div>
              </>
            )}

            {section === "scans" && (
              <section className="console-card">
                <div className="admin-section-heading">
                  <div><span className="admin-eyebrow">PLATFORM SCANS</span><h2>All user garment scans</h2></div>
                  <span className="admin-count">{adminScans.length} records</span>
                </div>
                <div className="admin-toolbar">
                  <label className="admin-search"><span className="sr-only">Search scan records</span><input value={scanQuery} onChange={(event) => setScanQuery(event.target.value)} placeholder="Search fabric, note, or user ID" type="search" /></label>
                  <label className="admin-filter"><span className="sr-only">Filter scan feedback</span><select value={scanFilter} onChange={(event) => setScanFilter(event.target.value as typeof scanFilter)}><option value="all">All scan statuses</option><option value="confirmed">User confirmed</option><option value="corrected">User corrected</option></select></label>
                </div>
                <div className="console-scan-list">
                  {adminPanelLoading.scans && !adminScans.length ? <Skeleton lines={5} /> : filteredScans.length ? filteredScans.map((scan: any) => (
                    <article className="admin-review-row console-scan-row" key={String(scan.id)}>
                      <div className="admin-user-avatar console-scan-avatar"><IconBasket size={20} /></div>
                      <div className="admin-review-copy">
                        <div className="console-scan-top">
                          <strong>{scan.fabric || "Unknown"}</strong>
                          <span className="console-badge ok">{Math.round(scan.confidence || 0)}% confidence</span>
                          {scan.user_feedback ? (
                            scan.user_feedback.was_correct ? (
                              <span className="console-badge ok">✓ User confirmed</span>
                            ) : (
                              <span className="console-badge warn">Corrected to {scan.user_feedback.confirmed_fabric}</span>
                            )
                          ) : (
                            <span className="console-badge muted">Scan record</span>
                          )}
                        </div>
                        {scan.note && <p className="console-scan-note">“{scan.note}”</p>}
                        <small>{scan.created_at ? new Date(scan.created_at).toLocaleString() : "Date recorded"} • User UID: {String(scan.owner_uid || scan.id || "").slice(0, 10)}</small>
                      </div>
                    </article>
                  )) : <p className="admin-empty">{adminScans.length ? "No scans match this search or filter." : "No scan records recorded yet."}</p>}
                </div>
              </section>
            )}

            {section === "feedback" && (
              <section className="console-card">
                <div className="admin-section-heading">
                  <div><span className="admin-eyebrow">HUMAN REVIEW</span><h2>Pending training feedback</h2></div>
                  <span className="admin-count">{adminFeedback.length} waiting</span>
                </div>
                <div className="admin-toolbar">
                  <label className="admin-search"><span className="sr-only">Search review records</span><input value={reviewQuery} onChange={(event) => setReviewQuery(event.target.value)} placeholder="Search fabric or filename" type="search" /></label>
                </div>
                {!adminPanelLoading.feedback && filteredFeedback.length > 0 && (
                  <div className="admin-review-hint" aria-hidden="true">
                    <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                    <span><kbd>A</kbd> / <kbd>Enter</kbd> approve</span>
                    <span><kbd>R</kbd> reject</span>
                  </div>
                )}
                {adminPanelLoading.feedback && !adminFeedback.length ? <Skeleton lines={4} /> : filteredFeedback.length ? filteredFeedback.map((item, index) => (
                  <article className={`admin-review-row ${reviewFocus === index ? "review-focused" : ""}`} key={`${item.fabric}/${item.file}`}>
                    <AdminFeedbackPreview item={item} />
                    <div className="admin-review-copy">
                      <strong>{item.fabric}</strong>
                      {item.original_fabric && <span>Model predicted: {item.original_fabric}</span>}
                      <small>{item.filename || item.file}</small>
                    </div>
                    <div className="admin-row-actions">
                      <button type="button" className="btn btn-primary" onClick={() => void approveItem(item)}>Approve label</button>
                      <button type="button" className="btn btn-outline" onClick={() => void rejectItem(item)}>Reject</button>
                    </div>
                  </article>
                )) : <p className="admin-empty">{adminFeedback.length ? "No feedback matches this search." : "No feedback is waiting for review. New user corrections will appear here for approval."}</p>}
              </section>
            )}


            {section === "users" && (
              <section className="console-card">
                <div className="admin-section-heading">
                  <div><span className="admin-eyebrow">ACCESS CONTROL</span><h2>Users and administrator roles</h2></div>
                  <span className="admin-count">{adminUsers.length} users</span>
                </div>
                <p className="admin-section-copy">Grant only trusted accounts administrator access. Role changes take effect after the user signs out and signs in again.</p>
                <label className="admin-search"><span className="sr-only">Search users</span><input value={userQuery} onChange={(event) => setUserQuery(event.target.value)} placeholder="Search name, email, or user ID" type="search" /></label>
                {adminPanelLoading.users ? <p className="admin-panel-loading" role="status">Loading user directory…</p> : filteredUsers.length ? filteredUsers.map((account) => (
                  <article className="admin-user-row" key={account.uid}>
                    <div className="admin-user-avatar">{account.picture ? <img src={account.picture} alt="" referrerPolicy="no-referrer" /> : (account.email || "?").charAt(0).toUpperCase()}</div>
                    <div className="admin-review-copy">
                      <strong>{account.name || account.email || "Unnamed user"}</strong>
                      <small>{account.email || account.uid}</small>
                      <div className="admin-badges">
                        <span className={account.email_verified ? "ok" : "warn"}>{account.email_verified ? "Verified" : "Unverified"}</span>
                        {account.is_admin && <span className="admin-badge">Admin</span>}
                        {account.disabled && <span className="danger">Disabled</span>}
                      </div>
                    </div>
                    <div className="admin-row-actions">
                      <button type="button" className="btn btn-outline" disabled={account.uid === user.uid && account.is_admin} onClick={async () => {
                        const next = !account.is_admin;
                        const response = await apiFetch(`${API}/admin/users/${encodeURIComponent(account.uid)}/role`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_admin: next }) });
                        if (response.ok) setAdminUsers((items) => items.map((item) => item.uid === account.uid ? { ...item, is_admin: next } : item));
                        else setAdminMessage((await response.json()).detail || "Could not update this role.");
                      }}>{account.is_admin ? "Remove admin" : "Make admin"}</button>
                      <button type="button" className={`btn ${account.disabled ? "btn-primary" : "btn-outline"}`} disabled={account.uid === user.uid} onClick={async () => {
                        const next = !account.disabled;
                        if (next && !window.confirm(`Disable ${account.email || "this user"}?`)) return;
                        const response = await apiFetch(`${API}/admin/users/${encodeURIComponent(account.uid)}/status`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ disabled: next }) });
                        if (response.ok) setAdminUsers((items) => items.map((item) => item.uid === account.uid ? { ...item, disabled: next } : item));
                        else setAdminMessage((await response.json()).detail || "Could not update this account.");
                      }}>{account.disabled ? "Enable user" : "Disable user"}</button>
                    </div>
                  </article>
                )) : <p className="admin-empty">{adminUsers.length ? "No users match this search." : adminErrors.users || "No Firebase users could be loaded."}</p>}
              </section>
            )}

            {section === "audit" && (
              <section className="console-card">
                <div className="admin-section-heading">
                  <div><span className="admin-eyebrow">ACCOUNTABILITY</span><h2>Audit log</h2></div>
                  <span className="admin-count">{adminAudit.length ? `${adminAudit.length} events` : "No events"}</span>
                </div>
                {adminPanelLoading.audit && !adminAudit.length ? <Skeleton lines={5} /> : adminAudit.length ? <div className="admin-audit-list">
                  {adminAudit.map((entry, index) => (
                    <div className="admin-audit-row" key={entry.id || `${entry.action}-${index}`}>
                      <span className="admin-audit-icon"><IconShield size={13} /></span>
                      <div><strong>{entry.action || "Administrative event"}</strong><small>{entry.detail || entry.actor || "Recorded by the platform"}{entry.created_at ? ` · ${new Date(entry.created_at).toLocaleString()}` : ""}</small></div>
                    </div>
                  ))}
                </div> : <p className="admin-empty">No admin actions recorded yet.</p>}
              </section>
            )}
          </MotionPanel>
        </div>
      </div>
    </main>
  );
}
