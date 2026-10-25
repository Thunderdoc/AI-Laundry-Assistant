# Supabase fallback plan (pre-authorized, do NOT deploy until triggered)

## Code prep DONE (2026-10-25 evening, local only, NOT pushed, NOT wired)
- `backend/app/supabase_store.py`: full data + image-storage seam
  (predictions, feedback, audit — same record shapes as the RTDB rows),
  stdlib-only, tested by `backend/tests/test_supabase_store.py`
  (5 tests, fake PostgREST + Storage; full suite 59/59 green).
- `main.py` and `firebase_store.py` UNTOUCHED — live behavior is 100%
  Firebase, zero risk from this prep. Wiring + Supabase Auth swap happen
  only at trigger, when a real project exists to verify against.
- Schema ready: `backend/supabase_schema.sql` (3 tables, RLS on with no
  public policies, private bucket note) — run once in the new project's
  SQL editor at setup time.
- Lesson from this prep: never set PERSISTENCE_BACKEND at test-module
  import — pytest imports all test files up front and it silently
  disables firebase_store for the whole process (broke test_18 once;
  fixed with per-test patch.dict).

Owner order (2026-10-25 ~19:31 IST): do whatever it takes, even from scratch.
Outcome criteria (non-negotiable): sahi prediction + photo saved in cloud and
visible back in history. Work is not done until both are true.
Free-only rule: Supabase free tier only, no billing, no paid route.

## Trigger (any one)
- Firebase Storage enabled in console, but `/api/health` still shows
  `storage_fallback_reachable: false` / `storage_bucket_unavailable`.
- Firebase free limit hit, or console demands billing/upgrade.

## Owner's single step (free)
- Create a NEW free Supabase project (the old Supabase URL in env is dead —
  do not try to revive it) and share its URL + anon/service keys via the
  secure flow. Everything else is Muse's work.

## Code seam (verified 2026-10-25)
- All persistence goes through `backend/app/firebase_store.py`
  (`enabled()`, `configured()`, `status()`, `list_predictions()`,
  `service_account_credential()`, audit events). `main.py` only calls this
  seam plus `firebase_admin` for auth/admin.
- Storage upload already has a firebase → supabase failover path (commit
  128d042); the Supabase leg needs a live project + bucket, not new logic.

## Switch steps
1. New `backend/app/supabase_store.py` implementing the same seam
   (predictions, feedback, audit, storage upload, status) against Postgres
   + Supabase Storage + Supabase Auth token verification.
2. `main.py`: persistence backend selectable by env (Supabase when its keys
   are present and valid, Firebase otherwise); auth middleware verifies
   Supabase JWTs; admin check maps to the Supabase admin flag/allowlist.
3. `frontend/src/main.tsx` + `lib.ts`: sign-in via Supabase Auth (Google +
   email/password) instead of Firebase Auth; keep the device-local fallback
   and `X-Anonymous-Id` guest history untouched.
4. Data: migrate RTDB predictions to Postgres (scripted export/import, no
   hand-copying); photos re-uploaded from device-local copies where present,
   otherwise re-scanned. Model file, inference, gates, thresholds: UNTOUCHED
   — this switch changes storage/auth only, never accuracy code.
5. Env on Render: replace dead Supabase URL/keys with the new project's;
   remove nothing else. No new paid service anywhere.

## Verification before calling it done
- `/api/health`: Supabase reachable, storage reachable, model ready.
- Live scan (owner's phone, final check): prediction correct AND photo
  visible in history on a second session/device.
- Old Firebase data readable or explicitly migrated — no silent loss.
- Backend tests green + frontend build green, then ONE batched push.
