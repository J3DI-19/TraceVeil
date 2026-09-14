import { useEffect, useMemo, useRef, useState } from "react";
import { batchApi, type ApiCase } from "../api/batch";
import { normalizeApiError } from "../api/client";
import { investigationApi, type TimelineRecord } from "../api/investigation";
import { phase3Api, type DeviceState, type LiveMetrics, type LiveSession, type StreamEnvelope } from "../api/phase3";
import { Button, MetricCard, PageHeader, Panel, StatusBadge } from "../components/ui/core";
import { SseLiveDataSource, type ConnectionState } from "../features/live/SseLiveDataSource";

const MAX_EVENTS = 500, MAX_ALERTS = 100, MAX_PENDING = 250, MAX_IDS = 2000, MAX_TIMELINE = 50;

export function ConnectedLiveOperationsPage({ navigate, search = "" }: { navigate: (path: string) => void; search?: string }) {
  const [cases, setCases] = useState<ApiCase[]>([]); const [caseId, setCaseId] = useState<number | null>(null);
  const [session, setSession] = useState<LiveSession | null>(null); const [metrics, setMetrics] = useState<LiveMetrics | null>(null); const [devices, setDevices] = useState<DeviceState[]>([]);
  const [events, setEvents] = useState<Record<string, unknown>[]>([]); const [alerts, setAlerts] = useState<Record<string, unknown>[]>([]); const [timeline, setTimeline] = useState<TimelineRecord[]>([]);
  const [state, setState] = useState<ConnectionState>("disconnected"); const [paused, setPaused] = useState(false); const [dropped, setDropped] = useState(0); const [malformed, setMalformed] = useState(0); const [error, setError] = useState<string | null>(null);
  const pending = useRef<StreamEnvelope[]>([]); const seen = useRef(new Set<number>()); const seenOrder = useRef<number[]>([]);
  useEffect(() => { const controller = new AbortController(); void batchApi.listCases(controller.signal).then(result => { const items = Array.isArray(result.items) ? result.items : []; const requested = Number(new URLSearchParams(search).get("case")); setCases(items); setCaseId(items.some(item => item.id === requested) ? requested : (items[0]?.id ?? null)); }).catch(reason => { if (!controller.signal.aborted) setError(normalizeApiError(reason).message); }); return () => controller.abort(); }, [search]);
  useEffect(() => { if (!caseId) return; const controller = new AbortController(); void phase3Api.sessions(caseId, controller.signal).then(result => { const items = Array.isArray(result.items) ? result.items : []; setSession(items.find(item => item.status === "active") ?? items[0] ?? null); }).catch(reason => { if (!controller.signal.aborted) setError(normalizeApiError(reason).message); }); return () => controller.abort(); }, [caseId]);
  // The timeline signal carries only identifiers, so the chronology is
  // always refetched from the investigation API and never reconstructed
  // in the browser from stream payloads.
  const refreshTimeline = (signal?: AbortSignal) => {
    if (!caseId) return;
    void investigationApi.timeline(caseId, { page: 1, pageSize: MAX_TIMELINE }, signal)
      .then(result => setTimeline(Array.isArray(result.items) ? result.items : []))
      .catch(reason => { if (!signal?.aborted) setError(normalizeApiError(reason).message); });
  };
  const apply = (message: StreamEnvelope) => {
    if (message.id && seen.current.has(message.id)) return;
    if (message.id) { seen.current.add(message.id); seenOrder.current.push(message.id); if (seenOrder.current.length > MAX_IDS) seen.current.delete(seenOrder.current.shift()!); }
    const payload = message.payload ?? {};
    if (message.topic === "event.accepted") setEvents(current => [payload, ...current].slice(0, MAX_EVENTS));
    if (message.topic === "alert.created") setAlerts(current => [payload, ...current].slice(0, MAX_ALERTS));
    if (message.topic === "device.updated") setDevices(current => [payload as unknown as DeviceState, ...current.filter(item => item.device_id !== payload.device_id)].slice(0, 200));
    if (message.topic === "metrics.updated" && caseId) void phase3Api.metrics(caseId, session?.session_id).then(setMetrics);
    if (message.topic === "timeline.updated") refreshTimeline();
  };
  useEffect(() => {
    if (!caseId || !session || session.status !== "active") return;
    const controller = new AbortController(); const source = new SseLiveDataSource();
    void source.connect({ caseId, sessionId: session.session_id, signal: controller.signal, onState: setState, onError: message => { setError(message); setMalformed(value => value + 1); }, onMessage: message => { if (paused) { if (pending.current.length >= MAX_PENDING) { pending.current.shift(); setDropped(value => value + 1); } pending.current.push(message); } else apply(message); } });
    return () => controller.abort();
  }, [caseId, session?.session_id, session?.status, paused]);
  useEffect(() => { if (!caseId) return; const controller = new AbortController(); void Promise.all([phase3Api.metrics(caseId, session?.session_id, controller.signal), phase3Api.devices(caseId, session?.session_id, controller.signal)]).then(([nextMetrics, nextDevices]) => { setMetrics(nextMetrics); setDevices(Array.isArray(nextDevices.items) ? nextDevices.items : []); }).catch(reason => { if (!controller.signal.aborted) setError(normalizeApiError(reason).message); }); refreshTimeline(controller.signal); return () => controller.abort(); }, [caseId, session?.session_id]);
  const start = async () => { if (!caseId) return; try { setSession(await phase3Api.startSession(caseId)); setError(null); } catch (reason) { setError(normalizeApiError(reason).message); } };
  const stop = async () => { if (!session) return; try { setSession(await phase3Api.stopSession(session.session_id)); } catch (reason) { setError(normalizeApiError(reason).message); } };
  const togglePause = () => { if (paused) { const queued = pending.current.splice(0); queued.forEach(apply); if (caseId) { void phase3Api.metrics(caseId, session?.session_id).then(setMetrics); refreshTimeline(); } } setPaused(value => !value); };
  const stateTone = state === "connected" ? "Operational" : state === "stale" || state === "terminal-error" ? "Unavailable" : state;
  const eventRows = useMemo(() => events.slice(0, 50), [events]);
  return <><PageHeader eyebrow="Controlled telemetry · Connected API" title="Live monitor" description="Authenticated live telemetry converges into persisted canonical evidence and deterministic analysis." actions={<><select aria-label="Live case" value={caseId ?? ""} onChange={event => setCaseId(Number(event.target.value))}>{cases.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select>{session?.status === "active" ? <Button variant="danger" onClick={stop}>Stop capture</Button> : <Button variant="primary" onClick={start} disabled={!caseId}>Start capture</Button>}</>}/>
    <div className="connection-banner live-connection-detail"><div className="radar-icon"><i/><i/><span/></div><div className="connection-copy"><span className="eyebrow">SSE connection</span><h3><StatusBadge status={stateTone}/></h3><p>{paused ? `Display paused; backend capture continues. ${pending.current.length} queued.` : "Accepted records stream after durable persistence."}</p></div><div className="connection-stats"><span><b>{session?.session_id.slice(0, 8) ?? "—"}</b>Session</span><span><b>{dropped}</b>Display drops</span><span><b>{malformed}</b>Stream errors</span></div></div>
    {error && <div className="state-box" role="alert"><strong>Live connection notice</strong><p>{error}</p></div>}
    <div className="metrics-grid four"><MetricCard label="Devices observed" value={String(metrics?.device_count ?? 0)}/><MetricCard label="Canonical live events" value={String(metrics?.event_count ?? 0)}/><MetricCard label="Live alerts" value={String(metrics?.alert_count ?? alerts.length)} tone="danger"/><MetricCard label="Malformed inputs" value={String(metrics?.malformed_count ?? 0)}/></div>
    <div className="monitoring-semantics"><span>Display control</span><Button onClick={togglePause}>{paused ? "Resume display" : "Pause display"}</Button><p>Pausing never stops collection or backend analysis.</p></div>
    <div className="live-grid refined live-feed-grid"><Panel className="span-2" title="Persisted live event feed" action={<span className="streaming">● {state}</span>}>{eventRows.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Observed UTC</th><th>Event</th><th>Device</th><th>Evidence</th></tr></thead><tbody>{eventRows.map((item, index) => <tr key={String(item.event_id ?? index)}><td>{String(item.observed_at ?? "Unavailable")}</td><td>{String(item.event_type ?? "Unknown")}</td><td>{String((item.device as Record<string, unknown> | undefined)?.id ?? "—")}</td><td><button onClick={() => navigate(`/cases/${caseId}/events`)}>{String(item.event_id ?? "Open")}</button></td></tr>)}</tbody></table></div> : <div className="state-box"><strong>No live events yet</strong><p>Post authenticated telemetry to the active session.</p></div>}</Panel>
      <Panel title="New deterministic alerts">{alerts.length ? alerts.slice(0, 20).map((alert, index) => <article className="alert-card" key={String(alert.alert_id ?? index)}><b>{String(alert.severity ?? "Alert")}</b><p>{String(alert.title ?? alert.rule_id ?? "Detection rule matched")}</p><button onClick={() => navigate(`/assistant?case=${caseId}&alert=${String(alert.alert_id ?? "")}`)}>Investigate</button></article>) : <div className="state-box"><strong>No live alerts</strong><p>Only backend-qualified live alerts appear here.</p></div>}</Panel></div>
    <div className="section-header compact"><div><h2>Incident timeline</h2><p>Rebuilt by the backend after every accepted live event; entries below are refetched from the investigation API, never assembled in the browser.</p></div></div>
    <Panel title="Deterministic incident timeline" action={<span className="streaming">{timeline.length} entries</span>}>{timeline.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Occurred UTC</th><th>Entry</th><th>Type</th><th>Severity</th><th>Basis</th></tr></thead><tbody>{timeline.slice(0, MAX_TIMELINE).map((entry, index) => <tr key={entry.entry_id ?? index}><td>{String(entry.occurred_at ?? "Unavailable")}</td><td>{entry.title}</td><td>{entry.entry_type}</td><td>{String(entry.severity ?? "—")}</td><td>{entry.timestamp_basis}</td></tr>)}</tbody></table></div> : <div className="state-box"><strong>No timeline entries yet</strong><p>The chronology appears once the backend has analysed an accepted live event.</p></div>}</Panel>
    <div className="section-header compact"><div><h2>Device status</h2><p>Staleness is backend-authored from accepted heartbeat and event times.</p></div></div><div className="device-grid">{devices.map(device => <article className="device-card" key={`${device.session_id}-${device.device_id}`}><header><b>{device.device_id}</b><StatusBadge status={device.stale ? "Stale" : "Online"}/></header><p>{device.source_id}</p><small>Last seen {device.last_seen_at}</small><dl>{Object.entries(device.latest_metrics).slice(0, 4).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></article>)}</div></>;
}
