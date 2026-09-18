import { useState } from "react";
import { useI18n } from "../i18n";
import { readTempUnit } from "../lib";
import HomePage from "./HomePage";
import LibraryPage from "./LibraryPage";
import SiteFooter from "./SiteFooter";

/**
 * What a first-time visitor sees: a fully browsable platform (home + care
 * guide are 100% client-side) with a single clear action — sign in.
 * No backend changes are needed because these pages make no API calls.
 */
export default function PublicLanding({ onSignIn }: { onSignIn: () => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<"home" | "library">("home");
  const tempUnit = readTempUnit();
  const [fabricKey, setFabricKey] = useState("cotton");

  const openLibrary = (key?: string) => {
    if (key) setFabricKey(key);
    setView("library");
  };

  return (
    <>
      <header className="app-header public-header">
<button className="brand-logo" onClick={() => setView("home")} aria-label="LaundryAI home">
          <div className="logo-icon">🧺</div>
          <div>
            <span className="logo-text">LaundryAI</span>
            <span className="logo-tag">Fabric Intelligence</span>
          </div>
        </button>
        <nav className="public-nav" aria-label="Public navigation">
          <button type="button" className={view === "home" ? "active" : ""} onClick={() => setView("home")}>
            {t("nav.home")}
          </button>
          <button type="button" className={view === "library" ? "active" : ""} onClick={() => setView("library")}>
            {t("nav.library")}
          </button>
        </nav>
        <button className="public-signin" type="button" onClick={onSignIn}>
          {t("landing.signIn")}
          <span aria-hidden="true"> →</span>
        </button>
      </header>

      {view === "home" ? (
        <HomePage isPublic onPrimaryCta={onSignIn} onLibrary={openLibrary} />
      ) : (
        <LibraryPage initialKey={fabricKey} tempUnit={tempUnit} />
      )}

      <SiteFooter
        onHome={() => setView("home")}
        onGuide={() => setView("library")}
        onResearch={onSignIn}
        onAbout={onSignIn}
        onScan={onSignIn}
      />
    </>
  );
}
