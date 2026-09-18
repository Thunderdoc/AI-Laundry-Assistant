import { useI18n } from "../i18n";

type SiteFooterProps = {
  onHome: () => void;
  onGuide: () => void;
  onResearch: () => void;
  onAbout: () => void;
  onScan: () => void;
  /** Omitted for public visitors — the admin link only appears for admins. */
  onAdmin?: () => void;
};

export default function SiteFooter({ onHome, onGuide, onResearch, onAbout, onScan, onAdmin }: SiteFooterProps) {
  const { t } = useI18n();
  return (
    <footer className="app-footer">
      <div className="footer-grid">
        <div className="footer-brand">
          <h3>🧺 LaundryAI</h3>
          <p>AI-assisted fabric intelligence for safer, smarter, and more sustainable domestic garment care.</p>
        </div>
        <div className="footer-col">
          <h4>Platform</h4>
          <ul className="footer-links">
            <li><button type="button" onClick={onHome}>Home</button></li>
            <li><button type="button" onClick={onScan}>Analyze Garment</button></li>
            <li><button type="button" onClick={onResearch}>Model Transparency</button></li>
            <li><button type="button" onClick={onGuide}>Fabric Care Guide</button></li>
          </ul>
        </div>
        <div className="footer-col">
          <h4>System</h4>
          <ul className="footer-links">
            <li><button type="button" onClick={onAbout}>How it works</button></li>
            {onAdmin ? <li><button type="button" onClick={onAdmin}>Admin Control Room</button></li> : null}
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
        <span>See the fabric. Understand the care.</span>
      </div>
    </footer>
  );
}
