export const PRESET_TAGS = [
  "100% Cotton",
  "Cold wash only",
  "Delicate wool / silk",
  "Has stubborn stain",
  "Hand wash recommended",
  "Do not tumble dry"
];

export const FABRICS_DATA: Record<string, {
  name: string;
  emoji: string;
  category: string;
  overview: string;
  visual: string;
  washTemp: string;
  cycle: string;
  dry: string;
  iron: string;
  shrinkRisk: string;
  heatSens: string;
  sustainability: string;
}> = {
  cotton: {
    name: "Cotton",
    emoji: "🌱",
    category: "Natural Plant Fiber",
    overview: "Cellulose fiber known for high absorbency, breathability, and durability. Ideal for daily casual garments.",
    visual: "Matte surface, visible plain or twill weave structure, soft natural fiber texture with minimal sheen.",
    washTemp: "30°C – 40°C",
    cycle: "Normal or gentle",
    dry: "Air dry where practical; low tumble dry",
    iron: "Medium heat (steam optional)",
    shrinkRisk: "Medium",
    heatSens: "Medium",
    sustainability: "Cold water washing extends cotton garment lifespan and reduces laundering carbon footprint."
  },
  polyester: {
    name: "Polyester",
    emoji: "🧶",
    category: "Synthetic Polymer",
    overview: "Petroleum-based synthetic textile prized for wrinkle resistance, quick drying, and tensile strength.",
    visual: "Smooth or micro-textured surface, subtle synthetic luster, uniform thread structure with crisp folds.",
    washTemp: "30°C max",
    cycle: "Gentle / Synthetic",
    dry: "Air dry or low heat dryer",
    iron: "Low heat with pressing cloth",
    shrinkRisk: "Low",
    heatSens: "High (melts at high temps)",
    sustainability: "Synthetic microfibers shed during hot vigorous cycles; wash cold in full loads."
  },
  denim: {
    name: "Denim",
    emoji: "👖",
    category: "Heavy Twill Cotton",
    overview: "Rugged warp-faced cotton twill with characteristic indigo dye on the warp and white weft threads.",
    visual: "Distinct diagonal twill lines (2/1 or 3/1 weave), rich indigo color variation, textured surface relief.",
    washTemp: "Cold (30°C max)",
    cycle: "Gentle, inside-out",
    dry: "Air dry in shade; avoid high dryer heat",
    iron: "Medium heat while slightly damp",
    shrinkRisk: "Medium",
    heatSens: "Medium",
    sustainability: "Denim requires less frequent washing. Spot clean and air out to preserve indigo color and save water."
  },
  wool: {
    name: "Wool",
    emoji: "🐑",
    category: "Natural Protein Fiber",
    overview: "Animal protein fiber with microscopic scales providing natural crimp, thermal insulation, and resilience.",
    visual: "Fuzzy, fibrous surface, soft textured hand, looped knit or woven texture without harsh sheen.",
    washTemp: "Cold (30°C max)",
    cycle: "Wool / Hand-wash only",
    dry: "Dry flat, reshape damp; never tumble dry",
    iron: "Low heat with damp pressing cloth",
    shrinkRisk: "High (felting risk)",
    heatSens: "High",
    sustainability: "Wool naturally resists odor. Air out regularly and wash only when visibly soiled."
  },
  silk: {
    name: "Silk",
    emoji: "🪡",
    category: "Natural Protein Filament",
    overview: "Continuous protein filament produced by silkworms, celebrated for luxurious drape, luster, and smooth hand.",
    visual: "Subtle pearlescent sheen, fine thread diameter, smooth fluid drape, delicate weave pattern.",
    washTemp: "Cold water",
    cycle: "Hand-wash / Ultra delicate",
    dry: "Air dry away from direct sunlight",
    iron: "Low heat, inside out",
    shrinkRisk: "Medium",
    heatSens: "High",
    sustainability: "Delicate filament structure requires pH-neutral gentle detergents to maintain tensile integrity."
  }
};

export const STAIN_GUIDE: Record<string, { label: string; icon: string; fabrics: Record<string, { steps: string[]; avoid: string; optimalTemp: string }> }> = {
  coffee: {
    label: "Coffee / Tea",
    icon: "☕",
    fabrics: {
      cotton: { steps: ["Blot excess liquid with a clean white cloth (do not rub).", "Flush from the reverse side with cold running water.", "Apply liquid detergent or baking soda paste directly to the spot; let sit 10 min.", "Machine wash at 30°C–40°C with an oxygen-safe booster if needed."], avoid: "Avoid hot water before treating as heat permanently sets tannin stains.", optimalTemp: "Cold to 30°C" },
      polyester: { steps: ["Dab with a sponge dampened in cold water and a drop of dish soap.", "Gently work solution into synthetic fibers.", "Rinse thoroughly and wash in normal 30°C synthetic cycle."], avoid: "Do not machine dry until stain is fully removed.", optimalTemp: "30°C Max" },
      denim: { steps: ["Blot with damp sponge and mild liquid detergent.", "Rinse with cold water from the inside of the garment.", "Wash inside-out in cold gentle cycle."], avoid: "Vigorous scrubbing that abrades indigo surface dye.", optimalTemp: "Cold (20°C–30°C)" },
      wool: { steps: ["Blot immediately with clean paper towel without rubbing.", "Mix 1 part white vinegar with 2 parts cold water; dab gently.", "Rinse with cold water and dry flat."], avoid: "Never use enzyme detergents, ammonia, or hot water on natural wool scales.", optimalTemp: "Cold (< 30°C)" },
      silk: { steps: ["Blot gently with a sponge soaked in cool water.", "Apply 1 drop of pH-neutral silk wash to a damp cloth and dab lightly.", "Flush with cold water and blot between towels."], avoid: "Never wring, twist, or use oxygen/chlorine bleach on delicate silk filaments.", optimalTemp: "Cold only" }
    }
  },
  oil: {
    label: "Oil & Grease",
    icon: "🍳",
    fabrics: {
      cotton: { steps: ["Cover grease spot generously with cornstarch or baking soda for 15 min to absorb oil.", "Brush off powder; apply concentrated clear dish soap directly to stain.", "Rub gently and wash in 40°C warm cycle."], avoid: "Never tumble dry before checking stain is 100% gone.", optimalTemp: "30°C–40°C" },
      polyester: { steps: ["Apply grease-cutting dish soap or liquid sports detergent directly onto synthetic fibers.", "Work into fibers using fingertips; let rest for 15 minutes.", "Wash in warm water (30°C) with standard detergent."], avoid: "Synthetic fibers bond quickly to oils; avoid high dryer heat.", optimalTemp: "30°C" },
      denim: { steps: ["Sprinkle baking soda over grease spot to absorb surface lipids.", "Pre-treat with diluted dish soap and lukewarm water.", "Machine wash cold inside out."], avoid: "Hot water cycles that fade dark denim washes.", optimalTemp: "Cold" },
      wool: { steps: ["Sprinkle talcum powder or cornstarch to absorb grease; let sit 30 min.", "Brush off gently with a soft-bristle garment brush.", "Spot-dab with wool-safe pH-neutral detergent and cold water."], avoid: "Never apply heavy chemical degreasers or hot water.", optimalTemp: "Cold" },
      silk: { steps: ["Immediately sprinkle with cornstarch; leave for 20 minutes to lift oil.", "Gently brush off powder without pressing.", "For persistent grease, use specialist silk dry-cleaning."], avoid: "Never rub oil deeper into fine silk weaves; avoid heavy soaps.", optimalTemp: "Cold" }
    }
  },
  wine: {
    label: "Red Wine",
    icon: "🍷",
    fabrics: {
      cotton: { steps: ["Blot excess wine with a dry cloth immediately.", "Flush with cold water or club soda to lift anthocyanin pigments.", "Pre-treat with liquid detergent or hydrogen peroxide on whites.", "Wash in normal 30°C–40°C cycle."], avoid: "Hot water sets red wine tannins permanently.", optimalTemp: "Cold" },
      polyester: { steps: ["Flush immediately with cold running water.", "Dab with liquid detergent mixed with a splash of white vinegar.", "Wash at 30°C in gentle cycle."], avoid: "Hot ironing before checking stain residue.", optimalTemp: "Cold / 30°C" },
      denim: { steps: ["Blot gently with a cold water-dampened sponge.", "Dab with mild liquid soap and flush with cold water.", "Air dry in shade."], avoid: "Chlorine bleach which ruins denim indigo dye.", optimalTemp: "Cold" },
      wool: { steps: ["Blot gently with a clean cloth.", "Dab with diluted white vinegar (1 part vinegar to 3 parts cold water).", "Rinse with cold water and reshape damp."], avoid: "Never use sodium percarbonate or bleach on wool.", optimalTemp: "Cold" },
      silk: { steps: ["Blot immediately without spreading stain radius.", "Dab with cold water mixed with 1 tsp cosmetic glycerin.", "Rinse with cold water and lay flat to dry."], avoid: "Bleach and alkaline detergents will dissolve silk protein bonds.", optimalTemp: "Cold only" }
    }
  },
  blood: {
    label: "Blood / Protein",
    icon: "🩸",
    fabrics: {
      cotton: { steps: ["Flush instantly with cold running water from back of fabric (never warm).", "Pre-soak in cold saline solution or apply 3% hydrogen peroxide on white cotton.", "Wash in cold gentle cycle."], avoid: "Warm or hot water coagulates blood proteins into fiber pores.", optimalTemp: "Cold only" },
      polyester: { steps: ["Rinse with cold running water.", "Pre-treat with enzymatic liquid detergent; let sit 10 min.", "Wash at 30°C max."], avoid: "Hot water pre-soak.", optimalTemp: "Cold" },
      denim: { steps: ["Flush thoroughly with cold water from behind the weave.", "Apply a paste of cold water and baking soda.", "Wash cold with mild detergent."], avoid: "Any heat until stain is completely gone.", optimalTemp: "Cold" },
      wool: { steps: ["Flush immediately with cold running water.", "Dab with cold saline solution (1 tsp salt in 1 cup cold water).", "Rinse with cold water and air dry flat."], avoid: "Hot water, alkaline soaps, and chlorine.", optimalTemp: "Cold only" },
      silk: { steps: ["Blot with cold water-dampened cotton pad.", "Dab with gentle cold soapy water (pH 7).", "Rinse cold."], avoid: "Hot water and aggressive scrubbing.", optimalTemp: "Cold only" }
    }
  },
  ink: {
    label: "Ink & Marker",
    icon: "🖋️",
    fabrics: {
      cotton: { steps: ["Place paper towel under the stain.", "Dab with isopropyl rubbing alcohol using a cotton swab.", "Rinse with cold water and wash normally at 30°C."], avoid: "Rubbing vigorously which spreads the pigment halo.", optimalTemp: "30°C" },
      polyester: { steps: ["Apply rubbing alcohol or hand sanitizer to ink spot.", "Blot until ink pigment transfers to paper towel.", "Wash at 30°C."], avoid: "High-temperature dryer heat.", optimalTemp: "30°C" },
      denim: { steps: ["Dab with alcohol-dampened cloth.", "Rinse with cold water.", "Wash cold inside out."], avoid: "Bleaching agents.", optimalTemp: "Cold" },
      wool: { steps: ["Lightly dab with rubbing alcohol on a cotton ball.", "Blot with damp cold cloth.", "Wash with wool detergent."], avoid: "Soaking entire wool garment in alcohol.", optimalTemp: "Cold" },
      silk: { steps: ["Lightly dab with dilute rubbing alcohol on a cotton swab.", "Blot gently without pressure.", "Consult professional dry cleaner if stubborn."], avoid: "Heavy chemical solvents on delicate silk filaments.", optimalTemp: "Cold" }
    }
  },
  sweat: {
    label: "Sweat & Deodorant",
    icon: "🏃",
    fabrics: {
      cotton: { steps: ["Pre-soak in 1:1 warm water and white vinegar for 20 min.", "Apply baking soda paste to underarms.", "Wash at 40°C with oxygen booster."], avoid: "Chlorine bleach which reacts with sweat minerals turning yellow.", optimalTemp: "40°C" },
      polyester: { steps: ["Soak in white vinegar solution (1 cup vinegar in warm water sink).", "Pre-treat with sport/synthetic detergent.", "Wash at 30°C."], avoid: "Fabric softeners which trap body odors in synthetic fibers.", optimalTemp: "30°C" },
      denim: { steps: ["Turn inside out and air in sunlight or soak in cold vinegar water.", "Wash cold."], avoid: "Frequent aggressive washing; spot treat and air out.", optimalTemp: "Cold" },
      wool: { steps: ["Air out garment overnight (wool naturally neutralizes sweat odor).", "If needed, spot clean with cold dilute vinegar."], avoid: "Never machine tumble or use alkaline detergents.", optimalTemp: "Cold" },
      silk: { steps: ["Dab underarms with 1:1 cold water and white vinegar.", "Rinse thoroughly with cold water.", "Hand wash in cool water with silk shampoo."], avoid: "Never use strong alkaline soaps or hot water.", optimalTemp: "Cold" }
    }
  }
};


// ---------------------------------------------------------------------------
// Care-symbol reference (ISO 3758) — static, standards-based knowledge that
// closes part of the "symbol decoder" gap without pretending to run OCR.
// ---------------------------------------------------------------------------
export type CareSymbol = {
  id: string;
  group: "washing" | "bleach" | "drying" | "ironing" | "dryclean";
  glyph: string;
  title: string;
  meaning: string;
};

export const CARE_SYMBOLS: CareSymbol[] = [
  { id: "wash", group: "washing", glyph: "🫧", title: "Washing tub", meaning: "Machine wash. Follow the fabric's temperature guidance." },
  { id: "handwash", group: "washing", glyph: "🖐️", title: "Tub with hand", meaning: "Hand wash only (max 40°C / 104°F)." },
  { id: "nowash", group: "washing", glyph: "🚫", title: "Crossed-out tub", meaning: "Do not wash with water." },
  { id: "temp30", group: "washing", glyph: "30°", title: "Tub with 30", meaning: "Machine wash, max 30°C (86°F)." },
  { id: "temp40", group: "washing", glyph: "40°", title: "Tub with 40", meaning: "Machine wash, max 40°C (104°F)." },
  { id: "temp60", group: "washing", glyph: "60°", title: "Tub with 60", meaning: "Machine wash, max 60°C (140°F)." },
  { id: "bleach", group: "bleach", glyph: "△", title: "Open triangle", meaning: "Bleaching allowed (including chlorine)." },
  { id: "oxybleach", group: "bleach", glyph: "△∕∕", title: "Triangle with slanted lines", meaning: "Non-chlorine (oxygen) bleach only." },
  { id: "nobleach", group: "bleach", glyph: "△✕", title: "Crossed-out triangle", meaning: "Do not bleach." },
  { id: "tumble", group: "drying", glyph: "◻", title: "Square with circle", meaning: "Tumble dry." },
  { id: "tumblelow", group: "drying", glyph: "◻⊙•", title: "Square, circle, one dot", meaning: "Tumble dry at low heat." },
  { id: "notumble", group: "drying", glyph: "◻✕", title: "Crossed-out square+circle", meaning: "Do not tumble dry." },
  { id: "linedry", group: "drying", glyph: "◻̄", title: "Square with top line", meaning: "Line dry." },
  { id: "dripdry", group: "drying", glyph: "◻|", title: "Square with vertical lines", meaning: "Drip dry (do not wring)." },
  { id: "dryflat", group: "drying", glyph: "◻", title: "Square with middle line", meaning: "Dry flat, away from direct heat." },
  { id: "iron", group: "ironing", glyph: "♨", title: "Iron", meaning: "Iron at the temperature marked on the label." },
  { id: "ironlow", group: "ironing", glyph: "♨•", title: "Iron with one dot", meaning: "Iron low — max 110°C (230°F), no steam for delicates." },
  { id: "noiron", group: "ironing", glyph: "♨✕", title: "Crossed-out iron", meaning: "Do not iron." },
  { id: "dryclean", group: "dryclean", glyph: "◯", title: "Circle", meaning: "Professional dry cleaning." },
  { id: "nodryclean", group: "dryclean", glyph: "◯✕", title: "Crossed-out circle", meaning: "Do not dry clean." },
];

export const CARE_SYMBOL_GROUPS: { id: CareSymbol["group"]; label: string }[] = [
  { id: "washing", label: "Washing" },
  { id: "bleach", label: "Bleaching" },
  { id: "drying", label: "Drying" },
  { id: "ironing", label: "Ironing" },
  { id: "dryclean", label: "Dry cleaning" },
];
