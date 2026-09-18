import { useEffect, useMemo, useState } from "react";
import {
  API,
  NOTE_MAX_LENGTH,
  apiFetch,
  convertTempText,
  readTempUnit,
  type Prediction,
  type TempUnit,
} from "../lib";
import { FABRICS_DATA } from "../data";
import { useI18n } from "../i18n";

// ---------------------------------------------------------------------------
// Local-only user conveniences (favorites + reminders) live in localStorage;
// they never touch the API. Scan records themselves come from /api/history.
// ---------------------------------------------------------------------------
const FAVORITES_KEY = "laundryai_favorites";
const REMINDERS_KEY = "laundryai_reminders";

type Reminder = { id: string; label: string; dueAt: number };

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

// Rule-based wash-load planning (no model): the strictest compatible condition
// wins, and delicate items are split out of machine loads.
const WASH_RULES: Record<string, { maxTempC: number | null; handwash?: boolean; tumbleSafe?: boolean }> = {
  cotton: { maxTempC: 40, tumbleSafe: true },
  polyester: { maxTempC: 30, tumbleSafe: true },
  denim: { maxTempC: 30, tumbleSafe: false },
  wool: { maxTempC: 30, handwash: true, tumbleSafe: false },
  silk: { maxTempC: 30, handwash: true, tumbleSafe: false },
};
const BASE_DOSE: Record<string, number> = { cotton: 40, polyester: 30, denim: 35, wool: 20, silk: 15 };

type LoadPlan = {
  machineCount: number;
  handwashCount: number;
  maxTempC: number | null;
  tumbleSafe: boolean;
  dose: number;
  warnings: string[];
};

function buildWashLoad(items: Prediction[]): LoadPlan {
  const machine = items.filter((item) => !WASH_RULES[item.fabric]?.handwash);
  const handwash = items.filter((item) => WASH_RULES[item.fabric]?.handwash);
  const temps = machine
    .map((item) => WASH_RULES[item.fabric]?.maxTempC)
    .filter((value): value is number => typeof value === "number");
  const warnings: string[] = [];
  if (handwash.length) {
    warnings.push(
      `${handwash.map((item) => FABRICS_DATA[item.fabric]?.name ?? item.fabric).join(", ")}: hand-wash these separately — do not machine-wash with the rest.`
    );
  }
  if (machine.length && machine.some((item) => WASH_RULES[item.fabric]?.tumbleSafe === false)) {
    warnings.push("At least one item should not go in the tumble dryer — air dry the load.");
  }
  return {
    machineCount: machine.length,
    handwashCount: handwash.length,
    maxTempC: temps.length ? Math.min(...temps) : null,
    tumbleSafe: machine.length > 0 && machine.every((item) => WASH_RULES[item.fabric]?.tumbleSafe === true),
    dose: machine.reduce((sum, item) => sum + (BASE_DOSE[item.fabric] ?? 30), 0),
    warnings,
  };
}

function relativeDue(dueAt: number, now: number): string {
  const hours = Math.round((dueAt - now) / 3_600_000);
  if (hours < 0) return "Due now";
  if (hours < 48) return `In ${hours} h`;
  const days = Math.round(hours / 24);
  return `In ${days} day${days === 1 ? "" : "s"}`;
}

export default function HistoryPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<Prediction[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [confidenceFilter, setConfidenceFilter] = useState<"all" | "high" | "mid" | "low">("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favorites, setFavorites] = useState<Record<string, boolean>>(() => readJSON(FAVORITES_KEY, {}));
  const [reminders, setReminders] = useState<Reminder[]>(() => readJSON(REMINDERS_KEY, []));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [showPlanner, setShowPlanner] = useState(false);
  const [toast, setToast] = useState("");
  const [tempUnit, setTempUnit] = useState<TempUnit>(readTempUnit);
  const [sessionLost, setSessionLost] = useState(false);

  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  const loadHistory = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await apiFetch(`${API}/history`);
      if (response.status === 401) {
        setSessionLost(true);
        return;
      }
      if (!response.ok) throw new Error(`History request failed (${response.status})`);
      const records = await response.json();
      if (Array.isArray(records)) setItems(records);
    } catch {
      setLoadError("Your scan history could not be loaded right now. The AI service may be waking up — try again.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFavorite = (id: string) => {
    setFavorites((current) => {
      const next = { ...current, [id]: !current[id] };
      writeJSON(FAVORITES_KEY, next);
      return next;
    });
  };

  const startEdit = (item: Prediction) => {
    setEditingId(String(item.id));
    setEditValue(item.note || "");
  };

  const saveNote = async (id: string) => {
    let note = editValue.trim();
    if (note && (note.length < 5 || note.length > NOTE_MAX_LENGTH)) {
      flash(`Notes need ${5}–${NOTE_MAX_LENGTH} characters.`);
      return;
    }
    if (!note) note = "";
    const response = await apiFetch(`${API}/history/${encodeURIComponent(id)}/note`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: note || null }),
    });
    if (response.ok) {
      setItems((current) => current.map((item) => (String(item.id) === id ? { ...item, note: note || null } : item)));
      setEditingId(null);
      flash("Note saved.");
    } else {
      flash("Could not save the note.");
    }
  };

  const deleteItem = async (id: string) => {
    if (!window.confirm(t("common.confirmDelete"))) return;
    const response = await apiFetch(`${API}/history/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.ok) {
      setItems((current) => current.filter((item) => String(item.id) !== id));
      flash("Scan deleted.");
    } else {
      flash("Could not delete this scan.");
    }
  };

  const clearAll = async () => {
    if (!window.confirm(t("common.confirmDelete"))) return;
    const response = await apiFetch(`${API}/history`, { method: "DELETE" });
    if (response.ok) {
      setItems([]);
      setSelected({});
      flash("History cleared.");
    } else {
      flash("Could not clear the history.");
    }
  };

  const exportCsv = async () => {
    try {
      const response = await apiFetch(`${API}/history/export/csv`);
      if (!response.ok) throw new Error("export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "laundryai_history.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      flash("CSV downloaded.");
    } catch {
      flash("CSV export failed right now.");
    }
  };

  const addReminder = (item: Prediction, weeks: number) => {
    const label = `${FABRICS_DATA[item.fabric]?.name ?? item.fabric}${item.note ? ` — ${item.note.slice(0, 40)}` : ""}`;
    setReminders((current) => {
      const next = [...current, { id: `${item.id}-${Date.now()}`, label, dueAt: Date.now() + weeks * 7 * 24 * 3_600_000 }];
      writeJSON(REMINDERS_KEY, next);
      return next;
    });
    flash(t("history.reminderAdded"));
  };

  const removeReminder = (id: string) => {
    setReminders((current) => {
      const next = current.filter((reminder) => reminder.id !== id);
      writeJSON(REMINDERS_KEY, next);
      return next;
    });
  };

  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(() => items.filter((item) => {
    const confidence = Number(item.confidence || 0);
    const matchesQuery = !normalizedQuery ||
      [item.fabric, item.note, item.created_at].some((value) => String(value || "").toLowerCase().includes(normalizedQuery));
    const matchesFilter =
      confidenceFilter === "all" ||
      (confidenceFilter === "high" && confidence >= 80) ||
      (confidenceFilter === "mid" && confidence >= 60 && confidence < 80) ||
      (confidenceFilter === "low" && confidence < 60);
    const matchesFavorite = !favoritesOnly || Boolean(favorites[String(item.id)]);
    return matchesQuery && matchesFilter && matchesFavorite;
  }), [items, normalizedQuery, confidenceFilter, favoritesOnly, favorites]);

  const selectedItems = useMemo(() => items.filter((item) => selected[String(item.id)]), [items, selected]);
  const plan = useMemo(() => (selectedItems.length ? buildWashLoad(selectedItems) : null), [selectedItems]);
  const now = Date.now();

  return (
    <section className="history-page">
      <div className="history-header">
        <div>
          <span className="eyebrow">YOUR WARDROBE RECORD</span>
          <h2>{t("history.title")}</h2>
          <p>{t("history.subtitle")}</p>
        </div>
        <div className="history-actions">
          <button type="button" className="btn btn-secondary" disabled={items.length === 0} onClick={exportCsv}>
            {t("history.export")}
          </button>
          <button type="button" className="btn btn-ghost" disabled={items.length === 0} onClick={clearAll}>
            {t("history.clear")}
          </button>
        </div>
      </div>

      {sessionLost && (
        <div className="result error" role="alert">
          Your sign-in session was rejected. History is paused until you sign in again.
        </div>
      )}
      {loadError && <div className="result error" role="alert">{loadError}</div>}
      {loading ? (
        <p className="admin-panel-loading" role="status">{t("common.loading")}</p>
      ) : visible.length === 0 ? (
        <p className="admin-empty">{items.length ? "No scans match this search or filter." : t("history.empty")}</p>
      ) : (
        <>
          <div className="history-toolbar">
            <input
              type="search"
              className="text-field"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("history.search")}
              aria-label="Search scan history"
            />
            <div className="history-filters">
              {([["all", t("history.all")], ["high", t("history.high")], ["mid", t("history.mid")], ["low", t("history.low")]] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`tag-chip ${confidenceFilter === value ? "active" : ""}`}
                  onClick={() => setConfidenceFilter(value)}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                className={`tag-chip ${favoritesOnly ? "active" : ""}`}
                onClick={() => setFavoritesOnly((value) => !value)}
              >
                ★ {t("history.favorites")}
              </button>
            </div>
          </div>

          <div className="history-list">
            {visible.map((item) => {
              const id = String(item.id);
              const fabricData = FABRICS_DATA[item.fabric];
              const isFavorite = Boolean(favorites[id]);
              return (
                <article className="history-row" key={id}>
                  <label className="history-select">
                    <input
                      type="checkbox"
                      checked={Boolean(selected[id])}
                      onChange={() => setSelected((current) => ({ ...current, [id]: !current[id] }))}
                      aria-label={`Select ${item.fabric} scan`}
                    />
                  </label>
                  <span className="history-fabric" aria-hidden>{fabricData?.emoji ?? "🧺"}</span>
                  <div className="history-copy">
                    <div className="history-title-line">
                      <strong style={{ textTransform: "capitalize" }}>{item.fabric}</strong>
                      <span className={`confidence-chip ${item.confidence >= 80 ? "high" : item.confidence >= 60 ? "mid" : "low"}`}>
                        {Math.round(Number(item.confidence || 0))}%
                      </span>
                      {item.user_feedback?.was_correct === false && (
                        <span className="confidence-chip low">⚠ corrected to {String(item.user_feedback.confirmed_fabric).replace("_", " ")}</span>
                      )}
                    </div>
                    {editingId === id ? (
                      <div className="history-note-edit">
                        <input
                          className="text-field"
                          value={editValue}
                          maxLength={NOTE_MAX_LENGTH}
                          onChange={(event) => setEditValue(event.target.value)}
                          onKeyDown={(event) => { if (event.key === "Enter") void saveNote(id); }}
                          aria-label="Edit care note"
                        />
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => void saveNote(id)}>{t("history.save")}</button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>{t("history.cancel")}</button>
                      </div>
                    ) : item.note ? (
                      <p className="history-note">“{item.note}”</p>
                    ) : (
                      <p className="history-note muted">{t("history.edit")}</p>
                    )}
                    <small className="history-date">{item.created_at ? new Date(item.created_at).toLocaleString() : ""}</small>
                  </div>
                  <div className="history-row-actions">
                    <button
                      type="button"
                      className={`history-icon-btn ${isFavorite ? "active" : ""}`}
                      onClick={() => toggleFavorite(id)}
                      aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
                      title="Favorite"
                    >
                      ★
                    </button>
                    {editingId !== id && (
                      <button type="button" className="history-icon-btn" onClick={() => startEdit(item)} aria-label="Edit note" title={t("history.edit")}>
                        ✏️
                      </button>
                    )}
                    <div className="history-remind-menu">
                      <button type="button" className="history-icon-btn" onClick={() => addReminder(item, 2)} aria-label="Remind me in two weeks" title={`${t("history.remind")} (2 w)`}>
                        ⏰
                      </button>
                    </div>
                    <button type="button" className="history-icon-btn danger" onClick={() => void deleteItem(id)} aria-label="Delete scan" title={t("history.delete")}>
                      🗑
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      {items.length > 0 && (
        <div className="history-planner">
          <div className="history-planner-toggle">
            <button
              type="button"
              className="btn btn-sage"
              onClick={() => setShowPlanner((value) => !value)}
              disabled={selectedItems.length === 0}
            >
              {t("history.washload")} {selectedItems.length ? `(${selectedItems.length})` : ""}
            </button>
            <small>Tick scans to plan a compatible wash load.</small>
          </div>
          {showPlanner && plan && (
            <div className="history-planner-panel" role="region" aria-label="Wash load plan">
              <h4>{t("history.loadTitle")}</h4>
              {plan.machineCount === 0 ? (
                <p className="admin-empty">{t("history.loadEmpty")}</p>
              ) : (
                <>
                  <div className="load-plan-grid">
                    <div><span>Machine load</span><b>{plan.machineCount} item{plan.machineCount === 1 ? "" : "s"}</b></div>
                    <div><span>Max temperature</span><b>{plan.maxTempC != null ? convertTempText(`${plan.maxTempC}°C`, tempUnit) : "Cold"}</b></div>
                    <div><span>Cycle</span><b>Gentle (safe for the mix)</b></div>
                    <div><span>Drying</span><b>{plan.tumbleSafe ? "Tumble dry low" : "Air dry"}</b></div>
                    <div><span>Detergent (full load)</span><b>~{plan.dose} ml</b></div>
                  </div>
                  {plan.warnings.map((warning) => (
                    <p className="load-plan-warning" key={warning}>⚠️ {warning}</p>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}

      {reminders.length > 0 && (
        <div className="history-reminders">
          <div className="history-section-title">
            <h4>⏰ Reminders</h4>
            <small>Stored only in this browser.</small>
          </div>
          {reminders
            .slice()
            .sort((a, b) => a.dueAt - b.dueAt)
            .map((reminder) => (
              <div className="history-reminder-row" key={reminder.id}>
                <span className={reminder.dueAt <= now ? "due" : ""}>
                  <strong>{reminder.label}</strong>
                  <small>{relativeDue(reminder.dueAt, now)} · {new Date(reminder.dueAt).toLocaleDateString()}</small>
                </span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeReminder(reminder.id)}>
                  {t("common.close")}
                </button>
              </div>
            ))}
        </div>
      )}

      {toast && <div className="history-toast" role="status">{toast}</div>}
    </section>
  );
}
