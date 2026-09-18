import { useEffect, useRef, useState } from "react";
import { withTimeout } from "../lib";
import { useI18n } from "../i18n";

// Bring-your-own-key fabric-care assistant. The model key is stored only in
// this browser (localStorage) and is sent only to the endpoint the operator
// chooses. Without a configured key the page explains what is needed instead
// of silently faking answers.
type AssistantSettings = { endpoint: string; model: string; key: string };
type ChatMessage = { role: "user" | "assistant"; content: string };

const SETTINGS_KEY = "laundryai_assistant_settings";

const SYSTEM_PROMPT = [
  "You are LaundryAI's fabric-care assistant, an expert in household textile care.",
  "Supported fabric classes: cotton, polyester, denim, wool, silk (plus blends when the user mentions them).",
  "Give short, practical, safety-first advice: washing temperature, cycle, detergent, drying, ironing, and stain handling.",
  "Always remind the user that the manufacturer care label is the final authority, and prefer the most conservative safe option for delicates and blends.",
  "Never invent test results, certifications, or exact chemical formulas. Keep answers under 150 words unless asked for a full care profile.",
  "Answer in the same language the user writes in.",
].join(" ");

function readSettings(): AssistantSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AssistantSettings>;
    if (parsed && typeof parsed.endpoint === "string" && typeof parsed.model === "string" && typeof parsed.key === "string" && parsed.key) {
      return { endpoint: parsed.endpoint, model: parsed.model, key: parsed.key };
    }
    return null;
  } catch {
    return null;
  }
}

export default function CareAssistant() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<AssistantSettings | null>(() => readSettings());
  const [endpoint, setEndpoint] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-4o-mini");
  const [apiKey, setApiKey] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isSending]);

  const saveSettings = () => {
    if (!endpoint.trim() || !model.trim() || !apiKey.trim()) {
      setError("Fill in the endpoint, model, and API key to enable the assistant.");
      return;
    }
    const next = { endpoint: endpoint.trim().replace(/\/$/, ""), model: model.trim(), key: apiKey.trim() };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    setSettings(next);
    setError("");
    setApiKey("");
  };

  const clearChat = () => {
    setMessages([]);
    setError("");
  };

  const forgetKey = () => {
    try { localStorage.removeItem(SETTINGS_KEY); } catch { /* ignore */ }
    setSettings(null);
    setMessages([]);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !settings || isSending) return;
    setError("");
    const history = [...messages, { role: "user" as const, content: text }];
    setMessages(history);
    setInput("");
    setIsSending(true);
    try {
      const response = await withTimeout(
        fetch(`${settings.endpoint}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.key}`,
          },
          body: JSON.stringify({
            model: settings.model,
            temperature: 0.4,
            max_tokens: 500,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              ...history.slice(-10).map((message) => ({ role: message.role, content: message.content })),
            ],
          }),
        }),
        60_000,
        "The assistant timed out. Check the endpoint and try again."
      );
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(typeof failure?.error?.message === "string" ? failure.error.message : `Assistant request failed (${response.status}).`);
      }
      const data = await response.json();
      const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
      if (!content) throw new Error("The assistant returned an empty reply. Try again.");
      setMessages((current) => [...current, { role: "assistant", content }]);
    } catch (sendError) {
      setMessages((current) => current.slice(0, -1));
      setInput(text);
      setError(sendError instanceof Error ? sendError.message : "The assistant could not be reached.");
    } finally {
      setIsSending(false);
    }
  };

  if (!settings) {
    return (
      <section className="assistant-page">
        <div>
          <span className="eyebrow">CARE ASSISTANT</span>
          <h2>{t("assistant.title")}</h2>
          <p>{t("assistant.subtitle")}</p>
        </div>
        <div className="assistant-setup">
          <h3>Connect a language model</h3>
          <p>
            The assistant is bring-your-own-key: it calls any OpenAI-compatible chat-completions endpoint.
            Your key is stored only in this browser and sent only to the endpoint you choose — it never
            touches the LaundryAI backend.
          </p>
          <label>Endpoint<input type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://api.openai.com/v1" /></label>
          <label>Model<input type="text" value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini" /></label>
          <label>API key<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" /></label>
          <button type="button" className="btn btn-primary" onClick={saveSettings}>Enable assistant</button>
          {error && <p className="login-error" role="alert">{error}</p>}
        </div>
      </section>
    );
  }

  return (
    <section className="assistant-page">
      <div className="assistant-header">
        <div>
          <span className="eyebrow">CARE ASSISTANT</span>
          <h2>{t("assistant.title")}</h2>
        </div>
        <div className="assistant-header-actions">
          <small>{settings.model} · {settings.endpoint}</small>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={clearChat}>Clear chat</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={forgetKey}>Remove key</button>
          </div>
        </div>
      </div>

      <div className="assistant-chat" role="log" aria-live="polite">
        {messages.length === 0 && (
          <p className="assistant-empty">
            Ask about a fabric, a stain, or a care decision — e.g. <em>“Can I tumble dry a denim jacket?”</em>
          </p>
        )}
        {messages.map((message, index) => (
          <div className={`assistant-bubble ${message.role}`} key={index}>
            {message.content}
          </div>
        ))}
        {isSending && <div className="assistant-bubble assistant typing">Thinking…</div>}
        <div ref={bottomRef} />
      </div>

      {error && <div className="result error" role="alert">{error}</div>}

      <div className="assistant-input">
        <textarea
          className="text-field"
          rows={2}
          value={input}
          placeholder={t("assistant.placeholder")}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void send();
          }}
          aria-label="Assistant question"
        />
        <button type="button" className="btn btn-primary" disabled={!input.trim() || isSending} onClick={() => void send()}>
          {t("assistant.send")}
        </button>
      </div>
      <small className="assistant-disclaimer">{t("assistant.disclaimer")}</small>
    </section>
  );
}
