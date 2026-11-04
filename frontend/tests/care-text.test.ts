/**
 * Care-summary text builder tests (voice readout + shareable care card).
 *
 * buildSpokenCareText / buildShareCareText are pure functions, so these run
 * the real module directly — no DOM, no speech engine, no network. The
 * critical contract under test is the result view's display rule: a result
 * the model REJECTED never has its confidence or care profile spoken/shared
 * (the UI hides the confidence bar and care tabs for rejected results too).
 */
import { describe, expect, it } from "vitest";
import {
  buildShareCareText,
  buildSpokenCareText,
  type CareSummaryInput,
  type CareTextLabels,
} from "../src/careText";

const labels: CareTextLabels = {
  title: "LaundryAI care summary",
  fabric: "Fabric",
  confidence: "confidence",
  percent: "percent",
  uncertain: "No confident match. The fabric could not be identified reliably.",
  uncertainShort: "no confident match",
  wash: "Wash",
  dry: "Dry",
  iron: "Iron",
  detergent: "Detergent",
  bleach: "Bleach",
  warning: "Warning",
};

const acceptedInput: CareSummaryInput = {
  fabric: "Cotton",
  accepted: true,
  confidence: 92.4,
  washTemperature: "40°C",
  washCycle: "Gentle cycle",
  dry: "Tumble dry low",
  iron: "Medium heat",
  detergent: "Mild formula",
  bleach: "Non-chlorine only",
  warning: null,
};

const rejectedInput: CareSummaryInput = {
  fabric: "Cotton",
  accepted: false,
  confidence: 41.2, // a rejected guess's score — must never surface
  washTemperature: "40°C",
  washCycle: "Gentle cycle",
  dry: "Tumble dry low",
  iron: "Medium heat",
  detergent: "Mild formula",
  bleach: "Non-chlorine only",
  warning: null,
};

describe("buildSpokenCareText", () => {
  it("reads fabric, rounded confidence and all five care points for an accepted result", () => {
    const text = buildSpokenCareText(acceptedInput, labels);
    expect(text).toBe(
      "Fabric: Cotton, 92 percent confidence. " +
        "Wash: 40°C, Gentle cycle. " +
        "Dry: Tumble dry low. " +
        "Iron: Medium heat. " +
        "Detergent: Mild formula. " +
        "Bleach: Non-chlorine only."
    );
  });

  it("appends the top warning as its own sentence when present", () => {
    const text = buildSpokenCareText(
      { ...acceptedInput, warning: "Photo looks blurry — retake with a steady hand." },
      labels
    );
    expect(text.endsWith("Warning: Photo looks blurry — retake with a steady hand.")).toBe(true);
    expect(text.match(/Warning:/g)).toHaveLength(1);
  });

  it("omits the warning entirely when there is none", () => {
    expect(buildSpokenCareText(acceptedInput, labels)).not.toContain("Warning");
  });

  it("skips missing care points instead of reading empty labels", () => {
    const text = buildSpokenCareText(
      { fabric: "Silk", accepted: true, confidence: 88, dry: "Line dry in shade" },
      labels
    );
    expect(text).toBe("Fabric: Silk, 88 percent confidence. Dry: Line dry in shade.");
  });

  it("for a rejected result reads the fabric and the uncertain sentence — never the score or care profile", () => {
    const text = buildSpokenCareText(rejectedInput, labels);
    expect(text).toBe(
      "Fabric: Cotton. No confident match. The fabric could not be identified reliably."
    );
    expect(text).not.toContain("41");
    expect(text).not.toContain("percent");
    expect(text).not.toContain("Wash:");
    expect(text).not.toContain("Bleach:");
  });

  it("still reads the top warning for a rejected result", () => {
    const text = buildSpokenCareText(
      { ...rejectedInput, warning: "Photo looks blurry — retake with a steady hand." },
      labels
    );
    expect(text).toContain("Warning: Photo looks blurry — retake with a steady hand.");
    expect(text).not.toContain("41");
  });
});

describe("buildShareCareText", () => {
  it("composes the full card for an accepted result", () => {
    const text = buildShareCareText(acceptedInput, labels);
    expect(text).toBe(
      [
        "🧺 LaundryAI care summary",
        "Fabric: Cotton (92% confidence)",
        "Wash: 40°C, Gentle cycle",
        "Dry: Tumble dry low",
        "Iron: Medium heat",
        "Detergent: Mild formula",
        "Bleach: Non-chlorine only",
      ].join("\n")
    );
  });

  it("adds at most one warning line, at the end", () => {
    const text = buildShareCareText(
      { ...acceptedInput, warning: "Photo looks blurry — retake with a steady hand." },
      labels
    );
    const lines = text.split("\n");
    expect(lines[lines.length - 1]).toBe(
      "⚠ Warning: Photo looks blurry — retake with a steady hand."
    );
    expect(text.match(/⚠/g)).toHaveLength(1);
  });

  it("for a rejected result shares the uncertain marker — no confidence, no care lines", () => {
    const text = buildShareCareText(rejectedInput, labels);
    expect(text).toBe(
      ["🧺 LaundryAI care summary", "Fabric: Cotton (no confident match)"].join("\n")
    );
    expect(text).not.toContain("%");
    expect(text).not.toContain("41");
    expect(text).not.toContain("Wash:");
  });

  it("uses the provided labels, so other locales compose correctly", () => {
    const de: CareTextLabels = {
      ...labels,
      title: "LaundryAI Pflegeübersicht",
      fabric: "Stoff",
      percent: "Prozent",
      confidence: "Sicherheit",
      wash: "Waschen",
    };
    const text = buildSpokenCareText({ ...acceptedInput, fabric: "Wool" }, de);
    expect(text.startsWith("Stoff: Wool, 92 Prozent Sicherheit. Waschen: 40°C, Gentle cycle.")).toBe(true);
    const share = buildShareCareText({ ...acceptedInput, fabric: "Wool" }, de);
    expect(share.split("\n")[1]).toBe("Stoff: Wool (92% Sicherheit)");
  });
});
