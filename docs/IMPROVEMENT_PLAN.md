# LaundryAI — Deep Research Report & Improvement Plan

_Prepared: 2026-09-18 · Branch: `arena/01a0b470-ai-laundry-assistant`_
_Scope: full project audit (front end + back end), market research, UI/UX research, admin console redesign, and a phased plan for new user features. Hard constraint: **nothing may break the existing Vercel (frontend) + Render (API) + Firebase (auth/persistence) deployment.**_

---

## 1. Executive summary

LaundryAI is structurally stronger than most consumer "AI laundry" apps: it runs a real TorchScript MobileNetV2 classifier with confidence + top-2-margin rejection gates, a human-in-the-loop active-learning loop (user correction → admin review → approved training data → versioned retraining), Firebase Auth with verified admin claims, an audit trail, and honest model-metric gates.

The weakest area is exactly what you flagged: **the admin console is overloaded**. It currently shows a big hero panel, 6 KPI cards, a 5-tile health grid, a 7-day trend, an audit list, and dataset balance all on one screen, plus a 5th "Reference" tab that is just links. Dashboard research is unambiguous about this: 3–5 KPIs max above the fold, progressive disclosure (overview → filter → detail), and "clarity over cleverness". The HITL research adds: the review queue should be the *center of gravity* of the console, with one item decidable in under 30 seconds, explicit approve/reject, and a clear "what happens next".

**This document therefore:**
1. Audits the current system in full (§2).
2. Summarizes what competing AI laundry/fabric-care products offer and where LaundryAI has gaps (§3).
3. Extracts the UI/UX rules we will apply (§4).
4. Defines the new minimal admin console — "only what is necessary" (§5).
5. Phases all further work so each phase ships safely without touching the deployment (§6).

---

## 2. Project audit — what exists today

### 2.1 Architecture (verified in code)

| Layer | What it is | Notes |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite, single page, Motion animations | **One file** `frontend/src/main.tsx` (~2,870 lines) + `style.css` (~2,760 lines). Pages are state-switched, not routed: Home, Analyze, Model (insights), Care Guide (library), Admin, About. |
| Backend | FastAPI (`backend/app/main.py`, ~1,300 lines) | Image validation (type, size, dimensions, decompression-bomb guard), TorchScript inference, decision gate, knowledge-base care synthesis, persistence, admin endpoints, rate limiting, security headers, cert caching for Firebase token verification. |
| Persistence | Firebase Realtime DB + Firebase/Supabase Storage in production (`PERSISTENCE_BACKEND=firebase`); SQLite + local folders as dev fallback | `backend/app/firebase_store.py` — clean adapter with timeouts, cleanup-on-failure, atomic metadata updates. |
| Auth | Firebase Auth (email/password + Google). Admin = verified `admin` custom claim **or** server-side `ADMIN_EMAILS` allowlist; token verified against cached Google signing certs. | Frontend never trusts itself for admin identity — it asks the backend. Good. |
| Model | MobileNetV2 (TorchScript) + manifest (classes, 224px, ImageNet norm, thresholds) | Manifest: 6 classes (cotton, polyester, denim, wool, silk, non_fabric), 79.43% test acc, 0.8012 macro-F1 on 282 test images. Model `.pt` is git-ignored but tracked as a deploy copy path. |
| Data | `data/train|val|test` — 3,940 train / 282 val / 282 test | **Imbalanced**: `non_fabric` has only 46 train / 5 val / 5 test samples. `silk` is thinnest of the fabrics (617 train). |
| Training | `backend/scripts/train.py` (local/optional GPU worker), external GPU dispatch + HMAC-protected callback, versioned candidates, **no auto-promotion** | Well-designed release gate; admin triggers retrain only when dataset splits exist. |
| Tests | 30 API tests covering auth, predict, feedback, admin, retrain callback, cert caching | Contract is protected. **We will not change API contracts in Phase 1–2.** |
| Deployment | Vercel (frontend) + Render (API) + Firebase | `vercel.json`, `Dockerfile`, `DEPLOYMENT.md`, `OPERATIONS.md`, `docs/17_product_and_model_roadmap.md` production checklist. API URL has a hardcoded Render fallback in the frontend; CORS origin allowlist in backend. **All of this stays untouched.** |

### 2.2 User-facing feature inventory (what works today)

- Garment scan: upload, drag-and-drop, **live camera** with front/back switch, center-crop capture.
- Client pre-flight quality check (resolution ≥ 224, brightness) before inference.
- Care context note with preset tags ("Do not tumble dry", "Has stubborn stain", …).
- AI result: fabric + confidence, probability distribution of all classes, confidence gate explanations (low confidence / ambiguous / non-fabric) with re-take guidance.
- Care Profile: wash temp/cycle/detergent/spin, dry, iron, bleach, scientific rationale, eco tips.
- Stain Treatment Guide: 6 stain types × 5 fabrics, step-by-step + "avoid" warnings.
- Smart Dosing Calculator: fabric base dose × load size × soil level.
- Active-learning feedback: confirm ("Yes, it's Cotton") or correct ("No, it's Silk") → private admin review queue.
- Copy Care Profile to clipboard.
- Model transparency page: KPIs, dataset growth tracker, fabric distribution, confidence histogram, confusion matrix + per-class P/R/F1.
- Care Guide: per-fabric spec sheets + compare-all matrix.
- Auth: Google, email/password, verification email, password reset, session expiry handling, guest preview only when Firebase unconfigured.

### 2.3 Gaps found in the audit (bugs/missing UI, not market features)

1. **No user-visible Scan History UI.** The backend fully supports it (`GET /api/history`, `PATCH /history/{id}/note`, `DELETE`, `GET /history/export/csv`, `DELETE /history` — all tested) and `UPDATED_PLAN.txt` lists it as a delivered module, but the current `main.tsx` never renders the `history` list. The user cannot browse, search, edit notes, export, or clear their scans. **High-value, low-risk: the API already exists.**
2. **`/api/admin/scans`, `/api/admin/analytics` (days param) exist but the admin UI uses only the basic list** — the daily trend is computed client-side from the first page of scans. Fine for now; note for later.
3. **Admin data loading is all-or-nothing**: entering the admin page fetches overview + feedback + users + scans + audit + health in one parallel batch even when the admin only wants, say, Users. Works, but wasteful and slows the initial paint.
4. **Single 2,870-line component** — every admin tab, all pages, auth, and data constants live in one `App` function. Maintainability risk grows with every feature.
5. `non_fabric` class is severely under-sampled (46 train) → the rejection gate leans on the confidence/margin thresholds more than a real learned negative class.
6. `test/wool` (58) and `test/silk` (43) are thin; macro-F1 0.80 has room to grow.
7. Minor: the `About` page says "SQLite3 Engine" as the database — outdated since Firebase is the production store.

---

## 3. Market research — what "AI laundry assistant" products do

Sources: App Store / Google Play listings (Laundry Symbols Scanner AI, Laundry Master – Care Label, Stain Solver AI, Stain Snap, Fabric Textile Identifier), PrecisionlyAI's AI Fabric Identifier, Cleanomatics (commercial AI laundry platform), TENET AI laundry robot coverage.

| Feature | Competitors have it | LaundryAI today | Gap verdict |
|---|---|---|---|
| Photo-based fabric ID + care advice | Yes (most) | **Yes** (real CNN + gate, stronger than most) | ✅ Our strength |
| Care-label / laundry-symbol scanner (OCR decode) | Yes (3–4 apps) | ❌ (roadmap: future scope) | Big gap, needs new model |
| Stain **detection** (point camera at stain, identify type) | Yes (Stain Solver, Cleanomatics) | ❌ static stain guide only | Big gap, needs new model |
| Stain removal steps per fabric | Yes | **Yes** (6 stains × 5 fabrics) | ✅ parity |
| **Smart wash load planner** (compatible loads, cycle tracking, AI temp/program recs) | Yes (Laundry Master) | Partial (dosing calculator only) | Medium gap — can be done with rule logic, no new model |
| **Digital wardrobe** (save garments + care records + wash history) | Yes (Laundry Master, Fabric Scanner) | ❌ (history not even rendered!) | Medium gap — mostly UI over existing API |
| **Scan history + favorites + search** | Yes | Backend yes, **UI missing** | **Fix now** |
| AI chat assistant ("will my shirt shrink?") | Yes (2 apps) | ❌ | Later — needs LLM key |
| °C / °F temperature toggle | Yes (Laundry Master) | ❌ | Small, later |
| Offline mode | Yes | ❌ (web PWA not set up) | Later |
| Eco/sustainability scoring & tips | Some | **Yes** (eco tips + rationale) | ✅ strength |
| Confidence transparency + refusal of low-confidence images | Rare (most apps always answer) | **Yes** | ✅ differentiator to market |
| Human-in-the-loop model improvement + admin review | Rare in consumer apps | **Yes** (full loop) | ✅ differentiator |
| Multilingual | Yes (60+ locales on one app) | ❌ | Later |

**Takeaway:** LaundryAI's defensible position is *honest, transparent, self-improving fabric intelligence* (confidence gates, active learning, metrics you can audit). We should add the features that make it a daily tool without pretending to do OCR/stain-detection that need separate models. Prioritized additions:

1. **Scan History page** (search, confidence filters, note editing, CSV export, clear) — UI only, API ready.
2. **Care symbol reference** (static, well-designed) in the Care Guide — content only, closes part of the symbol gap honestly.
3. **Wash load helper** (pick items from recent scans → compatible load suggestion with temperature rule) — pure rule logic.
4. **°C/°F toggle** — small.
5. (Later) wardrobe favorites, notifications/reminders, i18n, LLM chat assistant, care-label OCR, stain detection — each needs model work or an LLM key.

---

## 4. UI/UX research — rules we apply

From SaaS dashboard design research (f1studioz, designstudiouiux, orbix, tailadmin, rosalie) and HITL review-queue research (maviklabs, agent-swarm, parseur, ai-tldr, neuralbase):

**Dashboards**
1. **3–5 primary KPIs above the fold; never more than 7.** (Current admin shows 6 KPI cards + 5 health tiles + 3 more panels → overload.)
2. **Progressive disclosure:** overview → zoom/filter → details on demand. The "All scans" browser belongs one click deeper than the pending queue.
3. **5-second rule + F-pattern:** the most critical state (is inference up? what needs my attention?) goes top-left.
4. **Clear CTAs near insights** ("2 pending → Review").
5. **Design every state:** loading, empty, error, offline — no dead panels.
6. Bar charts over pies for small counts; numbers right-aligned, units visible.

**HITL review queues**
1. **One item decidable in < 30 seconds.** Show only what the decision needs: image, model's guess, user's label, what happens next.
2. **Explicit approve / reject** — never passive "next" (prevents automation bias).
3. **Keyboard-first** for batch work (shortcuts + focus management).
4. **Show "why it needs review" and "what happens next"** ("Approved labels enter the training dataset at the next export").
5. **Log every decision** (already done: audit events) and show a compact recent-activity trail for accountability.
6. Double-threshold thinking: our gate already routes low-confidence/non-fabric to explicit handling; the queue itself is the middle band.

---

## 5. Admin console redesign — "only what is necessary"

### 5.1 What is removed (and why)

| Removed | Why |
|---|---|
| Big gradient hero ("Operate the platform" + marketing copy) | Admins don't need a landing hero; wastes the 5-second zone. |
| 6-card stats grid | KPI overload; cut to 4 (below). |
| "Production health" 5-tile panel + readiness % | Redundant with one status line; folded into 3 status pills. |
| Full audit section (8-row panel on overview) | Demoted to a compact 5-row "Recent activity" list — accountability stays, clutter goes. |
| "Reference" tab (runbook cards + links) | It is just 4 links. Becomes 2 small footer links (API health, API docs). |
| 5-item numbered sidebar rail with descriptions | Replaced by a compact 4-tab bar with live count badges. |

### 5.2 What remains (the necessary core)

**Layout:** dark console shell (kept — it visually separates ops from the product), one compact **status bar** + **4 tabs** + quick links footer.

**Status bar (always visible, top):**
- `Inference: online / down` (model_ready) · `API: ok / degraded` (health status) · `Data: Firebase / Local` (persistence backend) · last sync time · **Refresh** button.
- This is the F-pattern top zone: one glance answers "is the platform healthy?".

**Tab 1 — Overview (default):**
- **4 KPI cards only:** Pending reviews (clickable → jumps to Review, with accent when > 0), Total scans, Active users, Dataset samples.
- **Two small panels:** 7-day scan activity (bar strip) + Class balance (dataset, with user-verified counts).
- **Recent admin activity:** last 5 audit events (accountability, compact).

**Tab 2 — Review (the heart of the console):**
- Sub-tabs: **Pending approvals** (default) | **All user scans** (drill-down, per progressive disclosure).
- Pending row = image preview + `user label` vs `model predicted` + filename + date + **Approve** / **Reject** (explicit, confirm on reject) + one-line "what happens next" caption.
- Search (fabric/filename/user) + status filter on the scans sub-tab.
- Empty state: "No feedback is waiting for review."

**Tab 3 — Users (access control — necessary for a multi-user admin product):**
- Search + list with verified/disabled/admin badges.
- **Make admin / Remove admin** (self-protection kept: cannot demote/disable yourself) and **Disable / Enable user**.
- These are the only two user actions the backend supports — no extras invented.

**Tab 4 — Model (release control — necessary to run the active-learning loop):**
- Current deployed metrics (test accuracy, macro-F1, version) + dataset readiness.
- **Dispatch/Start retraining** button (only enabled when backend says training is available) + live running/completed status (auto-refresh while running, as today).
- "Before deployment" checklist (5 steps) — kept because it encodes the no-auto-promotion policy.

**Footer:** `API health ↗` · `API docs ↗` (the former Reference tab, reduced to what is clickable).

### 5.3 Explicitly NOT changed (deployment safety)

- No backend endpoint added/removed/renamed. No changes to `firebase_store.py`, CORS, env vars, `vercel.json`, `Dockerfile`, deploy docs.
- Frontend keeps the `VITE_API_URL` → Render fallback logic, token refresh/retry logic, and the `is_admin` gate (`page === "admin" && user.is_admin`) exactly as-is.
- All data still comes from the same 6 admin endpoints; only the rendering and tab structure change. Rollback = revert one frontend commit.

---

## 6. Phased implementation plan

### Phase 1 — Admin console redesign ✅ (this change)
**Files:** `frontend/src/main.tsx` (admin section only), `frontend/src/style.css` (new admin-topbar styles), `docs/IMPROVEMENT_PLAN.md` (this file).
**What:** §5 exactly — 4 tabs, 4 KPIs, status bar, compact overview, review queue as the hub, footer links.
**Risk:** low (rendering-only). **Verify:** `tsc -b && vite build` passes; all admin endpoints called exactly as before; guest/non-admin users never see the page.

### Phase 2 — User-facing features over the existing API (next)
1. **"My Scans" history page** in the main nav: list with search (fabric/note), confidence filter pills (All / High ≥80 / Moderate 60–79 / Low <60), inline note editor (PATCH), per-item delete, **Export CSV**, **Clear all** (confirm). All endpoints exist and are tested.
2. **Care Symbol Reference** block in the Care Guide: static, standards-based (wash, bleach, dry, iron, dry-clean) with clear iconography — an honest step toward the symbol-scan gap without fake OCR.
3. Small UX fixes: About page "SQLite3" → "Firebase RTDB (cloud) / SQLite (local dev)"; focus-visible states on admin buttons; a11y labels on the new status pills.
**Risk:** low (additive UI, existing endpoints). **Verify:** build + existing API tests unchanged.

### Phase 3 — Optimization & hardening
1. **Lazy per-tab admin loading**: Users fetched only when the Users tab opens; scans only when Review→All scans opens. (Cuts the first admin paint and reduces token-using calls.)
2. **Split `main.tsx`** into `AuthGate`, `AnalyzeWorkspace`, `AdminConsole`, `Library`, `Insights`, `About` components (behavior-identical refactor, same styles).
3. **Backend scale fix (careful, deploy-aware):** `saved_history()` currently loads *all* predictions of *all* users into memory for admin endpoints (`/api/admin/scans`, `/api/admin/analytics`, overview). Add server-side pagination/filtering at the storage layer with the same response shape. Only after API tests are extended.
4. **Dataset balance:** add `non_fabric` negatives (objects, rooms, labels, people) — 46 → 300+; rebalance `silk`/`wool` test sets. Then retrain candidate + compare on the held-out split (existing release-gate flow).
5. **Wash load helper** (rule-based) + **°C/°F toggle** (Phase 2 leftovers if time).
**Risk:** medium (backend change) — gated behind the existing 30 API tests + new ones.

### Phase 4 — Bigger product bets (need models/LLM keys, planned not started)
- Care-label **OCR** symbol decoder · **Stain type detection** model · LLM **care assistant** (key required) · wardrobe with favorites · push notifications/reminders · i18n (start: EN/ES/DE/FR) · PWA offline for care guides.

---

## 7. Risks & rollback

| Risk | Mitigation |
|---|---|
| Admin redesign regression | Frontend-only diff; `vite build` gate; admin still needs verified backend claim or allowlist; rollback = revert commit. |
| Breaking Render/Vercel/Firebase | No env var, CORS, domain, contract, or deploy file touched in Phase 1–2. |
| Admin endpoints 401 after token expiry | Existing refresh-and-retry logic untouched. |
| Feature creep on admin page | §5.1 is the removal list; anything new to admin must replace something of equal weight. |
| Model quality expectations | Confidence gate + "unknown"/"non_fabric" refusal already protects users; dataset balance (Phase 3) targets the weakest class. |

---

## 8. Research sources

**Market / products:** Laundry Symbols Scanner AI (Google Play), Laundry Master – Care Label (App Store), Stain Solver AI (App Store), Stain Snap (App Store), Fabric Textile Identifier (App Store), PrecisionlyAI AI Fabric Identifier, Cleanomatics, TENET AI laundry robot (TrendHunter).
**Dashboard design:** Smart SaaS Dashboard Design Guide (f1studioz, 2026), SaaS Dashboard Design (designstudiouiux), SaaS Dashboard Complete Guide (orbix, 2026), SaaS Dashboard Templates (tailadmin, 2026), Admin Dashboard Best Practices (rosalie24).
**HITL review queues:** Human-in-the-Loop Review Queues (maviklabs, 2026), User feedback loops (theneuralbase), Human-in-the-Loop UX: Designing AI Approvals (ai-tldr), HITL Best Practices (parseur), HITL Practitioner's Guide (agent-swarm).
**Internal:** `docs/17_product_and_model_roadmap.md`, `UPDATED_PLAN.txt`, `docs/15_future_scope.md`, `backend/models/fabric_mobilenetv2.manifest.json`, `backend/tests/test_api.py`.
