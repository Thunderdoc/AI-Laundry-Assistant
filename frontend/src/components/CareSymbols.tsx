import { CARE_SYMBOL_GROUPS, CARE_SYMBOLS } from "../data";
import { useI18n } from "../i18n";

// Static, standards-based care-symbol reference (ISO 3758). Honest scope: it
// teaches the label language; automatic OCR decoding of labels is future work
// that requires a trained label-reading model and is not faked here.
export default function CareSymbols() {
  const { t } = useI18n();
  return (
    <section className="care-symbols" aria-labelledby="care-symbols-title">
      <div className="care-symbols-header">
        <span className="eyebrow">ISO 3758</span>
        <h3 id="care-symbols-title">{t("library.symbols")}</h3>
        <p>{t("library.symbolsCopy")}</p>
      </div>
      {CARE_SYMBOL_GROUPS.map((group) => (
        <div className="care-symbol-group" key={group.id}>
          <h4>{group.label}</h4>
          <div className="care-symbol-grid">
            {CARE_SYMBOLS.filter((symbol) => symbol.group === group.id).map((symbol) => (
              <div className="care-symbol-card" key={symbol.id}>
                <span className="care-symbol-glyph" aria-hidden>{symbol.glyph}</span>
                <b>{symbol.title}</b>
                <small>{symbol.meaning}</small>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
