/**
 * Care-summary text builders (extra features, 2026-11-04).
 *
 * Pure functions that compose the two text renderings of a scan result:
 *  - buildSpokenCareText — sentences for the voice readout (speechSynthesis)
 *  - buildShareCareText  — short line-based card for navigator.share/clipboard
 *
 * Both mirror the result view's display rules exactly: confidence and the
 * care profile appear ONLY for results the model accepted (a rejected guess
 * never gets its score read out or shared as if it were confidence), and at
 * most one warning line — the same top warning the UI banners show.
 * Labels arrive as parameters so the module stays i18n-agnostic and unit
 * tests can pin exact output without rendering the app.
 */

export type CareSummaryInput = {
  fabric: string;
  /** Mirrors result.model_decision.accepted. */
  accepted: boolean;
  /** Display confidence (0–100). Used only when accepted. */
  confidence?: number | null;
  /** Display-ready wash temperature (already converted to the user's unit). */
  washTemperature?: string | null;
  washCycle?: string | null;
  dry?: string | null;
  iron?: string | null;
  detergent?: string | null;
  bleach?: string | null;
  /** The single top warning (e.g. the blur retake hint), if any. */
  warning?: string | null;
};

export type CareTextLabels = {
  title: string; // share-card heading, e.g. "LaundryAI care summary"
  fabric: string; // "Fabric"
  confidence: string; // share form, e.g. "confidence" -> "(92% confidence)"
  percent: string; // spoken form, e.g. "percent" -> "92 percent"
  uncertain: string; // full spoken sentence for a rejected result
  uncertainShort: string; // short share marker, e.g. "no confident match"
  wash: string;
  dry: string;
  iron: string;
  detergent: string;
  bleach: string;
  warning: string; // "Warning"
};

const clean = (value?: string | null): string => (value ?? "").trim().replace(/\.+$/, "");

/** Care points in the Care Card's fixed order; empty values are skipped. */
function carePoints(input: CareSummaryInput, labels: CareTextLabels): [string, string][] {
  const wash = [clean(input.washTemperature), clean(input.washCycle)].filter(Boolean).join(", ");
  const points: [string, string][] = [
    [labels.wash, wash],
    [labels.dry, clean(input.dry)],
    [labels.iron, clean(input.iron)],
    [labels.detergent, clean(input.detergent)],
    [labels.bleach, clean(input.bleach)],
  ];
  return points.filter(([, value]) => value !== "");
}

export function buildSpokenCareText(input: CareSummaryInput, labels: CareTextLabels): string {
  const sentences: string[] = [];
  if (!input.accepted) {
    sentences.push(`${labels.fabric}: ${clean(input.fabric)}.`);
    sentences.push(`${clean(labels.uncertain)}.`);
  } else {
    const confidence =
      typeof input.confidence === "number"
        ? `, ${Math.round(input.confidence)} ${clean(labels.percent)} ${clean(labels.confidence)}`
        : "";
    sentences.push(`${labels.fabric}: ${clean(input.fabric)}${confidence}.`);
    for (const [label, value] of carePoints(input, labels)) {
      sentences.push(`${label}: ${value}.`);
    }
  }
  const warning = clean(input.warning);
  if (warning) {
    sentences.push(`${labels.warning}: ${warning}.`);
  }
  return sentences.join(" ");
}

export function buildShareCareText(input: CareSummaryInput, labels: CareTextLabels): string {
  const lines: string[] = [`🧺 ${clean(labels.title)}`];
  if (!input.accepted) {
    lines.push(`${labels.fabric}: ${clean(input.fabric)} (${clean(labels.uncertainShort)})`);
  } else {
    const confidence =
      typeof input.confidence === "number" ? ` (${Math.round(input.confidence)}% ${clean(labels.confidence)})` : "";
    lines.push(`${labels.fabric}: ${clean(input.fabric)}${confidence}`);
    for (const [label, value] of carePoints(input, labels)) {
      lines.push(`${label}: ${value}`);
    }
  }
  // Shared verbatim (trimmed only): the warning is a complete display string
  // from the backend, punctuation included — unlike the spoken builder,
  // which re-punctuates it into a sentence.
  const warning = (input.warning ?? "").trim();
  if (warning) {
    lines.push(`⚠ ${labels.warning}: ${warning}`);
  }
  return lines.join("\n");
}
