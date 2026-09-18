// Lightweight i18n for user-facing UI chrome (navigation, page titles, core
// actions, login, footer). Long-form care content and the admin console stay
// in English on purpose: care instructions must remain unambiguous and
// cross-checked against standards, and the admin workspace is for operators.
// Language choice is persisted in localStorage and never sent to the API.

import { createContext, useContext, useState, type ReactNode } from "react";
import { readLang, writeLang } from "./lib";

export type Lang = "en" | "es" | "de" | "fr";

export const LANGS: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
];

const en: Record<string, string> = {
  "nav.home": "Home",
  "nav.analyze": "Analyze",
  "nav.model": "Model",
  "nav.library": "Care Guide",
  "nav.history": "My Scans",
  "nav.assistant": "Assistant",
  "nav.admin": "Admin",
  "cta.analyze": "Analyze Garment",

  "login.eyebrow": "FABRIC CARE INTELLIGENCE",
  "login.back": "Keep exploring",
  "landing.signIn": "Sign in",
  "login.title": "Welcome back",
  "login.copy": "Sign in to analyze garments and access your personalized fabric-care guidance.",
  "login.login": "LOGIN",
  "login.register": "CREATE ACCOUNT",
  "login.new": "New here? Create an account",
  "login.have": "Already have an account? Sign in",
  "login.forgot": "Forgot password?",
  "login.google": "Continue with Google",
  "login.footnote": "Care labels always remain the final authority.",

  "hero.eyebrow": "COMPUTER VISION × TEXTILE SCIENCE",
  "hero.title": "See the Fabric.",
  "hero.titleSerif": "Understand the Care.",
  "hero.lead": "AI-powered fabric intelligence that analyzes garment images, estimates the most likely fabric class, and recommends safer, smarter, and more sustainable care.",
  "hero.primary": "Analyze a Garment",
  "hero.secondary": "Explore Fabric Library",

  "analyze.title": "Scan a Garment",
  "analyze.subtitle": "Upload a clear close-up of your garment's fabric surface for classification and care rules.",
  "analyze.upload": "Upload Photo",
  "analyze.camera": "Use Camera",
  "analyze.clear": "Clear",
  "analyze.run": "Run AI Analysis",
  "analyze.analyzing": "Analyzing Fabric...",

  "insights.title": "Model performance, made clear.",
  "insights.subtitle": "Real data-derived statistics from verified garment classifications and active learning dataset growth.",

  "library.title": "Fabric care, without guesswork.",
  "library.compare": "Compare All Fabrics",
  "library.symbols": "Care Symbol Reference",
  "library.symbolsCopy": "International care symbols (ISO 3758) explained — the same language as your garment labels.",

  "history.title": "Your scan history",
  "history.subtitle": "Every garment you have analyzed — searchable, editable, exportable, and ready to turn into a wash load.",
  "history.search": "Search fabric or note…",
  "history.all": "All",
  "history.high": "High ≥80%",
  "history.mid": "Moderate 60–79%",
  "history.low": "Low <60%",
  "history.favorites": "Favorites",
  "history.export": "Export CSV",
  "history.clear": "Clear all",
  "history.empty": "No scans yet. Analyze your first garment and it will appear here.",
  "history.edit": "Edit note",
  "history.save": "Save",
  "history.cancel": "Cancel",
  "history.delete": "Delete",
  "history.remind": "Remind me",
  "history.reminderAdded": "Reminder set",
  "history.loadTitle": "Build a wash load",
  "history.loadEmpty": "Select two or more scans to plan a compatible wash load.",
  "history.washload": "Wash Load Planner",

  "assistant.title": "Fabric-care assistant",
  "assistant.subtitle": "Ask about any fabric, stain, or care decision. Answers are advisory — the garment's care label always wins.",
  "assistant.placeholder": "Example: Will my wool sweater shrink in the dryer?",
  "assistant.send": "Send",
  "assistant.disclaimer": "AI-assisted guidance. For valuable or delicate garments, follow the manufacturer's care label.",

  "about.title": "Built for clearer garment care.",

  "common.loading": "Loading…",
  "common.confirm": "Confirm",
  "common.confirmDelete": "Are you sure? This cannot be undone.",
  "common.close": "Close",
  "footer.disclaimer": "AI predictions are advisory. Always check and follow manufacturer care tags when available.",
};

const es: typeof en = {
  "nav.home": "Inicio",
  "nav.analyze": "Analizar",
  "nav.model": "Modelo",
  "nav.library": "Guía de cuidado",
  "nav.history": "Mis escaneos",
  "nav.assistant": "Asistente",
  "nav.admin": "Admin",
  "cta.analyze": "Analizar prenda",

  "login.eyebrow": "INTELIGENCIA DE CUIDADO TEXTIL",
  "login.back": "Seguir explorando",
  "landing.signIn": "Iniciar sesión",
  "login.title": "Bienvenido de nuevo",
  "login.copy": "Inicia sesión para analizar prendas y acceder a tu guía personalizada de cuidado textil.",
  "login.login": "INICIAR SESIÓN",
  "login.register": "CREAR CUENTA",
  "login.new": "¿Nuevo aquí? Crea una cuenta",
  "login.have": "¿Ya tienes cuenta? Inicia sesión",
  "login.forgot": "¿Olvidaste tu contraseña?",
  "login.google": "Continuar con Google",
  "login.footnote": "La etiqueta de cuidado es siempre la autoridad final.",

  "hero.eyebrow": "VISIÓN POR ORDENADOR × CIENCIA TEXTIL",
  "hero.title": "Ve el tejido.",
  "hero.titleSerif": "Entiende el cuidado.",
  "hero.lead": "Inteligencia textil con IA que analiza imágenes de prendas, estima la clase de tejido más probable y recomienda un cuidado más seguro, inteligente y sostenible.",
  "hero.primary": "Analizar una prenda",
  "hero.secondary": "Explorar biblioteca de tejidos",

  "analyze.title": "Escanea una prenda",
  "analyze.subtitle": "Sube un primer plano nítido de la superficie del tejido para su clasificación y reglas de cuidado.",
  "analyze.upload": "Subir foto",
  "analyze.camera": "Usar cámara",
  "analyze.clear": "Limpiar",
  "analyze.run": "Ejecutar análisis IA",
  "analyze.analyzing": "Analizando tejido...",

  "insights.title": "Rendimiento del modelo, claro.",
  "insights.subtitle": "Estadísticas reales derivadas de clasificaciones verificadas y del crecimiento del conjunto de datos por aprendizaje activo.",

  "library.title": "Cuidado textil, sin conjeturas.",
  "library.compare": "Comparar todos los tejidos",
  "library.symbols": "Referencia de símbolos de cuidado",
  "library.symbolsCopy": "Símbolos de cuidado internacionales (ISO 3758) explicados — el mismo lenguaje que las etiquetas de tus prendas.",

  "history.title": "Tu historial de escaneos",
  "history.subtitle": "Cada prenda que has analizado: buscable, editable, exportable y lista para planificar una lavadora.",
  "history.search": "Buscar tejido o nota…",
  "history.all": "Todos",
  "history.high": "Alta ≥80%",
  "history.mid": "Media 60–79%",
  "history.low": "Baja <60%",
  "history.favorites": "Favoritos",
  "history.export": "Exportar CSV",
  "history.clear": "Borrar todo",
  "history.empty": "Aún no hay escaneos. Analiza tu primera prenda y aparecerá aquí.",
  "history.edit": "Editar nota",
  "history.save": "Guardar",
  "history.cancel": "Cancelar",
  "history.delete": "Eliminar",
  "history.remind": "Recordarme",
  "history.reminderAdded": "Recordatorio creado",
  "history.loadTitle": "Planificar una lavadora",
  "history.loadEmpty": "Selecciona dos o más escaneos para planificar una lavadora compatible.",
  "history.washload": "Planificador de carga",

  "assistant.title": "Asistente de cuidado textil",
  "assistant.subtitle": "Pregunta sobre cualquier tejido, mancha o decisión de cuidado. Las respuestas son orientativas — la etiqueta de la prenda siempre gana.",
  "assistant.placeholder": "Ejemplo: ¿Mi jersey de lana se encogerá en la secadora?",
  "assistant.send": "Enviar",
  "assistant.disclaimer": "Orientación asistida por IA. Para prendas de valor o delicadas, sigue la etiqueta del fabricante.",

  "about.title": "Hecho para un cuidado más claro.",

  "common.loading": "Cargando…",
  "common.confirm": "Confirmar",
  "common.confirmDelete": "¿Seguro? Esta acción no se puede deshacer.",
  "common.close": "Cerrar",
  "footer.disclaimer": "Las predicciones de IA son orientativas. Sigue siempre la etiqueta de cuidado del fabricante cuando esté disponible.",
};

const de: typeof en = {
  "nav.home": "Start",
  "nav.analyze": "Analysieren",
  "nav.model": "Modell",
  "nav.library": "Pflegeguide",
  "nav.history": "Meine Scans",
  "nav.assistant": "Assistent",
  "nav.admin": "Admin",
  "cta.analyze": "Gestück analysieren",

  "login.eyebrow": "TEXTILPFLEGE-INTELLIGENZ",
  "login.back": "Weiter entdecken",
  "landing.signIn": "Anmelden",
  "login.title": "Willkommen zurück",
  "login.copy": "Melde dich an, um Kleidung zu analysieren und deine persönliche Textilpflege-Empfehlung zu erhalten.",
  "login.login": "ANMELDEN",
  "login.register": "KONTO ERSTELLEN",
  "login.new": "Neu hier? Konto erstellen",
  "login.have": "Bereits ein Konto? Anmelden",
  "login.forgot": "Passwort vergessen?",
  "login.google": "Mit Google fortfahren",
  "login.footnote": "Pflegeetiketten bleiben immer die endgültige Authority.",

  "hero.eyebrow": "COMPUTER VISION × TEXTILWISSENSCHAFT",
  "hero.title": "Sieh den Stoff.",
  "hero.titleSerif": "Versteh die Pflege.",
  "hero.lead": "KI-gestützte Textilintelligenz, die Kleidungsstücke analysiert, die wahrscheinlichste Stoffklasse schätzt und sicherere, klügere und nachhaltigere Pflege empfiehlt.",
  "hero.primary": "Gestück analysieren",
  "hero.secondary": "Stoffbibliothek entdecken",

  "analyze.title": "Gestück scannen",
  "analyze.subtitle": "Lade ein scharfes Nahaufnahme des Stoffes hoch, um Klassifizierung und Pflegerregeln zu erhalten.",
  "analyze.upload": "Foto hochladen",
  "analyze.camera": "Kamera nutzen",
  "analyze.clear": "Leeren",
  "analyze.run": "KI-Analyse starten",
  "analyze.analyzing": "Stoff wird analysiert…",

  "insights.title": "Modellleistung, klar erklärt.",
  "insights.subtitle": "Reale Kennzahlen aus verifizierten Stoffklassifikationen und dem Wachstum des Active-Learning-Datensatzes.",

  "library.title": "Textilpflege ohne Rätselraten.",
  "library.compare": "Alle Stoffe vergleichen",
  "library.symbols": "Pflegesymbol-Referenz",
  "library.symbolsCopy": "Internationale Pflegesymbole (ISO 3758) erklärt — dieselbe Sprache wie auf deinen Kleidungsbeschriftungen.",

  "history.title": "Dein Scan-Verlauf",
  "history.subtitle": "Jedes analysierte Kleidungsstück — durchsuchbar, bearbeitbar, exportierbar und bereit für die Waschplanung.",
  "history.search": "Stoff oder Notiz suchen…",
  "history.all": "Alle",
  "history.high": "Hoch ≥80%",
  "history.mid": "Mittel 60–79%",
  "history.low": "Niedrig <60%",
  "history.favorites": "Favoriten",
  "history.export": "CSV exportieren",
  "history.clear": "Alle löschen",
  "history.empty": "Noch keine Scans. Analysiere dein erstes Kleidungsstück — es erscheint hier.",
  "history.edit": "Notiz bearbeiten",
  "history.save": "Speichern",
  "history.cancel": "Abbrechen",
  "history.delete": "Löschen",
  "history.remind": "Erinnere mich",
  "history.reminderAdded": "Erinnerung gesetzt",
  "history.loadTitle": "Waschladung planen",
  "history.loadEmpty": "Wähle zwei oder mehr Scans aus, um eine kompatible Waschladung zu planen.",
  "history.washload": "Waschladungs-Planer",

  "assistant.title": "Textilpflege-Assistent",
  "assistant.subtitle": "Frag zu Stoffen, Flecken oder Pflegeentscheidungen. Antworten sind Hinweise — das Pflegeetikett gewinnt immer.",
  "assistant.placeholder": "Beispiel: Verzieht mein Wollpullover im Trockner?",
  "assistant.send": "Senden",
  "assistant.disclaimer": "KI-gestützte Beratung. Bei wertvollen oder empfindlichen Kleidern das Pflegeetikett des Herstellers beachten.",

  "about.title": "Für klarere Kleidungspflege gebaut.",

  "common.loading": "Wird geladen…",
  "common.confirm": "Bestätigen",
  "common.confirmDelete": "Sicher? Das kann nicht rückgängig gemacht werden.",
  "common.close": "Schließen",
  "footer.disclaimer": "KI-Vorhersagen sind Hinweise. Folge immer den Pflegehinweisen des Herstellers, sofern vorhanden.",
};

const fr: typeof en = {
  "nav.home": "Accueil",
  "nav.analyze": "Analyser",
  "nav.model": "Modèle",
  "nav.library": "Guide d'entretien",
  "nav.history": "Mes scans",
  "nav.assistant": "Assistant",
  "nav.admin": "Admin",
  "cta.analyze": "Analyser un vêtement",

  "login.eyebrow": "INTELLIGENCE D'ENTRETIEN TEXTILE",
  "login.back": "Continuer à explorer",
  "landing.signIn": "Se connecter",
  "login.title": "Bon retour",
  "login.copy": "Connectez-vous pour analyser vos vêtements et accéder à vos conseils d'entretien personnalisés.",
  "login.login": "CONNEXION",
  "login.register": "CRÉER UN COMPTE",
  "login.new": "Nouveau ici ? Créer un compte",
  "login.have": "Déjà un compte ? Se connecter",
  "login.forgot": "Mot de passe oublié ?",
  "login.google": "Continuer avec Google",
  "login.footnote": "Les étiquettes d'entretien restent toujours l'autorité finale.",

  "hero.eyebrow": "VISION PAR ORDINATEUR × SCIENCE TEXTILE",
  "hero.title": "Voir le tissu.",
  "hero.titleSerif": "Comprendre l'entretien.",
  "hero.lead": "Une intelligence textile propulsée par l'IA qui analyse les images de vêtements, estime la classe de tissu la plus probable et recommande un entretien plus sûr, plus malin et plus durable.",
  "hero.primary": "Analyser un vêtement",
  "hero.secondary": "Explorer la bibliothèque des tissus",

  "analyze.title": "Scanner un vêtement",
  "analyze.subtitle": "Téléchargez un gros plan net de la surface du tissu pour sa classification et ses règles d'entretien.",
  "analyze.upload": "Téléverser une photo",
  "analyze.camera": "Utiliser la caméra",
  "analyze.clear": "Effacer",
  "analyze.run": "Lancer l'analyse IA",
  "analyze.analyzing": "Analyse du tissu…",

  "insights.title": "Performance du modèle, en clair.",
  "insights.subtitle": "Statistiques réelles issues des classifications vérifiées et de la croissance du jeu de données par apprentissage actif.",

  "library.title": "L'entretien textile, sans deviner.",
  "library.compare": "Comparer tous les tissus",
  "library.symbols": "Référence des symboles d'entretien",
  "library.symbolsCopy": "Symboles d'entretien internationaux (ISO 3758) expliqués — le même langage que vos étiquettes.",

  "history.title": "Votre historique de scans",
  "history.subtitle": "Chaque vêtement analysé — consultable, modifiable, exportable, et prêt à devenir une lessive planifiée.",
  "history.search": "Rechercher tissu ou note…",
  "history.all": "Tous",
  "history.high": "Haute ≥80%",
  "history.mid": "Moyenne 60–79%",
  "history.low": "Basse <60%",
  "history.favorites": "Favoris",
  "history.export": "Exporter CSV",
  "history.clear": "Tout effacer",
  "history.empty": "Aucun scan pour l'instant. Analysez votre premier vêtement, il apparaîtra ici.",
  "history.edit": "Modifier la note",
  "history.save": "Enregistrer",
  "history.cancel": "Annuler",
  "history.delete": "Supprimer",
  "history.remind": "Me rappeler",
  "history.reminderAdded": "Rappel programmé",
  "history.loadTitle": "Planifier une lessive",
  "history.loadEmpty": "Sélectionnez deux scans ou plus pour planifier une lessive compatible.",
  "history.washload": "Planificateur de lessive",

  "assistant.title": "Assistant d'entretien textile",
  "assistant.subtitle": "Posez des questions sur les tissus, les taches ou les décisions d'entretien. Les réponses sont indicatives — l'étiquette du vêtement prime toujours.",
  "assistant.placeholder": "Exemple : Mon pull en laine va-t-il rétrécir au sèche-linge ?",
  "assistant.send": "Envoyer",
  "assistant.disclaimer": "Conseil assisté par IA. Pour les vêtements de valeur ou délicats, suivez l'étiquette du fabricant.",

  "about.title": "Conçu pour un entretien plus clair.",

  "common.loading": "Chargement…",
  "common.confirm": "Confirmer",
  "common.confirmDelete": "Êtes-vous sûr ? Cette action est irréversible.",
  "common.close": "Fermer",
  "footer.disclaimer": "Les prédictions de l'IA sont indicatives. Suivez toujours les étiquettes d'entretien du fabricant lorsque disponibles.",
};

const dictionary: Record<Lang, Record<string, string>> = { en, es, de, fr };

type I18nContextValue = { lang: Lang; t: (key: string) => string; setLang: (lang: Lang) => void };
const I18nContext = createContext<I18nContextValue>({ lang: "en", t: (key) => key, setLang: () => undefined });

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const stored = readLang();
    return stored in dictionary ? (stored as Lang) : "en";
  });
  const setLang = (next: Lang) => {
    setLangState(next);
    writeLang(next);
  };
  const t = (key: string) => dictionary[lang][key] ?? en[key] ?? key;
  return <I18nContext.Provider value={{ lang, t, setLang }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
