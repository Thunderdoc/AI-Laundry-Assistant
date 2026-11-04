import { useEffect, useMemo, useRef, useState } from "react";
import {
  API,
  apiFetch,
  convertTempText,
  downscaleImage,
  withTimeout,
  type Prediction,
  type TempUnit,
} from "../lib";
import { FABRICS_DATA } from "../data";
import { buildLoads, LOAD_BUILDER_FABRICS, type LoadItem } from "../loadBuilder";
import { useI18n } from "../i18n";

// Load Builder: collect garments (by scanning them with the same /api/predict
// flow the Analyze page uses, or by adding a fabric manually), then group
// them into wash loads whose shared settings are safe for every item.
// Grouping itself lives in ../loadBuilder (pure, unit-tested); this file is
// only state + presentation. The basket persists locally so navigating away
// and back does not lose it.

const ITEMS_KEY = "laundryai_load_builder_items";

function readItems(): LoadItem[] {
  try {
    const raw = localStorage.getItem(ITEMS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<LoadItem>[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is LoadItem =>
        !!item &&
        typeof item.id === "string" &&
        typeof item.fabric === "string" &&
        (item.confidence === null || typeof item.confidence === "number") &&
        (item.source === "scan" || item.source === "manual"),
    );
  } catch {
    return [];
  }
}

function fabricLabel(fabric: string): string {
  const known = FABRICS_DATA[fabric];
  if (known) return `${known.emoji} ${known.name}`;
  if (fabric === "non_fabric") return "🚫 Not a fabric";
  return "❔ Unknown fabric";
}

type PendingScan = { fabric: string; confidence: number };

export default function LoadBuilderPage({ tempUnit }: { tempUnit: TempUnit }) {
  const { t } = useI18n();
  const [items, setItems] = useState<LoadItem[]>(() => readItems());
  const [manualFabric, setManualFabric] = useState<string>(LOAD_BUILDER_FABRICS[0]);
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState("");
  const [scanError, setScanError] = useState("");
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [built, setBuilt] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const idCounter = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(ITEMS_KEY, JSON.stringify(items));
    } catch {
      // Storage can be unavailable (private browsing); the basket still
      // works for this session.
    }
  }, [items]);

  // Recomputed whenever the basket changes, so a plan built earlier never
  // goes stale after an item is added or removed.
  const plan = useMemo(() => buildLoads(items), [items]);

  const nextId = () => {
    idCounter.current += 1;
    return `lb-${Date.now().toString(36)}-${idCounter.current.toString(36)}`;
  };

  const addItem = (fabric: string, confidence: number | null, source: LoadItem["source"]) => {
    setItems((current) => [...current, { id: nextId(), fabric, confidence, source }]);
  };

  const removeItem = (id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  };

  // Same predict path as the Analyze page: downscale, wake the service if
  // needed, one retry on timeout only (a completed-but-unacknowledged scan
  // must never be duplicated).
  const scanFile = async (file: File) => {
    setScanning(true);
    setScanError("");
    setPendingScan(null);
    setScanStatus("Preparing image…");
    try {
      const form = new FormData();
      form.append("image", await downscaleImage(file));

      setScanStatus("Connecting to the AI service…");
      let health = await withTimeout(fetch(`${API}/health?probe=false`), 4_000, "health check").catch(() => null);
      if (!health?.ok) {
        setScanStatus("Waking the AI service. This can take a few moments…");
        await new Promise((resolve) => setTimeout(resolve, 2500));
        health = await withTimeout(fetch(`${API}/health?probe=false`), 4_000, "health check").catch(() => null);
      }

      const predictOnce = () =>
        withTimeout(
          apiFetch(`${API}/predict`, { method: "POST", body: form }),
          120_000,
          "Inference request timed out. The server may be busy or waking up.",
        );
      let response: Response;
      try {
        response = await predictOnce();
      } catch (error) {
        if (error instanceof Error && error.message.includes("timed out")) {
          setScanStatus("Still waking the service — retrying once…");
          response = await predictOnce();
        } else {
          throw error;
        }
      }
      const data = (await response.json()) as Prediction;
      if (!response.ok) throw data;
      const fabric = data.model_decision?.detected_non_fabric ? "non_fabric" : data.fabric;
      setPendingScan({ fabric, confidence: data.confidence });
      setScanStatus("");
    } catch (error) {
      const err = error as { detail?: { message?: string } | string; message?: string };
      const msg = typeof err?.detail === "string" ? err.detail : err?.detail?.message || err?.message || "Scan failed. Please try again.";
      setScanError(msg);
      setScanStatus("");
    } finally {
      setScanning(false);
    }
  };

  return (
    <div style={{ maxWidth: "840px", margin: "0 auto" }}>
      <span className="eyebrow">LOAD BUILDER</span>
      <h1>{t("nav.loads")}</h1>
      <p style={{ color: "var(--text-muted)", fontSize: "17px", lineHeight: "1.6", marginBottom: "28px" }}>
        Add the garments you want to wash — scan each one or pick its fabric — and
        Load Builder groups them into loads that can safely share one wash:
        the coldest temperature, gentlest cycle and lowest spin any garment in
        the load allows.
      </p>

      {/* Add garments */}
      <div className="workspace-panel" style={{ marginBottom: "24px" }}>
        <h3>Add garments</h3>

        <div className="lb-actions">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void scanFile(file);
            }}
          />
          <button type="button" className="btn btn-primary" disabled={scanning} onClick={() => fileInput.current?.click()}>
            {scanning ? "Scanning…" : "📷 Scan a garment"}
          </button>

          <div className="lb-manual">
            <label htmlFor="lb-manual-fabric">or add manually</label>
            <select
              id="lb-manual-fabric"
              value={manualFabric}
              onChange={(event) => setManualFabric(event.target.value)}
            >
              {LOAD_BUILDER_FABRICS.map((fabric) => (
                <option key={fabric} value={fabric}>
                  {fabricLabel(fabric)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => addItem(manualFabric, null, "manual")}
            >
              Add
            </button>
          </div>
        </div>

        {scanStatus && <p style={{ color: "var(--text-muted)", marginTop: "14px" }}>{scanStatus}</p>}
        {scanError && (
          <p role="alert" style={{ color: "var(--danger)", marginTop: "14px" }}>
            {scanError}
          </p>
        )}

        {pendingScan && (
          <div className="lb-pending">
            <span>
              Detected: <b>{fabricLabel(pendingScan.fabric)}</b>
              {pendingScan.fabric !== "non_fabric" && pendingScan.fabric !== "unknown" && (
                <> — {pendingScan.confidence}% confidence</>
              )}
            </span>
            <button
              type="button"
              className="btn btn-sage btn-sm"
              onClick={() => {
                addItem(pendingScan.fabric, pendingScan.confidence, "scan");
                setPendingScan(null);
              }}
            >
              Add to basket
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPendingScan(null)}>
              Discard
            </button>
          </div>
        )}
      </div>

      {/* Basket */}
      <div className="workspace-panel" style={{ marginBottom: "24px" }}>
        <h3>Your basket ({items.length})</h3>
        {items.length === 0 ? (
          <p style={{ color: "var(--text-muted)", marginTop: "8px" }}>
            No garments yet. Scan a garment or add one manually to start building your loads.
          </p>
        ) : (
          <>
            <ul className="lb-items">
              {items.map((item) => (
                <li key={item.id} className="lb-item">
                  <span className="lb-item-name">{fabricLabel(item.fabric)}</span>
                  <span className="lb-item-meta">
                    {item.source === "scan" && item.confidence !== null ? `${item.confidence}% · scanned` : "manual"}
                  </span>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    aria-label={`Remove ${item.fabric} from basket`}
                    onClick={() => removeItem(item.id)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <div className="lb-actions" style={{ marginTop: "16px" }}>
              <button type="button" className="btn btn-primary" onClick={() => setBuilt(true)}>
                🧺 Build my loads
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setItems([]);
                  setBuilt(false);
                }}
              >
                Clear basket
              </button>
            </div>
          </>
        )}
      </div>

      {/* Loads */}
      {built && items.length > 0 && (
        <div aria-live="polite">
          {plan.loads.map((load) => (
            <div key={load.tier} className="workspace-panel lb-load" style={{ marginBottom: "24px" }}>
              <h3>
                {load.name} ({load.items.length} {load.items.length === 1 ? "item" : "items"})
              </h3>
              <div className="care-profile-grid" style={{ marginTop: "16px" }}>
                <div className="care-card">
                  <div className="care-card-icon">🌡️</div>
                  <div className="care-card-label">WASH TEMPERATURE</div>
                  <div className="care-card-value">{convertTempText(load.temperature, tempUnit)}</div>
                </div>
                <div className="care-card">
                  <div className="care-card-icon">🌀</div>
                  <div className="care-card-label">CYCLE</div>
                  <div className="care-card-value">{load.cycle}</div>
                </div>
                <div className="care-card">
                  <div className="care-card-icon">🎡</div>
                  <div className="care-card-label">SPIN</div>
                  <div className="care-card-value">{load.spin}</div>
                </div>
              </div>
              <ul className="lb-items" style={{ marginTop: "16px" }}>
                {load.items.map((item) => (
                  <li key={item.id} className="lb-item">
                    <span className="lb-item-name">{fabricLabel(item.fabric)}</span>
                    <span className="lb-item-meta">
                      {item.source === "scan" && item.confidence !== null ? `${item.confidence}% · scanned` : "manual"}
                    </span>
                  </li>
                ))}
              </ul>
              {load.warnings.length > 0 && (
                <ul className="lb-warnings">
                  {load.warnings.map((warning) => (
                    <li key={warning}>⚠️ {warning}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}

          {plan.excluded.length > 0 && (
            <div className="workspace-panel" style={{ marginBottom: "24px" }}>
              <h3>Not placed in a load ({plan.excluded.length})</h3>
              <p style={{ color: "var(--text-muted)", marginTop: "8px", lineHeight: "1.6" }}>
                These scans did not identify a washable fabric, so no safe wash
                settings can be derived for them. Follow the garment's own care
                label, or scan the fabric surface again in better light.
              </p>
              <ul className="lb-items" style={{ marginTop: "12px" }}>
                {plan.excluded.map((item) => (
                  <li key={item.id} className="lb-item">
                    <span className="lb-item-name">{fabricLabel(item.fabric)}</span>
                    <span className="lb-item-meta">excluded</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p style={{ color: "var(--text-muted)", lineHeight: "1.6" }}>
            Settings follow the same care rules as your scan results. The
            manufacturer's care label on each garment always remains the final
            authority.
          </p>
        </div>
      )}
    </div>
  );
}
