import { useState } from "react";
import type { ServiceStatus } from "../api/health";
import { Button, PageHeader, Panel, StatusBadge } from "../components/ui/core";
import { useSystemHealth } from "../health/SystemHealthContext";

function readService(services: ServiceStatus[], name: string) {
  return services.find(service => service.service === name);
}

function formatBytes(value?: number | null) {
  if (!value) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** unit).toFixed(unit > 2 ? 1 : 0)} ${units[unit]}`;
}

function formatTokens(value?: number | null) {
  return value ? `${value.toLocaleString("en-US")} tokens` : "Not loaded";
}

function traceveilAiStatus(ai?: ServiceStatus) {
  if (ai?.enabled === false) return "Disabled";
  if (!ai?.server_running) return "Waiting for Ollama";
  if (ai?.ready) return "Operational";
  if (ai?.available && !ai.model_installed) return "Model missing";
  return "Unavailable";
}

function ollamaServerStatus(ai?: ServiceStatus) {
  return ai?.server_running ? "Running" : "Stopped";
}

export function SystemStatusPage() {
  const { services, state, checked, loading, aiUpdating, ollamaUpdating, refresh, updateAiEnabled, updateOllamaRunning } = useSystemHealth();
  const [controlError, setControlError] = useState("");
  const api = readService(services, "api");
  const db = readService(services, "database");
  const ai = readService(services, "ollama");
  const currentAiStatus = traceveilAiStatus(ai);
  const currentOllamaStatus = ollamaServerStatus(ai);
  const cards = [
    { icon: "API", name: "Backend API", status: api?.status === "ok" ? "Operational" : "Unavailable", desc: "Versioned investigation, report, and audit APIs", meta: "/api/v1 · local FastAPI" },
    { icon: "DB", name: "Evidence database", status: db?.status === "ok" ? "Operational" : "Unavailable", desc: "Durable cases, evidence, analyses, and history", meta: "SQLite · serialized transactions" },
    { icon: "OL", name: "Ollama server", status: currentOllamaStatus, desc: "The separate local process that hosts and runs models", meta: ai?.server_running ? "Local model server reachable" : "Start it to make models available" },
    { icon: "AI", name: "Traceveil AI", status: currentAiStatus, desc: "Traceveil's grounded investigation assistant feature", meta: ai?.enabled === false ? "Usage disabled by preference" : ai?.model ?? "Model status unavailable" },
    { icon: "SSE", name: "Live collector", status: api?.status === "ok" ? "Operational" : "Unavailable", desc: "Authenticated ingestion with durable receipts and replay", meta: "HTTP POST + SSE" },
  ];
  const banner = { checking: "Checking core systems", operational: "Connected investigation platform", "database-unavailable": "Evidence database unavailable", "backend-unavailable": "Backend API unavailable" }[state];

  const toggleAi = async () => {
    setControlError("");
    try {
      await updateAiEnabled(ai?.enabled === false);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "The AI control could not be changed.");
    }
  };

  const toggleOllama = async () => {
    setControlError("");
    try {
      await updateOllamaRunning(!ai?.server_running);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "The Ollama server could not be changed.");
    }
  };

  return <>
    <PageHeader eyebrow="Platform observability" title="System status" description="Runtime health, model controls, and explicit capability boundaries for the connected local platform." actions={<Button onClick={() => void refresh()} disabled={loading}>↻ {loading ? "Checking…" : "Refresh status"}</Button>} />
    <div className={`system-banner system-${state}`} role="status"><div><span className="large-status-dot" /><div><h2>{banner}</h2><p>{state === "operational" ? "Core investigation services are available. Local AI may be controlled independently below." : state === "checking" ? "Checking the backend API and evidence database." : "Core investigation actions are unavailable until this service recovers."}</p></div></div><span>Last checked · {checked}</span></div>
    <div className="status-card-grid status-card-grid-services">{cards.map((card, index) => <article className="service-card" key={card.name}><div><span className={`service-icon service-${index}`}>{card.icon}</span><StatusBadge status={card.status} /></div><h2>{card.name}</h2><p>{card.desc}</p><footer><i /><span>{card.meta}</span></footer></article>)}</div>
    <Panel className="ai-runtime-panel" title="AI controls">
      <div className="ai-control-grid">
        <article>
          <div><span className="service-icon service-2">OL</span><StatusBadge status={currentOllamaStatus} /></div>
          <h4>Ollama server</h4>
          <p>Starts or stops the local process that loads models and performs generation.</p>
          <Button variant={ai?.server_running ? "danger" : "primary"} onClick={() => void toggleOllama()} disabled={loading || ollamaUpdating || !ai?.server_control_supported}>{ollamaUpdating ? "Updating Ollama…" : ai?.server_running ? "Stop Ollama" : "Start Ollama"}</Button>
        </article>
        <article>
          <div><span className="service-icon service-3">AI</span><StatusBadge status={currentAiStatus} /></div>
          <h4>Traceveil AI</h4>
          <p>Allows or prevents Traceveil from sending assistant questions to the Ollama server.</p>
          <Button variant={ai?.enabled === false ? "primary" : "danger"} onClick={() => void toggleAi()} disabled={loading || aiUpdating || !ai}>{aiUpdating ? "Updating AI…" : ai?.enabled === false ? "Enable AI" : "Disable AI"}</Button>
        </article>
      </div>
      {controlError && <p className="ai-control-error" role="alert">{controlError}</p>}
      <div className="ai-model-heading"><h4>Ollama model details</h4><p>These values describe the configured local model and its current Ollama allocation.</p></div>
      <div className="ai-detail-grid">
        <div><span>Configured model</span><b>{ai?.model ?? "Unavailable"}</b></div><div><span>Model state</span><b>{ai?.model_loaded ? "Loaded" : ai?.model_installed ? "Installed · standby" : "Not installed"}</b></div><div><span>Model family</span><b>{[ai?.family, ai?.parameter_size].filter(Boolean).join(" · ") || "Unavailable"}</b></div>
        <div><span>Quantization</span><b>{ai?.quantization_level ?? "Unavailable"}</b></div><div><span>Model size</span><b>{formatBytes(ai?.size_bytes)}</b></div><div><span>Active context</span><b>{formatTokens(ai?.active_context_length)}</b></div><div><span>Maximum context</span><b>{formatTokens(ai?.max_context_length)}</b></div>
        <div><span>Loaded VRAM</span><b>{formatBytes(ai?.size_vram_bytes)}</b></div><div><span>Capabilities</span><b>{ai?.capabilities?.join(" · ") || "Unavailable"}</b></div><div><span>Grounding packet limit</span><b>{formatBytes(ai?.grounding_context_limit_bytes)}</b></div><div><span>Request context</span><b>{ai?.request_context_length ? `${ai.request_context_length.toLocaleString("en-US")} tokens` : "Unavailable"}</b></div><div><span>Generation policy</span><b>{ai ? `${ai.max_output_tokens ?? "?"} output · thinking ${ai.thinking_enabled ? "on" : "off"} · temp ${ai.temperature ?? "?"}` : "Unavailable"}</b></div><div><span>Model residency</span><b>{ai?.keep_alive ? `Keep loaded ${ai.keep_alive}` : "Unavailable"}</b></div><div><span>Request timeout</span><b>{ai?.generation_timeout_seconds ? `${ai.generation_timeout_seconds} seconds` : "Unavailable"}</b></div>
      </div>
    </Panel>
    <div className="status-layout"><Panel title="Capability boundary"><div className="capability-table"><div><b>Capability</b><b>Current state</b><b>Notes</b></div>{[["Connected investigation views", "Implemented", "Backend-authored records, filters, pagination, and details"], ["Batch evidence ingestion", "Implemented", "Validation, explicit partial approval, persistence, and reanalysis"], ["Live HTTP collection", "Implemented", "Environment source tokens, receipts, deduplication, and device state"], ["SSE delivery", "Implemented", "Replayable one-way stream with bounded browser buffers"], ["Traceveil AI", ai?.enabled === false ? "Disabled" : ai?.server_running ? "Optional" : "Waiting", "Uses Ollama when both services are on; deterministic fallback remains available"], ["PDF and SMTP delivery", "Approval gated", "Immutable approvals; SMTP send is always a separate confirmation"], ["Physical hardware and MQTT", "Future adapter", "Simulator is the Phase 3 acceptance path"]].map(row => <div key={row[0]}><span>{row[0]}</span><StatusBadge status={row[1]} /><span>{row[2]}</span></div>)}</div></Panel><Panel title="Environment notes"><div className="notes-list"><div><i>i</i><p><b>Secrets stay server-side</b>Source tokens, Ollama configuration, and SMTP credentials are never returned by APIs.</p></div><div><i>✓</i><p><b>Deterministic authority</b>Risk, findings, ordering, and report evidence remain backend-authored.</p></div><div><i>⌁</i><p><b>Controlled delivery</b>No report email is sent without unchanged report and email approvals.</p></div></div></Panel></div>
  </>;
}
