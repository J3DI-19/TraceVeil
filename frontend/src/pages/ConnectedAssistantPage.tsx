import { useEffect, useMemo, useRef, useState } from "react";
import { batchApi, type ApiCase } from "../api/batch";
import { normalizeApiError } from "../api/client";
import { phase3Api, type AssistantMessage, type AssistantSession, type AssistantVisualizationMode, type VisualizationLayout } from "../api/phase3";
import { Button } from "../components/ui/core";
import { ConnectedVisualizationRenderer } from "../visualizations/ConnectedVisualizationRenderer";

function referencePath(reference: string) {
  const parts = reference.split(":");
  if (parts[0] !== "case" || !/^\d+$/.test(parts[1] ?? "")) return "/cases";
  const section = ({ finding: "findings", alert: "alerts", incident: "incidents", timeline: "timeline", evidence: "evidence", event: "events" } as Record<string, string>)[parts[2]] ?? "overview";
  return `/cases/${parts[1]}/${section}${parts[3] ? `#${encodeURIComponent(parts.slice(3).join(":"))}` : ""}`;
}

function sessionLabel(session: AssistantSession) {
  if (session.message_count === 0) return "New chat";
  const turns = Math.ceil(session.message_count / 2);
  return `${session.title} · ${turns} turn${turns === 1 ? "" : "s"}`;
}

function messageTime(createdAt: string) {
  const value = new Date(createdAt);
  return Number.isNaN(value.getTime()) ? "" : value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ConnectedAssistantPage({ search = window.location.search }: { search?: string }) {
  const params = new URLSearchParams(search);
  const selectedCase = Number(params.get("case")) || null;
  const selectedReferences = selectedCase
    ? ["alert", "finding", "evidence", "event", "incident", "timeline"].flatMap(kind => params.get(kind) ? [`case:${selectedCase}:${kind}:${params.get(kind)}`] : [])
    : [];
  const referenceKey = selectedReferences.join("|");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [cases, setCases] = useState<ApiCase[]>([]);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [value, setValue] = useState("");
  const [includeEvidence, setIncludeEvidence] = useState(selectedCase !== null || selectedReferences.length > 0);
  const [visualizationMode, setVisualizationMode] = useState<AssistantVisualizationMode>("none");
  const [openVisualMessageIds, setOpenVisualMessageIds] = useState<string[]>([]);
  const [state, setState] = useState<"connecting" | "ready" | "thinking" | "offline" | "failed">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [atLatest, setAtLatest] = useState(true);
  const operation = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const followLatest = useRef(true);
  const knownVisualMessageIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    void batchApi.listCases(controller.signal).then(result => setCases(Array.isArray(result?.items) ? result.items : [])).catch(() => { if (!controller.signal.aborted) setCases([]); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const caseIds = selectedCase ? [selectedCase] : [];
    const storageKey = `traceveil-assistant-${selectedCase ?? "auto"}`;
    const activate = async (session: AssistantSession) => {
      setSessionId(session.session_id);
      window.localStorage.setItem(storageKey, session.session_id);
      const history = await phase3Api.messages(session.session_id, controller.signal);
      setMessages(Array.isArray(history?.items) ? history.items : []);
      setState("ready");
    };
    void phase3Api.assistantSessions(selectedCase, controller.signal).then(async result => {
      const returned = Array.isArray(result?.items) ? result.items : [];
      const available = referenceKey
        ? returned.filter(item => item.reference_ids.join("|") === referenceKey)
        : selectedCase
          ? returned.filter(item => item.reference_ids.length === 0 && item.case_ids.includes(selectedCase))
          : returned.filter(item => item.case_ids.length === 0 && item.reference_ids.length === 0);
      const requested = params.get("session") ?? window.localStorage.getItem(storageKey);
      const matching = available.find(item => item.session_id === requested);
      const visible = available.filter(item => item.message_count > 0 || item.session_id === requested);
      setSessions(visible);
      if (matching) await activate(matching);
      else if (visible[0]) await activate(visible[0]);
      else {
        const created = await phase3Api.createAssistantSession(caseIds, selectedReferences, controller.signal);
        setSessions([created]);
        await activate(created);
      }
    }).catch(reason => {
      if (!controller.signal.aborted) { setState("failed"); setError(normalizeApiError(reason).message); }
    });
    return () => controller.abort();
  }, [selectedCase, referenceKey]);

  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    const availableIds = messages.filter(message => message.role === "assistant" && message.visualization).map(message => message.message_id);
    const unseenIds = availableIds.filter(id => !knownVisualMessageIds.current.has(id));
    knownVisualMessageIds.current = new Set(availableIds);
    setOpenVisualMessageIds(current => {
      const retained = current.filter(id => availableIds.includes(id));
      return [...new Set([...retained, ...unseenIds])].slice(-6);
    });
  }, [messages]);
  useEffect(() => {
    if (!followLatest.current && state !== "thinking") return;
    const frame = window.requestAnimationFrame(() => {
      const thread = threadRef.current;
      if (!thread) return;
      thread.scrollTop = thread.scrollHeight;
      setAtLatest(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, state]);

  const scrollToLatest = () => { followLatest.current = true; const thread = threadRef.current; if (thread) thread.scrollTop = thread.scrollHeight; setAtLatest(true); };
  const handleThreadScroll = () => { const thread = threadRef.current; if (!thread) return; const latest = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48; followLatest.current = latest; setAtLatest(latest); };
  const refresh = async (id: string, signal?: AbortSignal) => {
    const result = await phase3Api.messages(id, signal);
    const items = Array.isArray(result?.items) ? result.items : [];
    setMessages(items);
    setSessions(current => {
      const existing = current.find(item => item.session_id === id);
      if (!existing) return current;
      const firstQuestion = items.find(item => item.role === "user")?.text.replace(/\s+/g, " ").trim().slice(0, 80);
      const updated = { ...existing, title: firstQuestion || existing.title, message_count: items.length, updated_at: new Date().toISOString() };
      return [updated, ...current.filter(item => item.session_id !== id && item.message_count > 0)];
    });
  };
  const activateSession = async (id: string) => {
    operation.current?.abort(); followLatest.current = true; setSessionId(id); setState("connecting"); setError(null);
    try { await refresh(id); window.localStorage.setItem(`traceveil-assistant-${selectedCase ?? "auto"}`, id); setState("ready"); }
    catch (reason) { setState("failed"); setError(normalizeApiError(reason).message); }
  };
  const changeScope = (scope: string) => { window.location.href = scope === "all" ? "/assistant" : `/assistant?case=${encodeURIComponent(scope)}`; };
  const newSession = async () => {
    operation.current?.abort(); followLatest.current = true; setState("connecting"); setError(null);
    try {
      const created = await phase3Api.createAssistantSession(selectedCase ? [selectedCase] : [], selectedReferences);
      setSessions(items => [created, ...items.filter(item => item.message_count > 0)]); setMessages([]); setSessionId(created.session_id);
      window.localStorage.setItem(`traceveil-assistant-${selectedCase ?? "auto"}`, created.session_id); setState("ready");
    } catch (reason) { setState("failed"); setError(normalizeApiError(reason).message); }
  };
  const ask = async (question: string, evidenceOverride = includeEvidence, visualOverride = visualizationMode) => {
    const normalizedQuestion = question.trim();
    if (!sessionId || !normalizedQuestion || state === "thinking") return;
    const controller = new AbortController(); operation.current = controller; followLatest.current = true; setState("thinking"); setError(null); setValue("");
    try {
      const job = await phase3Api.ask(sessionId, normalizedQuestion, evidenceOverride, evidenceOverride ? visualOverride : "none", controller.signal);
      await refresh(sessionId, controller.signal);
      const deadline = Date.now() + 130_000;
      for (;;) {
        await new Promise(resolve => window.setTimeout(resolve, 300));
        const current = await phase3Api.assistantJob(job.job_id, controller.signal);
        if (current.status === "completed") { await refresh(sessionId, controller.signal); setState("ready"); break; }
        if (current.status === "failed") { setState(current.error?.code === "ollama_offline" ? "offline" : "failed"); setError(current.error?.message ?? "Assistant processing failed."); setValue(normalizedQuestion); break; }
        if (Date.now() >= deadline) throw new Error("Assistant processing timed out. You can safely retry.");
      }
    } catch (reason) {
      if (!controller.signal.aborted) { setState("failed"); setError(normalizeApiError(reason).message); setValue(normalizedQuestion); }
    }
  };

  const activeLayouts = useMemo(() => messages.filter(message => openVisualMessageIds.includes(message.message_id) && message.role === "assistant" && message.visualization).map(message => ({ messageId: message.message_id, layout: message.visualization! })), [messages, openVisualMessageIds]);
  const activeLayout = useMemo<VisualizationLayout | null>(() => {
    if (activeLayouts.length === 0) return null;
    if (activeLayouts.length === 1) return activeLayouts[0].layout;
    return {
      schema_version: "1.0",
      layout_id: `workspace-${activeLayouts.map(item => item.messageId.slice(0, 6)).join("-")}`.slice(0, 64),
      title: "Investigation visual workspace",
      components: activeLayouts.flatMap(item => item.layout.components.map(component => ({ ...component, id: `${item.messageId.slice(0, 12)}-${component.id}` }))).slice(0, 6),
    };
  }, [activeLayouts]);
  const activeCase = selectedCase ? cases.find(item => item.id === selectedCase) : null;
  const stateLabel = { connecting: "Connecting", ready: "Ready", thinking: "Working", offline: "Ollama offline", failed: "Unavailable" }[state];
  const messageKind = (message: AssistantMessage) => message.model === "deterministic-greeting" ? "Instant greeting" : message.model === "deterministic-conversation" ? "Local fallback" : message.model === "deterministic-fallback" ? "Deterministic fallback" : `AI narration · ${message.model ?? "local model"}`;
  const suggestedQuestions: Array<{ label: string; question: string; visual: AssistantVisualizationMode }> = [
    { label: "Priority findings", question: "Summarize the highest-risk findings", visual: "top_findings" },
    { label: "Activity spikes", question: "Show unusual event activity", visual: "event_activity" },
    { label: "Forensic timeline", question: "Show the forensic timeline", visual: "timeline" },
  ];

  return <main className="assistant-page-shell">
    <div className="connected-assistant-workspace">
      <section className="assistant-column global-assistant-column" aria-label="Investigation conversation">
        <header className="assistant-header">
          <div className="assistant-header-identity"><h1>Traceveil Assistant</h1><p className="visually-hidden">{selectedCase ? <><span>{`Scoped to persisted case ${selectedCase}`}</span>{activeCase ? ` · ${activeCase.name}` : ""}</> : "Auto retrieval across persisted cases"}</p><span className={`assistant-runtime-state state-${state}`}><i/>{stateLabel}</span></div>
          <div className="assistant-header-controls">
            <label><span className="visually-hidden">Scope</span><select title="Investigation scope" aria-label="Investigation scope" value={selectedCase?.toString() ?? "all"} onChange={event => changeScope(event.target.value)}><option value="all">All persisted cases</option>{selectedCase && !cases.some(item => item.id === selectedCase) && <option value={selectedCase}>Case {selectedCase}</option>}{cases.map(item => <option value={item.id} key={item.id}>Case {item.id} · {item.name}</option>)}</select></label>
            <label><span className="visually-hidden">History</span><select title="Chat history" aria-label="Chat history" value={sessionId ?? ""} onChange={event => void activateSession(event.target.value)}><option value="" disabled>Select chat</option>{sessions.map(session => <option value={session.session_id} key={session.session_id}>{sessionLabel(session)}</option>)}</select></label>
            <Button variant="secondary" onClick={() => void newSession()}><span aria-hidden="true">＋</span><span className="visually-hidden">New chat</span></Button>
          </div>
        </header>

        {selectedReferences.length > 0 && <div className="selected-context"><div><span>Locked evidence context</span><b>{selectedReferences.length} selected reference{selectedReferences.length === 1 ? "" : "s"}</b></div><div>{selectedReferences.map(reference => <button key={reference} onClick={() => { window.location.href = referencePath(reference); }}><small>{reference.split(":")[2]}</small>{reference.split(":").slice(3).join(":")}<span>↗</span></button>)}</div></div>}
        {error && <div className="assistant-error" role="alert"><span>!</span><div><strong>{state === "offline" ? "Ollama is optional and offline" : "Assistant unavailable"}</strong><p>{error}</p></div></div>}

        <div className="assistant-thread" ref={threadRef} onScroll={handleThreadScroll} aria-label="Conversation messages" aria-live="polite" aria-busy={state === "thinking"} tabIndex={0}>
          {messages.length ? messages.map(message => { const visualOpen = openVisualMessageIds.includes(message.message_id); return <article className={`assistant-message assistant-message-${message.role}`} key={message.message_id}><div className="message-content"><div className="message-byline"><b>{message.role === "assistant" ? "Traceveil" : "You"}</b>{message.role === "assistant" && <span className={`message-kind ${message.model?.startsWith("deterministic-") ? "kind-verified" : "kind-narration"}`}>{messageKind(message)}</span>}<time>{messageTime(message.created_at)}</time></div><div className="message-bubble"><p>{message.text}</p>{message.visualization && <button aria-label={visualOpen ? "Visual open ↗" : "Open visual ↗"} className={`message-visual-button ${visualOpen ? "active" : ""}`} onClick={() => setOpenVisualMessageIds(current => visualOpen ? current.filter(id => id !== message.message_id) : [...current, message.message_id].slice(-6))}><span>▣</span>{visualOpen ? "Visual open" : "Open visual"}</button>}</div>{message.citations.length > 0 && <div className="assistant-references" aria-label="Verified persisted facts"><strong>Sources · {message.citations.length}</strong>{message.citations.map(reference => <a className="evidence-reference" href={referencePath(reference)} key={reference}>{reference}<span>↗</span></a>)}</div>}{message.caveats.map(caveat => <small className="assistant-caveat" key={caveat}>{caveat}</small>)}</div></article>; }) : <div className="assistant-empty-state"><div className="empty-orbit"><span>✦</span></div><strong>Start with a question—or just say hello</strong><p>Ask normally, or include evidence for grounded analysis and visuals.</p><div>{suggestedQuestions.map(item => <button key={item.question} disabled={!sessionId} onClick={() => { setIncludeEvidence(true); setVisualizationMode(item.visual); void ask(item.question, true, item.visual); }}>{item.label}</button>)}</div></div>}
          {state === "thinking" && <div className="assistant-message assistant-thinking"><div className="message-content"><div className="message-byline"><b>Traceveil</b></div><div className="message-bubble thinking-bubble"><i/><i/><i/><span>{includeEvidence ? "Checking evidence" : "Thinking"}</span></div></div></div>}
        </div>
        {!atLatest && <button className="assistant-jump-latest" onClick={scrollToLatest}>↓ Jump to latest</button>}

        <div className="assistant-composer">
          <div className="composer-input-wrap"><textarea value={value} maxLength={4000} disabled={!sessionId || state === "thinking"} onChange={event => setValue(event.target.value)} placeholder={sessionId ? includeEvidence ? "Ask about this investigation…" : "Message Traceveil Assistant…" : "Preparing a conversation…"} aria-label="Assistant message" onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(value); } }}/><span>{value.length.toLocaleString("en-US")}/4,000</span></div>
          {state === "thinking" ? <Button variant="secondary" onClick={() => { operation.current?.abort(); setState("ready"); }}><span className="visually-hidden">Stop response</span><span aria-hidden="true">■</span></Button> : <Button variant="primary" disabled={!sessionId || !value.trim()} onClick={() => void ask(value)}><span className="visually-hidden">Ask Traceveil</span><span aria-hidden="true">↑</span></Button>}
          <div className="assistant-composer-controls"><label className="assistant-evidence-toggle"><input aria-label="Include investigation evidence" type="checkbox" checked={includeEvidence} disabled={state === "thinking"} onChange={event => { setIncludeEvidence(event.target.checked); if (!event.target.checked) setVisualizationMode("none"); }}/><span><b>Evidence</b></span></label><label className="assistant-visual-select"><span>Visual</span><select aria-label="Response visual" value={visualizationMode} disabled={!includeEvidence || state === "thinking"} onChange={event => setVisualizationMode(event.target.value as AssistantVisualizationMode)}><option value="none">None</option><option value="auto">Automatic</option><option value="timeline">Investigation timeline</option><option value="event_activity">Event activity · Area</option><option value="top_entities">Top entities · Bars</option><option value="severity_distribution">Severity mix · Pie</option><option value="entity_graph">Entity relationships · Graph</option><option value="top_findings">Top findings · Ranked</option></select></label><small>Enter to send · Shift+Enter for newline</small></div>
        </div>
      </section>

      <section className="investigation-canvas assistant-visual-studio" aria-label="Investigation visual workspace">
        <header className="canvas-header"><div><h2>Visuals</h2>{activeLayout && <h3 className="visually-hidden">{activeLayout.title}</h3>}<p className="visually-hidden">{activeLayout?.title ?? "No visual for this response"}</p></div><div className="canvas-meta"><b>{activeLayout?.components.length ?? 0}</b></div></header>
        <div className="canvas-scroll">{activeLayout ? <ConnectedVisualizationRenderer layout={activeLayout}/> : <div className="visual-studio-empty"><span>▣</span><strong>No visuals open</strong><p>Choose a visual before sending, or open one from an earlier response.</p></div>}</div>
      </section>
    </div>
  </main>;
}
