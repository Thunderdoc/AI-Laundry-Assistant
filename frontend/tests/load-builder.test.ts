/**
 * Load Builder grouping tests.
 *
 * buildLoads() is a pure function, so these run the real module directly —
 * no DOM, no network. Expected values come from the backend knowledge base
 * (backend/app/knowledge_base.py) that CARE_PROFILES mirrors.
 */
import { describe, expect, it } from "vitest";
import { buildLoads, CARE_PROFILES, LOAD_BUILDER_FABRICS, type LoadItem } from "../src/loadBuilder";

let seq = 0;
const item = (fabric: string, source: LoadItem["source"] = "scan"): LoadItem => ({
  id: `item-${++seq}`,
  fabric,
  confidence: source === "scan" ? 90 : null,
  source,
});

describe("buildLoads", () => {
  it("returns no loads and no exclusions for an empty basket", () => {
    expect(buildLoads([])).toEqual({ loads: [], excluded: [] });
  });

  it("puts a single item into a single load with its own care settings", () => {
    const cotton = item("cotton");
    const plan = buildLoads([cotton]);
    expect(plan.excluded).toEqual([]);
    expect(plan.loads).toHaveLength(1);
    expect(plan.loads[0].tier).toBe("regular");
    expect(plan.loads[0].items).toEqual([cotton]);
    expect(plan.loads[0].temperature).toBe("30°C");
    expect(plan.loads[0].cycle).toBe("Normal or gentle");
    expect(plan.loads[0].spin).toBe("800 RPM");
  });

  it("splits a mixed basket into delicates, gentle and regular loads", () => {
    const plan = buildLoads([
      item("cotton"),
      item("polyester"),
      item("denim"),
      item("wool"),
      item("silk"),
    ]);
    expect(plan.excluded).toEqual([]);
    expect(plan.loads.map((load) => load.tier)).toEqual(["regular", "gentle", "delicates"]);

    const byTier = Object.fromEntries(plan.loads.map((load) => [load.tier, load]));
    expect(byTier.regular.items.map((i) => i.fabric)).toEqual(["cotton"]);
    expect(byTier.gentle.items.map((i) => i.fabric)).toEqual(["denim", "polyester"]);
    expect(byTier.delicates.items.map((i) => i.fabric)).toEqual(["silk", "wool"]);
  });

  it("uses the lowest temperature and gentlest cycle among a load's items", () => {
    // Gentle load: polyester 30°C/"Gentle" + denim Cold/"Gentle, inside out".
    const gentle = buildLoads([item("polyester"), item("denim")]).loads[0];
    expect(gentle.temperature).toBe("Cold (30°C max)");
    expect(gentle.cycle).toBe("Gentle, inside out");
    expect(gentle.spin).toBe("800 RPM");

    // Delicates: wool + silk share Cold and the gentlest hand-wash cycle,
    // and the spin drops to the lowest either allows.
    const delicates = buildLoads([item("wool"), item("silk")]).loads[0];
    expect(delicates.temperature).toBe("Cold");
    expect(delicates.cycle).toBe("Hand-wash/gentle");
    expect(delicates.spin).toBe("Low or none");
  });

  it("carries per-item warnings into the load, de-duplicated", () => {
    const plan = buildLoads([item("wool"), item("wool", "manual"), item("denim")]);
    const delicates = plan.loads.find((load) => load.tier === "delicates")!;
    expect(delicates.warnings).toContain("Do not tumble dry — dry flat and reshape while damp");
    expect(delicates.warnings.filter((w) => w === "Low or no spin")).toHaveLength(1);

    const gentle = plan.loads.find((load) => load.tier === "gentle")!;
    expect(gentle.warnings).toContain("Wash inside out");
    expect(gentle.warnings).toContain("Colour may bleed — wash with similar colours");
  });

  it("excludes unknown and non_fabric items instead of loading them", () => {
    const unknown = item("unknown");
    const nonFabric = item("non_fabric");
    const cotton = item("cotton");
    const plan = buildLoads([unknown, cotton, nonFabric]);
    expect(plan.loads).toHaveLength(1);
    expect(plan.loads[0].items).toEqual([cotton]);
    expect(plan.excluded).toEqual([unknown, nonFabric]);
  });

  it("is deterministic: input order does not change the plan", () => {
    const basket = [item("silk"), item("cotton"), item("denim"), item("wool"), item("polyester")];
    const forward = buildLoads(basket);
    const reversed = buildLoads([...basket].reverse());
    expect(reversed).toEqual(forward);
    expect(buildLoads(basket)).toEqual(forward);
  });

  it("has a care profile for every manually addable fabric", () => {
    for (const fabric of LOAD_BUILDER_FABRICS) {
      expect(CARE_PROFILES[fabric], fabric).toBeDefined();
      expect(CARE_PROFILES[fabric].temperature).not.toBe("");
      expect(CARE_PROFILES[fabric].cycle).not.toBe("");
    }
  });
});
