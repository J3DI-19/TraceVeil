import { useEffect, useMemo, useRef, useState } from "react";
import { batchApi, type ApiCase } from "../api/batch";
import { normalizeApiError } from "../api/client";
import { investigationApi, type TimelineRecord } from "../api/investigation";
import { phase3Api, type DeviceState, type LiveMetrics, type LiveSession, type StreamEnvelope } from "../api/phase3";
import { Button, MetricCard, PageHeader, Panel, StatusBadge } from "../components/ui/core";
import { type ConnectionState } from "../features/live/SseLiveDataSource";
import { useLiveInvalidation } from "../features/live/useLiveInvalidation";

// Display capacity: how many records the browser is willing to hold.
const MAX_EVENTS = 500, MAX_ALERTS = 100, MAX_PENDING = 250, MAX_IDS = 2000, MAX_TIMELINE = 50;
// Transport pagination: how many records one API request may ask for.
// These are deliberately separate from the display bounds above. The
// investigation endpoints cap `page_size` at 200, so asking for the
// display bound (500) was rejected with a 422 and recovery rebuilt
// nothing at all. A display buffer is a browser concern; a page size is
// a contract term, and conflating them made a silent failure look like a
// successful authoritative rebuild.
const EVENT_PAGE_SIZE = 200, ALERT_PAGE_SIZE = 100;
// Recovery shows the most recent records case-wide, newest first, which
// is what the operator was watching when the stream broke. Ascending
// page 1 would be the oldest history of the case instead.
const RECOVERY_ORDER = "desc" as const;

/** Authoritative identifier, or "" when the record carries none. */
const recordId = (record: Record<string, unknown>, key: string) => String(record[key] ?? "");
/** Backend timestamps only. The browser never invents a forensic time. */
const eventTime = (record: Record<string, unknown>) => String(record.observed_at ?? record.ingested_at ?? "");
const alertTime = (record: Record<string, unknown>) => String(record.triggered_at ?? "");

/**
 * Combine an authoritative snapshot with records streamed while it was
 * loading.
 *
 * A reset starts an asynchronous snapshot request but leaves the stream
 * connected, so a newer event or alert can arrive before the response
 * lands. Replacing the feed with the snapshot then erases a record the
 * backend had already delivered - the investigator watches an alert
 * appear and vanish, while the stream cursor has moved past it. The
 * persisted evidence is intact; what is lost is the operator's sight of
 * it, which during a live incident is the thing that matters.
 *
 * Records are keyed by their authoritative identifier, and the streamed
 * representation wins for an id present in both: it is the later view of
 * the same record. Ordering uses backend timestamps with the identifier
 * as a stable tiebreak, then the display bound is applied. Records with
 * no identifier cannot be de-duplicated, so they are kept rather than
 * silently dropped, and sort last.
 */
function mergeNewestFirst(
  snapshot: Record<string, unknown>[],
  streamed: Record<string, unknown>[],
  idKey: string,
  timeOf: (record: Record<string, unknown>) => string,
  bound: number,
): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  const anonymous: Record<string, unknown>[] = [];
  for (const record of [...snapshot, ...streamed]) {
    const id = recordId(record, idKey);
    if (id) byId.set(id, record); else anonymous.push(record);
  }
  return [...byId.values(), ...anonymous]
    .sort((left, right) => {
      const leftTime = timeOf(left), rightTime = timeOf(right);
      if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1;
      return recordId(left, idKey) < recordId(right, idKey) ? 1 : -1;
    })
    .slice(0, bound);
}

/** The resources a reset rebuilds. Recovery is complete only when every
 *  one of them has answered successfully. */
const RECOVERY_RESOURCES = ["devices", "metrics", "timeline", "events", "alerts"] as const;
type RecoveryResource = (typeof RECOVERY_RESOURCES)[number];
type ResourceOutcome = "pending" | "ok" | "failed";
interface RecoveryStatus {
  recovery: number;
  reason: string;
  overflowed: boolean;
  resources: Record<RecoveryResource, ResourceOutcome>;
}

export function ConnectedLiveOperationsPage({ navigate, search = "" }: { navigate: (path: string) => void; search?: string }) {
  const [cases, setCases] = useState<ApiCase[]>([]); const [caseId, setCaseId] = useState<number | null>(null);
  const [session, setSession] = useState<LiveSession | null>(null); const [metrics, setMetrics] = useState<LiveMetrics | null>(null); const [devices, setDevices] = useState<DeviceState[]>([]);
  const [events, setEvents] = useState<Record<string, unknown>[]>([]); const [alerts, setAlerts] = useState<Record<string, unknown>[]>([]); const [timeline, setTimeline] = useState<TimelineRecord[]>([]);
  const [state, setState] = useState<ConnectionState>("disconnected"); const [paused, setPaused] = useState(false); const [dropped, setDropped] = useState(0); const [malformed, setMalformed] = useState(0); const [error, setError] = useState<string | null>(null);
  const seen = useRef(new Set<number>()); const seenOrder = useRef<number[]>([]);
  /** Discard every browser-held buffer. Used on a reset and whenever the
   *  selected case or live session changes, so nothing crosses a scope. */
  const clearBuffers = () => { setEvents([]); setAlerts([]); seen.current.clear(); seenOrder.current = []; };
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
  // --- Scope lifetime -----------------------------------------------------
  // Every loader below is asynchronous, and clearing a buffer does not
  // cancel a request already in flight. A Case A response that resolves
  // after the operator has switched to Case B would otherwise be applied
  // on arrival - attributing one case's alerts to another, which in an
  // investigation tool is a correctness failure, not a flicker.
  //
  // So a response is accepted only if the scope it was issued under is
  // still current. Three checks, because each catches something the
  // others do not:
  //
  //   * the abort signal - the normal path, when the transport honours it;
  //   * the generation    - the final boundary, for transports, wrappers
  //                         and test doubles that ignore cancellation and
  //                         deliver the promise anyway;
  //   * the recovery id   - for two refreshes inside the *same* scope,
  //                         where the scope check passes for both and only
  //                         ordering separates them.
  //
  // The same checks guard error handling, so a stale rejection cannot
  // raise a notice against the scope that replaced it.
  const generation = useRef(0);
  const scopeController = useRef<AbortController>(new AbortController());
  const recoverySequence = useRef(0);
  const timelineSequence = useRef(0);
  const timelineRequest = useRef<AbortController | null>(null);

  // Records that arrive on the stream while a recovery snapshot is in
  // flight. They are displayed immediately *and* retained here, so the
  // snapshot can be merged with them instead of replacing them.
  const recoveryBuffer = useRef<{ recovery: number; generation: number; events: Record<string, unknown>[]; alerts: Record<string, unknown>[]; pending: { events: boolean; alerts: boolean } } | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus | null>(null);
  // One automatic re-run per overflowed recovery, never a loop.
  const overflowRetried = useRef(0);

  interface Scope { caseId: number; sessionId: string | undefined; generation: number; recovery: number; signal: AbortSignal }
  const captureScope = (newRecovery = false): Scope | null => {
    if (!caseId) return null;
    if (newRecovery) recoverySequence.current += 1;
    return {
      caseId, sessionId: session?.session_id, generation: generation.current,
      recovery: recoverySequence.current, signal: scopeController.current.signal,
    };
  };
  const stillCurrent = (scope: Scope) =>
    !scope.signal.aborted
    && scope.generation === generation.current
    && scope.caseId === caseId
    && scope.sessionId === session?.session_id
    && scope.recovery === recoverySequence.current;

  /** Record how one resource of the *current* recovery finished. A result
   *  from an old scope or a superseded recovery must not move the status. */
  const reportRecovery = (scope: Scope, resource: RecoveryResource, ok: boolean) => {
    if (!stillCurrent(scope)) return;
    setRecoveryStatus(current => (current && current.recovery === scope.recovery
      ? { ...current, resources: { ...current.resources, [resource]: ok ? "ok" : "failed" } }
      : current));
  };

  // Invalidate the scope the moment the case or session changes: bump the
  // generation, abort everything outstanding, and drop the buffers before
  // any new request begins.
  useEffect(() => {
    generation.current += 1;
    scopeController.current.abort();
    scopeController.current = new AbortController();
    clearBuffers();
    // Every recovery buffer, result and status belongs to the scope that
    // started it and dies with that scope.
    recoveryBuffer.current = null;
    setRecoveryStatus(null);
    // A notice raised for the previous case is not true of this one. It is
    // cleared here rather than inside `clearBuffers`, which a reset also
    // calls - a reset's own explanation must survive its rebuild.
    setError(null);
    const controller = scopeController.current;
    return () => { generation.current += 1; controller.abort(); };
  }, [caseId, session?.session_id]);

  // The timeline signal carries only identifiers, so the chronology is
  // always refetched from the investigation API and never reconstructed
  // in the browser from stream payloads.
  //
  // `analysisId` pins the request to the exact snapshot the signal named,
  // which the timeline API accepts. Asking for a named snapshot is
  // stronger than asking for "latest" and sorting the answers out
  // afterwards: two requests for "latest" can legitimately return
  // different analyses, and only the arrival order would distinguish
  // them. The sequence guard still applies, because a refresh with no
  // analysis id - a heartbeat, a reset, a resume - has nothing to pin.
  const refreshTimeline = (_signal?: AbortSignal, analysisId?: string, recoveryScope?: Scope) => {
    const scope = recoveryScope ?? captureScope();
    if (!scope) return;
    const requestId = ++timelineSequence.current;
    timelineRequest.current?.abort();
    const controller = new AbortController();
    timelineRequest.current = controller;
    scope.signal.addEventListener("abort", () => controller.abort(), { once: true });
    void investigationApi.timeline(scope.caseId, { page: 1, pageSize: MAX_TIMELINE, analysisId: analysisId ?? null }, controller.signal)
      .then(result => {
        if (stillCurrent(scope) && requestId === timelineSequence.current) {
          setTimeline(Array.isArray(result.items) ? result.items : []);
        }
        if (recoveryScope) reportRecovery(scope, "timeline", true);
      })
      .catch(reason => {
        // A superseded or out-of-scope request is not a failure, and must
        // never surface an error or blank the chronology on screen.
        if (controller.signal.aborted) return;
        if (stillCurrent(scope) && requestId === timelineSequence.current) {
          setError(normalizeApiError(reason).message);
        }
        if (recoveryScope) reportRecovery(scope, "timeline", false);
      })
      .finally(() => { if (timelineRequest.current === controller) timelineRequest.current = null; });
  };

  // Device status is never inferred here. A silent device only becomes
  // Stale when the backend says so, which is why an idle heartbeat
  // refetches devices instead of the browser ageing them out locally.
  const refreshDevices = (recoveryScope?: Scope) => {
    const scope = recoveryScope ?? captureScope();
    if (!scope) return;
    void phase3Api.devices(scope.caseId, scope.sessionId, scope.signal)
      .then(result => {
        if (stillCurrent(scope)) setDevices(Array.isArray(result.items) ? result.items : []);
        if (recoveryScope) reportRecovery(scope, "devices", true);
      })
      .catch(reason => {
        if (stillCurrent(scope)) setError(normalizeApiError(reason).message);
        if (recoveryScope) reportRecovery(scope, "devices", false);
      });
  };
  const refreshMetrics = (recoveryScope?: Scope) => {
    const scope = recoveryScope ?? captureScope();
    if (!scope) return;
    void phase3Api.metrics(scope.caseId, scope.sessionId, scope.signal)
      .then(result => {
        if (stillCurrent(scope)) setMetrics(result);
        if (recoveryScope) reportRecovery(scope, "metrics", true);
      })
      .catch(reason => {
        if (stillCurrent(scope)) setError(normalizeApiError(reason).message);
        if (recoveryScope) reportRecovery(scope, "metrics", false);
      });
  };

  // Persisted events and alerts, reloaded from the investigation API. The
  // live feeds are display buffers assembled from stream frames, so after
  // a gap the only way to show a true feed is to read the records the
  // backend actually kept - clearing the buffers would leave the operator
  // with an empty panel and no indication anything was missed.
  //
  // A failed reload is reported as a failed reload. Presenting an empty
  // or partial panel as a completed rebuild is worse than saying the
  // rebuild did not happen.
  const refreshPersistedFeeds = (scope: Scope | null) => {
    if (!scope) return;
    /** Take the records streamed during *this* recovery and clear only
     *  that resource's collection. A stale response must never empty the
     *  active recovery's buffer. */
    const drain = (resource: "events" | "alerts") => {
      const buffer = recoveryBuffer.current;
      if (!buffer || buffer.recovery !== scope.recovery || buffer.generation !== scope.generation) return [];
      const streamed = buffer[resource];
      buffer[resource] = [];
      // Retention stops once this resource's snapshot has landed. Records
      // arriving afterwards are ordinary live feed, already displayed;
      // continuing to buffer them would let a busy stream report an
      // overflow against a recovery that had already finished.
      buffer.pending[resource] = false;
      return streamed;
    };
    void investigationApi.events(scope.caseId, { page: 1, pageSize: EVENT_PAGE_SIZE, order: RECOVERY_ORDER }, scope.signal)
      .then(result => {
        if (stillCurrent(scope)) {
          const snapshot = Array.isArray(result.items) ? result.items as unknown as Record<string, unknown>[] : [];
          setEvents(mergeNewestFirst(snapshot, drain("events"), "event_id", eventTime, MAX_EVENTS));
        }
        reportRecovery(scope, "events", true);
      })
      .catch(reason => {
        // The snapshot failed, but records already delivered in this scope
        // are still true and stay on screen. Only the claim of a completed
        // rebuild is withdrawn.
        if (stillCurrent(scope)) setError(`Persisted events could not be reloaded: ${normalizeApiError(reason).message}`);
        reportRecovery(scope, "events", false);
      });
    void investigationApi.alerts(scope.caseId, { page: 1, pageSize: ALERT_PAGE_SIZE, order: RECOVERY_ORDER }, scope.signal)
      .then(result => {
        if (stillCurrent(scope)) {
          const snapshot = Array.isArray(result.items) ? result.items as unknown as Record<string, unknown>[] : [];
          setAlerts(mergeNewestFirst(snapshot, drain("alerts"), "alert_id", alertTime, MAX_ALERTS));
        }
        reportRecovery(scope, "alerts", true);
      })
      .catch(reason => {
        if (stillCurrent(scope)) setError(`Persisted alerts could not be reloaded: ${normalizeApiError(reason).message}`);
        reportRecovery(scope, "alerts", false);
      });
  };

  /** Rebuild every view named by the reset from its authoritative API. */
  const resynchronize = (reason: string) => {
    // One recovery generation for the whole rebuild, so a newer reset
    // supersedes an older one even inside the same case and session.
    const scope = captureScope(true);
    if (!scope) return;
    clearBuffers();
    recoveryBuffer.current = { recovery: scope.recovery, generation: scope.generation, events: [], alerts: [], pending: { events: true, alerts: true } };
    setRecoveryStatus({
      recovery: scope.recovery, reason, overflowed: false,
      resources: { devices: "pending", metrics: "pending", timeline: "pending", events: "pending", alerts: "pending" },
    });
    refreshDevices(scope); refreshMetrics(scope); refreshTimeline(undefined, undefined, scope); refreshPersistedFeeds(scope);
  };

  const apply = (message: StreamEnvelope) => {
    if (message.id && seen.current.has(message.id)) return;
    if (message.id) { seen.current.add(message.id); seenOrder.current.push(message.id); if (seenOrder.current.length > MAX_IDS) seen.current.delete(seenOrder.current.shift()!); }
    const payload = message.payload ?? {};
    // A record delivered while a recovery snapshot is in flight is shown
    // at once *and* retained, so the snapshot merges with it rather than
    // replacing it. Overflow is reported rather than silently dropped: a
    // truncated buffer would make the merged feed quietly incomplete.
    const retain = (resource: "events" | "alerts", record: Record<string, unknown>, bound: number) => {
      const buffer = recoveryBuffer.current;
      if (!buffer || buffer.generation !== generation.current || !buffer.pending[resource]) return;
      buffer[resource].push(record);
      if (buffer[resource].length > bound) {
        buffer[resource].shift();
        setRecoveryStatus(current => (current && current.recovery === buffer.recovery && !current.overflowed
          ? { ...current, overflowed: true } : current));
      }
    };
    if (message.topic === "event.accepted") { retain("events", payload, MAX_EVENTS); setEvents(current => [payload, ...current].slice(0, MAX_EVENTS)); }
    if (message.topic === "alert.created") { retain("alerts", payload, MAX_ALERTS); setAlerts(current => [payload, ...current].slice(0, MAX_ALERTS)); }
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
    // A gap is announced, never silent. The notice says a rebuild has
    // *begun*: claiming success here would pair a completion message with
    // requests that are still in flight, and a stalled one would leave an
    // incomplete panel looking finished.
    onReset: reset => {
      setError(null);
      resynchronize(reset.reason === "cursor_expired"
        ? "Live replay fell outside the retained window"
        : "The live cursor could not be resumed");
    },
    onError: message => { setError(message); setMalformed(value => value + 1); },
  });
  // Nothing survives a change of case or live session. Without this the
  // previous scope's events and seen ids stay on screen and keep
  // suppressing the new scope's frames as duplicates.
  // Initial load goes through the same guarded loaders as every other
  // path, rather than keeping a private controller with unchecked state
  // writes. Protecting only the recovery path would leave the first load
  // of a newly selected case able to land after the operator moved on.
  useEffect(() => {
    if (!caseId) return;
    refreshMetrics(); refreshDevices(); refreshTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, session?.session_id]);
  const start = async () => { if (!caseId) return; try { setSession(await phase3Api.startSession(caseId)); setError(null); } catch (reason) { setError(normalizeApiError(reason).message); } };
  const stop = async () => { if (!session) return; try { setSession(await phase3Api.stopSession(session.session_id)); } catch (reason) { setError(normalizeApiError(reason).message); } };
  // Resuming replays what was buffered and then refetches, so the display
  // catches up without the stream ever having been torn down - the SSE
  // cursor is untouched by pausing, so no replay and no gap occur.
  const togglePause = () => { if (paused) { live.flush(); refreshMetrics(); refreshDevices(); refreshTimeline(); } setPaused(value => !value); };
  // Derived from the per-resource outcomes, never asserted independently.
  const recoveryOutcome = (() => {
    if (!recoveryStatus) return null;
    const values = RECOVERY_RESOURCES.map(resource => recoveryStatus.resources[resource]);
    if (values.includes("pending")) return "pending" as const;
    if (values.every(value => value === "ok")) return recoveryStatus.overflowed ? ("partial" as const) : ("complete" as const);
    return values.includes("ok") ? ("partial" as const) : ("failed" as const);
  })();
  const recoveryMessage = !recoveryStatus || !recoveryOutcome ? null
    : recoveryOutcome === "pending" ? `${recoveryStatus.reason}; rebuilding from persisted state…`
    : recoveryOutcome === "complete" ? `${recoveryStatus.reason}. Rebuilt from persisted state.`
    : recoveryOutcome === "partial" ? (recoveryStatus.overflowed
        ? `${recoveryStatus.reason}. More records arrived during the rebuild than could be held; rebuild again for a complete view.`
        : `${recoveryStatus.reason}. The rebuild finished only in part.`)
    : `${recoveryStatus.reason}. The rebuild failed.`;
  const pendingResources = recoveryStatus
    ? RECOVERY_RESOURCES.filter(resource => recoveryStatus.resources[resource] === "pending")
    : [];

  // An overflowed recovery is re-run once, automatically and only once, so
  // a busy stream cannot spin the page in a recovery loop.
  useEffect(() => {
    if (!recoveryStatus?.overflowed || recoveryOutcome === "pending") return;
    if (overflowRetried.current === recoveryStatus.recovery) return;
    overflowRetried.current = recoveryStatus.recovery;
    resynchronize(recoveryStatus.reason);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryStatus?.overflowed, recoveryOutcome]);

  const stateTone = state === "connected" ? "Operational" : state === "stale" || state === "terminal-error" ? "Unavailable" : state;
  const eventRows = useMemo(() => events.slice(0, 50), [events]);
  return <><PageHeader eyebrow="Controlled telemetry · Connected API" title="Live monitor" description="Authenticated live telemetry converges into persisted canonical evidence and deterministic analysis." actions={<><select aria-label="Live case" value={caseId ?? ""} onChange={event => setCaseId(Number(event.target.value))}>{cases.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select>{session?.status === "active" ? <Button variant="danger" onClick={stop}>Stop capture</Button> : <Button variant="primary" onClick={start} disabled={!caseId}>Start capture</Button>}</>}/>
    <div className="connection-banner live-connection-detail"><div className="radar-icon"><i/><i/><span/></div><div className="connection-copy"><span className="eyebrow">SSE connection</span><h3><StatusBadge status={stateTone}/></h3><p>{paused ? `Display paused; backend capture continues. ${live.queuedCount()} queued.` : "Accepted records stream after durable persistence."}</p></div><div className="connection-stats"><span><b>{session?.session_id.slice(0, 8) ?? "—"}</b>Session</span><span><b>{dropped}</b>Display drops</span><span><b>{malformed}</b>Stream errors</span></div></div>
    {recoveryMessage && <div className={`state-box recovery-${recoveryOutcome}`} role="status"><strong>{recoveryOutcome === "pending" ? "Rebuilding live state" : recoveryOutcome === "complete" ? "Live state rebuilt" : "Live rebuild incomplete"}</strong><p>{recoveryMessage}</p>{pendingResources.length > 0 && <p>Still loading: {pendingResources.join(", ")}.</p>}{(recoveryOutcome === "partial" || recoveryOutcome === "failed") && <Button onClick={() => resynchronize(recoveryStatus!.reason)}>Retry rebuild</Button>}</div>}
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
