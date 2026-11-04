import type { ReactNode } from "react";
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

// ─────────────────────────────────────────────────────────────────────────────
// Icon module (audit P1-2, 2026-11-03): the app's single inline-SVG icon set.
// One visual language — 24×24 stroke icons in currentColor — replacing the
// emoji / bare-unicode glyphs that rendered differently on every platform.
// Used by the result care tiles + tabs, the About stack tiles, the landing
// feature wall + vision-engine grid, the trust pill and the History empty
// state. The 🧺 logo mark and the hero scanner demo intentionally stay emoji.
// ─────────────────────────────────────────────────────────────────────────────

export type IconProps = { size?: number };

function Svg({ size = 24, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconWash({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 10.5 5.4 18.6A2 2 0 0 0 7.4 20.2h9.2a2 2 0 0 0 2-1.6L20 10.5" />
      <path d="M2.8 10.5h18.4" />
      <path d="M7 15c1.7-1.4 3.3-1.4 5 0s3.3 1.4 5 0" />
      <circle cx="9" cy="6.4" r="1.1" />
      <circle cx="13.6" cy="5.2" r="1.4" />
      <circle cx="16.8" cy="7" r="0.9" />
    </Svg>
  );
}

export function IconDry({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 9.2V7.4a1.9 1.9 0 1 0-1.9-1.9" />
      <path d="M12 9.2 20.6 17a1.15 1.15 0 0 1-1 1.9H4.4a1.15 1.15 0 0 1-1-1.9Z" />
    </Svg>
  );
}

export function IconIron({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8.2 11c0-2.2 1.7-3.8 3.8-3.8s3.8 1.6 3.8 3.8" />
      <path d="M3.8 17.4 5.2 12.6h13.4c1.7 1.1 2.6 2.8 2.6 4.8Z" />
      <path d="M3 20.6h18" />
    </Svg>
  );
}

export function IconDetergent({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M10 3.2h4V6l1.3 2.1V19a2 2 0 0 1-2 2h-2.6a2 2 0 0 1-2-2V8.1L10 6Z" />
      <path d="M9.6 3.2h4.8" />
      <path d="M10 13h4" />
      <path d="M10 16.4h4" />
    </Svg>
  );
}

export function IconBleach({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 4.2 20.8 19.5H3.2Z" />
      <path d="M12 11.4c1 1.2 1.6 2.1 1.6 2.9a1.6 1.6 0 1 1-3.2 0c0-.8.6-1.7 1.6-2.9Z" />
    </Svg>
  );
}

export function IconFlask({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M10 3h4" />
      <path d="M10.6 3v5.1L5.2 17.9A1.6 1.6 0 0 0 6.6 20.4h10.8a1.6 1.6 0 0 0 1.4-2.5L13.4 8.1V3" />
      <path d="M8.2 14.6h7.6" />
    </Svg>
  );
}

export function IconDosing({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6.2 4h11.6l-1.3 15.1a2 2 0 0 1-2 1.9H9.5a2 2 0 0 1-2-1.9Z" />
      <path d="M5.4 4h13.2" />
      <path d="M15.6 9.2h-2.5" />
      <path d="M15.2 13h-2.5" />
    </Svg>
  );
}

export function IconCamera({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M3.5 8.5A1.5 1.5 0 0 1 5 7h1.7l1.6-2.3a1 1 0 0 1 .8-.4h5.8a1 1 0 0 1 .8.4L17.3 7H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z" />
      <circle cx="12" cy="13" r="3.4" />
    </Svg>
  );
}

export function IconProfile({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6.5 3.5H14L19 8.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V5A1.5 1.5 0 0 1 6.5 3.5Z" />
      <path d="M14 3.5V8.5h5" />
      <path d="M8.3 12.6h7.4" />
      <path d="M8.3 16h7.4" />
    </Svg>
  );
}

export function IconVault({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M3.2 6.4h17.6v4.1H3.2Z" />
      <path d="M4.6 10.5h14.8V19a1.5 1.5 0 0 1-1.5 1.5H6.1A1.5 1.5 0 0 1 4.6 19Z" />
      <path d="M10 14.6h4" />
    </Svg>
  );
}

export function IconBasket({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M7.6 10.2C7.6 6.8 9.6 4.6 12 4.6s4.4 2.2 4.4 5.6" />
      <path d="M2.9 10.2h18.2" />
      <path d="M4.2 10.2l1.5 8.9a2 2 0 0 0 2 1.7h8.6a2 2 0 0 0 2-1.7l1.5-8.9" />
      <path d="M9.2 13.8v3.8" />
      <path d="M12 13.8v3.8" />
      <path d="M14.8 13.8v3.8" />
    </Svg>
  );
}

export function IconAssistant({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 7V4.4" />
      <circle cx="12" cy="3.4" r="0.7" fill="currentColor" stroke="none" />
      <path d="M5 9.7A2.6 2.6 0 0 1 7.6 7.1h8.8A2.6 2.6 0 0 1 19 9.7v5.8a2.6 2.6 0 0 1-2.6 2.6H7.6A2.6 2.6 0 0 1 5 15.5Z" />
      <circle cx="9.4" cy="12.2" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="14.6" cy="12.2" r="0.95" fill="currentColor" stroke="none" />
      <path d="M9.9 15.1c.65.6 1.35.9 2.1.9s1.45-.3 2.1-.9" />
    </Svg>
  );
}

export function IconRefresh({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M20.8 12a8.8 8.8 0 1 1-2.6-6.3" />
      <path d="M21 3.2v5.6h-5.6" />
    </Svg>
  );
}

export function IconShield({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 3.2 19 5.7v5.5c0 4.5-2.9 7.5-7 9.2-4.1-1.7-7-4.7-7-9.2V5.7Z" />
      <path d="m9.1 11.7 2.1 2.1 4-4" />
    </Svg>
  );
}

export function IconGlobe({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M3.4 12h17.2" />
      <path d="M12 3.4c2.35 2.3 3.55 5.2 3.55 8.6s-1.2 6.3-3.55 8.6c-2.35-2.3-3.55-5.2-3.55-8.6S9.65 5.7 12 3.4Z" />
    </Svg>
  );
}

export function IconTexture({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="10.8" cy="10.8" r="6.4" />
      <path d="m15.4 15.4 5 5" />
      <path d="M8.3 8.3l5 5" />
      <path d="M13.3 8.3l-5 5" />
    </Svg>
  );
}

export function IconWeave({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 4h16v16H4Z" />
      <path d="M4 9.3h16" />
      <path d="M4 14.7h16" />
      <path d="M9.3 4v16" />
      <path d="M14.7 4v16" />
    </Svg>
  );
}

export function IconSparkle({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M11 4.2 12.8 9.7l5.5 1.8-5.5 1.8L11 18.8l-1.8-5.5L3.7 11.5l5.5-1.8Z" />
      <path d="M18.7 3.6v3" />
      <path d="M17.2 5.1h3" />
    </Svg>
  );
}

export function IconChat({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 5.6A1.6 1.6 0 0 1 5.6 4h12.8A1.6 1.6 0 0 1 20 5.6v7.9a1.6 1.6 0 0 1-1.6 1.6H12L7.4 19.4v-4.3H5.6A1.6 1.6 0 0 1 4 13.5Z" />
      <path d="M7.8 8.4h8.4" />
      <path d="M7.8 11.5h5" />
    </Svg>
  );
}

export function IconLeaf({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5.2 19.2C5.2 10.4 12 4.6 19.8 4.6c0 7.8-5.8 14.6-14.6 14.6Z" />
      <path d="M5.2 19.2c2.3-4.9 5.7-8.4 10-10.4" />
    </Svg>
  );
}

export function IconBolt({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M13 2.8 4.9 13.4h5.5L9.6 21.2l8.3-10.6h-5.7Z" />
    </Svg>
  );
}

export function IconChip({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M7.6 7.6h8.8v8.8H7.6Z" />
      <path d="M10.6 10.6h2.8v2.8h-2.8Z" />
      <path d="M9.6 7.6V4.7" />
      <path d="M14.4 7.6V4.7" />
      <path d="M9.6 19.3v-2.9" />
      <path d="M14.4 19.3v-2.9" />
      <path d="M7.6 9.6H4.7" />
      <path d="M7.6 14.4H4.7" />
      <path d="M19.3 9.6h-2.9" />
      <path d="M19.3 14.4h-2.9" />
    </Svg>
  );
}

export function IconAtom({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <ellipse cx="12" cy="12" rx="9.2" ry="3.9" />
      <ellipse cx="12" cy="12" rx="9.2" ry="3.9" transform="rotate(62 12 12)" />
      <ellipse cx="12" cy="12" rx="9.2" ry="3.9" transform="rotate(-62 12 12)" />
    </Svg>
  );
}

export function IconDatabase({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <ellipse cx="12" cy="5.8" rx="7" ry="2.6" />
      <path d="M5 5.8v12.4c0 1.45 3.13 2.6 7 2.6s7-1.15 7-2.6V5.8" />
      <path d="M5 12c0 1.45 3.13 2.6 7 2.6s7-1.15 7-2.6" />
    </Svg>
  );
}

export function IconScanFrame({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5V8" />
      <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
      <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <path d="M4.5 12h15" />
    </Svg>
  );
}

export function IconFeather({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M19.6 4.4c-5.2.4-11 2.9-13.4 9.3L4 19.6" />
      <path d="M6.2 13.7C9 10.4 12.6 8 16.8 6.6" />
      <path d="M6.2 13.7 4 19.6l5.9-2.2" />
    </Svg>
  );
}

export function IconShirt({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8.6 4.6 3.9 7.3l1.6 3.3 2.3-1.1v10h8.4v-10l2.3 1.1 1.6-3.3-4.7-2.7a3.4 3.4 0 0 1-6.8 0Z" />
    </Svg>
  );
}

export function IconKettlebell({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8.2 9.2a3.8 3.8 0 0 1 7.6 0" />
      <circle cx="12" cy="15" r="5.6" />
    </Svg>
  );
}

export function IconLayers({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="m12 3.6 8.8 4.4L12 12.4 3.2 8Z" />
      <path d="m3.6 12.4 8.4 4.2 8.4-4.2" />
      <path d="m3.6 16.4 8.4 4.2 8.4-4.2" />
    </Svg>
  );
}

export function IconDrop({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 3.8c2.9 3.6 5.4 6.9 5.4 10a5.4 5.4 0 1 1-10.8 0c0-3.1 2.5-6.4 5.4-10Z" />
    </Svg>
  );
}

export function IconBulb({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 3.5a5.4 5.4 0 0 1 3.1 9.8c-.6.5-1 1-1.15 1.7l-.25 1.2h-3.4L10.05 15c-.15-.7-.55-1.2-1.15-1.7A5.4 5.4 0 0 1 12 3.5Z" />
      <path d="M10.1 19.3h3.8" />
      <path d="M10.9 21h2.2" />
    </Svg>
  );
}

export function IconThermo({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M10.2 4a1.8 1.8 0 0 1 3.6 0v9.1a4.1 4.1 0 1 1-3.6 0Z" />
      <circle cx="12" cy="17.1" r="1.25" fill="currentColor" stroke="none" />
      <path d="M12 17.1V9.5" />
    </Svg>
  );
}

// Result tools (extra features, 2026-11-04): voice readout + share controls
// on the Care Card — same stroke language as the care set.
export function IconSpeaker({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 9.6v4.8h3.4L12 18.7V5.3L7.4 9.6Z" />
      <path d="M15.4 9.3a3.9 3.9 0 0 1 0 5.4" />
      <path d="M17.9 6.9a7.3 7.3 0 0 1 0 10.2" />
    </Svg>
  );
}

export function IconStop({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2" />
    </Svg>
  );
}

export function IconShare({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="17.5" cy="5.8" r="2.6" />
      <circle cx="17.5" cy="18.2" r="2.6" />
      <path d="m8.3 10.9 6.9-3.9" />
      <path d="m8.3 13.1 6.9 3.9" />
    </Svg>
  );
}

// Admin console navigation (2026-11-03 console redesign) — same stroke
// language as the care set, drawn for the sidebar's small sizes.
export function IconGrid({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3.5" y="3.5" width="7.2" height="7.2" rx="1.6" />
      <rect x="13.3" y="3.5" width="7.2" height="7.2" rx="1.6" />
      <rect x="3.5" y="13.3" width="7.2" height="7.2" rx="1.6" />
      <rect x="13.3" y="13.3" width="7.2" height="7.2" rx="1.6" />
    </Svg>
  );
}

export function IconCheckCircle({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="m8.4 12.4 2.5 2.5 4.7-5.3" />
    </Svg>
  );
}

export function IconList({ size = 24 }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8.6 6.2h11M8.6 12h11M8.6 17.8h11" />
      <circle cx="4.4" cy="6.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="4.4" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="4.4" cy="17.8" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  );
}
