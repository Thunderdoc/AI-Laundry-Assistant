// Load Builder — pure grouping logic (no React, no I/O) so it stays
// deterministic and unit-testable: items[] in, wash loads[] out.
//
// The care profiles below mirror the backend knowledge base
// (backend/app/knowledge_base.py, FABRICS + recommendation()), which is the
// same source the /api/predict responses are generated from — so a load's
// temperature/cycle can never contradict the care advice shown after a scan.
// The frontend's FABRICS_DATA (src/data.tsx) is display copy with ranges
// (e.g. cotton "30°C – 40°C") that disagree with the backend (cotton "30°C"),
// so it is used for names/emoji only, never for grouping values.

export type LoadTier = "regular" | "gentle" | "delicates";

export interface LoadItem {
  id: string;
  /** Model/manual fabric key, e.g. "cotton". Anything without a care
   *  profile ("unknown", "non_fabric", ...) is excluded from loads. */
  fabric: string;
  /** Scan confidence as a percentage (0–100, same units as the predict
   *  response); null for manually added items. */
  confidence: number | null;
  source: "scan" | "manual";
}

export interface CareProfile {
  fabric: string;
  tier: LoadTier;
  /** Backend wash.temperature string, verbatim. */
  temperature: string;
  /** Lower = colder = safer for every other item in the load. */
  tempRank: number;
  /** Backend wash.cycle string, verbatim. */
  cycle: string;
  /** Higher = gentler mechanical action. A shared load must run at the
   *  gentlest cycle any of its items needs. */
  cycleRank: number;
  /** Backend wash.spin string, verbatim. */
  spin: string;
  /** Lower = gentler spin; a shared load uses the lowest. */
  spinRank: number;
  /** Per-item cautions carried into the load, each traceable to a knowledge
   *  base field (dry / bleach / detergent / risks) — see notes per fabric. */
  warnings: string[];
}

// Tier rationale (backend risks.mechanical + wash.spin):
// - wool & silk: mechanical risk "High", spin "Low or none", hand/wool
//   cycles → delicates, never mixed with machine-agitated loads.
// - polyester & denim: "Gentle" cycles, spin 800 RPM → gentle machine load.
//   (Denim's cycle is gentle despite its sturdy reputation, and its colour
//   fading risk is "High", so it does not join the regular load.)
// - cotton: "Normal or gentle", spin 800 RPM, mechanical risk "Low" →
//   regular load.
export const CARE_PROFILES: Record<string, CareProfile> = {
  cotton: {
    fabric: "cotton",
    tier: "regular",
    temperature: "30°C",
    tempRank: 1,
    cycle: "Normal or gentle",
    cycleRank: 1,
    spin: "800 RPM",
    spinRank: 1,
    warnings: [
      // bleach: "Limited — test colourfastness"
      "Limited bleach only — test colourfastness first",
    ],
  },
  polyester: {
    fabric: "polyester",
    tier: "gentle",
    temperature: "30°C",
    tempRank: 1,
    cycle: "Gentle",
    cycleRank: 2,
    spin: "800 RPM",
    spinRank: 1,
    warnings: [
      // bleach: "Avoid chlorine bleach"
      "Avoid chlorine bleach",
      // dry: "Air dry or tumble dry low heat"; heat_sensitivity "High"
      "Tumble dry on low heat only — polyester is heat-sensitive",
    ],
  },
  denim: {
    fabric: "denim",
    tier: "gentle",
    temperature: "Cold (30°C max)",
    tempRank: 0,
    cycle: "Gentle, inside out",
    cycleRank: 2,
    spin: "800 RPM",
    spinRank: 1,
    warnings: [
      // cycle: "Gentle, inside out"
      "Wash inside out",
      // color_fading_risk: "High"
      "Colour may bleed — wash with similar colours",
    ],
  },
  wool: {
    fabric: "wool",
    tier: "delicates",
    temperature: "Cold",
    tempRank: 0,
    cycle: "Wool/hand-wash",
    cycleRank: 3,
    spin: "Low or none",
    spinRank: 0,
    warnings: [
      // dry: "Dry flat, reshape while damp" (never tumble dried)
      "Do not tumble dry — dry flat and reshape while damp",
      // spin: "Low or none"
      "Low or no spin",
      // detergent: "Wool-safe detergent"
      "Use wool-safe detergent",
    ],
  },
  silk: {
    fabric: "silk",
    tier: "delicates",
    temperature: "Cold",
    tempRank: 0,
    cycle: "Hand-wash/gentle",
    cycleRank: 3,
    spin: "Low or none",
    spinRank: 0,
    warnings: [
      // dry: "Air dry away from direct sun"
      "Air dry away from direct sun",
      // spin: "Low or none"
      "Low or no spin",
      // detergent: "Silk-safe mild detergent"
      "Use a silk-safe mild detergent",
    ],
  },
};

/** Fabrics the user can add manually (exactly the knowledge-base classes). */
export const LOAD_BUILDER_FABRICS: string[] = ["cotton", "polyester", "denim", "wool", "silk"];

const TIER_ORDER: LoadTier[] = ["regular", "gentle", "delicates"];

const TIER_NAMES: Record<LoadTier, string> = {
  regular: "Everyday load",
  gentle: "Gentle load",
  delicates: "Delicates load",
};

export interface WashLoad {
  tier: LoadTier;
  name: string;
  items: LoadItem[];
  /** Safest shared settings: lowest temperature, gentlest cycle, lowest
   *  spin among the load's items (labels verbatim from the knowledge base). */
  temperature: string;
  cycle: string;
  spin: string;
  /** Union of the items' care warnings, de-duplicated, in item order. */
  warnings: string[];
}

export interface LoadPlan {
  loads: WashLoad[];
  /** Items with no care profile (unknown / non_fabric scans). They are
   *  never placed in a load; the UI explains why. */
  excluded: LoadItem[];
}

const byFabricThenId = (a: LoadItem, b: LoadItem) =>
  a.fabric === b.fabric ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.fabric < b.fabric ? -1 : 1;

/**
 * Group basket items into wash loads by care compatibility.
 *
 * Rule: two garments may share a load only if they sit in the same care
 * tier (see CARE_PROFILES). Within a load the shared settings are the
 * safest each item allows: minimum tempRank, maximum cycleRank (gentlest),
 * minimum spinRank; ties break alphabetically by fabric so the result is
 * identical for any input ordering of the same basket.
 */
export function buildLoads(items: readonly LoadItem[]): LoadPlan {
  const excluded: LoadItem[] = [];
  const byTier = new Map<LoadTier, LoadItem[]>();

  for (const item of items) {
    const profile = CARE_PROFILES[item.fabric];
    if (!profile) {
      excluded.push(item);
      continue;
    }
    const bucket = byTier.get(profile.tier);
    if (bucket) bucket.push(item);
    else byTier.set(profile.tier, [item]);
  }

  const loads: WashLoad[] = [];
  for (const tier of TIER_ORDER) {
    const bucket = byTier.get(tier);
    if (!bucket || bucket.length === 0) continue;

    const sorted = [...bucket].sort(byFabricThenId);
    const profiles = sorted.map((item) => CARE_PROFILES[item.fabric]);

    const coldest = [...profiles].sort(
      (a, b) => a.tempRank - b.tempRank || (a.fabric < b.fabric ? -1 : 1),
    )[0];
    const gentlest = [...profiles].sort(
      (a, b) => b.cycleRank - a.cycleRank || (a.fabric < b.fabric ? -1 : 1),
    )[0];
    const softestSpin = [...profiles].sort(
      (a, b) => a.spinRank - b.spinRank || (a.fabric < b.fabric ? -1 : 1),
    )[0];

    const warnings: string[] = [];
    for (const profile of profiles) {
      for (const warning of profile.warnings) {
        if (!warnings.includes(warning)) warnings.push(warning);
      }
    }

    loads.push({
      tier,
      name: TIER_NAMES[tier],
      items: sorted,
      temperature: coldest.temperature,
      cycle: gentlest.cycle,
      spin: softestSpin.spin,
      warnings,
    });
  }

  return { loads, excluded };
}
