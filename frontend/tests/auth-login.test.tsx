/**
 * Login regression tests.
 *
 * The recurring "login problem" in this app is silent failure after Firebase
 * itself succeeds: the auth-state listener is the ONLY thing that calls setUser,
 * so if it is never registered (backend probe failed / threw) or if storage
 * access throws mid-flow, the sign-in popup closes and nothing happens.
 *
 * These tests drive the real AuthGate DOM through those exact conditions.
 */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The app self-mounts via createRoot (main.tsx), outside of RTL's render().
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no matchMedia; components query it for responsive/reduced-motion.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom has no IntersectionObserver either (scroll-reveal, count-ups). Report
// everything as visible so animations settle immediately.
if (typeof window.IntersectionObserver !== "function") {
  class FakeIntersectionObserver {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      queueMicrotask(() =>
        this.callback(
          [{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        ),
      );
    }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  window.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
}

const mocks = vi.hoisted(() => {
  type Listener = (user: unknown) => void;
  const state = {
    listeners: [] as Listener[],
    apps: [] as unknown[],
    persistenceCalls: [] as unknown[],
    signInCalls: [] as { email: string; password: string }[],
    googleCalls: 0,
    signedInUser: null as Record<string, unknown> | null,
    fetchImpl: ((_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>) as (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>,
  };
  state.fetchImpl = () => Promise.reject(new TypeError("Failed to fetch"));
  return state;
});

vi.mock("firebase/app", () => ({
  getApps: () => mocks.apps,
  getApp: () => mocks.apps[0],
  initializeApp: (config: unknown) => {
    const app = { name: "[DEFAULT]", options: config };
    mocks.apps.push(app);
    return app;
  },
}));

vi.mock("firebase/auth", () => {
  const emit = (user: Record<string, unknown> | null) => {
    for (const listener of [...mocks.listeners]) listener(user);
  };
  const fakeUser = () =>
    mocks.signedInUser ?? {
      uid: "user-1",
      email: "ada@example.com",
      displayName: "Ada",
      photoURL: null,
      emailVerified: true,
      providerData: [{ providerId: "password" }],
      getIdToken: async () => "header." + btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })) + ".sig",
    };
  return {
    getAuth: () => ({ currentUser: null }),
    setPersistence: vi.fn(async (_auth: unknown, persistence: unknown) => {
      mocks.persistenceCalls.push(persistence);
    }),
    onAuthStateChanged: vi.fn((_auth: unknown, listener: (user: unknown) => void) => {
      mocks.listeners.push(listener);
      listener(null);
      return () => {
        mocks.listeners = mocks.listeners.filter((item) => item !== listener);
      };
    }),
    signInWithEmailAndPassword: vi.fn(async (_auth: unknown, email: string, password: string) => {
      mocks.signInCalls.push({ email, password });
      queueMicrotask(() => emit(fakeUser()));
      return { user: fakeUser() };
    }),
    createUserWithEmailAndPassword: vi.fn(async (_auth: unknown, _email: string, _password: string) => {
      const user = { ...fakeUser(), emailVerified: false };
      queueMicrotask(() => emit(user));
      return { user };
    }),
    signInWithPopup: vi.fn(async () => {
      mocks.googleCalls += 1;
      queueMicrotask(() => emit(fakeUser()));
      return { user: fakeUser() };
    }),
    signOut: vi.fn(async () => {
      queueMicrotask(() => emit(null));
    }),
    sendEmailVerification: vi.fn(async () => undefined),
    sendPasswordResetEmail: vi.fn(async () => undefined),
    GoogleAuthProvider: class {
      setCustomParameters() {}
    },
    browserSessionPersistence: "browser-session",
    inMemoryPersistence: "in-memory",
  };
});

vi.mock("firebase/database", () => ({
  getDatabase: () => ({}),
  ref: () => ({}),
  set: vi.fn(async () => undefined),
}));

vi.mock("motion/react", async () => {
  const React = await import("react");
  const stripMotionProps = ({
    initial: _initial,
    animate: _animate,
    exit: _exit,
    whileHover: _whileHover,
    whileTap: _whileTap,
    whileInView: _whileInView,
    transition: _transition,
    viewport: _viewport,
    variants: _variants,
    ...rest
  }: Record<string, unknown>) => rest;
  const cache = new Map<string, unknown>();
  const component = (tag: string) => {
    if (!cache.has(tag)) {
      cache.set(
        tag,
        React.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) =>
          React.createElement(tag, { ...stripMotionProps(props), ref }),
        ),
      );
    }
    return cache.get(tag);
  };
  const motion = new Proxy({}, { get: (_target, tag) => component(String(tag)) });
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useReducedMotion: () => true,
  };
});

async function loadApp() {
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import("../src/main");
  });
}

function openLoginScreen(typeCredentials = true) {
  // The landing page shows "Sign in" as feature tags too; only the header
  // control is a button with that exact accessible name (the arrow is aria-hidden).
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  if (!typeCredentials) return;
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "ada@example.com" } });
  fireEvent.change(screen.getByPlaceholderText("Enter your password"), { target: { value: "secret123" } });
}

beforeEach(() => {
  mocks.listeners = [];
  mocks.apps = [];
  mocks.persistenceCalls = [];
  mocks.signInCalls = [];
  mocks.googleCalls = 0;
  mocks.signedInUser = null;
  mocks.fetchImpl = () => Promise.reject(new TypeError("Failed to fetch"));
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => mocks.fetchImpl(input, init));
  window.sessionStorage.clear();
  window.localStorage.clear();
  for (const key of ["VITE_FIREBASE_API_KEY", "VITE_FIREBASE_AUTH_DOMAIN", "VITE_FIREBASE_PROJECT_ID", "VITE_FIREBASE_STORAGE_BUCKET", "VITE_FIREBASE_MESSAGING_SENDER_ID", "VITE_FIREBASE_APP_ID", "VITE_FIREBASE_DATABASE_URL", "VITE_API_URL"]) {
    vi.stubEnv(key, "");
  }
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("AuthGate login", () => {
  it("completes sign-in even when the backend config probe is unreachable", async () => {
    // Regression: with VITE web config present but /api/auth/config failing
    // (CORS-blocked preview host, sleeping API), the old code enabled the login
    // form but never registered onAuthStateChanged — Firebase signed in and the
    // app did nothing.
    vi.stubEnv("VITE_FIREBASE_API_KEY", "web-api-key");
    vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "demo.firebaseapp.com");
    vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "demo");
    vi.stubEnv("VITE_FIREBASE_APP_ID", "1:1:web:1");

    await loadApp();
    await waitFor(() => expect(mocks.listeners.length).toBe(1));

    openLoginScreen();
    fireEvent.click(screen.getByText("LOGIN"));

    await waitFor(() => expect(mocks.signInCalls).toEqual([{ email: "ada@example.com", password: "secret123" }]));
    expect(await screen.findByText("Sign out")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("completes sign-in from the backend-provided config and survives a malformed verify payload", async () => {
    mocks.fetchImpl = async (input) => {
      if (String(input).includes("/api/auth/config")) {
        return new Response(
          JSON.stringify({
            enabled: true,
            firebase_config: {
              apiKey: "server-api-key",
              authDomain: "demo.firebaseapp.com",
              projectId: "demo",
              appId: "1:1:web:1",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // A 200 body without account fields used to replace the working local
      // account and crash the workspace on render (user.name.charAt).
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };

    await loadApp();
    await waitFor(() => expect(mocks.listeners.length).toBe(1));

    openLoginScreen();
    fireEvent.click(screen.getByText("LOGIN"));
    expect(await screen.findByText("Sign out")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("keeps Google sign-in working when Web Storage is blocked", async () => {
    // Privacy-restricted browsers and in-app webviews throw on storage access.
    // The old code aborted before signInWithPopup and could never complete.
    vi.stubEnv("VITE_FIREBASE_API_KEY", "web-api-key");
    vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "demo.firebaseapp.com");
    vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "demo");
    vi.stubEnv("VITE_FIREBASE_APP_ID", "1:1:web:1");
    const deny = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(deny);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(deny);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(deny);

    await loadApp();
    await waitFor(() => expect(mocks.listeners.length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByText("Continue with Google"));

    await waitFor(() => expect(mocks.googleCalls).toBe(1));
    expect(await screen.findByText("Sign out")).toBeTruthy();
    // Sessions fall back to in-memory persistence when storage is unavailable.
    expect(mocks.persistenceCalls[mocks.persistenceCalls.length - 1]).toBe("in-memory");

    vi.restoreAllMocks();
  });

  it("still offers guest access when Firebase is not configured at all", async () => {
    await loadApp();
    await waitFor(() => expect(mocks.listeners.length).toBe(0));

    openLoginScreen(false);
    fireEvent.click(screen.getByText(/CONTINUE AS GUEST/));
    expect(await screen.findByText("Sign out")).toBeTruthy();
    expect(mocks.signInCalls).toEqual([]);
  });
});
