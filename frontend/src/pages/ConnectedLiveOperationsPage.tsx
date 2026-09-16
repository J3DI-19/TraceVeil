import { useEffect, useMemo, useRef, useState } from "react";
import { batchApi, type ApiCase } from "../api/batch";
import { normalizeApiError } from "../api/client";
import { investigationApi, type TimelineRecord } from "../api/investigation";
import { phase3Api, type DeviceState, type LiveMetrics, type LiveSession, type StreamEnvelope } from "../api/phase3";
import { Button, MetricCard, PageHeader, Panel, StatusBadge } from "../components/ui/core";
import { type ConnectionState } from "../features/live/SseLiveDataSource";
import { useLiveInvalidation } from "../features/live/useLiveInvalidation";

const MAX_EVENTS = 500, MAX_ALERTS = 100, MAX_PENDING = 250, MAX_IDS = 2000, MAX_TIMELINE = 50;

export function ConnectedLiveOperationsPage({ navigate, search = "" }: { navigate: (path: string) => void; search?: string }) {
  const [cases, setCases] = useState<ApiCase[]>([]); const [caseId, setCaseId] = useState<number | null>(null);
  const [session, setSession] = useState<LiveSession | null>(null); const [metrics, setMetrics] = useState<LiveMetrics | null>(null); const [devices, setDevices] = useState<DeviceState[]>([]);
  const [events, setEvents] = useState<Record<string, unknown>[]>([]); const [alerts, setAlerts] = useState<Record<string, unknown>[]>([]); const [timeline, setTimeline] = useState<TimelineRecord[]>([]);
  const [state, setState] = useState<ConnectionState>("disconnected"); const [paused, setPaused] = useState(false); const [dropped, setDropped] = useState(0); const [malformed, setMalformed] = useState(0); const [error, setError] = useState<string | null>(null);
  const seen = useRef(new Set<number>()); const seenOrder = useRef<number[]>([]);
  useEffect(() => { const controller = new AbortController(); void batchApi.listCases(controller.signal).then(result => { const items = Array.isArray(result.items) ? result.items : []; const requested = Number(new URLSearchParams(search).get("case")); setCases(items); setCaseId(items.some(item => item.id === requested) ? requested : (items[0]?.id ?? null)); }).catch(reason => { if (!controller.signal.aborted) setError(normalizeApiError(reason).message); }); return () => controller.abort(); }, [search]);
  useEffect(() => { if (!caseId) return; const controller = new AbortController(); void phase3Api.sessions(caseId, controller.signal).then(result => { const items = Array.isArray(result.items) ? result.items : []; setSession(items.find(item => item.status === "active") ?? items[0] ?? null); }).catch(reason => { if (!controller.signal.aborted) setError(normalizeApiError(reason).message); }); return () => controller.abort(); }, [caseId]);
  // The timeline signal carries only identifiers, so the chronology is
  // always refetched from the investigation API and never reconstructed
  // in the browser from stream payloads.
  //
  // Every refresh path - signal, heartbeat, reset and resume - goes
  // through this one function so they share a single ordering rule. Live
  // analysis can emit several `timeline.updated` frames in quick
  // succession; without a guard their responses can resolve out of order
  // and an older analysis overwrites a newer chronology. The in-flight
  // request is aborted, and the sequence is checked again on resolution
  // because a transport or a test double may ignore the abort.
  const timelineSequence = useRef(0);
  const timelineRequest = useRef<AbortController | null>(null);
  // `analysisId` pins the request to the exact snapshot the signal named,
  // which the timeline API accepts. Asking for a named snapshot is
  // stronger than asking for "latest" and sorting the answers out
  // afterwards: two requests for "latest" can legitimately return
  // different analyses, and only the arrival order would distinguish
  // them. The sequence guard below still applies, because a refresh with
  // no analysis id - a heartbeat, a reset, a resume - has nothing to pin.
  const refreshTimeline = (signal?: AbortSignal, analysisId?: string) => {
    if (!caseId) return;
    const requestId = ++timelineSequence.current;
    timelineRequest.current?.abort();
    const controller = new AbortController();
    timelineRequest.current = controller;
    // An outer signal (a page teardown) must cancel this request too.
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    void investigationApi.timeline(caseId, { page: 1, pageSize: MAX_TIMELINE, analysisId: analysisId ?? null }, controller.signal)
      .then(result => {
        if (requestId !== timelineSequence.current) return;
        setTimeline(Array.isArray(result.items) ? result.items : []);
      })
      .catch(reason => {
        // A superseded or torn-down request is not a failure, and must
        // never surface an error or blank the chronology on screen.
        if (controller.signal.aborted || signal?.aborted) return;
        if (requestId !== timelineSequence.current) return;
        setError(normalizeApiError(reason).message);
      })
      .finally(() => { if (timelineRequest.current === controller) timelineRequest.current = null; });
  };
  // Device status is never inferred here. A silent device only becomes
  // Stale when the backend says so, which is why an idle heartbeat
  // refetches devices instead of the browser ageing them out locally.
  const refreshDevices = (signal?: AbortSignal) => {
    if (!caseId) return;
    void phase3Api.devices(caseId, session?.session_id, signal)
      .then(result => setDevices(Array.isArray(result.items) ? result.items : []))
      .catch(reason => { if (!signal?.aborted) setError(normalizeApiError(reason).message); });
  };
  const refreshMetrics = (signal?: AbortSignal) => {
    if (!caseId) return;
    void phase3Api.metrics(caseId, session?.session_id, signal).then(setMetrics)
      .catch(reason => { if (!signal?.aborted) setError(normalizeApiError(reason).message); });
  };
  // Persisted events and alerts, reloaded from the investigation API. The
  // live feeds are display buffers assembled from stream frames, so after
  // a gap the only way to show a true feed is to read the records the
  // backend actually kept - clearing the buffers would leave the operator
  // with an empty panel and no indication anything was missed.
  const refreshPersistedFeeds = (signal?: AbortSignal) => {
    if (!caseId) return;
    void investigationApi.events(caseId, { page: 1, pageSize: MAX_EVENTS }, signal)
      .then(result => setEvents(Array.isArray(result.items) ? result.items as unknown as Record<string, unknown>[] : []))
      .catch(reason => { if (!signal?.aborted) setError(normalizeApiError(reason).message); });
    void investigationApi.alerts(caseId, { page: 1, pageSize: MAX_ALERTS }, signal)
      .then(result => setAlerts(Array.isArray(result.items) ? result.items as unknown as Record<string, unknown>[] : []))
      .catch(reason => { if (!signal?.aborted) setError(normalizeApiError(reason).message); });
  };
  /** Discard every browser-held buffer. Used on a reset and whenever the
   *  selected case or live session changes, so nothing crosses a scope. */
  const clearBuffers = () => { setEvents([]); setAlerts([]); seen.current.clear(); seenOrder.current = []; };
  /** Rebuild every view named by the reset from its authoritative API. */
  const resynchronize = () => { clearBuffers(); refreshDevices(); refreshMetrics(); refreshTimeline(); refreshPersistedFeeds(); };
  const apply = (message: StreamEnvelope) => {
    if (message.id && seen.current.has(message.id)) return;
    if (message.id) { seen.current.add(message.id); seenOrder.current.push(message.id); if (seenOrder.current.length > MAX_IDS) seen.current.delete(seenOrder.current.shift()!); }
    const payload = message.payload ?? {};
    if (message.topic === "event.accepted") setEvents(current => [payload, ...current].slice(0, MAX_EVENTS));
    if (message.topic === "alert.created") setAlerts(current => [payload, ...current].slice(0, MAX_ALERTS));
    if (message.topic === "device.updated") setDevices(current => [payload as unknown as DeviceState, ...current.filter(item => item.device_id !== payload.device_id)].slice(0, 200));
    if (message.topic === "metrics.updated") refreshMetrics();
    // The signal names the analysis the backend just persisted, so the
    // refetch asks for that snapshot by id rather than for "latest".
    if (message.topic === "timeline.updated") refreshTimeline(undefined, String(payload.analysis_id ?? "") || undefined);
    // An idle stream still has to age devices out. The heartbeat is the
    // only tick available when nothing is being reported, and it is what
    // turns a silent sensor from Online into Stale.
    if (message.topic === "heartbeat") refreshDevices();
  };
  const live = useLiveInvalidation({
    caseId, sessionId: session?.session_id, active: session?.status === "active",
    paused, maxQueued: MAX_PENDING, onMessage: apply, onState: setState,
    onDrop: count => setDropped(value => value + count),
    // A gap is announced, never silent: say so, then rebuild from the
    // authoritative APIs rather than leaving a partial feed on screen.
    onReset: reset => {
      setError(reset.reason === "cursor_expired"
        ? "Live replay fell outside the retained window; refetched authoritative state."
        : "The live cursor could not be resumed; refetched authoritative state.");
      resynchronize();
    },
    onError: message => { setError(message); setMalformed(value => value + 1); },
  });
  // Nothing survives a change of case or live session. Without this the
  // previous scope's events and seen ids stay on screen and keep
  // suppressing the new scope's frames as duplicates.
  useEffect(clearBuffers, [caseId, session?.session_id]);
  useEffect(() => { if (!caseId) return; const controller = new AbortController(); void Promise.all([phase3Api.metrics(caseId, session?.session_id, controller.signal), phase3Api.devices(caseId, session?.session_id, controller.signal)]).then(([nextMetrics, nextDevices]) => { setMetrics(nextMetrics); setDevices(Array.isArray(nextDevices.items) ? nextDevices.items : []); }).catch(reason => { if (!controller.signal.aborted) setError(normalizeApiError(reason).message); }); refreshTimeline(controller.signal); return () => controller.abort(); }, [caseId, session?.session_id]);
  const start = async () => { if (!caseId) return; try { setSession(await phase3Api.startSession(caseId)); setError(null); } catch (reason) { setError(normalizeApiError(reason).message); } };
  const stop = async () => { if (!session) return; try { setSession(await phase3Api.stopSession(session.session_id)); } catch (reason) { setError(normalizeApiError(reason).message); } };
  // Resuming replays what was buffered and then refetches, so the display
  // catches up without the stream ever having been torn down - the SSE
  // cursor is untouched by pausing, so no replay and no gap occur.
  const togglePause = () => { if (paused) { live.flush(); refreshMetrics(); refreshDevices(); refreshTimeline(); } setPaused(value => !value); };
  const stateTone = state === "connected" ? "Operational" : state === "stale" || state === "terminal-error" ? "Unavailable" : state;
  const eventRows = useMemo(() => events.slice(0, 50), [events]);
  return <><PageHeader eyebrow="Controlled telemetry · Connected API" title="Live monitor" description="Authenticated live telemetry converges into persisted canonical evidence and deterministic analysis." actions={<><select aria-label="Live case" value={caseId ?? ""} onChange={event => setCaseId(Number(event.target.value))}>{cases.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select>{session?.status === "active" ? <Button variant="danger" onClick={stop}>Stop capture</Button> : <Button variant="primary" onClick={start} disabled={!caseId}>Start capture</Button>}</>}/>
    <div className="connection-banner live-connection-detail"><div className="radar-icon"><i/><i/><span/></div><div className="connection-copy"><span className="eyebrow">SSE connection</span><h3><StatusBadge status={stateTone}/></h3><p>{paused ? `Display paused; backend capture continues. ${live.queuedCount()} queued.` : "Accepted records stream after durable persistence."}</p></div><div className="connection-stats"><span><b>{session?.session_id.slice(0, 8) ?? "—"}</b>Session</span><span><b>{dropped}</b>Display drops</span><span><b>{malformed}</b>Stream errors</span></div></div>
    {error && <div className="state-box" role="alert"><strong>Live connection notice</strong><p>{error}</p></div>}
    <div className="metrics-grid four"><MetricCard label="Devices observed" value={String(metrics?.device_count ?? 0)}/><MetricCard label="Canonical live events" value={String(metrics?.event_count ?? 0)}/><MetricCard label="Live alerts" value={String(metrics?.alert_count ?? alerts.length)} tone="danger"/><MetricCard label="Malformed inputs" value={String(metrics?.malformed_count ?? 0)}/></div>
    <div className="monitoring-semantics"><span>Display control</span><Button onClick={togglePause}>{paused ? "Resume display" : "Pause display"}</Button><p>Pausing never stops collection or backend analysis.</p></div>
    <div className="live-grid refined live-feed-grid"><Panel className="span-2" title="Persisted live event feed" action={<span className="streaming">● {state}</span>}>{eventRows.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Observed UTC</th><th>Event</th><th>Device</th><th>Evidence</th></tr></thead><tbody>{eventRows.map((item, index) => <tr key={String(item.event_id ?? index)}><td>{String(item.observed_at ?? "Unavailable")}</td><td>{String(item.event_type ?? "Unknown")}</td><td>{String((item.device as Record<string, unknown> | undefined)?.id ?? "—")}</td><td><button onClick={() => navigate(`/cases/${caseId}/events`)}>{String(item.event_id ?? "Open")}</button></td></tr>)}</tbody></table></div> : <div className="state-box"><strong>No live events yet</strong><p>Post authenticated telemetry to the active session.</p></div>}</Panel>
      <Panel title="New deterministic alerts">{alerts.length ? alerts.slice(0, 20).map((alert, index) => <article className="alert-card" key={String(alert.alert_id ?? index)}><b>{String(alert.severity ?? "Alert")}</b><p>{String(alert.title ?? alert.rule_id ?? "Detection rule matched")}</p><button onClick={() => navigate(`/assistant?case=${caseId}&alert=${String(alert.alert_id ?? "")}`)}>Investigate</button>
      {/* A direct path from the live feed to this alert's record, where the
          approval-gated notification panel sits - so notifying about a live
          alert does not require hunting for the row by hand. */}
      <button onClick={() => navigate(`/cases/${caseId}/alerts?alert=${String(alert.alert_id ?? "")}`)}>Notify</button></article>) : <div className="state-box"><strong>No live alerts</strong><p>Only backend-qualified live alerts appear here.</p></div>}</Panel></div>
    <div className="section-header compact"><div><h2>Incident timeline</h2><p>Rebuilt by the backend after every accepted live event; entries below are refetched from the investigation API, never assembled in the browser.</p></div></div>
    <Panel title="Deterministic incident timeline" action={<span className="streaming">{timeline.length} entries</span>}>{timeline.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Occurred UTC</th><th>Entry</th><th>Type</th><th>Severity</th><th>Basis</th></tr></thead><tbody>{timeline.slice(0, MAX_TIMELINE).map((entry, index) => <tr key={entry.entry_id ?? index}><td>{String(entry.occurred_at ?? "Unavailable")}</td><td>{entry.title}</td><td>{entry.entry_type}</td><td>{String(entry.severity ?? "—")}</td><td>{entry.timestamp_basis}</td></tr>)}</tbody></table></div> : <div className="state-box"><strong>No timeline entries yet</strong><p>The chronology appears once the backend has analysed an accepted live event.</p></div>}</Panel>
    <div className="section-header compact"><div><h2>Device status</h2><p>Online, Stale and Offline are backend-authored. Stale means nothing has been accepted within this session's own threshold; Offline means the device reported its link down.</p></div></div><div className="device-grid">{devices.map(device => <article className="device-card" key={`${device.session_id}-${device.device_id}`}><header><b>{device.device_id}</b><StatusBadge status={deviceStatusLabel(device)}/></header><p>{device.source_id}</p><small>Last seen {device.last_seen_at}{device.stale_after_seconds ? ` · stale after ${device.stale_after_seconds}s` : ""}</small><dl>{Object.entries(device.latest_metrics).slice(0, 4).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></article>)}</div></>;
}

/**
 * The three states are never collapsed. A device whose link is down can
 * still carry a recent timestamp (a retained transport message), so
 * reading recency alone would render a disconnected sensor as Online -
 * exactly the misreading that matters during a live demonstration.
 */
function deviceStatusLabel(device: DeviceState) {
  if (device.connection_state === "offline") return "Offline";
  if (device.connection_state === "stale") return "Stale";
  if (device.connection_state === "online") return "Online";
  return device.stale ? "Stale" : "Online";
}
