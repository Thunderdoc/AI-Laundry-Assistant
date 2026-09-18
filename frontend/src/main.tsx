import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { createRoot } from "react-dom/client";
import { getApp, getApps, initializeApp } from "firebase/app";
import { browserSessionPersistence, createUserWithEmailAndPassword, getAuth, GoogleAuthProvider, onAuthStateChanged, sendEmailVerification, sendPasswordResetEmail, setPersistence, signInWithEmailAndPassword, signInWithPopup, signOut } from "firebase/auth";
import { getDatabase, ref, set } from "firebase/database";
import { MotionButton, MotionDiv, MotionPage, MotionSection, Reveal, TextEffect } from "./motion-primitives";
import {
  API,
  AUTH_SESSION_KEY,
  NOTE_MAX_LENGTH,
  apiFetch,
  clearStoredToken,
  convertTempText,
  fetchWithTimeout,
  readTempUnit,
  writeStoredToken,
  writeTempUnit,
  withTimeout,
  type Analytics,
  type DatasetStats,
  type FirebaseSettings,
  type ImageAssessment,
  type Prediction,
  type SignedInUser,
  type TempUnit,
} from "./lib";
import { FABRICS_DATA, PRESET_TAGS, STAIN_GUIDE } from "./data";
import { LANGS, LangProvider, useI18n } from "./i18n";
import AdminConsole from "./components/AdminConsole";
import CareAssistant from "./components/CareAssistant";
import CareSymbols from "./components/CareSymbols";
import HistoryPage from "./components/HistoryPage";
import "./style.css";

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

function AuthGate() {
  const { t } = useI18n();
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
              writeStoredToken(idToken);
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
    clearStoredToken();
    sessionStorage.removeItem(AUTH_SESSION_KEY);
    setVerificationPending(false);
    setAuthNotice("");
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
        <p className="login-eyebrow">{t("login.eyebrow")}</p>
        <h1 id="login-title"><TextEffect>{t("login.title")}</TextEffect></h1>
        <p className="login-copy">{t("login.copy")}</p>
        {settings === null ? <div className="login-loading">Connecting to secure sign-in…</div> : (
          <>
            <form className={`email-login ${settings.enabled ? "" : "credentials-disabled"}`} onSubmit={handleEmailLogin}>
              <label>Email<input type="email" autoComplete="email" required disabled={!settings.enabled} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
              <label>Password<input type="password" autoComplete={isRegistering ? "new-password" : "current-password"} minLength={6} required disabled={!settings.enabled} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" /></label>
              {!isRegistering && <button className="forgot-password" type="button" onClick={handlePasswordReset} disabled={!settings.enabled || isSigningIn}>{t("login.forgot")}</button>}
              <button className="email-login-submit" disabled={!settings.enabled || isSigningIn}>{isSigningIn ? "…" : isRegistering ? t("login.register") : t("login.login")}</button>
            </form>
            {settings.enabled ? <>
              <button className="auth-switch" type="button" onClick={() => setIsRegistering((value) => !value)}>{isRegistering ? t("login.have") : t("login.new")}</button>
              {verificationPending && <button className="auth-switch verification-link" type="button" onClick={handleResendVerification}>Resend verification email</button>}
              <div className="auth-divider"><span>or</span></div>
              <MotionButton whileHover={{ y: -2 }} whileTap={{ scale: .985 }} className="google-login" onClick={handleGoogleLogin} disabled={isSigningIn}>
                <span className="google-g">G</span>{t("login.google")}
              </MotionButton>
            </> : <>
              <div className="auth-setup"><strong>Firebase setup pending</strong><br />Email, password and Google sign-in will activate after deployment.</div>
              <button className="email-login-submit guest-entry" type="button" onClick={continueAsGuest}>CONTINUE AS GUEST <span>→</span></button>
            </>}
          </>
        )}
        {authNotice && <p className="login-notice" role="status">{authNotice}</p>}
        {authError && <p className="login-error" role="alert">{authError}</p>}
        <small>{t("login.footnote")}</small>
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

type Page = "home" | "analyze" | "insights" | "library" | "history" | "assistant" | "admin" | "about";

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
  const reduceMotion = useReducedMotion();
  const [page, setPage] = useState<Page>("home");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { t, lang, setLang } = useI18n();
  const [tempUnit, setTempUnit] = useState<TempUnit>(readTempUnit);
  const [langOpen, setLangOpen] = useState(false);
  const changeTempUnit = (unit: TempUnit) => { setTempUnit(unit); writeTempUnit(unit); };
  const [file, setFile] = useState<File | undefined>();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState("");
  const [isErrorStatus, setIsErrorStatus] = useState(false);
  const [analysisStep, setAnalysisStep] = useState<number>(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<Prediction | undefined>();
  const [history, setHistory] = useState<Prediction[]>([]);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [analytics, setAnalytics] = useState<Analytics | undefined>();
  const [datasetStats, setDatasetStats] = useState<DatasetStats | undefined>();
  const [modelMetrics, setModelMetrics] = useState<any>(null);
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
      const [historyResponse, analyticsResponse] = await Promise.all([
        apiFetch(`${API}/history`).catch(() => null),
        apiFetch(`${API}/analytics`).catch(() => null),
      ]);
      // A rejected session must never be written into state: an error payload is
      // an object, and rendering it as scan history used to blank the whole app.
      if (historyResponse?.status === 401 || analyticsResponse?.status === 401) {
        setSessionExpired(true);
      } else if (historyResponse?.ok || analyticsResponse?.ok) {
        setSessionExpired(false);
      }
      if (historyResponse?.ok) {
        const records = await historyResponse.json().catch(() => null);
        if (Array.isArray(records)) setHistory(records);
      }
      if (analyticsResponse?.ok) {
        const summary = await analyticsResponse.json().catch(() => null);
        if (summary && typeof summary === "object" && !Array.isArray(summary)) setAnalytics(summary);
      }
      const statsRes = await apiFetch(`${API}/dataset/stats`).catch(() => null);
      if (statsRes?.ok) {
        const stats = await statsRes.json().catch(() => null);
        if (stats) setDatasetStats(stats);
      }
      const metricsRes = await apiFetch(`${API}/model/metrics`).catch(() => null);
      if (metricsRes?.ok) {
        const m = await metricsRes.json().catch(() => null);
        if (m?.available && m.metrics) setModelMetrics(m.metrics);
      }
    } catch {
      // The backend may be asleep or offline. Keep whatever is already on screen.
    }
  };

  useEffect(() => {
    void load();
  }, []);


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
        if (response.status === 401) setSessionExpired(true);
        throw data;
      }
      setSessionExpired(false);
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
      const data = await response.json().catch(() => ({} as { message?: string; detail?: string }));
      if (!response.ok) {
        if (response.status === 401) setSessionExpired(true);
        setFeedbackMessage(typeof data?.detail === "string" ? data.detail : "Feedback could not be submitted right now. Try again shortly.");
        return;
      }
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
      {sessionExpired && (
        <div className="session-expired" role="alert">
          <span><strong>Your sign-in session was rejected.</strong> History and analysis are paused until you sign in again.</span>
          <button type="button" onClick={() => void onSignOut()}>Sign in again</button>
        </div>
      )}
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
          {nav("home", t("nav.home"))}
          {nav("analyze", t("nav.analyze"))}
          {nav("insights", t("nav.model"))}
          {nav("library", t("nav.library"))}
          {nav("history", t("nav.history"))}
          {nav("assistant", t("nav.assistant"))}
          {user.is_admin && nav("admin", t("nav.admin"))}
        </nav>

        <div className="header-tools">
          <div className="temp-toggle" role="group" aria-label="Temperature unit">
            <button type="button" className={tempUnit === "C" ? "active" : ""} onClick={() => changeTempUnit("C")} title="Celsius">°C</button>
            <button type="button" className={tempUnit === "F" ? "active" : ""} onClick={() => changeTempUnit("F")} title="Fahrenheit">°F</button>
          </div>
          <div className="lang-switch">
            <button type="button" onClick={() => setLangOpen((value) => !value)} aria-haspopup="listbox" aria-expanded={langOpen}>
              🌐 {lang.toUpperCase()}
            </button>
            {langOpen && (
              <div className="lang-menu" role="listbox" aria-label="Language">
                {LANGS.map((option) => (
                  <button key={option.code} type="button" role="option" aria-selected={lang === option.code} className={lang === option.code ? "active" : ""} onClick={() => { setLang(option.code); setLangOpen(false); }}>
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <button className="header-cta" onClick={() => setPage("analyze")}>
          <span>+</span> {t("cta.analyze")}
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
        <MotionPage className="page-container">
          {/* Hero Section */}
          <section className="hero-grid">
            <Reveal className="hero-left">
              <span className="eyebrow">{t("hero.eyebrow")}</span>
              <h1>
                <TextEffect>{t("hero.title")}</TextEffect> <br />
                <span className="serif">{t("hero.titleSerif")}</span>
              </h1>
              <p className="lead">
                {t("hero.lead")}
              </p>
              <div className="hero-actions">
                <MotionButton whileHover={{ y: -3 }} whileTap={{ scale: .98 }} className="btn btn-primary" onClick={() => setPage("analyze")}>
                  {t("hero.primary")} →
                </MotionButton>
                <button className="btn btn-secondary" onClick={() => setPage("library")}>
                  {t("hero.secondary")}
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
        </MotionPage>
      )}

      {/* ========================================================
          ANALYZE PAGE (3-STAGE WORKSPACE WITH ACTIVE LEARNING)
          ======================================================== */}
      {page === "analyze" && (
        <MotionPage className="page-container">
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
              <h2><TextEffect>{t("analyze.title")}</TextEffect></h2>
              <p style={{ color: "var(--text-muted)", marginBottom: "20px" }}>
                {t("analyze.subtitle")}
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
                  {t("analyze.upload")}
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => useCamera("environment")}>
                  {t("analyze.camera")}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!file}
                  onClick={() => onFileChange(undefined)}
                >
                  {t("analyze.clear")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1, minWidth: "160px" }}
                  disabled={!file || isAnalyzing || !!noteError}
                  onClick={analyze}
                >
                  {isAnalyzing ? t("analyze.analyzing") : `✨ ${t("analyze.run")}`}
                </button>
              </div>

              {/* Multi-step Processing Animation */}
              {isAnalyzing && (
                <MotionDiv className="processing-screen" initial={reduceMotion ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .25, ease: "easeOut" }}>
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
                </MotionDiv>
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
              <MotionSection style={{ marginTop: "32px" }} initial={reduceMotion ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .35, ease: "easeOut" }}>
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
                      <div className="confidence-bar-fill" style={{ transform: `scaleX(${Math.min(100, Math.max(5, result.confidence)) / 100})` }}></div>
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
                              <div className="care-card-value">{convertTempText(result.recommendation.wash.temperature, tempUnit)}</div>
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
                                  🌡️ Wash at <strong>{convertTempText(result.recommendation.wash.temperature, tempUnit)}</strong> · {result.recommendation.wash.cycle} cycle
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
                            const text = `🧺 LaundryAI Care Profile\nFabric: ${result.fabric.toUpperCase()} (${result.confidence}% confidence)\nWash: ${convertTempText(result.recommendation.wash.temperature, tempUnit)} · ${result.recommendation.wash.cycle}\nDry: ${result.recommendation.dry}\nIron: ${result.recommendation.iron}\nBleach: ${result.recommendation.bleach}\nEco Tip: ${result.recommendation.eco.join(" ")}`;
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
              </MotionSection>
            )}
          </Reveal>
        </MotionPage>
      )}

      {/* ========================================================
          INSIGHTS PAGE (ANALYTICS & DATASET STATS)
          ======================================================== */}
      {page === "insights" && (
        <MotionPage className="page-container">
          <Reveal>
          <span className="eyebrow">MODEL METRICS & USAGE</span>
          <h1><TextEffect>{t("insights.title")}</TextEffect></h1>
          <p style={{ color: "var(--text-muted)", marginBottom: "32px" }}>
            {t("insights.subtitle")}
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
              {Array.isArray(history) && history.length ? (
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
        </MotionPage>
      )}

      {/* ========================================================
          FABRIC LIBRARY & COMPARISON
          ======================================================== */}
      {page === "library" && (
        <MotionPage className="page-container">
          <Reveal>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "12px", marginBottom: "20px" }}>
            <div>
              <span className="eyebrow">TEXTILE KNOWLEDGE BASE</span>
              <h1><TextEffect>{t("library.title")}</TextEffect></h1>
            </div>
            <MotionButton
              whileHover={{ y: -2 }}
              whileTap={{ scale: .985 }}
              className="btn btn-secondary"
              onClick={() => setCompareActive(!compareActive)}
            >
              {compareActive ? "View Single Fabric" : `📊 ${t("library.compare")}`}
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
                        <div className="care-card-value">{convertTempText(current.washTemp, tempUnit)}</div>
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

          <div style={{ marginTop: "40px" }}>
            <CareSymbols />
          </div>
          </Reveal>
        </MotionPage>
      )}

      {page === "history" && user.is_admin && <AdminConsole user={user} />}

      {/* ========================================================
          HISTORY PAGE (My Scans)
          ======================================================== */}
      {page === "history" && (
        <MotionPage className="page-container">
          <HistoryPage />
        </MotionPage>
      )}

      {/* ========================================================
          CARE ASSISTANT PAGE
          ======================================================== */}
      {page === "assistant" && (
        <MotionPage className="page-container">
          <CareAssistant />
        </MotionPage>
      )}

      {/* ========================================================
          ABOUT PAGE
          ======================================================== */}
      {page === "about" && (
        <MotionPage className="page-container">
          <Reveal>
          <div style={{ maxWidth: "840px", margin: "0 auto" }}>
            <span className="eyebrow">ABOUT THE PLATFORM</span>
            <h1><TextEffect>{t("about.title")}</TextEffect></h1>
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
                              <div className="care-card-value">Firebase RTDB (cloud) · SQLite (local dev)</div>
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
        </MotionPage>
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
              {t("footer.disclaimer")}
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

/**
 * React unmounts the whole tree when a render throws, which leaves a blank
 * white page with no explanation. This boundary keeps a recoverable message on
 * screen instead, so one unexpected value can never hide the whole application.
 */
class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("LaundryAI interface error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="crash-shell" role="alert">
        <div className="crash-panel">
          <span className="eyebrow">UNEXPECTED INTERFACE ERROR</span>
          <h1>The workspace could not finish rendering.</h1>
          <p className="crash-detail">{this.state.error.message || "An unknown rendering error occurred."}</p>
          <div className="crash-actions">
            <button type="button" className="btn btn-primary" onClick={() => this.setState({ error: null })}>Try again</button>
            <button type="button" className="btn btn-outline" onClick={() => window.location.reload()}>Reload the app</button>
          </div>
          <small>Your sign-in is preserved. If this repeats, send the message above to the administrator.</small>
        </div>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <LangProvider>
      <AuthGate />
    </LangProvider>
  </AppErrorBoundary>,
);

