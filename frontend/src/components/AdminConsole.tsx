import { useEffect, useState } from "react";
import { MotionPanel } from "../motion-primitives";
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


export default function AdminConsole({ user, datasetStats }: { user: SignedInUser; datasetStats?: DatasetStats }) {
  const [adminOverview, setAdminOverview] = useState<any>(null);
  const [adminFeedback, setAdminFeedback] = useState<AdminFeedbackItem[]>([]);
  const [adminScans, setAdminScans] = useState<any[]>([]);
  const [reviewSubtab, setReviewSubtab] = useState<"pending" | "scans">("pending");
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminAudit, setAdminAudit] = useState<AdminAuditEntry[]>([]);
  const [adminHealth, setAdminHealth] = useState<AdminHealth | null>(null);
  const [adminMessage, setAdminMessage] = useState("");
  const [adminErrors, setAdminErrors] = useState<Record<string, string>>({});
  const [adminPanelLoading, setAdminPanelLoading] = useState<Record<string, boolean>>({});
  const [reviewQuery, setReviewQuery] = useState("");
  const [reviewFilter, setReviewFilter] = useState<"all" | "corrected" | "confirmed">("all");
  const [userQuery, setUserQuery] = useState("");
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminTab, setAdminTab] = useState<"overview" | "review" | "users" | "model">("overview");
  const [adminRefreshKey, setAdminRefreshKey] = useState(0);
  const [adminLastUpdated, setAdminLastUpdated] = useState<string>("");

  // Users are loaded lazily: the Firebase user directory is the heaviest admin
  // call, and most visits start in Overview/Review — not on the Users tab.
  const [usersLoaded, setUsersLoaded] = useState(false);
  useEffect(() => {
    if (adminTab !== "users" || usersLoaded) return;
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
  }, [adminTab, usersLoaded]);

  useEffect(() => {
    if (!user.is_admin) return;
    let timer: number | undefined;
    const refreshAdminOverview = async () => {
      setAdminLoading(true);
      setAdminMessage("");
      setAdminPanelLoading({ overview: true, feedback: true, scans: true, audit: true, health: true });
      const [healthResponse, overviewResponse, feedbackResponse, scansResponse, auditResponse] = await Promise.all([
        fetch(`${API}/health`, { cache: "no-store" }).catch(() => null),
        apiFetch(`${API}/admin/overview`).catch(() => null),
        apiFetch(`${API}/admin/feedback`).catch(() => null),
        apiFetch(`${API}/admin/scans`).catch(() => null),
        apiFetch(`${API}/admin/audit-log`).catch(() => null),
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

  const normalizedReviewQuery = reviewQuery.trim().toLowerCase();
  const filteredFeedback = adminFeedback.filter((item) =>
    !normalizedReviewQuery || [item.fabric, item.original_fabric, item.filename, item.file].some((value) => String(value || "").toLowerCase().includes(normalizedReviewQuery))
  );
  const filteredScans = adminScans.filter((scan) => {
    const matchesQuery = !normalizedReviewQuery || [scan.fabric, scan.note, scan.owner_uid, scan.id].some((value) => String(value || "").toLowerCase().includes(normalizedReviewQuery));
    const corrected = Boolean(scan.user_feedback && !scan.user_feedback.was_correct);
    const confirmed = Boolean(scan.user_feedback?.was_correct);
    return matchesQuery && (reviewFilter === "all" || (reviewFilter === "corrected" && corrected) || (reviewFilter === "confirmed" && confirmed));
  });
  const filteredUsers = adminUsers.filter((account) =>
    !userQuery.trim() || [account.name, account.email, account.uid].some((value) => String(value || "").toLowerCase().includes(userQuery.trim().toLowerCase()))
  );
  const trendDays = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    const key = date.toISOString().slice(0, 10);
    return { key, label: date.toLocaleDateString([], { weekday: "short" }), count: adminScans.filter((scan) => String(scan.created_at || "").slice(0, 10) === key).length };
  });
  const trendMax = Math.max(1, ...trendDays.map((day) => day.count));

  return (
        <main className="admin-page">
          {/* Status bar: one glance answers "is the platform healthy?" */}
          <div className="admin-topbar">
            <div className="admin-topbar-id">
              <span className="admin-topbar-mark" aria-hidden>🧺</span>
              <div>
                <b>Administration</b>
                <small>{user.email || user.name} · Verified administrator</small>
              </div>
            </div>
            <div className="admin-status-pills" role="status">
              <span className={`admin-status-pill ${adminOverview?.model_ready ? "ok" : "warn"}`}>
                <i aria-hidden /> Inference: {adminOverview == null ? "checking" : adminOverview.model_ready ? "online" : "down"}
              </span>
              <span className={`admin-status-pill ${adminHealth?.status === "ok" ? "ok" : adminHealth ? "warn" : "pending"}`}>
                <i aria-hidden /> API: {adminHealth?.status || "checking"}
              </span>
              <span className="admin-status-pill pending">
                <i aria-hidden /> Data: {adminOverview?.persistence?.backend === "firebase" ? "Firebase cloud" : "Local"}
              </span>
            </div>
            <div className="admin-topbar-sync">
              <small>{adminLastUpdated ? `Synced ${adminLastUpdated}` : "Waiting for first sync"}</small>
              <button type="button" disabled={adminLoading} onClick={() => setAdminRefreshKey((value) => value + 1)}>
                {adminLoading ? "Refreshing…" : "↻ Refresh"}
              </button>
            </div>
          </div>

          {/* Four tabs — the entire console */}
          <nav className="admin-tabs-minimal" role="tablist" aria-label="Admin sections">
            {([
              ["overview", "Overview"],
              ["review", adminFeedback.length ? `Review · ${adminFeedback.length}` : "Review"],
              ["users", adminUsers.length ? `Users · ${adminUsers.length}` : "Users"],
              ["model", "Model"],
            ] as const).map(([key, label]) => (
              <button
                type="button"
                key={key}
                role="tab"
                aria-selected={adminTab === key}
                tabIndex={adminTab === key ? 0 : -1}
                className={adminTab === key ? "active" : ""}
                onClick={() => setAdminTab(key)}
              >
                {label}
              </button>
            ))}
          </nav>

          <MotionPanel panelKey={`${adminTab}-${adminRefreshKey}`} className={`admin-command-main ${adminLoading ? "is-refreshing" : ""}`}>
            {adminMessage && <div className="admin-alert">{adminMessage}</div>}
            {Object.keys(adminErrors).length > 0 && (
              <div className="admin-inline-error" role="alert">
                <b>Some admin data is unavailable</b>
                <span>{Object.entries(adminErrors).map(([area, message]) => `${area}: ${message}`).join(" ")}</span>
                <button type="button" className="btn btn-outline" onClick={() => setAdminRefreshKey((value) => value + 1)}>Retry</button>
              </div>
            )}

            {adminTab === "overview" && (
              <>
                {/* 4 KPIs only — the first one is the action the admin most often needs */}
                <section className="admin-kpi-grid" aria-label="Key numbers">
                  <button type="button" className={`admin-kpi ${adminFeedback.length ? "attention" : ""}`} onClick={() => setAdminTab("review")}>
                    <span>Pending reviews</span>
                    <b>{adminPanelLoading.feedback ? "…" : adminFeedback.length}</b>
                    <small>{adminFeedback.length ? "Awaiting your approval →" : "Queue is clear"}</small>
                  </button>
                  <div>
                    <span>Total scans</span>
                    <b>{adminPanelLoading.overview ? "…" : adminOverview?.total_scans ?? "—"}</b>
                    <small>Recorded analyses</small>
                  </div>
                  <div>
                    <span>Active users</span>
                    <b>{adminPanelLoading.users ? "…" : adminUsers.length || "—"}</b>
                    <small>Firebase accounts</small>
                  </div>
                  <div>
                    <span>Dataset samples</span>
                    <b>{adminPanelLoading.overview ? "…" : adminOverview?.dataset?.total_samples ?? datasetStats?.total_samples ?? "—"}</b>
                    <small>Across supported classes</small>
                  </div>
                </section>

                <div className="admin-overview-grid">
                  <section className="admin-panel-card">
                    <div className="admin-section-heading">
                      <div><span className="admin-eyebrow">ACTIVITY</span><h2>Scans this week</h2></div>
                      <span className="admin-count">{adminScans.length ? "Last 7 days" : "No scan data"}</span>
                    </div>
                    {adminPanelLoading.scans ? <p className="admin-panel-loading" role="status">Loading scan activity…</p> : adminScans.length ? <div className="admin-trend" aria-label="Seven day scan activity">
                      {trendDays.map((day) => <div className="admin-trend-day" key={day.key}><strong>{day.count}</strong><div className="admin-trend-bar"><i style={{ height: `${Math.max(8, day.count / trendMax * 100)}%` }} /></div><small>{day.label}</small></div>)}
                    </div> : <p className="admin-empty">Scan activity will appear after the API records scans.</p>}
                  </section>

                  <section className="admin-panel-card">
                    <div className="admin-section-heading">
                      <div><span className="admin-eyebrow">DATASET</span><h2>Class balance</h2></div>
                      <span className="admin-count">{adminOverview?.dataset?.total_samples ?? 0} samples</span>
                    </div>
                    <div className="admin-dataset-grid">
                      {Object.entries(adminOverview?.dataset?.classes || {}).map(([label, value]: [string, any]) => {
                        const maximum = Math.max(1, ...Object.values(adminOverview?.dataset?.classes || {}).map((item: any) => Number(item.total) || 0));
                        return <div className="admin-dataset-row" key={label}><span>{label.replace("_", " ")}</span><div><i style={{ width: `${Math.max(3, (Number(value.total) || 0) / maximum * 100)}%` }} /></div><b>{value.total}</b><small>{value.user_verified} reviewed</small></div>;
                      })}
                    </div>
                  </section>
                </div>

                <section className="admin-panel-card">
                  <div className="admin-section-heading">
                    <div><span className="admin-eyebrow">ACCOUNTABILITY</span><h2>Recent admin activity</h2></div>
                    <span className="admin-count">{adminAudit.length ? `${adminAudit.length} events` : "No events"}</span>
                  </div>
                  {adminPanelLoading.audit ? <p className="admin-panel-loading" role="status">Loading audit history…</p> : adminAudit.length ? <div className="admin-audit-list">
                    {adminAudit.slice(0, 5).map((entry, index) => <div className="admin-audit-row" key={entry.id || `${entry.action}-${index}`}><span className="admin-audit-icon">↳</span><div><strong>{entry.action || "Administrative event"}</strong><small>{entry.detail || entry.actor || "Recorded by the platform"}{entry.created_at ? ` · ${new Date(entry.created_at).toLocaleString()}` : ""}</small></div></div>)}
                  </div> : <p className="admin-empty">No admin actions recorded yet.</p>}
                </section>
              </>
            )}

{adminTab === "model" &&
          <section className="admin-workspace">
            <div>
              <span className="eyebrow">MODEL DELIVERY / {String(adminOverview?.training_mode || "checking").replace(/_/g," ")}</span>
              <h2>GPU training and controlled release</h2>
              <p>Approved feedback becomes a versioned dataset. Training runs on a dedicated GPU worker, while Render keeps the current model online until the candidate passes accuracy, macro-F1, recall, latency, and regression gates.</p>
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
            </div>
            <div className="admin-checklist">
              <h3>Before deployment</h3>
              <p>1. Approve corrected labels</p>
              <p>2. Export the reviewed dataset</p>
              <p>3. Train a versioned candidate offline</p>
              <p>4. Compare held-out metrics and regressions</p>
              <p>5. Promote through a reviewed deployment</p>
              <div className="model-metric-mini"><span>Current accuracy <b>{adminOverview?.model_metrics?.test_accuracy != null ? `${(adminOverview.model_metrics.test_accuracy*100).toFixed(1)}%` : "Not recorded"}</b></span><span>Macro F1 <b>{adminOverview?.model_metrics?.macro_f1 != null ? `${(adminOverview.model_metrics.macro_f1*100).toFixed(1)}%` : "Not recorded"}</b></span></div>
            </div>
          </section>}

{adminTab === "review" && (
            <section className="admin-review-queue">
              <div className="admin-section-heading">
                <div>
                  <span className="eyebrow">HUMAN REVIEW & PLATFORM SCANS</span>
                  <h2>{reviewSubtab === "pending" ? "Pending training feedback" : "All user garment scans"}</h2>
                </div>
                <div className="admin-subtab-switch" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className={`btn ${reviewSubtab === "pending" ? "btn-primary" : "btn-outline"}`}
                    style={{ fontSize: "11px", padding: "6px 14px", height: "auto" }}
                    onClick={() => setReviewSubtab("pending")}
                  >
                    Pending Approvals ({adminFeedback.length})
                  </button>
                  <button
                    type="button"
                    className={`btn ${reviewSubtab === "scans" ? "btn-primary" : "btn-outline"}`}
                    style={{ fontSize: "11px", padding: "6px 14px", height: "auto" }}
                    onClick={() => setReviewSubtab("scans")}
                  >
                    All User Scans ({adminScans.length})
                  </button>
                </div>
              </div>
              <div className="admin-toolbar">
                <label className="admin-search"><span className="sr-only">Search review records</span><input value={reviewQuery} onChange={(event) => setReviewQuery(event.target.value)} placeholder={reviewSubtab === "pending" ? "Search fabric or filename" : "Search fabric, note, or user ID"} type="search" /></label>
                {reviewSubtab === "scans" && <label className="admin-filter"><span className="sr-only">Filter scan feedback</span><select value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as typeof reviewFilter)}><option value="all">All scan statuses</option><option value="confirmed">User confirmed</option><option value="corrected">User corrected</option></select></label>}
              </div>

              {reviewSubtab === "pending" && (
                <>
                  {adminPanelLoading.feedback ? <p className="admin-panel-loading" role="status">Loading feedback queue…</p> : filteredFeedback.length ? filteredFeedback.map((item) => (
                    <article className="admin-review-row" key={`${item.fabric}/${item.file}`}>
                      <AdminFeedbackPreview item={item} />
                      <div className="admin-review-copy">
                        <strong>{item.fabric}</strong>
                        {item.original_fabric && <span>Model predicted: {item.original_fabric}</span>}
                        <small>{item.filename || item.file}</small>
                      </div>
                      <div className="admin-row-actions">
                        <button type="button" className="btn btn-primary" onClick={async () => {
                          const response = await apiFetch(`${API}/admin/feedback/${encodeURIComponent(item.fabric)}/${encodeURIComponent(item.file)}/approve`, { method: "POST" });
                          if (response.ok) setAdminFeedback((items) => items.filter((candidate) => candidate.file !== item.file));
                          else setAdminMessage("Could not approve this feedback item.");
                        }}>Approve label</button>
                        <button type="button" className="btn btn-outline" onClick={async () => {
                          if (!window.confirm("Reject this feedback image?")) return;
                          const response = await apiFetch(`${API}/admin/feedback/${encodeURIComponent(item.fabric)}/${encodeURIComponent(item.file)}`, { method: "DELETE" });
                          if (response.ok) setAdminFeedback((items) => items.filter((candidate) => candidate.file !== item.file));
                          else setAdminMessage("Could not reject this feedback item.");
                        }}>Reject</button>
                      </div>
                    </article>
                  )) : <p className="admin-empty">{adminFeedback.length ? "No feedback matches this search." : "No feedback is waiting for review. New user corrections will appear here for approval."}</p>}
                </>
              )}

              {reviewSubtab === "scans" && (
                <div className="admin-scans-list" style={{ display: "grid", gap: "10px", marginTop: "14px" }}>
                  {adminPanelLoading.scans ? <p className="admin-panel-loading" role="status">Loading scan history…</p> : filteredScans.length ? filteredScans.map((scan: any) => (
                    <article className="admin-review-row admin-scan-card" key={String(scan.id)}>
                      <div className="admin-user-avatar" style={{ fontSize: "20px", background: "rgba(67,214,162,0.12)", color: "#43d6a2" }}>
                        🧺
                      </div>
                      <div className="admin-review-copy">
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
                          <strong style={{ textTransform: "capitalize", fontSize: "14px" }}>{scan.fabric || "Unknown"}</strong>
                          <span className="admin-badge ok" style={{ fontSize: "10px" }}>{Math.round(scan.confidence || 0)}% confidence</span>
                          {scan.user_feedback ? (
                            scan.user_feedback.was_correct ? (
                              <span className="admin-badge ok" style={{ fontSize: "10px" }}>✓ User confirmed</span>
                            ) : (
                              <span className="admin-badge warn" style={{ fontSize: "10px" }}>⚠️ Corrected to {scan.user_feedback.confirmed_fabric}</span>
                            )
                          ) : (
                            <span className="admin-badge" style={{ fontSize: "10px", background: "rgba(255,255,255,0.06)", color: "#8ca69b" }}>Scan record</span>
                          )}
                        </div>
                        {scan.note && <p style={{ margin: "2px 0 4px", color: "#c2d6ce", fontSize: "12px" }}>"{scan.note}"</p>}
                        <small style={{ color: "#78968a" }}>{scan.created_at ? new Date(scan.created_at).toLocaleString() : "Date recorded"} • User UID: {String(scan.owner_uid || scan.id || "").slice(0, 10)}</small>
                      </div>
                    </article>
                  )) : <p className="admin-empty">{adminScans.length ? "No scans match this search or filter." : "No scan records recorded yet."}</p>}
                </div>
              )}
            </section>
          )}

          {adminTab === "users" &&
          <section className="admin-review-queue admin-users">
            <div className="admin-section-heading">
              <div><span className="eyebrow">ACCESS CONTROL</span><h2>Users and administrator roles</h2></div>
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
                    const next=!account.is_admin;
                    const response=await apiFetch(`${API}/admin/users/${encodeURIComponent(account.uid)}/role`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({is_admin:next})});
                    if (response.ok) setAdminUsers((items) => items.map((item) => item.uid === account.uid ? {...item,is_admin:next} : item));
                    else setAdminMessage((await response.json()).detail || "Could not update this role.");
                  }}>{account.is_admin ? "Remove admin" : "Make admin"}</button>
                  <button type="button" className={`btn ${account.disabled ? "btn-primary" : "btn-outline"}`} disabled={account.uid === user.uid} onClick={async () => {
                    const next=!account.disabled;
                    if (next && !window.confirm(`Disable ${account.email || "this user"}?`)) return;
                    const response=await apiFetch(`${API}/admin/users/${encodeURIComponent(account.uid)}/status`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({disabled:next})});
                    if (response.ok) setAdminUsers((items) => items.map((item) => item.uid === account.uid ? {...item,disabled:next} : item));
                    else setAdminMessage((await response.json()).detail || "Could not update this account.");
                  }}>{account.disabled ? "Enable user" : "Disable user"}</button>
                </div>
              </article>
            )) : <p className="admin-empty">{adminUsers.length ? "No users match this search." : adminErrors.users || "No Firebase users could be loaded."}</p>}
          </section>}

          
            <div className="admin-quick-links">
              <a href={`${API}/health`} target="_blank" rel="noreferrer">API health ↗</a>
              <a href={`${API.replace(/\/api$/, "")}/docs`} target="_blank" rel="noreferrer">API docs ↗</a>
            </div>
          </MotionPanel>
        </main>
  );
}
