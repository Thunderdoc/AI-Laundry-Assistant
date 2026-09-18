import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { FABRICS_DATA } from "../data";
import { convertTempText, type TempUnit } from "../lib";
import { MotionButton, MotionPage, Reveal, TextEffect } from "../motion-primitives";
import CareSymbols from "./CareSymbols";

export default function LibraryPage({ initialKey = "cotton", tempUnit }: { initialKey?: string; tempUnit: TempUnit }) {
  const { t } = useI18n();
  const [selectedFabricKey, setSelectedFabricKey] = useState(initialKey);
  const [compareActive, setCompareActive] = useState(false);

  // Follow explicit navigation (e.g. "View Care Spec" from a home fabric card),
  // without clobbering in-page selections.
  useEffect(() => {
    setSelectedFabricKey(initialKey);
  }, [initialKey]);

  return (
    <MotionPage className="page-container">
          <Reveal>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "12px", marginBottom: "20px" }}>
            <div>
              <span className="eyebrow">TEXTILE KNOWLEDGE BASE</span>
              <h1><TextEffect>{t("library.title")}</TextEffect></h1>
            </div>
            <MotionButton
              whileHover={{ y: -2 }}
              whileTap={{ scale: .985 }}
              className="btn btn-secondary"
              onClick={() => setCompareActive(!compareActive)}
            >
              {compareActive ? "View Single Fabric" : `📊 ${t("library.compare")}`}
            </MotionButton>
          </div>

          {/* Comparison Matrix View */}
          {compareActive ? (
            <div className="comparison-table-wrapper">
              <table className="comparison-table">
                <thead>
                  <tr>
                    <th>Fabric Class</th>
                    <th>Category</th>
                    <th>Wash Temp</th>
                    <th>Cycle</th>
                    <th>Drying</th>
                    <th>Ironing</th>
                    <th>Shrinkage Risk</th>
                    <th>Heat Sensitivity</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(FABRICS_DATA).map(([key, data]) => (
                    <tr key={key}>
                      <td><b>{data.emoji} {data.name}</b></td>
                      <td>{data.category}</td>
                      <td>{data.washTemp}</td>
                      <td>{data.cycle}</td>
                      <td>{data.dry}</td>
                      <td>{data.iron}</td>
                      <td><span className={`tag-chip ${data.shrinkRisk === "High" ? "danger" : ""}`}>{data.shrinkRisk}</span></td>
                      <td><span className="tag-chip">{data.heatSens}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div>
              {/* Fabric Picker Chips */}
              <div className="tag-container" style={{ marginBottom: "28px" }}>
                {Object.entries(FABRICS_DATA).map(([key, data]) => (
                  <button
                    key={key}
                    type="button"
                    className={`tag-chip ${selectedFabricKey === key ? "active" : ""}`}
                    style={{
                      background: selectedFabricKey === key ? "var(--primary)" : "var(--surface)",
                      color: selectedFabricKey === key ? "#FFFFFF" : "var(--dark)",
                      fontSize: "14px",
                      padding: "8px 18px"
                    }}
                    onClick={() => setSelectedFabricKey(key)}
                  >
                    {data.emoji} {data.name}
                  </button>
                ))}
              </div>

              {/* Selected Fabric 6-Section Spec Card */}
              {(() => {
                const current = FABRICS_DATA[selectedFabricKey];
                return (
                  <div className="workspace-panel">
                    <span className="eyebrow">{current.category}</span>
                    <h2 style={{ fontSize: "36px", marginBottom: "8px" }}>{current.emoji} {current.name}</h2>
                    <p style={{ color: "var(--text-muted)", fontSize: "16px", marginBottom: "28px" }}>{current.overview}</p>

                    <div className="care-profile-grid">
                      <div className="care-card">
                        <div className="care-card-icon">🫧</div>
                        <div className="care-card-label">WASH TEMP</div>
                        <div className="care-card-value">{convertTempText(current.washTemp, tempUnit)}</div>
                        <span style={{ fontSize: "12px", color: "var(--text-light)" }}>{current.cycle}</span>
                      </div>
                      <div className="care-card">
                        <div className="care-card-icon">◌</div>
                        <div className="care-card-label">DRYING</div>
                        <div className="care-card-value">{current.dry}</div>
                      </div>
                      <div className="care-card">
                        <div className="care-card-icon">♨</div>
                        <div className="care-card-label">IRONING</div>
                        <div className="care-card-value">{current.iron}</div>
                      </div>
                      <div className="care-card">
                        <div className="care-card-icon">⚠️</div>
                        <div className="care-card-label">SHRINKAGE</div>
                        <div className="care-card-value">{current.shrinkRisk}</div>
                      </div>
                      <div className="care-card">
                        <div className="care-card-icon">🔥</div>
                        <div className="care-card-label">HEAT SENSITIVITY</div>
                        <div className="care-card-value">{current.heatSens}</div>
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", marginTop: "24px" }}>
                      <div className="rationale-box">
                        <h4>Visual Characteristics (Computer Vision Cues)</h4>
                        <p>{current.visual}</p>
                      </div>
                      <div className="rationale-box" style={{ background: "var(--warm-beige)", borderColor: "#DECDB5" }}>
                        <h4 style={{ color: "var(--dark)" }}>Sustainability Impact</h4>
                        <p>{current.sustainability}</p>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          <div style={{ marginTop: "40px" }}>
            <CareSymbols />
          </div>
          </Reveal>
        
    </MotionPage>
  );
}
