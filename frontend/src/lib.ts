// Shared types, environment wiring, token handling, and small helpers used by
// every page. Moved out of main.tsx so pages and admin can stay small files.

import { getApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";

// Vercel and Render are separate deployments. Keep the known production API
// as a safe fallback so a missing Vercel variable cannot silently disable
// backend token verification or administrator access.
const configuredApi = import.meta.env.VITE_API_URL?.trim().replace(/\/$/, "");
export const API = configuredApi || (window.location.hostname.endsWith("vercel.app")
  ? "https://ai-laundry-assistant.onrender.com/api"
  : "/api");

export const NOTE_MAX_LENGTH = 240;
export const AUTH_SESSION_KEY = "laundryai_explicit_auth_session";
const TOKEN_STORAGE_KEY = "laundryai_firebase_token";
// Firebase ID tokens live for one hour. Treat a token as unusable slightly
// before that so a request never leaves with a token that expires mid-flight.
const TOKEN_EXPIRY_SLACK_MS = 60_000;

export type SignedInUser = { uid: string; email: string; name: string; picture?: string | null; guest?: boolean; is_admin?: boolean };
export type FirebaseSettings = { enabled: boolean; firebase_config: Record<string, string> | null };

export type Recommendation = {
  wash: { temperature: string; cycle: string; detergent?: string; spin?: string };
  dry: string;
  iron: string;
  bleach: string;
  explanation: string;
  eco: string[];
};

export type Alternative = { fabric: string; confidence: number };

export type Prediction = {
  id: number | string;
  created_at: string;
  fabric: string;
  confidence: number;
  note: string | null;
  image_token?: string | null;
  persistence_warning?: string | null;
  saved?: boolean;
  user_feedback?: any;
  owner_uid?: string | null;
  alternatives?: Alternative[];
  quality?: { width?: number; height?: number; brightness?: number; texture?: number; warning?: boolean };
  recommendation: Recommendation | null;
  preview: boolean;
  model_decision?: {
    accepted: boolean;
    detected_non_fabric: boolean;
    reason?: string | null;
    top_fabric?: string;
    top_confidence?: number;
    top2_margin?: number;
    thresholds?: { min_confidence?: number; min_margin?: number };
  };
};

export type AdminFeedbackItem = {
  id?: string;
  fabric: string;
  file: string;
  filename?: string;
  original_fabric?: string;
  created_at?: string;
};

export type AdminUser = {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
  email_verified: boolean;
  disabled: boolean;
  is_admin: boolean;
  providers: string[];
  created_at?: number;
  last_sign_in_at?: number;
};

export type AdminAuditEntry = {
  id?: string;
  action?: string;
  actor?: string;
  created_at?: string | number;
  detail?: string;
};

export type AdminHealth = { status?: string; model_ready?: boolean; [key: string]: unknown };

export type Analytics = {
  garments_analyzed: number;
  average_confidence: number | null;
  most_detected_fabric: string | null;
  eco_recommendations: number;
  distribution?: Record<string, number>;
};

export type DatasetStats = {
  total_samples: number;
  user_contributed: number;
  classes: Record<string, { total: number; user_verified: number }>;
};

export type ImageAssessment = {
  width: number;
  height: number;
  resolutionStatus: "Optimal" | "Low";
  brightness: number;
  brightnessStatus: "Optimal" | "Too Dark" | "Too Bright";
  isReady: boolean;
};

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  return withTimeout(fetch(input, init), timeoutMs, "The authentication service timed out.");
}

export function tokenExpiry(token: string): number {
  try {
    const payload = token.split(".")[1];
    if (!payload) return 0;
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof claims?.exp === "number" ? claims.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function writeStoredToken(token: string) {
  const stored = { token, expires_at: tokenExpiry(token) };
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Private browsing can refuse storage; the in-memory Firebase session still works.
  }
}

function readStoredToken(): string | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  const usableAfter = Date.now() + TOKEN_EXPIRY_SLACK_MS;
  try {
    const stored = JSON.parse(raw) as { token?: string; expires_at?: number };
    return stored?.token && (stored.expires_at || 0) > usableAfter ? stored.token : null;
  } catch {
    // A token stored by an earlier build was written as a bare string.
    return tokenExpiry(raw) > usableAfter ? raw : null;
  }
}

export function clearStoredToken() {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

// The stored token is only a fallback: whenever the SDK still holds the
// signed-in user we ask it for a current token, so the app never calls the API
// with a token that is missing, stale, or already expired.
export async function currentIdToken(forceRefresh = false): Promise<string | null> {
  const firebaseUser = getApps().length ? getAuth(getApp()).currentUser : null;
  if (firebaseUser) {
    try {
      const token = await withTimeout(firebaseUser.getIdToken(forceRefresh), 8_000, "Firebase token retrieval timed out.");
      writeStoredToken(token);
      return token;
    } catch (error) {
      console.warn("Firebase token retrieval:", error);
    }
  }
  return forceRefresh ? null : readStoredToken();
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await currentIdToken();
  const send = (value: string | null) => {
    const headers = new Headers(init.headers);
    if (value) headers.set("Authorization", `Bearer ${value}`);
    return fetch(input, { ...init, headers });
  };
  const response = await send(token);
  if (response.status === 401 && retry) {
    // The session may have expired mid-use: force one refresh, then retry once.
    const refreshed = await currentIdToken(true).catch(() => null);
    if (refreshed && refreshed !== token) return send(refreshed);
  }
  return response;
}

export function triggerAuthSession() {
  try { sessionStorage.setItem(AUTH_SESSION_KEY, "1"); } catch { /* ignore */ }
}

export function clearAuthSession() {
  try { sessionStorage.removeItem(AUTH_SESSION_KEY); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Display settings (temperature unit, language) — persisted locally, no API.
// ---------------------------------------------------------------------------

export type TempUnit = "C" | "F";
const TEMP_UNIT_KEY = "laundryai_temp_unit";
const LANG_KEY = "laundryai_lang";

export function readTempUnit(): TempUnit {
  try {
    return localStorage.getItem(TEMP_UNIT_KEY) === "F" ? "F" : "C";
  } catch { return "C"; }
}
export function writeTempUnit(unit: TempUnit) {
  try { localStorage.setItem(TEMP_UNIT_KEY, unit); } catch { /* ignore */ }
}

export function readLang(): string {
  try { return localStorage.getItem(LANG_KEY) || "en"; } catch { return "en"; }
}
export function writeLang(lang: string) {
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
}

/**
 * Display-level °C → °F conversion for care text. The knowledge base stores
 * temperatures as human strings ("30°C", "Cold (30°C max)"); converting the
 * leading celsius number keeps every sentence intact. Unknown formats pass
 * through unchanged, so the care label (not this display) stays authoritative.
 */
export function convertTempText(text: string, unit: TempUnit): string {
  if (unit === "C" || !text) return text;
  return text.replace(/(-?\d+(?:\.\d+)?)\s*°C/g, (_match, value: string) => {
    const celsius = Number(value);
    if (Number.isNaN(celsius)) return _match;
    return `${Math.round((celsius * 9) / 5 + 32)}°F`;
  });
}
