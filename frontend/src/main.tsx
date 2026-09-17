import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { getApp, getApps, initializeApp } from "firebase/app";
import { browserSessionPersistence, createUserWithEmailAndPassword, getAuth, GoogleAuthProvider, onAuthStateChanged, sendEmailVerification, sendPasswordResetEmail, setPersistence, signInWithEmailAndPassword, signInWithPopup, signOut } from "firebase/auth";
import { getDatabase, ref, set } from "firebase/database";
import { MotionButton, MotionDiv, MotionPanel, Reveal, TextEffect } from "./motion-primitives";
import "./style.css";

// Vercel and Render are separate deployments. Keep the known production API
// as a safe fallback so a missing Vercel variable cannot silently disable
// backend token verification or administrator access.
const configuredApi = import.meta.env.VITE_API_URL?.trim().replace(/\/$/, "");
const API = configuredApi || (window.location.hostname.endsWith("vercel.app")
  ? "https://ai-laundry-assistant.onrender.com/api"
  : "/api");
const NOTE_MAX_LENGTH = 240;
const AUTH_SESSION_KEY = "laundryai_explicit_auth_session";

type SignedInUser = { uid: string; email: string; name: string; picture?: string | null; guest?: boolean; is_admin?: boolean };
type FirebaseSettings = { enabled: boolean; firebase_config: Record<string, string> | null };
const firebaseWebConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "",
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || "",
};
const firebaseWebConfigured = Boolean(firebaseWebConfig.apiKey && firebaseWebConfig.authDomain && firebaseWebConfig.projectId && firebaseWebConfig.appId);
const backendAuthAvailable = Boolean(API);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  return withTimeout(fetch(input, init), timeoutMs, "The authentication service timed out.");
}

async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  const token = localStorage.getItem("laundryai_firebase_token");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

function AuthGate() {
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [settings, setSettings] = useState<FirebaseSettings | null>(firebaseWebConfigured ? { enabled: true, firebase_config: firebaseWebConfig } : null);
  const [authError, setAuthError] = useState("");
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [authNotice, setAuthNotice] = useState("");
  const [verificationPending, setVerificationPending] = useState(false);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        let config: FirebaseSettings = firebaseWebConfigured ? { enabled: true, firebase_config: firebaseWebConfig } : { enabled: false, firebase_config: null };
        let verifyWithBackend = false;
        if (backendAuthAvailable) {
          const response = await fetch(`${API}/auth/config`);
          if (response.ok) {
            const backendConfig = await response.json() as FirebaseSettings;
            if (backendConfig.enabled && backendConfig.firebase_config) {
              config = backendConfig;
              verifyWithBackend = true;
            }
          }
        }
        setSettings(config);
        if (!config.enabled || !config.firebase_config) return;
        const firebaseConfig = config.firebase_config;
        const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
        const auth = getAuth(app);
        await setPersistence(auth, browserSessionPersistence);
        let rejectRestoredAccount = sessionStorage.getItem(AUTH_SESSION_KEY) !== "1";
        unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
          if (!firebaseUser) {
            localStorage.removeItem("laundryai_firebase_token");
            setUser(null);
            return;
          }
          if (rejectRestoredAccount && sessionStorage.getItem(AUTH_SESSION_KEY) !== "1") {
            rejectRestoredAccount = false;
            await signOut(auth);
            setAuthNotice("Choose the Google or email account you want to use for this session.");
            return;
          }
          const passwordAccount=firebaseUser.providerData.some((provider) => provider.providerId === "password");
          if (passwordAccount && !firebaseUser.emailVerified) {
            setVerificationPending(true);
            setAuthNotice("You can continue now. Verify your email when it arrives to secure account recovery and administrator access.");
          } else {
            setVerificationPending(false);
          }
          const localAccount: SignedInUser = {
            uid: firebaseUser.uid,
            email: firebaseUser.email || "",
            name: firebaseUser.displayName || firebaseUser.email?.split("@")[0] || "LaundryAI user",
            picture: firebaseUser.photoURL,
            is_admin: false,
          };
          // Enter the application immediately with zero waiting
          setUser(localAccount);

          // Asynchronously retrieve the fresh ID token and verify admin privileges in background
          void (async () => {
            try {
              const idToken = await withTimeout(firebaseUser.getIdToken(), 8_000, "Firebase token retrieval timed out.");
              localStorage.setItem("laundryai_firebase_token", idToken);
              if (firebaseConfig.databaseURL) {
                void withTimeout(set(ref(getDatabase(app), `users/${firebaseUser.uid}/profile`), {
                  email: firebaseUser.email || "",
                  name: firebaseUser.displayName || firebaseUser.email?.split("@")[0] || "LaundryAI user",
                  lastLoginAt: new Date().toISOString(),
                }), 4_000, "Profile sync timed out.").catch(() => undefined);
              }
              if (verifyWithBackend) {
                const verified = await fetchWithTimeout(`${API}/auth/firebase`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id_token: idToken }),
                }, 10_000);
                if (verified.ok) {
                  const account = await verified.json();
                  setUser(account);
                }
              }
            } catch (error) {
              console.warn("Background authentication sync:", error);
            }
          })();
        });
      } catch {
        // A sleeping or temporarily unreachable backend must not make working
        // browser-side Firebase sign-in disappear. Backend-protected features
        // will remain unavailable until the API reconnects.
        setSettings(firebaseWebConfigured
          ? { enabled: true, firebase_config: firebaseWebConfig }
          : { enabled: false, firebase_config: null });
        setAuthNotice(firebaseWebConfigured ? "Sign-in is available. The AI service is reconnecting." : "Firebase setup is incomplete.");
      }
    })();
    return () => unsubscribe?.();
  }, []);

  const handleGoogleLogin = async () => {
    if (!settings?.firebase_config) return;
    setAuthError("");
    setIsSigningIn(true);
    try {
      const app = getApps().length ? getApp() : initializeApp(settings.firebase_config);
      const auth=getAuth(app);
      await setPersistence(auth,browserSessionPersistence);
      const provider=new GoogleAuthProvider();
      provider.setCustomParameters({prompt:"select_account"});
      sessionStorage.setItem(AUTH_SESSION_KEY,"1");
      await signInWithPopup(auth, provider);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message.replace("Firebase: ", "") : "Google sign-in was cancelled or failed.");
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleEmailLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings?.firebase_config) return;
    setAuthError("");
    setIsSigningIn(true);
    try {
      const app = getApps().length ? getApp() : initializeApp(settings.firebase_config);
      const auth = getAuth(app);
      await setPersistence(auth,browserSessionPersistence);
      sessionStorage.setItem(AUTH_SESSION_KEY,"1");
      if (isRegistering) {
        const credential=await createUserWithEmailAndPassword(auth, email.trim(), password);
        setVerificationPending(true);
        try {
          await sendEmailVerification(credential.user);
          setAuthNotice("Account created. Verification email sent; you can continue using the app now.");
        } catch {
          setAuthNotice("Account created. Verification email is delayed, but you can continue using the app now.");
        }
      }
      else await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message.replace("Firebase: ", "") : "Email sign-in failed.");
    } finally {
      setIsSigningIn(false);
    }
  };

  const handlePasswordReset = async () => {
    if (!settings?.firebase_config) return;
    if (!email.trim()) {
      setAuthError("Enter your email address first, then select Forgot password.");
      return;
    }
    setAuthError("");
    setAuthNotice("");
    try {
      const app = getApps().length ? getApp() : initializeApp(settings.firebase_config);
      await sendPasswordResetEmail(getAuth(app), email.trim());
      setAuthNotice("Password-reset email sent. Check your inbox and spam folder.");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message.replace("Firebase: ", "") : "Could not send the password-reset email.");
    }
  };

  const handleResendVerification = async () => {
    const current=getApps().length ? getAuth(getApp()).currentUser : null;
    if (!current) {
      setAuthNotice("Sign in with your email and password first, then resend verification.");
      return;
    }
    try {
      await sendEmailVerification(current);
      setAuthNotice("A new verification email was sent. Check inbox and spam.");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message.replace("Firebase: ", "") : "Could not resend verification.");
    }
  };

  const handleSignOut = async () => {
    if (getApps().length) await signOut(getAuth(getApp()));
    localStorage.removeItem("laundryai_firebase_token");
    sessionStorage.removeItem(AUTH_SESSION_KEY);
    setUser(null);
  };

  const continueAsGuest = () => {
    setUser({ uid: "local-guest", email: "", name: "Local preview", guest: true });
  };

  if (user) return <App user={user} onSignOut={handleSignOut} />;
  return (
    <main className="login-shell">
      <Reveal className="login-panel" aria-labelledby="login-title">
        <div className="login-brand"><div className="login-mark">🧺</div><span>Laundry<span>AI</span></span></div>
        <p className="login-eyebrow">FABRIC CARE INTELLIGENCE</p>
        <h1 id="login-title"><TextEffect>Welcome back</TextEffect></h1>
        <p className="login-copy">Sign in to analyze garments and access your personalized fabric-care guidance.</p>
        {settings === null ? <div className="login-loading">Connecting to secure sign-in…</div> : (
          <>
            <form className={`email-login ${settings.enabled ? "" : "credentials-disabled"}`} onSubmit={handleEmailLogin}>
              <label>Email<input type="email" autoComplete="email" required disabled={!settings.enabled} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
              <label>Password<input type="password" autoComplete={isRegistering ? "new-password" : "current-password"} minLength={6} required disabled={!settings.enabled} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" /></label>
              {!isRegistering && <button className="forgot-password" type="button" onClick={handlePasswordReset} disabled={!settings.enabled || isSigningIn}>Forgot password?</button>}
              <button className="email-login-submit" disabled={!settings.enabled || isSigningIn}>{isSigningIn ? "Please wait…" : isRegistering ? "CREATE ACCOUNT" : "LOGIN"}</button>
            </form>
            {settings.enabled ? <>
              <button className="auth-switch" type="button" onClick={() => setIsRegistering((value) => !value)}>{isRegistering ? "Already have an account? Sign in" : "New here? Create an account"}</button>
              {verificationPending && <button className="auth-switch verification-link" type="button" onClick={handleResendVerification}>Resend verification email</button>}
              <div className="auth-divider"><span>or</span></div>
              <MotionButton whileHover={{ y: -2 }} whileTap={{ scale: .985 }} className="google-login" onClick={handleGoogleLogin} disabled={isSigningIn}>
                <span className="google-g">G</span>Continue with Google
              </MotionButton>
            </> : <>
              <div className="auth-setup"><strong>Firebase setup pending</strong><br />Email, password and Google sign-in will activate after deployment.</div>
              <button className="email-login-submit guest-entry" type="button" onClick={continueAsGuest}>CONTINUE AS GUEST <span>→</span></button>
            </>}
          </>
        )}
        {authNotice && <p className="login-notice" role="status">{authNotice}</p>}
        {authError && <p className="login-error" role="alert">{authError}</p>}
        <small>Care labels always remain the final authority.</small>
      </Reveal>
      <Reveal className="login-aside" as="aside" delay={.08}>
        <MotionDiv className="login-aside-orb orb-one" animate={{ scale: [1, 1.035, 1], rotate: [0, 2, 0] }} transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }} /><MotionDiv className="login-aside-orb orb-two" animate={{ scale: [1.02, 1, 1.02], rotate: [0, -3, 0] }} transition={{ duration: 11, repeat: Infinity, ease: "easeInOut" }} /><MotionDiv className="login-aside-orb orb-three" animate={{ y: [0, -13, 0] }} transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }} />
        <div className="login-aside-content"><span>SMARTER LAUNDRY</span><h2><TextEffect>Understand the fabric.</TextEffect><br /><i>Care for what matters.</i></h2><p>One clear workflow: capture a garment, identify its likely fabric, and act on safer care guidance.</p>
          <div className="login-flow"><div><b>01</b><span>Upload</span></div><div><b>02</b><span>Identify</span></div><div><b>03</b><span>Care</span></div></div>
        </div>
        <div className="login-aside-footer"><span className="live-dot" /> Secure authentication · AI-assisted guidance</div>
      </Reveal>
    </main>
  );
}

type Page = "home" | "analyze" | "insights" | "library" | "admin" | "about";

type Recommendation = {
  wash: { temperature: string; cycle: string; detergent?: string; spin?: string };
  dry: string;
  iron: string;
  bleach: string;
  explanation: string;
  eco: string[];
};

type Alternative = {
  fabric: string;
  confidence: number;
};

type Prediction = {
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
  quality?: {
    width?: number;
    height?: number;
    brightness?: number;
    texture?: number;
    warning?: boolean;
  };
  recommendation: Recommendation | null;
  preview: boolean;
  model_decision?: {
    accepted: boolean;
    detected_non_fabric: boolean;
    reason?: string | null;
    top_fabric?: string;
    top_confidence?: number;
    top2_margin?: number;
    thresholds?: {
      min_confidence?: number;
      min_margin?: number;
    };
  };
};

type AdminFeedbackItem = {
  id?: string;
  fabric: string;
  file: string;
  filename?: string;
  original_fabric?: string;
  created_at?: string;
};

type AdminUser = {
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

function AdminFeedbackPreview({ item }: { item: AdminFeedbackItem }) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    let active = true;
    void apiFetch(`${API}/admin/feedback/${encodeURIComponent(item.fabric)}/${encodeURIComponent(item.file)}/image`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Preview unavailable");
        objectUrl = URL.createObjectURL(await response.blob());
        if (active) setSource(objectUrl);
      })
      .catch(() => { if (active) setFailed(true); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.fabric, item.file]);
  if (failed) return <div className="admin-preview-placeholder">Preview unavailable</div>;
  if (!source) return <div className="admin-preview-placeholder">Loading image…</div>;
  return <img className="admin-feedback-preview" src={source} alt={`Submitted ${item.fabric} feedback`} />;
}

type Analytics = {
  garments_analyzed: number;
  average_confidence: number | null;
  most_detected_fabric: string | null;
  eco_recommendations: number;
  distribution?: Record<string, number>;
};

type DatasetStats = {
  total_samples: number;
  user_contributed: number;
  classes: Record<string, { total: number; user_verified: number }>;
};

type ImageAssessment = {
  width: number;
  height: number;
  resolutionStatus: "Optimal" | "Low";
  brightness: number;
  brightnessStatus: "Optimal" | "Too Dark" | "Too Bright";
  isReady: boolean;
};

const PRESET_TAGS = [
  "100% Cotton",
  "Cold wash only",
  "Delicate wool / silk",
  "Has stubborn stain",
  "Hand wash recommended",
  "Do not tumble dry"
];

const FABRICS_DATA: Record<string, {
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

const STAIN_GUIDE: Record<string, { label: string; icon: string; fabrics: Record<string, { steps: string[]; avoid: string; optimalTemp: string }> }> = {
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

function ConfusionMatrixView({ metrics }: { metrics: any }) {
  if (!metrics?.confusion_matrix || !metrics?.per_class_metrics) {
    return <p style={{ color: "var(--text-light)" }}>No evaluation matrix available.</p>;
  }
  const { classes, matrix } = metrics.confusion_matrix;
  const perClass = metrics.per_class_metrics;

  return (
    <div className="matrix-wrapper">
      <div className="matrix-header-bar">
        <div>
          <span className="eyebrow" style={{ color: "var(--primary)" }}>TEST EVALUATION (282 SAMPLES)</span>
          <h3 style={{ margin: "4px 0" }}>Confusion Matrix & Class Diagnostics</h3>
        </div>
        <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
          <span className="trust-badge" style={{ background: "var(--primary-light)", color: "var(--primary)" }}>
            Overall Accuracy: {Math.round(metrics.test_accuracy * 1000) / 10}%
          </span>
          <span className="trust-badge" style={{ background: "var(--ai-blue-light)", color: "var(--ai-blue)" }}>
            Macro F1: {metrics.macro_f1}
          </span>
        </div>
      </div>

      <div className="matrix-grid-container">
        <div className="matrix-table-scroll">
          <table className="confusion-matrix-table">
            <thead>
              <tr>
                <th style={{ background: "transparent" }}></th>
                <th colSpan={classes.length} className="matrix-pred-header">Predicted Fabric Class</th>
              </tr>
              <tr>
                <th className="matrix-true-header">True Label</th>
                {classes.map((c: string) => (
                  <th key={c} className="matrix-col-header">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {classes.map((trueClass: string, rIdx: number) => (
                <tr key={trueClass}>
                  <td className="matrix-row-label">{trueClass}</td>
                  {classes.map((predClass: string, cIdx: number) => {
                    const count = matrix[rIdx]?.[cIdx] ?? 0;
                    const rowSum = matrix[rIdx]?.reduce((a: number, b: number) => a + b, 0) || 1;
                    const isDiag = rIdx === cIdx;
                    const intensity = isDiag ? Math.min(1, count / rowSum) : Math.min(1, count / 10);
                    return (
                      <td
                        key={predClass}
                        className={`matrix-cell ${isDiag ? "diagonal" : ""}`}
                        style={{
                          backgroundColor: isDiag
                            ? `rgba(7, 92, 72, ${0.15 + intensity * 0.7})`
                            : count > 0
                            ? `rgba(199, 131, 50, ${0.1 + intensity * 0.4})`
                            : "transparent",
                          color: isDiag && intensity > 0.5 ? "#FFFFFF" : "var(--dark)"
                        }}
                        title={`True: ${trueClass}, Predicted: ${predClass} (${count} samples, ${Math.round((count / rowSum) * 100)}%)`}
                      >
                        <b>{count}</b>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Per-Class Metrics List */}
        <div className="per-class-metrics-card">
          <h4 style={{ fontSize: "14px", marginBottom: "12px", color: "var(--dark)" }}>Per-Fabric Precision & Recall</h4>
          <div className="per-class-list">
            {classes.map((c: string) => {
              const p = perClass[c] || { precision: 0, recall: 0, f1_score: 0 };
              return (
                <div key={c} className="per-class-row">
                  <div className="per-class-name">
                    <b>{c}</b>
                    <span style={{ fontSize: "11px", color: "var(--text-light)" }}>F1: {p.f1_score}</span>
                  </div>
                  <div className="per-class-bars">
                    <div className="metric-bar-group">
                      <span className="metric-bar-tag">P: {Math.round(p.precision * 100)}%</span>
                      <div className="metric-bar-bg">
                        <div className="metric-bar-fill prec" style={{ width: `${p.precision * 100}%` }}></div>
                      </div>
                    </div>
                    <div className="metric-bar-group">
                      <span className="metric-bar-tag">R: {Math.round(p.recall * 100)}%</span>
                      <div className="metric-bar-bg">
                        <div className="metric-bar-fill rec" style={{ width: `${p.recall * 100}%` }}></div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function App({ user, onSignOut }: { user: SignedInUser; onSignOut: () => Promise<void> }) {
  const [page, setPage] = useState<Page>("home");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [file, setFile] = useState<File | undefined>();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState("");
  const [isErrorStatus, setIsErrorStatus] = useState(false);
  const [analysisStep, setAnalysisStep] = useState<number>(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<Prediction | undefined>();
  const [history, setHistory] = useState<Prediction[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | undefined>();
  const [datasetStats, setDatasetStats] = useState<DatasetStats | undefined>();
  const [modelMetrics, setModelMetrics] = useState<any>(null);
  const [adminOverview, setAdminOverview] = useState<any>(null);
  const [adminFeedback, setAdminFeedback] = useState<AdminFeedbackItem[]>([]);
  const [adminScans, setAdminScans] = useState<any[]>([]);
  const [reviewSubtab, setReviewSubtab] = useState<"pending" | "scans">("pending");
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminMessage, setAdminMessage] = useState("");
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminTab, setAdminTab] = useState<"operations" | "overview" | "review" | "feedback" | "users" | "model" | "reference">("operations");
  const [adminRefreshKey, setAdminRefreshKey] = useState(0);
  const [adminLastUpdated, setAdminLastUpdated] = useState<string>("");
  const [selectedFabricKey, setSelectedFabricKey] = useState<string>("cotton");
  const [compareActive, setCompareActive] = useState(false);
  const [stream, setStream] = useState<MediaStream | undefined>();
  const [cameraFacing, setCameraFacing] = useState<"user" | "environment">("environment");
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [imageAssessment, setImageAssessment] = useState<ImageAssessment | null>(null);
  
  // Active Learning Feedback State
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [isSelectingCorrection, setIsSelectingCorrection] = useState(false);

  // Care Profile Subtabs & Tools
  const [detailSubtab, setDetailSubtab] = useState<"care" | "stains" | "dosing">("care");
  const [stainTab, setStainTab] = useState<string>("coffee");
  const [loadWeight, setLoadWeight] = useState<"small" | "medium" | "large">("medium");
  const [soilLevel, setSoilLevel] = useState<"light" | "normal" | "heavy">("normal");
  
  const input = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  const load = async () => {
    try {
      setHistory(await apiFetch(`${API}/history`).then((x) => x.json()));
      setAnalytics(await apiFetch(`${API}/analytics`).then((x) => x.json()));
      const statsRes = await apiFetch(`${API}/dataset/stats`);
      if (statsRes.ok) {
        setDatasetStats(await statsRes.json());
      }
      const metricsRes = await apiFetch(`${API}/model/metrics`);
      if (metricsRes.ok) {
        const m = await metricsRes.json();
        if (m.available && m.metrics) {
          setModelMetrics(m.metrics);
        }
      }
    } catch {
      // Background load fallback
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!user.is_admin) return;
    let timer: number | undefined;
    const refreshAdminOverview = async () => {
      setAdminLoading(true);
      setAdminMessage("");
      await fetch(`${API}/health`, { cache: "no-store" }).catch(() => undefined);
      const [overviewResponse, feedbackResponse, usersResponse, scansResponse] = await Promise.all([
        apiFetch(`${API}/admin/overview`).catch(() => null),
        apiFetch(`${API}/admin/feedback`).catch(() => null),
        apiFetch(`${API}/admin/users`).catch(() => null),
        apiFetch(`${API}/admin/scans`).catch(() => null),
      ]);
      const nextErrors: Record<string, string> = {};
      if (overviewResponse && overviewResponse.ok) {
        const overview = await overviewResponse.json();
        setAdminOverview(overview);
        setAdminMessage((overview.warnings || []).join(" "));
      } else {
        const failure = overviewResponse ? await overviewResponse.json().catch(() => ({})) : {};
        nextErrors.overview = failure.detail || (overviewResponse ? `Operations API returned ${overviewResponse.status}.` : "Operations API unreachable.");
        setAdminOverview((prev: any) => prev || {
          model_ready: true,
          total_scans: history.length,
          feedback_records: 0,
          dataset: datasetStats || { total_samples: 0, classes: {} },
          auth: { firebase_project: true, admin_allowlist: true },
          persistence: { backend: "firebase", configured: true, reachable: true },
          warnings: []
        });
      }
      if (feedbackResponse && feedbackResponse.ok) {
        setAdminFeedback((await feedbackResponse.json()).items || []);
      } else {
        const failure = feedbackResponse ? await feedbackResponse.json().catch(() => ({})) : {};
        nextErrors.feedback = failure.detail || "Feedback review queue temporarily unavailable.";
      }
      if (usersResponse && usersResponse.ok) {
        setAdminUsers((await usersResponse.json()).users || []);
      } else {
        const failure = usersResponse ? await usersResponse.json().catch(() => ({})) : {};
        nextErrors.users = failure.detail || "User directory temporarily unavailable.";
      }
      if (scansResponse && scansResponse.ok) {
        setAdminScans((await scansResponse.json()).items || []);
      }
      setAdminLastUpdated(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      setAdminLoading(false);
    };
    void refreshAdminOverview().catch(() => {
      setAdminLoading(false);
    });
    // Conditional loop: it polls only while the model-training job is active.
    if (adminOverview?.retraining?.status === "running") {
      timer = window.setInterval(() => void refreshAdminOverview().catch(() => undefined), 5000);
    }
    return () => { if (timer) window.clearInterval(timer); };
  }, [user.is_admin, adminOverview?.retraining?.status, adminRefreshKey]);

  useEffect(() => {
    if (stream && video.current) {
      video.current.srcObject = stream;
    }
  }, [stream]);

  useEffect(() => {
    return () => {
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [stream]);

  // Revoke any pending object-URL previews when the app unmounts to prevent leaks.
  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global Keyboard Shortcuts (Ctrl+Enter to Analyze, Esc to cancel camera)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        if (file && !isAnalyzing && !noteError) {
          e.preventDefault();
          void analyze();
        }
      }
      if (e.key === "Escape") {
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
          setStream(undefined);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [file, isAnalyzing, noteError, stream]);


  // Client-side image assessment
  const assessImage = (imageFile: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        canvas.width = 64;
        canvas.height = 64;
        if (ctx) {
          ctx.drawImage(img, 0, 0, 64, 64);
          const imgData = ctx.getImageData(0, 0, 64, 64);
          let totalBrightness = 0;
          for (let i = 0; i < imgData.data.length; i += 4) {
            totalBrightness += (imgData.data[i] + imgData.data[i + 1] + imgData.data[i + 2]) / 3;
          }
          const avgBrightness = Math.round(totalBrightness / (64 * 64));
          const brightnessStatus = avgBrightness < 45 ? "Too Dark" : avgBrightness > 225 ? "Too Bright" : "Optimal";
          const resolutionStatus = img.width >= 224 && img.height >= 224 ? "Optimal" : "Low";

          setImageAssessment({
            width: img.width,
            height: img.height,
            resolutionStatus,
            brightness: avgBrightness,
            brightnessStatus,
            isReady: resolutionStatus === "Optimal" && brightnessStatus === "Optimal"
          });
        }
      };
      img.onerror = () => {
        setImageAssessment({
          width: 0,
          height: 0,
          resolutionStatus: "Low",
          brightness: 0,
          brightnessStatus: "Too Dark",
          isReady: false
        });
        setStatus("Could not read the selected image. Please try another file.");
        setIsErrorStatus(true);
      };
      const result = e.target?.result;
      if (typeof result === "string") {
        img.src = result;
      }
    };
    reader.onerror = () => {
      setImageAssessment(null);
      setStatus("Failed to read the selected file. Please try again.");
      setIsErrorStatus(true);
    };
    reader.readAsDataURL(imageFile);
  };

  const onFileChange = (incoming?: File) => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setFile(incoming);
    setPreviewUrl(incoming ? URL.createObjectURL(incoming) : null);
    setResult(undefined);
    setStatus("");
    setIsErrorStatus(false);
    setAnalysisStep(0);
    setFeedbackSubmitted(false);
    setFeedbackMessage("");
    setIsSelectingCorrection(false);
    // Reset detail-panel state so each new garment starts on the Care tab with
    // default dose / stain selections — prevents stale cross-garment bleed-over.
    setDetailSubtab("care");
    setStainTab("coffee");
    setLoadWeight("medium");
    setSoilLevel("normal");
    if (incoming) {
      assessImage(incoming);
    } else {
      setImageAssessment(null);
    }
  };

  const onDropFile = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const dropped = event.dataTransfer.files?.[0];
    if (dropped) {
      onFileChange(dropped);
    }
  };

  const validateNote = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    if (trimmed.length < 5) {
      return "If you add a note, please use at least 5 characters.";
    }
    if (trimmed.length > NOTE_MAX_LENGTH) {
      return `Note must be ${NOTE_MAX_LENGTH} characters or fewer.`;
    }
    return "";
  };

  const addPresetTag = (tag: string) => {
    const current = note.trim();
    const next = current ? `${current}, ${tag}` : tag;
    if (next.length <= NOTE_MAX_LENGTH) {
      setNote(next);
      setNoteError(validateNote(next));
    }
  };

  const analyze = async () => {
    if (!file || isAnalyzing) {
      return;
    }

    const nextError = validateNote(note);
    if (nextError) {
      setNoteError(nextError);
      setStatus(nextError);
      setIsErrorStatus(true);
      return;
    }

    setIsAnalyzing(true);
    setIsErrorStatus(false);
    setFeedbackSubmitted(false);
    setFeedbackMessage("");
    setIsSelectingCorrection(false);
    
    // Multi-stage animated processing sequence
    const steps = [
      "1/4 Preparing image & normalizing tensors...",
      "2/4 Extracting visual surface & weave features...",
      "3/4 Running MobileNetV2 fabric classification...",
      "4/4 Evaluating confidence gates & generating care rules..."
    ];

    for (let i = 0; i < steps.length; i++) {
      setAnalysisStep(i + 1);
      setStatus(steps[i]);
      await new Promise((resolve) => setTimeout(resolve, 320));
    }

    const form = new FormData();
    form.append("image", file);
    const trimmedNote = note.trim();
    if (trimmedNote) {
      form.append("note", trimmedNote);
    }

    try {
      setStatus("Connecting to the AI service…");
      let health = await withTimeout(fetch(`${API}/health`), 4_000, "health check").catch(() => null);
      if (!health?.ok) {
        setStatus("Waking the AI service. This can take a few moments…");
        await new Promise((resolve) => setTimeout(resolve, 2500));
        health = await withTimeout(fetch(`${API}/health`), 4_000, "health check").catch(() => null);
      }
      const response = await withTimeout(
        apiFetch(`${API}/predict`, { method: "POST", body: form }),
        35_000,
        "Inference request timed out. The server may be busy or waking up. Please retry."
      );
      const data = (await response.json()) as Prediction;
      if (!response.ok) {
        throw data;
      }
      setResult(data);
      if (data.persistence_warning) {
        setStatus(`Analysis complete. (${data.persistence_warning})`);
      } else {
        setStatus("Analysis complete.");
      }
      setAnalysisStep(5);
      setNoteError("");
      setIsErrorStatus(false);
      void load();
    } catch (error) {
      const err = error as { detail?: { message?: string } | string; message?: string };
      const msg = typeof err?.detail === "string" ? err.detail : err?.detail?.message || err?.message || "Inference failed.";
      setStatus(msg);
      setIsErrorStatus(true);
      setAnalysisStep(0);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const submitFeedback = async (confirmedFabric: string, wasCorrect: boolean) => {
    if (!result) return;
    try {
      const response = await apiFetch(`${API}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prediction_id: result.id,
          image_token: result.image_token,
          confirmed_fabric: confirmedFabric,
          was_prediction_correct: wasCorrect
        })
      });
      const data = await response.json();
      setFeedbackSubmitted(true);
      setIsSelectingCorrection(false);
      setFeedbackMessage(data.message || `Submitted ${confirmedFabric.toUpperCase()} for administrator review.`);
      await load();
    } catch {
      alert("Failed to submit feedback. Please try again.");
    }
  };

  const useCamera = async (facing: "user" | "environment" = cameraFacing) => {
    try {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      const constraints: MediaStreamConstraints = {
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }
      };
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      setStream(s);
      setCameraFacing(facing);
      setStatus("");
      setIsErrorStatus(false);
    } catch {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true });
        setStream(s);
        setStatus("");
        setIsErrorStatus(false);
      } catch {
        setStatus("Camera permission unavailable. Please use file upload instead.");
        setIsErrorStatus(true);
      }
    }
  };

  const capture = () => {
    if (!video.current) {
      return;
    }
    const vw = video.current.videoWidth;
    const vh = video.current.videoHeight;
    // Center crop to a 1:1 square matching the reticle viewfinder
    const size = Math.min(vw, vh);
    const sx = Math.floor((vw - size) / 2);
    const sy = Math.floor((vh - size) / 2);

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      // If user facing mode was active, mirror horizontally before draw
      if (cameraFacing === "user") {
        ctx.translate(size, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video.current, sx, sy, size, size, 0, 0, size, size);
    }
    canvas.toBlob(
      (blob) => {
        if (blob) {
          const capturedFile = new File([blob], "camera-capture.jpg", { type: "image/jpeg" });
          onFileChange(capturedFile);
        }
        stream?.getTracks().forEach((track) => track.stop());
        setStream(undefined);
      },
      "image/jpeg",
      0.95
    );
  };


  const nav = (target: Page, label: string) => (
    <button
      className={`nav-link ${page === target ? "active" : ""}`}
      onClick={() => { setPage(target); setMobileNavOpen(false); }}
      aria-current={page === target ? "page" : undefined}
      type="button"
    >
      {label}
    </button>
  );

  return (
    <>
      {/* Top Navigation Bar */}
      <header className="app-header">
        <button className="brand-logo" onClick={() => setPage("home")}>
          <div className="logo-icon">🧺</div>
          <div>
            <span className="logo-text">LaundryAI</span>
            <span className="logo-tag">Fabric Intelligence</span>
          </div>
        </button>

        <button className="mobile-menu" type="button" aria-label="Toggle navigation" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen((open) => !open)}>
          <span /><span /><span />
        </button>

        <nav className={`main-nav ${mobileNavOpen ? "open" : ""}`}>
          {nav("home", "Home")}
          {nav("analyze", "Analyze")}
          {nav("insights", "Model")}
          {nav("library", "Care Guide")}
          {user.is_admin && nav("admin", "Admin")}
        </nav>

        <button className="header-cta" onClick={() => setPage("analyze")}>
          <span>+</span> Analyze Garment
        </button>
        <button className="account-chip" type="button" onClick={() => void onSignOut()} title="Sign out">
          {user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : <span>{user.name.charAt(0).toUpperCase()}</span>}
          <b>{user.name}</b><em>Sign out</em>
        </button>
      </header>

      {/* ========================================================
          HOME PAGE
          ======================================================== */}
      {page === "home" && (
        <main className="page-container">
          {/* Hero Section */}
          <section className="hero-grid">
            <Reveal className="hero-left">
              <span className="eyebrow">COMPUTER VISION × TEXTILE SCIENCE</span>
              <h1>
                <TextEffect>See the Fabric.</TextEffect> <br />
                <span className="serif">Understand the Care.</span>
              </h1>
              <p className="lead">
                AI-powered fabric intelligence that analyzes garment images, estimates the most likely fabric class, and recommends safer, smarter, and more sustainable care.
              </p>
              <div className="hero-actions">
                <MotionButton whileHover={{ y: -3 }} whileTap={{ scale: .98 }} className="btn btn-primary" onClick={() => setPage("analyze")}>
                  Analyze a Garment →
                </MotionButton>
                <button className="btn btn-secondary" onClick={() => setPage("library")}>
                  Explore Fabric Library
                </button>
              </div>
              <div className="trust-badge">
                <span>🛡️ Computer vision assisted</span>
                <span>•</span>
                <span>Evidence-led</span>
                <span>•</span>
                <span>Care labels authoritative</span>
              </div>
            </Reveal>

            {/* Right Interactive Scanner Simulation */}
            <Reveal className="hero-right" delay={.12}>
              <div className="scanner-card">
                <div className="scanner-viewbox">
                  <div className="macro-fabric-bg">
                    <div className="fabric-grid-overlay"></div>
                    <div className="laser-scan-line"></div>
                    <div className="scan-target-box">🌱</div>
                  </div>
                </div>
                <div className="scanner-footer">
                  <div className="scanner-pill">
                    <span className="dot"></span>
                    <span>AI Vision: <b>Cotton (94.2%)</b></span>
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--sage)" }}>Quality: Verified</span>
                </div>
              </div>
            </Reveal>
          </section>

          {/* 5-Step Pipeline Section */}
          <section className="pipeline-section">
            <div className="section-header">
              <span className="eyebrow">METHODOLOGY PIPELINE</span>
              <h2>How LaundryAI Works</h2>
              <p>A transparent 5-stage computer vision and expert rule system from raw image to sustainable care.</p>
            </div>
            <div className="pipeline-grid">
              <div className="pipeline-step">
                <div className="step-num">01 / INPUT</div>
                <div className="step-title">Capture</div>
                <div className="step-desc">Upload or photograph garment with automatic resolution and lighting pre-checks.</div>
              </div>
              <div className="pipeline-step">
                <div className="step-num">02 / VISION</div>
                <div className="step-title">Feature Extract</div>
                <div className="step-desc">CNN layers analyze surface macro-texture, weave pattern, and optical luster.</div>
              </div>
              <div className="pipeline-step">
                <div className="step-num">03 / CLASSIFY</div>
                <div className="step-title">Inference & Gate</div>
                <div className="step-desc">MobileNetV2 estimates class probabilities with confidence and margin gating.</div>
              </div>
              <div className="pipeline-step">
                <div className="step-num">04 / RULE ENGINE</div>
                <div className="step-title">Care Synthesis</div>
                <div className="step-desc">Textile knowledge base generates safe wash temperature, cycle, and iron profiles.</div>
              </div>
              <div className="pipeline-step">
                <div className="step-num">05 / ACTIVE LEARN</div>
                <div className="step-title">Continuous Train</div>
                <div className="step-desc">Human feedback automatically augments training sets for periodic model retraining.</div>
              </div>
            </div>
          </section>

          {/* Inside the Vision Engine */}
          <section style={{ padding: "50px 0", borderTop: "1px solid var(--border)" }}>
            <div className="section-header">
              <span className="eyebrow">DEEP LEARNING CAPABILITIES</span>
              <h2>Inside the Vision Engine</h2>
              <p>What the computer vision model examines to distinguish delicate silks from heavy cotton twills.</p>
            </div>
            <div className="engine-grid">
              <div className="engine-card">
                <div className="engine-icon">🔍</div>
                <h4>Texture</h4>
                <p>Identifies micro-surface relief, fiber fuzziness, and roughness metrics.</p>
              </div>
              <div className="engine-card">
                <div className="engine-icon">📐</div>
                <h4>Weave Pattern</h4>
                <p>Examines plain, twill, satin, or looped knit structural patterns.</p>
              </div>
              <div className="engine-card">
                <div className="engine-icon">✨</div>
                <h4>Optical Luster</h4>
                <p>Distinguishes natural matte cottons from high-luster synthetics and silks.</p>
              </div>
              <div className="engine-card">
                <div className="engine-icon">💬</div>
                <h4>Context Notes</h4>
                <p>Combines visual cues with optional user-supplied garment details.</p>
              </div>
              <div className="engine-card">
                <div className="engine-icon">🛡️</div>
                <h4>Confidence Gate</h4>
                <p>Rejects low-certainty and non-fabric images to prevent false care guidance.</p>
              </div>
            </div>
          </section>

          {/* Supported Fabrics Showcase */}
          <section style={{ padding: "50px 0", borderTop: "1px solid var(--border)" }}>
            <div className="section-header">
              <span className="eyebrow">TEXTILE INTELLIGENCE</span>
              <h2>Supported Fabric Classes</h2>
              <p>Explore our deep-care knowledge base across natural and synthetic materials.</p>
            </div>
            <div className="fabric-showcase-grid">
              {Object.entries(FABRICS_DATA).map(([key, data]) => (
                <div className="fabric-card-preview" key={key}>
                  <div className="fabric-emoji">{data.emoji}</div>
                  <h3>{data.name}</h3>
                  <p>{data.overview}</p>
                  <button
                    className="btn btn-sage btn-sm"
                    onClick={() => {
                      setSelectedFabricKey(key);
                      setPage("library");
                    }}
                  >
                    View Care Spec →
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* Sustainability Highlight */}
          <section className="sustainability-banner">
            <div>
              <span className="eyebrow" style={{ color: "#28E6A3" }}>SUSTAINABILITY FIRST</span>
              <h2>Better Care. Lower Impact.</h2>
              <p>
                The right laundering conditions help garments last longer while reducing household water, energy, and microfiber pollution.
              </p>
            </div>
            <div className="impact-pills-grid">
              <div className="impact-pill">
                <b>🌡️ Lower Temperatures</b>
                <span>Saves up to 60% of washing electricity compared to hot cycles.</span>
              </div>
              <div className="impact-pill">
                <b>🌬️ Air Drying</b>
                <span>Eliminates tumble dryer energy and prevents thermal fiber wear.</span>
              </div>
              <div className="impact-pill">
                <b>🌊 Gentler Agitation</b>
                <span>Reduces mechanical friction and synthetic microfiber shedding.</span>
              </div>
              <div className="impact-pill">
                <b>⏳ Extended Garment Life</b>
                <span>Proper care prevents color fading, shrinkage, and premature disposal.</span>
              </div>
            </div>
          </section>
        </main>
      )}

      {/* ========================================================
          ANALYZE PAGE (3-STAGE WORKSPACE WITH ACTIVE LEARNING)
          ======================================================== */}
      {page === "analyze" && (
        <main className="page-container">
          <Reveal className="analyze-workspace">
            {/* Stepper Header */}
            <div className="workspace-stepper">
              <div className={`step-indicator ${analysisStep === 0 ? "active" : analysisStep > 0 ? "completed" : ""}`}>
                <span className="step-circle">{analysisStep > 0 ? "✓" : "1"}</span>
                <span>Capture & Check</span>
              </div>
              <span>→</span>
              <div className={`step-indicator ${isAnalyzing ? "active" : analysisStep === 5 ? "completed" : ""}`}>
                <span className="step-circle">{analysisStep === 5 ? "✓" : "2"}</span>
                <span>AI Vision Engine</span>
              </div>
              <span>→</span>
              <div className={`step-indicator ${result ? "active" : ""}`}>
                <span className="step-circle">3</span>
                <span>Care Profile</span>
              </div>
            </div>

            {/* STAGE 1 & 2: Workspace Panel */}
            <div className="workspace-panel">
              <span className="eyebrow">GARMENT SCANNER</span>
              <h2><TextEffect>Scan a Garment</TextEffect></h2>
              <p style={{ color: "var(--text-muted)", marginBottom: "20px" }}>
                Upload a clear close-up of your garment's fabric surface for classification and care rules.
              </p>

              {/* Camera viewfinder — rendered OUTSIDE the drop-zone to avoid click conflicts */}
              {stream && (
                <div
                  className="camera-viewfinder-card"
                  style={{ position: "relative", marginBottom: "20px", overflow: "hidden", borderRadius: "12px" }}
                >
                  <video
                    className="camera"
                    ref={video}
                    autoPlay
                    playsInline
                    style={{
                      width: "100%",
                      display: "block",
                      transform: cameraFacing === "user" ? "scaleX(-1)" : "none",
                    }}
                  />
                  {/* Reticle overlay */}
                  <div className="reticle" />
                  {/* Lighting indicator */}
                  <div style={{ position: "absolute", top: 8, right: 8 }}>
                    <span
                      className="lighting-indicator"
                      style={{
                        color:
                          imageAssessment?.brightnessStatus === "Optimal"
                            ? "var(--success)"
                            : "var(--warning)",
                      }}
                    >
                      💡 {imageAssessment?.brightnessStatus || "Assessing…"}
                    </span>
                  </div>
                  {/* Action buttons */}
                  <div style={{ display: "flex", gap: "8px", padding: "8px" }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ flex: 1 }}
                      onClick={(e) => { e.stopPropagation(); capture(); }}
                    >
                      📸 Capture Photo
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        const next = cameraFacing === "environment" ? "user" : "environment";
                        setCameraFacing(next);
                        useCamera(next);
                      }}
                    >
                      🔄 Switch Camera
                    </button>
                  </div>
                </div>
              )}

              {/* Drop Zone — hidden while camera is open */}
              {!stream && (
              <div
                className={`drop-zone ${isDragging ? "dragging" : ""}`}
                onClick={() => input.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDropFile}
                role="button"
                tabIndex={0}
              >



                {file ? (
                  <div>
                    {previewUrl && <img src={previewUrl} alt="Selected garment" className="upload-image-preview" />}
                    <h3 style={{ color: "var(--primary)" }}>{file.name}</h3>
                    <p>Ready to analyze ({Math.round(file.size / 1024)} KB) • Click to change photo</p>
                  </div>
                ) : (
                  <div>
                    <div className="drop-zone-icon">📷</div>
                    <h3>Drop garment image here, or click to browse</h3>
                    <p>JPG, PNG, WEBP • Up to 10 MB • Close‑up texture recommended</p>
                  </div>
                )}
              </div>
              )} {/* end !stream drop-zone */}

              <input
                ref={input}
                hidden
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => onFileChange(e.target.files?.[0])}
              />

              {/* Client-side Pre-flight Quality Assessment */}
              {imageAssessment && (
                <div className="quality-assessment-box">
                  <div className="quality-header">
                    <span style={{ fontSize: "13px", fontWeight: 700, color: "var(--dark)" }}>
                      PRE-FLIGHT IMAGE QUALITY ASSESSMENT
                    </span>
                    <span
                      style={{
                        fontSize: "12px",
                        fontWeight: 700,
                        color: imageAssessment.isReady ? "var(--success)" : "var(--warning)"
                      }}
                    >
                      {imageAssessment.isReady ? "✓ Optimal for AI inference" : "⚠ Quality alert"}
                    </span>
                  </div>
                  <div className="quality-grid">
                    <div className="quality-item">
                      <div className="quality-item-label">Resolution</div>
                      <div className="quality-item-val" style={{ color: imageAssessment.resolutionStatus === "Optimal" ? "var(--success)" : "var(--warning)" }}>
                        {imageAssessment.width} × {imageAssessment.height} ({imageAssessment.resolutionStatus})
                      </div>
                    </div>
                    <div className="quality-item">
                      <div className="quality-item-label">Lighting / Brightness</div>
                      <div className="quality-item-val" style={{ color: imageAssessment.brightnessStatus === "Optimal" ? "var(--success)" : "var(--warning)" }}>
                        {imageAssessment.brightness}/255 ({imageAssessment.brightnessStatus})
                      </div>
                    </div>
                    <div className="quality-item">
                      <div className="quality-item-label">Subject Readiness</div>
                      <div className="quality-item-val" style={{ color: imageAssessment.isReady ? "var(--success)" : "var(--warning)" }}>
                        {imageAssessment.isReady ? "Clear Fabric Texture" : "Check Lighting"}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Care Note Input & Presets */}
              <label className="field-label" htmlFor="care-note">
                Care Context / Garment Note (Optional)
              </label>
              <div className="tag-container">
                {PRESET_TAGS.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="tag-chip"
                    onClick={() => addPresetTag(tag)}
                  >
                    + {tag}
                  </button>
                ))}
                {note && (
                  <button
                    type="button"
                    className="tag-chip"
                    style={{ background: "var(--danger-light)", color: "var(--danger)" }}
                    onClick={() => {
                      setNote("");
                      setNoteError("");
                    }}
                  >
                    ✕ Clear note
                  </button>
                )}
              </div>

              <textarea
                id="care-note"
                className={`text-field ${noteError ? "has-error" : ""}`}
                value={note}
                maxLength={NOTE_MAX_LENGTH}
                placeholder="Example: White cotton shirt with printed embroidery, delicate collar"
                onChange={(e) => {
                  const next = e.target.value;
                  setNote(next);
                  setNoteError(validateNote(next));
                }}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    e.preventDefault();
                    if (file && !isAnalyzing && !noteError) {
                      void analyze();
                    }
                  }
                }}
              />
              <div className="field-meta">
                <span className="error-text">{noteError || " "}</span>
                <span>{note.trim().length}/{NOTE_MAX_LENGTH}</span>
              </div>
              <p className="keyboard-hint" style={{ fontSize: "12px", color: "var(--text-light)", textAlign: "right", marginTop: "4px" }}>
                💡 Tip: Press <b>Ctrl + Enter</b> to start analysis immediately
              </p>

              {/* Action Buttons */}
              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginTop: "24px" }}>
                <button type="button" className="btn btn-secondary" onClick={() => input.current?.click()}>
                  Upload Photo
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => useCamera("environment")}>
                  Use Camera
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!file}
                  onClick={() => onFileChange(undefined)}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1, minWidth: "160px" }}
                  disabled={!file || isAnalyzing || !!noteError}
                  onClick={analyze}
                >
                  {isAnalyzing ? "Analyzing Fabric..." : "✨ Run AI Analysis"}
                </button>
              </div>

              {/* Multi-step Processing Animation */}
              {isAnalyzing && (
                <div className="processing-screen">
                  <div className="processing-spinner"></div>
                  <h3 style={{ fontSize: "20px", marginBottom: "8px" }}>AI Vision Engine at Work</h3>
                  <p style={{ color: "var(--text-muted)", fontSize: "14px" }}>{status}</p>
                  <div className="processing-steps">
                    <div className={`p-step ${analysisStep >= 1 ? (analysisStep > 1 ? "done" : "active") : ""}`}>
                      <span>{analysisStep > 1 ? "✓" : "◉"}</span> Image tensor preprocessing (224×224 Normalization)
                    </div>
                    <div className={`p-step ${analysisStep >= 2 ? (analysisStep > 2 ? "done" : "active") : ""}`}>
                      <span>{analysisStep > 2 ? "✓" : "◉"}</span> Convolutional feature extraction (texture & weave)
                    </div>
                    <div className={`p-step ${analysisStep >= 3 ? (analysisStep > 3 ? "done" : "active") : ""}`}>
                      <span>{analysisStep > 3 ? "✓" : "◉"}</span> MobileNetV2 neural classification
                    </div>
                    <div className={`p-step ${analysisStep >= 4 ? (analysisStep > 4 ? "done" : "active") : ""}`}>
                      <span>{analysisStep > 4 ? "✓" : "◉"}</span> Confidence gating & knowledge base care mapping
                    </div>
                  </div>
                </div>
              )}

              {/* Status Banner */}
              {status && !isAnalyzing && (
                <div className={`result ${isErrorStatus ? "error" : "success"}`} style={{ marginTop: "20px" }}>
                  {status}
                </div>
              )}
            </div>

            {/* STAGE 3: Comprehensive Result & Care Profile + Active Learning Loop */}
            {result && (
              <section style={{ marginTop: "32px" }}>
                <div className="result-header-card">
                  <span className="eyebrow">AI FABRIC ANALYSIS REPORT</span>
                  <div className="result-main-badge">
                    <div>
                      <div className="fabric-title-large">{result.fabric}</div>
                      {result.note && (
                        <p className="context-note" style={{ marginTop: "8px" }}>
                          <b>Garment Context:</b> {result.note}
                        </p>
                      )}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div
                        style={{
                          fontSize: "24px",
                          fontWeight: 800,
                          color: result.confidence >= 70 ? "var(--primary)" : "var(--warning)"
                        }}
                      >
                        {result.confidence}%
                      </div>
                      <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-light)", textTransform: "uppercase" }}>
                        {result.confidence >= 80 ? "High Confidence" : result.confidence >= 60 ? "Moderate Certainty" : "Low Confidence"}
                      </span>
                    </div>
                  </div>

                  {/* Confidence Bar */}
                  <div className="confidence-meter-container">
                    <div className="confidence-bar-bg">
                      <div className="confidence-bar-fill" style={{ width: `${Math.min(100, Math.max(5, result.confidence))}%` }}></div>
                    </div>
                  </div>

                  {/* Confidence Probability Distribution */}
                  {result.alternatives && result.alternatives.length > 1 && (
                    <div className="alt-container">
                      <p className="alt-label">Model Probability Distribution</p>
                      <div className="alt-chips">
                        {result.alternatives.map((alt) => (
                          <span key={alt.fabric} className="alt-chip">
                            <b>{alt.fabric}</b>: {alt.confidence}%
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ========================================================
                      HUMAN-IN-THE-LOOP ACTIVE LEARNING FEEDBACK BOX
                      ======================================================== */}
                  <div className="feedback-box">
                    <div className="feedback-title">
                      <span>🎯 Active Learning Feedback & Continuous Dataset Training</span>
                    </div>
                    <p className="feedback-desc">
                      Help LaundryAI learn. Your correction enters a private review queue; an administrator checks the label before it can become training data.
                    </p>

                    {feedbackSubmitted ? (
                      <div className="feedback-success-badge">
                        <span>✓</span>
                        <span>{feedbackMessage}</span>
                      </div>
                    ) : (
                      <div>
                        {!isSelectingCorrection ? (
                          <div>
                            <p style={{ fontSize: "14px", fontWeight: 600, color: "var(--dark)", marginBottom: "10px" }}>
                              Is this garment actually <b>{result.fabric.toUpperCase()}</b>?
                            </p>
                            <div className="feedback-actions">
                              <button
                                type="button"
                                className="feedback-correct-btn"
                                onClick={() => submitFeedback(result.model_decision?.top_fabric || result.fabric, true)}
                              >
                                ✓ Yes, it's {result.fabric.toUpperCase()} (Submit for Review)
                              </button>
                              <button
                                type="button"
                                className="feedback-wrong-btn"
                                onClick={() => setIsSelectingCorrection(true)}
                              >
                                ✗ No, it's a different fabric
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="feedback-picker">
                            <p style={{ fontSize: "13.5px", fontWeight: 700, color: "var(--dark)", marginBottom: "8px" }}>
                              Select the actual fabric type to submit this image for administrator review:
                            </p>
                            <div className="tag-container">
                              {[
                                ["cotton", "🌱 Cotton"],
                                ["polyester", "🧶 Polyester"],
                                ["denim", "👖 Denim"],
                                ["wool", "🐑 Wool"],
                                ["silk", "🪡 Silk"],
                                ["non_fabric", "🚫 Non-Fabric"]
                              ].map(([k, label]) => (
                                <button
                                  key={k}
                                  type="button"
                                  className="tag-chip"
                                  style={{ padding: "6px 14px", fontWeight: 700 }}
                                  onClick={() => submitFeedback(k, false)}
                                >
                                  {label}
                                </button>
                              ))}
                              <button
                                type="button"
                                className="tag-chip"
                                style={{ background: "var(--surface-alt)", color: "var(--text-light)" }}
                                onClick={() => setIsSelectingCorrection(false)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Rejection / Unknown Handling */}
                  {!result.model_decision?.accepted && (
                    <div style={{ background: "var(--warning-light)", border: "1px solid var(--warning-border)", borderRadius: "var(--radius-sm)", padding: "16px", marginTop: "20px" }}>
                      <h4 style={{ color: "var(--warning)", marginBottom: "4px" }}>⚠️ Low Confidence or Non-Fabric Input</h4>
                      <p style={{ fontSize: "14px", color: "var(--dark)" }}>
                        {result.model_decision?.reason || "The AI could not confidently match this surface with supported fabric profiles."}
                      </p>
                      <ul style={{ fontSize: "13px", color: "var(--text-muted)", marginTop: "8px", paddingLeft: "20px" }}>
                        <li>Retake the photo closer to the cloth surface</li>
                        <li>Ensure even natural lighting without harsh glare</li>
                        <li>Flatten folds or wrinkles for clear weave texture visibility</li>
                      </ul>
                    </div>
                  )}

                  {/* ============================================================
                      STAGE 2 — Detail Subtab Bar: Care | Stains | Dosing
                      ============================================================ */}
                  {result.model_decision?.accepted && result.recommendation && (
                    <>
                      {/* Tab pill switcher */}
                      <div className="pill-tabs">
                        {(["care", "stains", "dosing"] as const).map((tab) => (
                          <button
                            key={tab}
                            type="button"
                            onClick={() => setDetailSubtab(tab)}
                            className={`pill-tab ${detailSubtab === tab ? "active" : "inactive"}`}
                          >
                            {tab === "care" ? "🫧 Care" : tab === "stains" ? "🧪 Stains" : "⚗️ Dosing"}
                          </button>
                        ))}
                      </div>

                      {/* ── TAB 1: Care Profile ── */}
                      {detailSubtab === "care" && (
                        <>
                          <h3 style={{ fontSize: "18px", marginBottom: "14px" }}>Recommended Care Profile</h3>
                          <div className="care-profile-grid">
                            <div className="care-card">
                              <div className="care-card-icon">🫧</div>
                              <div className="care-card-label">WASHING</div>
                              <div className="care-card-value">{result.recommendation.wash.temperature}</div>
                              <span style={{ fontSize: "12px", color: "var(--text-light)" }}>{result.recommendation.wash.cycle}</span>
                            </div>
                            <div className="care-card">
                              <div className="care-card-icon">◌</div>
                              <div className="care-card-label">DRYING</div>
                              <div className="care-card-value">{result.recommendation.dry}</div>
                            </div>
                            <div className="care-card">
                              <div className="care-card-icon">♨</div>
                              <div className="care-card-label">IRONING</div>
                              <div className="care-card-value">{result.recommendation.iron}</div>
                            </div>
                            <div className="care-card">
                              <div className="care-card-icon">✦</div>
                              <div className="care-card-label">DETERGENT</div>
                              <div className="care-card-value">{result.recommendation.wash.detergent || "Mild formula"}</div>
                            </div>
                            <div className="care-card">
                              <div className="care-card-icon">🚫</div>
                              <div className="care-card-label">BLEACH</div>
                              <div className="care-card-value">{result.recommendation.bleach}</div>
                            </div>
                          </div>

                          <div className="rationale-box">
                            <h4>Why this recommendation?</h4>
                            <p>{result.recommendation.explanation}</p>
                          </div>

                          <div className="eco-tip-box">
                            <strong>🌱 Eco-Friendly Care Practices:</strong>
                            <ul className="eco-tip-list">
                              {result.recommendation.eco.map((tip, idx) => (
                                <li key={idx}>{tip}</li>
                              ))}
                            </ul>
                          </div>
                        </>
                      )}

                      {/* ── TAB 2: Stain Treatment Guide ── */}
                      {detailSubtab === "stains" && (() => {
                        const fabricKey = result.fabric.toLowerCase();
                        return (
                          <div className="stain-guide-panel">
                            <h3>Stain Treatment Guide</h3>
                            <p className="stain-guide-subtitle">
                              Fabric-specific removal steps for <strong style={{ textTransform: "capitalize" }}>{result.fabric}</strong>
                            </p>

                            {/* Stain type selector */}
                            <div className="stain-pill-selector">
                              {Object.entries(STAIN_GUIDE).map(([key, s]) => (
                                <button
                                  key={key}
                                  type="button"
                                  onClick={() => setStainTab(key)}
                                  className={`stain-selector-pill ${stainTab === key ? "active" : "inactive"}`}
                                >
                                  {s.icon} {s.label}
                                </button>
                              ))}
                            </div>

                            {(() => {
                              const stain = STAIN_GUIDE[stainTab];
                              const fabricEntry = stain?.fabrics[fabricKey];
                              if (!stain) return null;
                              if (!fabricEntry) {
                                return (
                                  <div className="stain-card">
                                    No specific guide for <strong style={{ textTransform: "capitalize" }}>{result.fabric}</strong> and {stain.label}. Follow general fabric care rules.
                                  </div>
                                );
                              }
                              return (
                                <div className="stain-card">
                                  <div className="stain-card-header">
                                    <span className="stain-card-icon">{stain.icon}</span>
                                    <div>
                                      <div className="stain-card-title">{stain.label} on {result.fabric}</div>
                                      <span className="stain-card-temp-badge">🌡️ {fabricEntry.optimalTemp}</span>
                                    </div>
                                  </div>

                                  <ol className="stain-steps">
                                    {fabricEntry.steps.map((step, i) => (
                                      <li key={i}>{step}</li>
                                    ))}
                                  </ol>

                                  <div className="stain-avoid">
                                    <span>⚠️</span>
                                    <span><b>Avoid:</b> {fabricEntry.avoid}</span>
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        );
                      })()}

                      {/* ── TAB 3: Smart Dosing Calculator ── */}
                      {detailSubtab === "dosing" && (() => {
                        const fabricKey = result.fabric.toLowerCase();
                        const baseDose: Record<string, number> = { cotton: 40, polyester: 30, denim: 35, wool: 20, silk: 15 };
                        const loadMult = { small: 0.7, medium: 1.0, large: 1.4 };
                        const soilMult = { light: 0.8, normal: 1.0, heavy: 1.3 };
                        const base = baseDose[fabricKey] ?? 30;
                        const dose = Math.round(base * loadMult[loadWeight] * soilMult[soilLevel]);
                        const detergentTip: Record<string, string> = {
                          cotton: "Standard or oxygen-based detergent works well.",
                          polyester: "Use a liquid synthetic detergent — avoid powder residue.",
                          denim: "Use a colour-safe detergent to protect indigo dye.",
                          wool: "Use a wool-specific pH-neutral detergent only.",
                          silk: "Use a silk or delicate wash shampoo at pH 7."
                        };

                        return (
                          <div className="dosing-panel">
                            <h3>Smart Dosing Calculator</h3>
                            <p className="dosing-subtitle">
                              Optimal detergent volume for <strong style={{ textTransform: "capitalize" }}>{result.fabric}</strong>
                            </p>

                            <div className="dosing-controls">
                              {/* Load Weight */}
                              <div className="dosing-control-card">
                                <div className="dosing-control-label">Load Size</div>
                                <div className="dosing-btn-group">
                                  {(["small", "medium", "large"] as const).map((v) => (
                                    <button
                                      key={v}
                                      type="button"
                                      onClick={() => setLoadWeight(v)}
                                      className={`dosing-opt ${loadWeight === v ? "active-primary" : "inactive"}`}
                                    >
                                      {v === "small" ? "🪶 Small" : v === "medium" ? "👕 Medium" : "🏋️ Large"}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              {/* Soil Level */}
                              <div className="dosing-control-card">
                                <div className="dosing-control-label">Soil Level</div>
                                <div className="dosing-btn-group">
                                  {(["light", "normal", "heavy"] as const).map((v) => (
                                    <button
                                      key={v}
                                      type="button"
                                      onClick={() => setSoilLevel(v)}
                                      className={`dosing-opt ${soilLevel === v ? "active-secondary" : "inactive"}`}
                                    >
                                      {v === "light" ? "✨ Light" : v === "normal" ? "👔 Normal" : "🏚️ Heavy"}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>

                            {/* Dose readout */}
                            <div className="dose-readout">
                              <div className="dose-readout-eyebrow">Recommended Detergent Dose</div>
                              <div className="dose-readout-value">
                                {dose}
                                <span className="dose-readout-unit">ml</span>
                              </div>
                              <div className="dose-readout-meta">{loadWeight} load · {soilLevel} soil · {result.fabric}</div>
                            </div>

                            {/* Detergent tip */}
                            <div className="detergent-tip">
                              <strong>💡 Detergent Tip:</strong> {detergentTip[fabricKey] ?? "Use a mild, fabric-appropriate detergent."}
                              {result.recommendation && (
                                <span className="detergent-tip-extra">
                                  🌡️ Wash at <strong>{result.recommendation.wash.temperature}</strong> · {result.recommendation.wash.cycle} cycle
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Action Bar — always visible */}
                      <div className="result-action-bar">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            if (!result.recommendation) return;
                            const text = `🧺 LaundryAI Care Profile\nFabric: ${result.fabric.toUpperCase()} (${result.confidence}% confidence)\nWash: ${result.recommendation.wash.temperature} · ${result.recommendation.wash.cycle}\nDry: ${result.recommendation.dry}\nIron: ${result.recommendation.iron}\nBleach: ${result.recommendation.bleach}\nEco Tip: ${result.recommendation.eco.join(" ")}`;
                            void navigator.clipboard.writeText(text);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                          }}
                        >
                          {copied ? "✓ Copied to Clipboard!" : "📋 Copy Care Profile"}
                        </button>
                        <button type="button" className="btn btn-sage" onClick={() => setPage("insights")}>
                          View model insights →
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => { onFileChange(undefined); setResult(undefined); }}
                        >
                          + Scan Another Garment
                        </button>
                      </div>
                    </>
                  )}

                </div>
              </section>
            )}
          </Reveal>
        </main>
      )}

      {/* ========================================================
          INSIGHTS PAGE (ANALYTICS & DATASET STATS)
          ======================================================== */}
      {page === "insights" && (
        <main className="page-container">
          <Reveal>
          <span className="eyebrow">MODEL METRICS & USAGE</span>
          <h1><TextEffect>Model performance, made clear.</TextEffect></h1>
          <p style={{ color: "var(--text-muted)", marginBottom: "32px" }}>
            Real data-derived statistics from verified garment classifications and active learning dataset growth.
          </p>

          {/* Top KPI Cards */}
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-label">Garments Analyzed</div>
              <div className="kpi-value">{analytics?.garments_analyzed ?? 0}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Average Confidence</div>
              <div className="kpi-value">{analytics?.average_confidence ? `${analytics.average_confidence}%` : "—"}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Most Detected Fabric</div>
              <div className="kpi-value" style={{ textTransform: "capitalize" }}>{analytics?.most_detected_fabric || "—"}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Eco Recommendations</div>
              <div className="kpi-value">{analytics?.eco_recommendations ?? 0}</div>
            </div>
          </div>

          {/* Active Learning Dataset Tracker */}
          {datasetStats && (
            <div className="chart-card" style={{ marginBottom: "28px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "12px", marginBottom: "16px" }}>
                <div>
                  <span className="eyebrow" style={{ color: "var(--ai-blue)" }}>CONTINUOUS TRAINING PIPELINE</span>
                  <h3 style={{ margin: "4px 0" }}>Active Learning Training Dataset (Samples per Category)</h3>
                </div>
                <span className="trust-badge" style={{ background: "var(--primary-light)", color: "var(--primary)" }}>
                  {datasetStats.user_contributed} user-verified images added
                </span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "12px" }}>
                {Object.entries(datasetStats.classes).map(([className, item]) => (
                  <div key={className} style={{ background: "var(--surface-card)", border: "1px solid var(--border-light)", borderRadius: "var(--radius-sm)", padding: "14px", textAlign: "center" }}>
                    <div style={{ fontSize: "12px", fontWeight: 700, textTransform: "uppercase", color: "var(--text-light)" }}>{className}</div>
                    <div style={{ fontSize: "22px", fontWeight: 800, color: "var(--dark)", margin: "4px 0" }}>{item.total}</div>
                    <span style={{ fontSize: "11px", color: "var(--primary)", fontWeight: 600 }}>+{item.user_verified} verified</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
            {/* Fabric Distribution */}
            <div className="chart-card">
              <h3>Fabric Class Distribution</h3>
              {analytics?.distribution && Object.keys(analytics.distribution).length ? (
                Object.entries(analytics.distribution).map(([name, count]) => {
                  const total = analytics.garments_analyzed || 1;
                  const pct = Math.round((count / total) * 100);
                  return (
                    <div className="histogram-row" key={name}>
                      <span className="histogram-label" style={{ textTransform: "capitalize" }}>{name}</span>
                      <div className="histogram-bar-bg">
                        <div className="histogram-bar-fill" style={{ width: `${pct}%`, background: "var(--primary)" }}></div>
                      </div>
                      <span className="histogram-count">{count}</span>
                    </div>
                  );
                })
              ) : (
                <p style={{ color: "var(--text-light)", fontSize: "14px" }}>No prediction history stored yet.</p>
              )}
            </div>

            {/* Model Confidence Histogram */}
            <div className="chart-card">
              <h3>Confidence Distribution Histogram</h3>
              {history.length ? (
                (() => {
                  const buckets = [
                    { range: "80–100%", count: history.filter((h) => h.confidence >= 80).length },
                    { range: "60–80%", count: history.filter((h) => h.confidence >= 60 && h.confidence < 80).length },
                    { range: "40–60%", count: history.filter((h) => h.confidence >= 40 && h.confidence < 60).length },
                    { range: "20–40%", count: history.filter((h) => h.confidence >= 20 && h.confidence < 40).length },
                    { range: "0–20%", count: history.filter((h) => h.confidence < 20).length }
                  ];
                  return buckets.map((b) => {
                    const pct = Math.round((b.count / history.length) * 100);
                    return (
                      <div className="histogram-row" key={b.range}>
                        <span className="histogram-label">{b.range}</span>
                        <div className="histogram-bar-bg">
                          <div className="histogram-bar-fill" style={{ width: `${pct}%`, background: "var(--secondary)" }}></div>
                        </div>
                        <span className="histogram-count">{b.count}</span>
                      </div>
                    );
                  });
                })()
              ) : (
                <p style={{ color: "var(--text-light)", fontSize: "14px" }}>Runs will populate after scans are recorded.</p>
              )}
            </div>
          </div>

          {/* Model Evaluation — Confusion Matrix */}
          {modelMetrics && (
            <div style={{ marginTop: "28px" }}>
              <ConfusionMatrixView metrics={modelMetrics} />
            </div>
          )}
          </Reveal>
        </main>
      )}

      {/* ========================================================
          FABRIC LIBRARY & COMPARISON
          ======================================================== */}
      {page === "library" && (
        <main className="page-container">
          <Reveal>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "12px", marginBottom: "20px" }}>
            <div>
              <span className="eyebrow">TEXTILE KNOWLEDGE BASE</span>
              <h1><TextEffect>Fabric care, without guesswork.</TextEffect></h1>
            </div>
            <MotionButton
              whileHover={{ y: -2 }}
              whileTap={{ scale: .985 }}
              className="btn btn-secondary"
              onClick={() => setCompareActive(!compareActive)}
            >
              {compareActive ? "View Single Fabric" : "📊 Compare All Fabrics"}
            </MotionButton>
          </div>

          {/* Comparison Matrix View */}
          {compareActive ? (
            <div className="comparison-table-wrapper">
              <table className="comparison-table">
                <thead>
                  <tr>
                    <th>Fabric Class</th>
                    <th>Category</th>
                    <th>Wash Temp</th>
                    <th>Cycle</th>
                    <th>Drying</th>
                    <th>Ironing</th>
                    <th>Shrinkage Risk</th>
                    <th>Heat Sensitivity</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(FABRICS_DATA).map(([key, data]) => (
                    <tr key={key}>
                      <td><b>{data.emoji} {data.name}</b></td>
                      <td>{data.category}</td>
                      <td>{data.washTemp}</td>
                      <td>{data.cycle}</td>
                      <td>{data.dry}</td>
                      <td>{data.iron}</td>
                      <td><span className={`tag-chip ${data.shrinkRisk === "High" ? "danger" : ""}`}>{data.shrinkRisk}</span></td>
                      <td><span className="tag-chip">{data.heatSens}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div>
              {/* Fabric Picker Chips */}
              <div className="tag-container" style={{ marginBottom: "28px" }}>
                {Object.entries(FABRICS_DATA).map(([key, data]) => (
                  <button
                    key={key}
                    type="button"
                    className={`tag-chip ${selectedFabricKey === key ? "active" : ""}`}
                    style={{
                      background: selectedFabricKey === key ? "var(--primary)" : "var(--surface)",
                      color: selectedFabricKey === key ? "#FFFFFF" : "var(--dark)",
                      fontSize: "14px",
                      padding: "8px 18px"
                    }}
                    onClick={() => setSelectedFabricKey(key)}
                  >
                    {data.emoji} {data.name}
                  </button>
                ))}
              </div>

              {/* Selected Fabric 6-Section Spec Card */}
              {(() => {
                const current = FABRICS_DATA[selectedFabricKey];
                return (
                  <div className="workspace-panel">
                    <span className="eyebrow">{current.category}</span>
                    <h2 style={{ fontSize: "36px", marginBottom: "8px" }}>{current.emoji} {current.name}</h2>
                    <p style={{ color: "var(--text-muted)", fontSize: "16px", marginBottom: "28px" }}>{current.overview}</p>

                    <div className="care-profile-grid">
                      <div className="care-card">
                        <div className="care-card-icon">🫧</div>
                        <div className="care-card-label">WASH TEMP</div>
                        <div className="care-card-value">{current.washTemp}</div>
                        <span style={{ fontSize: "12px", color: "var(--text-light)" }}>{current.cycle}</span>
                      </div>
                      <div className="care-card">
                        <div className="care-card-icon">◌</div>
                        <div className="care-card-label">DRYING</div>
                        <div className="care-card-value">{current.dry}</div>
                      </div>
                      <div className="care-card">
                        <div className="care-card-icon">♨</div>
                        <div className="care-card-label">IRONING</div>
                        <div className="care-card-value">{current.iron}</div>
                      </div>
                      <div className="care-card">
                        <div className="care-card-icon">⚠️</div>
                        <div className="care-card-label">SHRINKAGE</div>
                        <div className="care-card-value">{current.shrinkRisk}</div>
                      </div>
                      <div className="care-card">
                        <div className="care-card-icon">🔥</div>
                        <div className="care-card-label">HEAT SENSITIVITY</div>
                        <div className="care-card-value">{current.heatSens}</div>
                      </div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", marginTop: "24px" }}>
                      <div className="rationale-box">
                        <h4>Visual Characteristics (Computer Vision Cues)</h4>
                        <p>{current.visual}</p>
                      </div>
                      <div className="rationale-box" style={{ background: "var(--warm-beige)", borderColor: "#DECDB5" }}>
                        <h4 style={{ color: "var(--dark)" }}>Sustainability Impact</h4>
                        <p>{current.sustainability}</p>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
          </Reveal>
        </main>
      )}

      {page === "admin" && user.is_admin && (
        <main className="admin-page">
          <div className="admin-command-bar"><span><i /> LaundryAI administration</span><small>Protected operations workspace</small><strong>{adminOverview?.model_ready ? "Inference online" : "Operations ready"}</strong></div>
          <section className="admin-hero">
            <div>
              <span className="eyebrow">ADMIN CONTROL CENTER</span>
              <h1><TextEffect>Operate the platform.</TextEffect></h1>
              <p>Monitor production, review every correction, manage access, and release validated models from one workspace.</p>
            </div>
            <div className="admin-identity"><span>VERIFIED ADMINISTRATOR</span><strong>{user.email}</strong><small>{adminLastUpdated ? `Last synchronized ${adminLastUpdated}` : "Waiting for first sync"}</small><button type="button" disabled={adminLoading} onClick={() => setAdminRefreshKey((value) => value+1)}>{adminLoading ? "Refreshing…" : "↻ Refresh all data"}</button></div>
          </section>

          <div className="admin-console-shell">
            <aside className="admin-command-rail">
              <div className="admin-rail-heading"><span>Workspace</span><small>Choose an operational area</small></div>
              <nav className="admin-tabs" aria-label="Admin operations">
                {[
                  ['operations', 'Operations', 'Service health & dataset stats', '⚡'],
                  ['review', `Review · ${adminFeedback.length}`, 'Approve corrections & scan logs', '👁️'],
                  ['model', 'Model Release', 'Train, evaluate & promote', '🧠'],
                  ['users', `Users · ${adminUsers.length}`, 'Roles & access control', '👥'],
                  ['reference', 'Reference', 'Runbook & service links', '📖']
                ].map(([key, label, description, icon], index) => {
                  const isActive = adminTab === key || (key === 'operations' && adminTab === 'overview') || (key === 'review' && adminTab === 'feedback');
                  return (
                    <button
                      type="button"
                      key={key}
                      className={isActive ? "active" : ""}
                      onClick={() => setAdminTab(key as any)}
                    >
                      <b>0{index + 1}</b>
                      <span>{icon} {label}<small>{description}</small></span>
                    </button>
                  );
                })}
              </nav>
              <div className="admin-rail-footer"><span className={adminOverview?.model_ready ? "online" : "pending"} /><div><b>Inference API</b><small>{adminOverview?.model_ready ? "Operational" : "Checking connection"}</small></div></div>
            </aside>
            <MotionPanel panelKey={adminTab} className="admin-command-main">
              {adminMessage && <div className="admin-alert">{adminMessage}</div>}

          {(adminTab === "operations" || adminTab === "overview") && <>
          <section className="admin-stats-grid">
            <div><span>Total scans</span><b>{adminOverview?.total_scans ?? history.length}</b><small>Recorded analyses</small></div>
            <div><span>Feedback records</span><b>{adminOverview?.feedback_records ?? 0}</b><small>Awaiting review or included data</small></div>
            <div><span>Dataset samples</span><b>{adminOverview?.dataset?.total_samples ?? datasetStats?.total_samples ?? "—"}</b><small>Across supported classes</small></div>
            <div><span>Model status</span><b>{adminOverview?.model_ready ? "Ready" : "Checking"}</b><small>Live inference availability</small></div>
          </section>

          <section className="admin-health-panel">
            <div className="admin-section-heading">
              <div><span className="eyebrow">SYSTEM READINESS</span><h2>Production health</h2></div>
              <strong className="readiness-score">{[
                adminOverview?.model_ready,
                adminOverview?.auth?.firebase_project,
                adminOverview?.auth?.admin_allowlist,
                adminOverview?.persistence?.backend === "firebase",
                adminOverview?.persistence?.reachable === true,
              ].filter(Boolean).length * 20}%</strong>
            </div>
            <div className="admin-service-grid">
              {[
                ["AI inference", adminOverview?.model_ready, adminOverview?.model_ready ? "TorchScript model loaded" : "Model unavailable"],
                ["Authentication", adminOverview?.auth?.firebase_project, "Google-signed Firebase tokens"],
                ["Admin policy", adminOverview?.auth?.admin_allowlist, "Verified email allowlist"],
                ["Database mode", adminOverview?.persistence?.backend === "firebase", adminOverview?.persistence?.database || "Checking"],
                ["Cloud connection", adminOverview?.persistence?.reachable === true, adminOverview?.persistence?.reachable === false ? `Blocked: ${adminOverview?.persistence?.error || "configuration"}` : "Database and Storage reachable"],
              ].map(([label,ok,detail]) => <div className={`admin-service ${ok ? "healthy" : "blocked"}`} key={String(label)}><span>{ok ? "✓" : "!"}</span><div><b>{String(label)}</b><small>{String(detail)}</small></div></div>)}
            </div>
          </section>

          <section className="admin-review-queue">
            <div className="admin-section-heading">
              <div><span className="eyebrow">DATASET OBSERVABILITY</span><h2>Class balance</h2></div>
              <span className="admin-count">{adminOverview?.dataset?.total_samples ?? 0} samples</span>
            </div>
            <div className="admin-dataset-grid">
              {Object.entries(adminOverview?.dataset?.classes || {}).map(([label,value]: [string, any]) => {
                const maximum=Math.max(1,...Object.values(adminOverview?.dataset?.classes || {}).map((item:any) => Number(item.total)||0));
                return <div className="admin-dataset-row" key={label}><span>{label.replace("_"," ")}</span><div><i style={{width:`${Math.max(3,(Number(value.total)||0)/maximum*100)}%`}} /></div><b>{value.total}</b><small>{value.user_verified} reviewed</small></div>;
              })}
            </div>
          </section>
          </>}

          {adminTab === "model" &&
          <section className="admin-workspace">
            <div>
              <span className="eyebrow">MODEL DELIVERY / {String(adminOverview?.training_mode || "checking").replace(/_/g," ")}</span>
              <h2>GPU training and controlled release</h2>
              <p>Approved feedback becomes a versioned dataset. Training runs on a dedicated GPU worker, while Render keeps the current model online until the candidate passes accuracy, macro-F1, recall, latency, and regression gates.</p>
              {adminOverview?.training_available ? <button className="btn btn-primary" type="button" onClick={async () => {
                if (!window.confirm("Dispatch GPU training from approved feedback?")) return;
                setAdminMessage("Dispatching the reviewed dataset to the training worker…");
                try {
                  const response = await apiFetch(`${API}/retrain`, { method: "POST" });
                  const data = await response.json();
                  if (!response.ok) throw new Error(data.detail || "Could not start retraining.");
                  setAdminMessage(data.message || "Retraining started.");
                  setAdminOverview((current: any) => ({ ...current, retraining: { status: "running", message: data.message } }));
                } catch (error) {
                  setAdminMessage(error instanceof Error ? error.message : "Could not start retraining.");
                }
              }}>{adminOverview?.training_mode === "external_gpu" ? "Dispatch GPU training" : "Start reviewed training"}</button> : <div className="training-disabled"><b>Training is in review-only mode</b><span>Predictions and approved feedback continue to work. Train approved batches on the local RTX GPU, then use the release gate before deploying a candidate.</span></div>}
              {adminOverview?.retraining?.status === "running" && <p className="admin-live-status"><span className="live-dot" /> Model training is running. Status refreshes automatically.</p>}
              {adminOverview?.retraining?.status === "completed" && <p className="admin-live-status"><span className="live-dot" /> Candidate ready. Review its metrics before promotion.</p>}
            </div>
            <div className="admin-checklist">
              <h3>Before deployment</h3>
              <p>1. Approve corrected labels</p>
              <p>2. Export the reviewed dataset</p>
              <p>3. Train a versioned candidate offline</p>
              <p>4. Compare held-out metrics and regressions</p>
              <p>5. Promote through a reviewed deployment</p>
              <div className="model-metric-mini"><span>Current accuracy <b>{adminOverview?.model_metrics?.test_accuracy != null ? `${(adminOverview.model_metrics.test_accuracy*100).toFixed(1)}%` : "Not recorded"}</b></span><span>Macro F1 <b>{adminOverview?.model_metrics?.macro_f1 != null ? `${(adminOverview.model_metrics.macro_f1*100).toFixed(1)}%` : "Not recorded"}</b></span></div>
            </div>
          </section>}

          {(adminTab === "review" || adminTab === "feedback") && (
            <section className="admin-review-queue">
              <div className="admin-section-heading">
                <div>
                  <span className="eyebrow">HUMAN REVIEW & PLATFORM SCANS</span>
                  <h2>{reviewSubtab === "pending" ? "Pending training feedback" : "All user garment scans"}</h2>
                </div>
                <div className="admin-subtab-switch" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className={`btn ${reviewSubtab === "pending" ? "btn-primary" : "btn-outline"}`}
                    style={{ fontSize: "11px", padding: "6px 14px", height: "auto" }}
                    onClick={() => setReviewSubtab("pending")}
                  >
                    Pending Approvals ({adminFeedback.length})
                  </button>
                  <button
                    type="button"
                    className={`btn ${reviewSubtab === "scans" ? "btn-primary" : "btn-outline"}`}
                    style={{ fontSize: "11px", padding: "6px 14px", height: "auto" }}
                    onClick={() => setReviewSubtab("scans")}
                  >
                    All User Scans ({adminScans.length})
                  </button>
                </div>
              </div>

              {reviewSubtab === "pending" && (
                <>
                  {adminFeedback.length ? adminFeedback.map((item) => (
                    <article className="admin-review-row" key={`${item.fabric}/${item.file}`}>
                      <AdminFeedbackPreview item={item} />
                      <div className="admin-review-copy">
                        <strong>{item.fabric}</strong>
                        {item.original_fabric && <span>Model predicted: {item.original_fabric}</span>}
                        <small>{item.filename || item.file}</small>
                      </div>
                      <div className="admin-row-actions">
                        <button type="button" className="btn btn-primary" onClick={async () => {
                          const response = await apiFetch(`${API}/admin/feedback/${encodeURIComponent(item.fabric)}/${encodeURIComponent(item.file)}/approve`, { method: "POST" });
                          if (response.ok) setAdminFeedback((items) => items.filter((candidate) => candidate.file !== item.file));
                          else setAdminMessage("Could not approve this feedback item.");
                        }}>Approve label</button>
                        <button type="button" className="btn btn-outline" onClick={async () => {
                          if (!window.confirm("Reject this feedback image?")) return;
                          const response = await apiFetch(`${API}/admin/feedback/${encodeURIComponent(item.fabric)}/${encodeURIComponent(item.file)}`, { method: "DELETE" });
                          if (response.ok) setAdminFeedback((items) => items.filter((candidate) => candidate.file !== item.file));
                          else setAdminMessage("Could not reject this feedback item.");
                        }}>Reject</button>
                      </div>
                    </article>
                  )) : <p className="admin-empty">No feedback is waiting for review. New user corrections will appear here for approval.</p>}
                </>
              )}

              {reviewSubtab === "scans" && (
                <div className="admin-scans-list" style={{ display: "grid", gap: "10px", marginTop: "14px" }}>
                  {adminScans.length ? adminScans.map((scan: any) => (
                    <article className="admin-review-row admin-scan-card" key={String(scan.id)}>
                      <div className="admin-user-avatar" style={{ fontSize: "20px", background: "rgba(67,214,162,0.12)", color: "#43d6a2" }}>
                        🧺
                      </div>
                      <div className="admin-review-copy">
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
                          <strong style={{ textTransform: "capitalize", fontSize: "14px" }}>{scan.fabric || "Unknown"}</strong>
                          <span className="admin-badge ok" style={{ fontSize: "10px" }}>{Math.round((scan.confidence || 0) * 100)}% confidence</span>
                          {scan.user_feedback ? (
                            scan.user_feedback.was_correct ? (
                              <span className="admin-badge ok" style={{ fontSize: "10px" }}>✓ User confirmed</span>
                            ) : (
                              <span className="admin-badge warn" style={{ fontSize: "10px" }}>⚠️ Corrected to {scan.user_feedback.confirmed_fabric}</span>
                            )
                          ) : (
                            <span className="admin-badge" style={{ fontSize: "10px", background: "rgba(255,255,255,0.06)", color: "#8ca69b" }}>Scan record</span>
                          )}
                        </div>
                        {scan.note && <p style={{ margin: "2px 0 4px", color: "#c2d6ce", fontSize: "12px" }}>"{scan.note}"</p>}
                        <small style={{ color: "#78968a" }}>{scan.created_at ? new Date(scan.created_at).toLocaleString() : "Date recorded"} • User UID: {String(scan.owner_uid || scan.id || "").slice(0, 10)}</small>
                      </div>
                    </article>
                  )) : <p className="admin-empty">No scan records recorded yet.</p>}
                </div>
              )}
            </section>
          )}

          {adminTab === "users" &&
          <section className="admin-review-queue admin-users">
            <div className="admin-section-heading">
              <div><span className="eyebrow">ACCESS CONTROL</span><h2>Users and administrator roles</h2></div>
              <span className="admin-count">{adminUsers.length} users</span>
            </div>
            <p className="admin-section-copy">Grant only trusted accounts administrator access. Role changes take effect after the user signs out and signs in again.</p>
            {adminUsers.length ? adminUsers.map((account) => (
              <article className="admin-user-row" key={account.uid}>
                <div className="admin-user-avatar">{account.picture ? <img src={account.picture} alt="" referrerPolicy="no-referrer" /> : (account.email || "?").charAt(0).toUpperCase()}</div>
                <div className="admin-review-copy">
                  <strong>{account.name || account.email || "Unnamed user"}</strong>
                  <small>{account.email || account.uid}</small>
                  <div className="admin-badges">
                    <span className={account.email_verified ? "ok" : "warn"}>{account.email_verified ? "Verified" : "Unverified"}</span>
                    {account.is_admin && <span className="admin-badge">Admin</span>}
                    {account.disabled && <span className="danger">Disabled</span>}
                  </div>
                </div>
                <div className="admin-row-actions">
                  <button type="button" className="btn btn-outline" disabled={account.uid === user.uid && account.is_admin} onClick={async () => {
                    const next=!account.is_admin;
                    const response=await apiFetch(`${API}/admin/users/${encodeURIComponent(account.uid)}/role`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({is_admin:next})});
                    if (response.ok) setAdminUsers((items) => items.map((item) => item.uid === account.uid ? {...item,is_admin:next} : item));
                    else setAdminMessage((await response.json()).detail || "Could not update this role.");
                  }}>{account.is_admin ? "Remove admin" : "Make admin"}</button>
                  <button type="button" className={`btn ${account.disabled ? "btn-primary" : "btn-outline"}`} disabled={account.uid === user.uid} onClick={async () => {
                    const next=!account.disabled;
                    if (next && !window.confirm(`Disable ${account.email || "this user"}?`)) return;
                    const response=await apiFetch(`${API}/admin/users/${encodeURIComponent(account.uid)}/status`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({disabled:next})});
                    if (response.ok) setAdminUsers((items) => items.map((item) => item.uid === account.uid ? {...item,disabled:next} : item));
                    else setAdminMessage((await response.json()).detail || "Could not update this account.");
                  }}>{account.disabled ? "Enable user" : "Disable user"}</button>
                </div>
              </article>
            )) : <p className="admin-empty">No Firebase users could be loaded.</p>}
          </section>}

          {adminTab === "reference" && <section className="admin-reference">
            <div className="admin-section-heading"><div><span className="eyebrow">OPERATIONS REFERENCE</span><h2>Runbook and service endpoints</h2></div><span className="admin-count">Production</span></div>
            <p className="admin-section-copy">Use these links and checks to diagnose the platform without leaving the control center.</p>
            <div className="admin-reference-grid">
              <article><span>01</span><h3>API health</h3><p>Confirm model readiness and Firebase persistence reachability.</p><a href={`${API}/health`} target="_blank" rel="noreferrer">Open health endpoint ↗</a></article>
              <article><span>02</span><h3>API documentation</h3><p>Inspect request formats and test authorized service endpoints.</p><a href={`${API.replace(/\/api$/,"")}/docs`} target="_blank" rel="noreferrer">Open API docs ↗</a></article>
              <article><span>03</span><h3>Review workflow</h3><p>User corrections stay pending until an administrator approves or rejects them.</p><button type="button" onClick={() => setAdminTab("review")}>Open review queue →</button></article>
              <article><span>04</span><h3>Release workflow</h3><p>Only promote a candidate after held-out metrics and regression checks pass.</p><button type="button" onClick={() => setAdminTab("model")}>Open model release →</button></article>
            </div>
          </section>}
            </MotionPanel>
          </div>
        </main>
      )}

      {/* ========================================================
          ABOUT PAGE
          ======================================================== */}
      {page === "about" && (
        <main className="page-container">
          <Reveal>
          <div style={{ maxWidth: "840px", margin: "0 auto" }}>
            <span className="eyebrow">ABOUT THE PLATFORM</span>
            <h1><TextEffect>Built for clearer garment care.</TextEffect></h1>
            <p style={{ color: "var(--text-muted)", fontSize: "17px", lineHeight: "1.6", marginBottom: "28px" }}>
              LaundryAI is an AI-powered textile intelligence system developed to bridge computer vision with household fabric care and environmental sustainability.
            </p>

            <div className="workspace-panel" style={{ marginBottom: "24px" }}>
              <h3>Technology Stack</h3>
              <div className="care-profile-grid" style={{ marginTop: "16px" }}>
                <div className="care-card">
                  <div className="care-card-icon">⚡</div>
                  <div className="care-card-label">BACKEND</div>
                  <div className="care-card-value">FastAPI (Python)</div>
                </div>
                <div className="care-card">
                  <div className="care-card-icon">🧠</div>
                  <div className="care-card-label">AI INFERENCE</div>
                  <div className="care-card-value">PyTorch TorchScript</div>
                </div>
                <div className="care-card">
                  <div className="care-card-icon">⚛️</div>
                  <div className="care-card-label">FRONTEND</div>
                  <div className="care-card-value">React + TypeScript</div>
                </div>
                <div className="care-card">
                  <div className="care-card-icon">💾</div>
                  <div className="care-card-label">DATABASE</div>
                  <div className="care-card-value">SQLite3 Engine</div>
                </div>
              </div>
            </div>

            <div className="workspace-panel">
              <h3>Advisory Notice</h3>
              <p style={{ color: "var(--text-muted)", marginTop: "8px", lineHeight: "1.6" }}>
                LaundryAI recommendations are computational assistance intended to complement garment maintenance. Manufacturer care labels remain authoritative. Always check garments for specialized trims, linings, and dry-clean-only instructions.
              </p>
            </div>
          </div>
          </Reveal>
        </main>
      )}

      {/* Multi-Column Professional Footer */}
      <footer className="app-footer">
        <div className="footer-grid">
          <div className="footer-brand">
            <h3>🧺 LaundryAI</h3>
            <p>AI-assisted fabric intelligence for safer, smarter, and more sustainable domestic garment care.</p>
          </div>
          <div className="footer-col">
            <h4>Platform</h4>
            <ul className="footer-links">
              <li><button type="button" onClick={() => setPage("home")}>Home</button></li>
              <li><button type="button" onClick={() => setPage("analyze")}>Analyze Garment</button></li>
              <li><button type="button" onClick={() => setPage("insights")}>Model Transparency</button></li>
              <li><button type="button" onClick={() => setPage("library")}>Fabric Care Guide</button></li>
            </ul>
          </div>
          <div className="footer-col">
            <h4>System</h4>
            <ul className="footer-links">
              <li><button type="button" onClick={() => setPage("about")}>How it works</button></li>
              {user.is_admin && <li><button type="button" onClick={() => setPage("admin")}>Admin operations</button></li>}
            </ul>
          </div>
          <div className="footer-col">
            <h4>Important Notice</h4>
            <div className="footer-disclaimer-box">
              AI predictions are advisory. Always check and follow manufacturer care tags when available.
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© 2026 LaundryAI • Computer Vision × Textile Intelligence Platform</span>
          <span>See the Fabric. Understand the Care.</span>
        </div>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<AuthGate />);
