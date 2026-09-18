import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "../api/batch";
import { phase3Api } from "../api/phase3";
import { normalizeApiError, serializeQuery } from "../api/client";
import { Button, PageHeader } from "../components/ui/core";
import { ConnectedReportsPanel } from "./ConnectedReportsPanel";
import { ArtifactNotificationPanel } from "../features/reports/ArtifactNotificationPanel";
import { useLiveInvalidation } from "../features/live/useLiveInvalidation";
import { mapInvestigationRecords, type InvestigationRecordKind, type InvestigationRecordViewModel } from "../features/investigation/viewModels";
import { IncidentContext, PersistedTimeline, PersistedVisuals, TimelineActivityOverview, type TimelineWindowSummary } from "../features/investigation/PersistedVisuals";
import type { components } from "../api/generated";

interface PageResult { items?: Record<string, unknown>[]; page?: number; page_size?: number; total?: number; record_total?: number }
interface CaseSummary { analysis_id?: string | null; event_count?: number; [key: string]: unknown }
interface OverviewContext { findings: Record<string, unknown>[]; alerts: Record<string, unknown>[]; incidents: Record<string, unknown>[]; evidence: Record<string, unknown>[] }
interface AnalysisSnapshot { analysis_id: string; case_id: number; status: string; created_at: string }
type ReanalysisResult = components["schemas"]["ReanalysisPublic"];
type ActivityWindowExplanation = components["schemas"]["ActivityWindowExplanation"];
type LoadMode = "initial" | "refresh";
const names: Record<string, string> = { overview: "Case overview", evidence: "Evidence", events: "Canonical events", history: "Analysis history", findings: "Findings", alerts: "Alerts", incidents: "Incidents", timeline: "Timeline", visuals: "Visuals", reports: "Reports", audit: "Audit history" };
const columns: Record<string, string[]> = {
  evidence: ["evidence_id", "original_filename", "source_type", "validation_status", "duplicate_of_evidence_id", "sha256", "received_at"],
  events: ["event_id", "observed_at", "origin", "event_type", "entity_id"],
  findings: ["finding_id", "title", "entity_id", "classification_source", "severity", "risk_score", "rule_id"],
  alerts: ["alert_id", "title", "severity", "risk_score", "workflow_status", "notification_status", "triggered_at"],
  // `summary` leads the incident table: it is the deterministic, backend-authored
  // account of the incident, and a reader should meet it before the raw counts.
  incidents: ["incident_id", "summary", "severity", "maximum_risk", "finding_count", "evidence_count", "entity_count", "entity_ids", "started_at", "ended_at"],
  timeline: ["entry_id", "occurred_at", "entry_type", "title", "severity", "risk_score"],
  audit: ["occurred_at", "action", "actor", "subject_type", "subject_id", "request_id"],
  aggregates: ["series", "category", "subgroup", "value"],
  charts: ["series", "category", "subgroup", "value"],
  "graph nodes": ["node_id", "kind", "label", "event_count", "maximum_risk"],
  "graph edges": ["edge_id", "source_node_id", "target_node_id", "relationships", "event_count"],
};
const analysisSections = new Set(["findings", "alerts", "incidents", "timeline", "visuals"]);
// Sections whose contents change when live analysis re-runs. Evidence and
// canonical events are append-only source records and are left alone.
const liveInvalidatedSections = new Set(["overview", "findings", "alerts", "incidents", "timeline"]);
const visualAliases = new Set(["graph", "charts", "aggregates", "analytics"]);
const primaryTabs = ["overview", "evidence", "findings", "timeline", "visuals", "reports"];
const timelineWindowsPerPage = 10;
const heading = (value: string) => value.replaceAll("_", " ");
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const display = (value: unknown): string => value == null ? "—" : typeof value === "boolean" ? (value ? "Yes" : "No") : Array.isArray(value) ? value.join(", ") : typeof value === "object" ? "Structured details" : String(value);
const valueFor = (item: Record<string, unknown>, column: string): unknown => column === "risk_score" ? item.risk_score ?? item.score ?? record(item.risk).score : column === "classification_source" ? record(item.classification).source : column === "finding_count" ? item.finding_count ?? (Array.isArray(item.finding_ids) ? item.finding_ids.length : 0) : item[column];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function ConnectedCaseWorkspaceV3Page({ path, search = "", navigate }: { path: string; search?: string; navigate: (path: string) => void }) {
  const [, , id = "", requested = "overview"] = path.split("/"); const caseId = Number(id); const section = visualAliases.has(requested) ? "visuals" : requested;
  const requestedAnalysis = new URLSearchParams(search).get("analysis");
  const selectedAnalysisId = requestedAnalysis && uuid.test(requestedAnalysis) ? requestedAnalysis : null;
  const snapshotSearch = selectedAnalysisId ? serializeQuery({ analysis: selectedAnalysisId }) : "";
  const [data, setData] = useState<unknown>(null); const [summary, setSummary] = useState<CaseSummary | null>(null);
  const [loadedEndpoint, setLoadedEndpoint] = useState<string | null>(null);
  const [loading, setLoading] = useState(section !== "reports"); const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null); const [refreshError, setRefreshError] = useState<string | null>(null);
  const [query, setQuery] = useState(""); const [pageNumber, setPageNumber] = useState(1); const [reportRefresh, setReportRefresh] = useState(0);
  const [selected, setSelected] = useState<InvestigationRecordViewModel | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [liveUpdate, setLiveUpdate] = useState<string | null>(null);
  const [relatedIncidents, setRelatedIncidents] = useState<Record<string, unknown>[]>([]);
  const [timelinePoints, setTimelinePoints] = useState<Record<string, unknown>[]>([]);
  const [activityWindows, setActivityWindows] = useState<ActivityWindowExplanation[]>([]);
  const [overviewContext, setOverviewContext] = useState<OverviewContext>({ findings: [], alerts: [], incidents: [], evidence: [] });
  const [referenceError, setReferenceError] = useState<string | null>(null); const [resolvingReference, setResolvingReference] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false); const [reanalysisError, setReanalysisError] = useState<string | null>(null);
  const [reanalysisResult, setReanalysisResult] = useState<ReanalysisResult | null>(null);
  const loadSequence = useRef(0); const activeLoad = useRef<AbortController | null>(null); const refreshFlight = useRef(false); const reanalysisFlight = useRef(false);
  const pageSize = section === "timeline" ? timelineWindowsPerPage : section === "history" ? 25 : 50;
  const endpoint = useMemo(() => {
    if (section === "overview") return `/cases/${id}/summary`;
    if (section === "history") return `/cases/${id}/analyses${serializeQuery({ page: pageNumber, page_size: 25 })}`;
    if (section === "visuals") return `/cases/${id}/charts${serializeQuery({ analysis_id: selectedAnalysisId })}`;
    if (section === "timeline") return `/cases/${id}/timeline/windows${serializeQuery({ page: pageNumber, page_size: timelineWindowsPerPage, analysis_id: selectedAnalysisId })}`;
    const filter = section === "events" ? { event_type: query || undefined } : section === "evidence" ? { source: query || undefined } : ["findings", "alerts", "incidents", "timeline"].includes(section) ? { severity: query || undefined } : {};
    return `/cases/${id}/${section}${serializeQuery({ page: pageNumber, page_size: pageSize, ...filter, analysis_id: analysisSections.has(section) ? selectedAnalysisId : null })}`;
  }, [id, pageNumber, pageSize, query, section, selectedAnalysisId]);

  useEffect(() => { setPageNumber(1); setQuery(""); setSelected(null); setDetailOpen(false); setReferenceError(null); }, [section]);
  useEffect(() => { setPageNumber(1); setSelected(null); }, [selectedAnalysisId]);

  const loadWorkspace = useCallback((mode: LoadMode) => {
    if (requestedAnalysis && !selectedAnalysisId) {
      activeLoad.current?.abort(); loadSequence.current += 1; refreshFlight.current = false;
      setLoading(false); setRefreshing(false); setRefreshError(null);
      setError("The selected analysis ID is malformed. Open Analysis history and choose a persisted snapshot.");
      return null;
    }
    const requestId = ++loadSequence.current; activeLoad.current?.abort();
    const controller = new AbortController(); activeLoad.current = controller;
    if (mode === "initial") { refreshFlight.current = false; setRefreshing(false); setLoading(true); } else setRefreshing(true);
    setError(null); setRefreshError(null);
    const summaryRequest = apiClient.request<CaseSummary>(`/cases/${id}/summary`, { signal: controller.signal });
    const dataRequest: Promise<unknown> = section === "reports" ? Promise.resolve(null) : section === "audit" ? phase3Api.audit(caseId, controller.signal) : section === "overview" ? summaryRequest : section === "visuals" ? Promise.all([
      apiClient.request<unknown>(`/cases/${id}/charts${serializeQuery({ analysis_id: selectedAnalysisId })}`, { signal: controller.signal }),
      apiClient.request<unknown>(`/cases/${id}/graph${serializeQuery({ analysis_id: selectedAnalysisId })}`, { signal: controller.signal }),
    ]).then(([charts, graph]) => ({ charts, graph })) : apiClient.request<unknown>(endpoint, { signal: controller.signal });
    const snapshotRequest = selectedAnalysisId ? apiClient.request(`/cases/${id}/analyses/${selectedAnalysisId}`, { signal: controller.signal }) : Promise.resolve(null);
    const contextRequest = section === "overview"
      ? Promise.all([
          apiClient.request<PageResult>(`/cases/${id}/findings${serializeQuery({ page: 1, page_size: 6, analysis_id: selectedAnalysisId })}`, { signal: controller.signal }).catch(() => ({ items: [] })),
          apiClient.request<PageResult>(`/cases/${id}/alerts${serializeQuery({ page: 1, page_size: 6, analysis_id: selectedAnalysisId })}`, { signal: controller.signal }).catch(() => ({ items: [] })),
          apiClient.request<PageResult>(`/cases/${id}/incidents${serializeQuery({ page: 1, page_size: 6, analysis_id: selectedAnalysisId })}`, { signal: controller.signal }).catch(() => ({ items: [] })),
          apiClient.request<PageResult>(`/cases/${id}/evidence${serializeQuery({ page: 1, page_size: 50 })}`, { signal: controller.signal }).catch(() => ({ items: [] })),
        ]).then(([findings, alerts, incidents, evidence]) => ({ overview: { findings: findings.items ?? [], alerts: alerts.items ?? [], incidents: incidents.items ?? [], evidence: evidence.items ?? [] } }))
      : section === "findings"
      ? apiClient.request<PageResult>(`/cases/${id}/incidents${serializeQuery({ page: 1, page_size: 50, analysis_id: selectedAnalysisId })}`, { signal: controller.signal }).catch(() => null)
      : section === "timeline"
      ? Promise.all([
          apiClient.request<PageResult>(`/cases/${id}/charts${serializeQuery({ analysis_id: selectedAnalysisId })}`, { signal: controller.signal }).catch(() => ({ items: [] })),
          apiClient.request<PageResult>(`/cases/${id}/activity-windows${serializeQuery({ analysis_id: selectedAnalysisId })}`, { signal: controller.signal }).catch(() => ({ items: [] })),
        ]).then(([charts, windows]) => ({ charts: charts.items ?? [], windows: windows.items ?? [] }))
      : Promise.resolve(null);
    void Promise.all([summaryRequest, dataRequest, snapshotRequest, contextRequest]).then(([nextSummary, nextData, , contextData]) => {
      if (controller.signal.aborted || requestId !== loadSequence.current) return;
      setSummary(nextSummary); setData(section === "overview" ? nextSummary : nextData); setLoadedEndpoint(endpoint);
      const context = record(contextData);
      setOverviewContext(section === "overview" && context.overview ? context.overview as OverviewContext : { findings: [], alerts: [], incidents: [], evidence: [] });
      setRelatedIncidents(section === "findings" && Array.isArray(context.items) ? context.items as Record<string, unknown>[] : []);
      setTimelinePoints(section === "timeline" && Array.isArray(context.charts) ? context.charts as Record<string, unknown>[] : []);
      setActivityWindows(section === "timeline" && Array.isArray(context.windows) ? context.windows as unknown as ActivityWindowExplanation[] : []);
    }).catch(reason => {
      if (controller.signal.aborted || requestId !== loadSequence.current) return;
      const message = normalizeApiError(reason).message;
      if (mode === "initial") setError(message); else setRefreshError(message);
    }).finally(() => {
      if (requestId !== loadSequence.current) return;
      if (activeLoad.current === controller) activeLoad.current = null;
      if (mode === "initial") setLoading(false); else { setRefreshing(false); refreshFlight.current = false; }
    });
    return controller;
  }, [caseId, endpoint, id, requestedAnalysis, section, selectedAnalysisId]);

  useEffect(() => { const controller = loadWorkspace("initial"); return () => controller?.abort(); }, [loadWorkspace]);

  // Step 7: the case workspace subscribes to live invalidation, not only
  // Live Monitor. Without this an investigator reading the Timeline here
  // would keep seeing a stale chronology while live events were being
  // accepted, and would have to navigate away and back to notice.
  //
  // Two rules make that safe. A deliberately pinned historical snapshot is
  // never replaced - `active` is false whenever an analysis is pinned - so
  // reviewing the past is not disturbed by the present. And when a record
  // drawer is open, the view is not swapped underneath the investigator;
  // an explicit action is offered instead.
  //
  // The signal carries only identifiers, so every refresh re-reads the
  // investigation API. Out-of-order responses cannot regress the display:
  // `loadWorkspace` aborts the previous request and discards any response
  // that is no longer the newest.
  const detailOpenRef = useRef(detailOpen); detailOpenRef.current = detailOpen;
  const lastLiveAnalysis = useRef<string | null>(null);
  useLiveInvalidation({
    caseId: caseId || null,
    active: !selectedAnalysisId && liveInvalidatedSections.has(section),
    topics: ["timeline.updated"],
    onMessage: message => {
      if (message.topic !== "timeline.updated") return;
      const analysisId = String((message.payload ?? {}).analysis_id ?? "");
      if (!analysisId || analysisId === lastLiveAnalysis.current) return;
      lastLiveAnalysis.current = analysisId;
      if (detailOpenRef.current) { setLiveUpdate(analysisId); return; }
      setLiveUpdate(null); loadWorkspace("refresh");
    },
    // A reset means the stream could not be resumed, so this view may be
    // stale with no `timeline.updated` frame following to correct it.
    // The section is reloaded from the investigation API directly, and
    // the last-seen analysis is forgotten so the next signal is not
    // mistaken for one already applied.
    onReset: () => {
      lastLiveAnalysis.current = null;
      if (detailOpenRef.current) { setLiveUpdate("reset"); return; }
      setLiveUpdate(null); loadWorkspace("refresh");
    },
  });
  const applyLiveUpdate = () => { setLiveUpdate(null); setDetailOpen(false); loadWorkspace("refresh"); };

  const refreshWorkspace = () => {
    if (refreshFlight.current) return;
    refreshFlight.current = true;
    if (section === "reports") setReportRefresh(value => value + 1);
    if (!loadWorkspace("refresh")) refreshFlight.current = false;
  };

  const reanalyze = async () => {
    if (reanalysisFlight.current) return;
    reanalysisFlight.current = true; setReanalyzing(true); setReanalysisError(null); setReanalysisResult(null);
    try {
      const result = await apiClient.request<ReanalysisResult>(`/cases/${id}/analyses`, { method: "POST" });
      setReanalysisResult(result);
      const target = `/cases/${id}/findings${serializeQuery({ analysis: result.analysis_id })}`;
      const alreadyShowingResult = `${path}${search}` === target;
      navigate(target);
      if (alreadyShowingResult) { refreshFlight.current = true; loadWorkspace("refresh"); }
    } catch (reason) {
      setReanalysisError(normalizeApiError(reason).message);
    } finally {
      reanalysisFlight.current = false; setReanalyzing(false);
    }
  };

  // Route changes reuse this component. Never interpret the previous tab's rows
  // using the new tab's schema while the new request is waiting for its effect.
  const dataIsCurrent = loadedEndpoint === endpoint;
  const viewLoading = loading || (!error && !dataIsCurrent);
  const activeData = dataIsCurrent ? data : null;
  const object = record(activeData); const result = object as PageResult; const all = Array.isArray(result.items) ? result.items : [];
  const mapped = mapInvestigationRecords(section as InvestigationRecordKind, all);
  useEffect(() => {
    // `alerts` is deep-linkable so Live Monitor can hand an investigator
    // straight to a new alert's record - and therefore to its notification
    // panel - without making them find the row by hand.
    if (viewLoading || error || !["evidence", "events", "alerts"].includes(section)) return;
    const parameter = section === "evidence" ? "evidence" : section === "alerts" ? "alert" : "event"; const requestedId = new URLSearchParams(search).get(parameter);
    if (!requestedId) { setReferenceError(null); setSelected(null); setDetailOpen(false); return; }
    if (!uuid.test(requestedId)) { setSelected(null); setDetailOpen(false); setReferenceError(`The requested ${parameter} reference is malformed.`); return; }
    const existing = mapped.find(item => item.id === requestedId);
    if (existing) { setSelected(existing); setDetailOpen(true); setReferenceError(null); return; }
    // An alert lives in the persisted alert page; if it is not on the page
    // being shown, say so rather than inventing a record for it.
    if (section === "alerts") { setSelected(null); setDetailOpen(false); setReferenceError("The requested alert is not in the current analysis snapshot."); return; }
    const controller = new AbortController(); setResolvingReference(true); setReferenceError(null);
    const detailPath = section === "evidence" ? `/cases/${id}/evidence/${requestedId}` : `/cases/${id}/events/${requestedId}`;
    void apiClient.request<Record<string, unknown>>(detailPath, { signal: controller.signal }).then(value => { setSelected(mapInvestigationRecords(section as InvestigationRecordKind, [value])[0]); setDetailOpen(true); }).catch(() => { if (!controller.signal.aborted) { setSelected(null); setDetailOpen(false); setReferenceError(`The requested ${parameter} is unavailable or does not belong to this case.`); } }).finally(() => { if (!controller.signal.aborted) setResolvingReference(false); });
    return () => controller.abort();
  }, [activeData, error, id, search, section, viewLoading]);

  const loadTimelineRecords = useCallback((window: TimelineWindowSummary, signal: AbortSignal) => apiClient.request<PageResult>(`/cases/${id}/timeline${serializeQuery({ page: 1, page_size: 200, window_key: window.key, analysis_id: selectedAnalysisId })}`, { signal }), [id, selectedAnalysisId]);
  const selectRecord = (item: InvestigationRecordViewModel) => { const analysis = selectedAnalysisId ?? undefined; setSelected(item); setDetailOpen(true); if (section === "evidence") navigate(`/cases/${id}/evidence${serializeQuery({ evidence: item.id, analysis })}`); else if (section === "events") navigate(`/cases/${id}/events${serializeQuery({ event: item.id, analysis })}`); };
  const total = result.total ?? all.length; const start = total ? (pageNumber - 1) * pageSize + 1 : 0; const end = Math.min(pageNumber * pageSize, total); const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const timelineRecordTotal = result.record_total ?? 0;
  const viewingHistorical = Boolean(selectedAnalysisId && summary?.analysis_id !== selectedAnalysisId);
  const snapshotLabel = viewingHistorical ? "historical analysis" : "latest analysis";

  const primarySection = section === "events" ? "evidence" : ["alerts", "incidents"].includes(section) ? "findings" : section === "audit" ? "reports" : section;
  const visualData = record(data); const chartResult = record(visualData.charts) as PageResult; const graphResult = record(visualData.graph) as { nodes?: Record<string, unknown>[]; edges?: Record<string, unknown>[]; truncated?: boolean };
  return <><PageHeader eyebrow={`Persisted investigation · CASE-${id.padStart(4, "0")}`} title={names[section] ?? heading(section)} description="Connected records and visual summaries preserve backend-authored identifiers, timestamps, provenance, rule traces, and risk factors." actions={<><Button onClick={() => navigate(`/cases/${id}/history${snapshotSearch}`)}>Analysis history</Button><Button disabled={viewLoading || refreshing} onClick={refreshWorkspace}>{refreshing ? "Refreshing…" : "Refresh"}</Button><Button onClick={() => navigate(`/import?case=${id}`)}>Import evidence</Button><Button variant="primary" disabled={reanalyzing} onClick={reanalyze}>{reanalyzing ? "Reanalyzing…" : "Reanalyze"}</Button></>}/>
    <nav className="case-tabs case-tabs-primary" aria-label="Connected case views">{primaryTabs.map(tab => <button className={primarySection === tab ? "active" : ""} onClick={() => navigate(`/cases/${id}/${tab}${snapshotSearch}`)} key={tab}>{tab}</button>)}</nav>
    {/* Offered rather than applied: replacing the view while a record is
        open would pull the investigator out of what they were reading. */}
    {liveUpdate && <div className="live-update-banner" role="status"><span>New live results available. A newer deterministic analysis has been persisted for this case.</span><Button variant="primary" onClick={applyLiveUpdate}>Show new live results</Button><Button onClick={() => setLiveUpdate(null)}>Keep current view</Button></div>}
    {(["evidence", "events"].includes(section) || ["findings", "alerts", "incidents"].includes(section) || ["reports", "audit"].includes(section)) && <nav className="case-subtabs" aria-label={`${primarySection} views`}>{(primarySection === "evidence" ? [["evidence", "Imported evidence"], ["events", "Canonical events"]] : primarySection === "findings" ? [["findings", "Findings"], ["incidents", "Incidents"], ["alerts", "Alerts"]] : [["reports", "Reports"], ["audit", "Audit history"]]).map(([tab, label]) => <button className={section === tab ? "active" : ""} onClick={() => navigate(`/cases/${id}/${tab}${snapshotSearch}`)} key={tab}>{label}</button>)}</nav>}
    {refreshing && <div className="workspace-notice" role="status"><div><b>Refreshing persisted data</b><p>The current view remains available while Traceveil reloads this case.</p></div></div>}
    {refreshError && <div className="workspace-notice reference-warning" role="alert"><div><b>Refresh failed</b><p>{refreshError} Existing results remain available.</p></div><Button disabled={refreshing} onClick={refreshWorkspace}>Retry</Button></div>}
    {reanalysisError && <div className="workspace-notice reference-warning" role="alert"><div><b>Reanalysis failed</b><p>{reanalysisError} Existing persisted results were not replaced.</p></div><Button disabled={reanalyzing} onClick={reanalyze}>Retry reanalysis</Button></div>}
    {reanalysisResult && <div className="workspace-notice" role="status"><div><b>{reanalysisResult.outcome === "created" ? "New analysis snapshot created" : "Identical analysis snapshot reused"}</b><p>{reanalysisResult.outcome === "created" ? "Traceveil persisted a new deterministic result." : "The evidence and analysis inputs were unchanged, so Traceveil reused the existing deterministic result."} Snapshot <code>{reanalysisResult.analysis_id}</code>.</p></div></div>}
    {viewLoading && <div className="state-box" aria-live="polite"><strong>Loading persisted {heading(section)}…</strong><p>Traceveil is reading case-owned records from the backend.</p></div>}
    {error && <div className="state-box" role="alert"><strong>{requestedAnalysis ? "Selected analysis unavailable" : "Connected view unavailable"}</strong><p>{error}</p>{requestedAnalysis ? <Button onClick={() => navigate(`/cases/${id}/history`)}>Open analysis history</Button> : <Button onClick={() => loadWorkspace("initial")}>Retry</Button>}</div>}
    {!viewLoading && !error && summary?.analysis_id && (analysisSections.has(section) || section === "history") && <div className={`analysis-snapshot-banner ${viewingHistorical ? "historical" : "latest"}`} role="status"><div><span>{viewingHistorical ? "Historical snapshot" : "Latest snapshot"}</span><b>{selectedAnalysisId ?? summary.analysis_id}</b><p>{viewingHistorical ? "Results are pinned to a persisted historical analysis and will stay selected across case tabs." : "Results use the case's latest persisted analysis."}</p></div>{viewingHistorical && <Button onClick={() => navigate(`/cases/${id}/${section}`)}>View latest</Button>}</div>}
    {!viewLoading && !error && referenceError && <div className="workspace-notice reference-warning" role="alert"><div><b>Source reference unavailable</b><p>{referenceError} The surrounding persisted results remain available.</p></div><Button onClick={() => navigate(`/cases/${id}/${section}${snapshotSearch}`)}>Clear reference</Button></div>}
    {!viewLoading && !error && resolvingReference && <div className="workspace-notice" role="status"><div><b>Opening source record</b><p>Resolving the case-owned reference from persisted data…</p></div></div>}
    {!viewLoading && !error && section === "reports" && <ConnectedReportsPanel key={reportRefresh} caseId={caseId}/>}
    {!viewLoading && !error && section === "history" && <AnalysisHistory snapshots={all as unknown as AnalysisSnapshot[]} latestId={summary?.analysis_id ?? null} selectedId={selectedAnalysisId} caseId={id} pageNumber={pageNumber} total={total} onPage={setPageNumber} navigate={navigate}/>}
    {!viewLoading && !error && section === "overview" && <><CaseDatasetOverview summary={object} context={overviewContext}/><AnalysisOverview summary={object} context={overviewContext} caseId={id} navigate={navigate}/></>}
    {!viewLoading && !error && section === "visuals" && (summary?.analysis_id ? <PersistedVisuals points={(chartResult.items ?? []) as { series?: string; category?: string; subgroup?: string | null; value?: number }[]} nodes={graphResult.nodes ?? []} edges={graphResult.edges ?? []} truncated={graphResult.truncated}/> : <NoAnalysis onRun={reanalyze} disabled={reanalyzing}/>)}
    {!viewLoading && !error && section === "timeline" && (summary?.analysis_id ? <><TimelineActivityOverview points={timelinePoints} total={timelineRecordTotal}/><section className="table-panel timeline-visual-panel"><div className="filter-row timeline-window-header"><div><strong>Chronological record windows</strong><p>Each page loads ten lightweight minute summaries. Individual records load only when a minute is expanded.</p></div><span>{total ? `${total.toLocaleString()} minute blocks · ${timelineRecordTotal.toLocaleString()} persisted entries` : "0 persisted entries"}</span></div>{all.length ? <PersistedTimeline items={all as unknown as TimelineWindowSummary[]} onInspect={selectRecord} loadRecords={loadTimelineRecords}/> : <SectionEmpty section={section} filtered={Boolean(query)} analyzed snapshotLabel={snapshotLabel} caseId={id} onClear={() => setQuery("")} navigate={navigate} onRun={reanalyze} runDisabled={reanalyzing}/>} {total > pageSize && <div className="table-footer timeline-pagination"><div><Button disabled={pageNumber === 1} onClick={() => setPageNumber(1)}>First</Button><Button disabled={pageNumber === 1} onClick={() => setPageNumber(value => value - 1)}>Previous</Button></div><span>Minute blocks <b>{start}–{end}</b> of <b>{total}</b></span><div><Button disabled={pageNumber >= totalPages} onClick={() => setPageNumber(value => value + 1)}>Next</Button><Button disabled={pageNumber >= totalPages} onClick={() => setPageNumber(totalPages)}>Last</Button></div></div>}</section></> : <NoAnalysis onRun={reanalyze} disabled={reanalyzing}/>)}
    {!viewLoading && !error && section === "timeline" && summary?.analysis_id && <TimelineAttributionPanel windows={activityWindows}/>}
    {!viewLoading && !error && section === "findings" && summary?.analysis_id && <IncidentContext items={relatedIncidents} onInspect={selectRecord}/>}
    {!viewLoading && !error && !["overview", "history", "visuals", "timeline", "reports"].includes(section) && <section className="workspace-results"><div className="table-panel"><div className="filter-row"><input className="input" aria-label={`Filter ${section}`} placeholder={section === "events" ? "Exact event type" : section === "evidence" ? "Exact source" : ["findings", "alerts", "incidents"].includes(section) ? "Exact severity" : `Filter ${section}`} value={query} onChange={event => { setQuery(event.target.value); setPageNumber(1); }}/><span>{total ? `Showing ${start}–${end} of ${total} persisted records` : "0 persisted records"}</span></div>{all.length ? <RecordTable section={section} items={all} columns={columns[section]} selectedId={selected?.id} onSelect={selectRecord}/> : <SectionEmpty section={section} filtered={Boolean(query)} analyzed={Boolean(summary?.analysis_id)} snapshotLabel={snapshotLabel} caseId={id} onClear={() => setQuery("")} navigate={navigate} onRun={reanalyze} runDisabled={reanalyzing}/>} {total > 50 && <div className="table-footer"><Button disabled={pageNumber === 1} onClick={() => setPageNumber(value => value - 1)}>Previous</Button><span>Page {pageNumber} · partial view of {total}</span><Button disabled={pageNumber * 50 >= total} onClick={() => setPageNumber(value => value + 1)}>Next</Button></div>}</div></section>}
    {selected && detailOpen && <RecordDetail item={selected} caseId={id} analysisId={selectedAnalysisId} navigate={navigate} onClose={() => setDetailOpen(false)}/>}
  </>;
}

function CaseDatasetOverview({ summary, context }: { summary: Record<string, unknown>; context: OverviewContext }) {
  const caseDetails = record(summary.case);
  const description = String(caseDetails.description ?? "").replace(/^Dataset overview:\s*/i, "").trim();
  const sourceTypes = [...new Set(context.evidence.map(item => String(item.source_type ?? "")).filter(Boolean))];
  return <section className="case-dataset-overview" aria-labelledby="case-dataset-overview-title">
    <div className="case-dataset-overview__icon" aria-hidden="true">i</div>
    <div className="case-dataset-overview__copy">
      <span>About this case</span>
      <h2 id="case-dataset-overview-title">{String(caseDetails.name ?? "Dataset overview")}</h2>
      <p>{description || "Import evidence to generate a simple explanation of what this case contains."}</p>
    </div>
    <aside aria-label="Case dataset sources">
      <span>{sourceTypes.length ? `${sourceTypes.length} dataset source${sourceTypes.length === 1 ? "" : "s"}` : "Awaiting evidence"}</span>
      {sourceTypes.length > 0 && <div>{sourceTypes.map(source => <b key={source}>{heading(source)}</b>)}</div>}
    </aside>
  </section>;
}

function AnalysisOverview({ summary, context, caseId, navigate }: { summary: Record<string, unknown>; context: OverviewContext; caseId: string; navigate: (path: string) => void }) {
  const analysisId = summary.analysis_id;
  if (!analysisId) return <EmptyState title="No analysis has run" message="This case has no persisted analysis snapshot yet. Import evidence or run deterministic analysis to create result sections." action="Import evidence" onAction={() => navigate(`/import?case=${caseId}`)}/>;
  const openAlerts = context.alerts.filter(alert => !["resolved", "suppressed"].includes(String(alert.workflow_status ?? "pending")));
  const rankedFindings = [...context.findings].sort((left, right) => Number(record(right.risk).score ?? right.risk_score ?? 0) - Number(record(left.risk).score ?? left.risk_score ?? 0));
  const topFinding = rankedFindings[0];
  const topRisk = topFinding ? Number(record(topFinding.risk).score ?? topFinding.risk_score ?? 0) : Number(summary.maximum_risk ?? 0);
  const classification = record(topFinding?.classification);
  const sourceTypes = [...new Set(context.evidence.map(item => String(item.source_type ?? "unknown")))].filter(item => item !== "unknown");
  const affectedDevices = [...new Set(context.findings.map(item => String(item.entity_id ?? "")).filter(Boolean))];
  const metricRows: [string, unknown, string][] = [
    ["Events", summary.event_count ?? 0, "Normalized activity"],
    ["Findings", summary.finding_count ?? 0, "Detected concerns"],
    ["Incidents", summary.incident_count ?? 0, "Correlated groups"],
    ["Peak risk", summary.maximum_risk ?? 0, riskBand(Number(summary.maximum_risk ?? 0))],
  ];
  return <section className="analysis-command-summary" aria-label="Case analysis summary">
    <header><div><span>Analysis posture</span><h2>{topRisk >= 70 ? "Prioritized investigation required" : topRisk >= 40 ? "Review noteworthy activity" : "No urgent risk detected"}</h2><p>Counts describe different layers: events are source activity, findings are detections, incidents correlate related findings, and alerts track investigator action.</p></div><span className={`risk-orb risk-${riskBand(topRisk).toLowerCase()}`}><b>{topRisk}</b><small>peak risk</small></span></header>
    <div className="analysis-metric-strip">{metricRows.map(([label, value, detail]) => <button key={String(label)} onClick={() => navigate(`/cases/${caseId}/${label === "Events" ? "events" : String(label).toLowerCase() === "peak risk" ? "findings" : String(label).toLowerCase()}`)}><span>{label}</span><b>{String(value)}</b><small>{detail}</small></button>)}</div>
    <div className="analysis-attention-grid">
      <article><span>Next action</span><h3>{openAlerts.length ? `${openAlerts.length} alert${openAlerts.length === 1 ? "" : "s"} need review` : "No open alert workflow"}</h3><p>{openAlerts.length ? "Acknowledge, resolve, or suppress the outstanding alerts so the case state reflects the investigation." : "All loaded alerts are resolved or suppressed. Review findings if the evidence has changed."}</p><Button onClick={() => navigate(`/cases/${caseId}/alerts`)}>Review alerts</Button></article>
      <article><span>Highest-priority finding</span><h3>{String(topFinding?.title ?? "No findings produced")}</h3><p>{topFinding ? `Risk ${topRisk} · ${riskBand(topRisk)} · ${classificationLabel(String(classification.source ?? "unknown"))}` : "The latest deterministic analysis produced no classified finding."}</p><Button onClick={() => navigate(`/cases/${caseId}/findings`)}>Open findings</Button></article>
      <article><span>Correlation</span><h3>{context.incidents.length ? `${context.incidents.length} recent incident group${context.incidents.length === 1 ? "" : "s"}` : "No incident groups"}</h3><p>Incidents explain which findings share time, entities, evidence, or correlation edges; they are not additional detections.</p><Button onClick={() => navigate(`/cases/${caseId}/incidents`)}>Review incidents</Button></article>
    </div>
    <div className="evidence-convergence"><div><span>Converged evidence</span><h3>{sourceTypes.length ? sourceTypes.map(heading).join(" + ") : "Source inventory unavailable"}</h3><p>{context.evidence.length} evidence object{context.evidence.length === 1 ? "" : "s"} contribute to this case-wide analysis. Timelines and incidents can overlap across sources only through shared device, network, service, or observed-time context.</p></div><div><span>Affected canonical devices</span><strong>{affectedDevices.length ? affectedDevices.join(", ") : "No finding-linked device identity"}</strong></div></div>
  </section>;
}

function TimelineAttributionPanel({ windows }: { windows: ActivityWindowExplanation[] }) {
  const interesting = windows.filter(window => window.is_volume_anomaly).sort((left, right) => (right.deviation_ratio ?? 0) - (left.deviation_ratio ?? 0));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = interesting.find(window => window.window_id === selectedKey) ?? interesting[0];
  if (!windows.length) return <section className="timeline-attribution empty"><span>Spike attribution</span><h2>No activity explanation data available</h2><p>This analysis snapshot did not return persisted activity-window explanations. Reanalyze the case if it predates activity attribution.</p></section>;
  if (!interesting.length) return <section className="timeline-attribution empty"><span>Spike attribution</span><h2>No statistically unusual activity windows</h2><p>{windows.length.toLocaleString()} windows were analyzed, but none exceeded the persisted anomaly threshold.</p></section>;
  if (!selected) return null;
  return <section className="timeline-attribution" aria-label="Timeline spike attribution"><header><div><span>Spike attribution</span><h2>What caused the activity peaks?</h2><p>Select an anomalous window to inspect the persisted evidence behind its volume.</p></div><b>{interesting.length} anomalous window{interesting.length === 1 ? "" : "s"}</b></header>
    <div className="timeline-hotspots" role="list" aria-label="Anomalous activity windows">{interesting.slice(0, 8).map(window => <button role="listitem" className={window.window_id === selected.window_id ? "selected" : ""} key={window.window_id} onClick={() => setSelectedKey(window.window_id)}><span>{window.window_id}</span><b>{window.event_count} events</b><small>{window.deviation_ratio?.toFixed(2) ?? "—"}× baseline</small></button>)}</div>
    <article className="timeline-cause-card"><div><span className={`cause-chip ${selected.cause_status}`}>{heading(selected.cause_status)}</span><h3>{selected.explanation}</h3><p>{selected.cause_status === "undetermined" ? "The spike is real, but no single classification or device dominates enough to claim a cause. Treat this as an investigation lead, not a DDoS conclusion." : "This explanation is derived from the classifications and entities present in the imported records for this window."}</p></div><dl><div><dt>Events</dt><dd>{selected.event_count}</dd></div><div><dt>Baseline</dt><dd>{selected.baseline_count}</dd></div><div><dt>Top devices</dt><dd>{topBreakdown(selected.top_devices)}</dd></div><div><dt>Top event types</dt><dd>{topBreakdown(selected.top_event_types)}</dd></div><div><dt>Source labels</dt><dd>{selected.source_classifications?.slice(0, 3).map(item => `${item.value} (${item.count})`).join(", ") || "None supplied"}</dd></div></dl></article>
  </section>;
}

function classificationLabel(source: string) { return ({ dataset_label: "Dataset supplied", deterministic_rule: "Rule detected", behavioral_anomaly: "Behavioral anomaly" } as Record<string, string>)[source] ?? heading(source); }
function riskBand(score: number) { return score >= 75 ? "Critical" : score >= 50 ? "High" : score >= 25 ? "Medium" : score > 0 ? "Low" : "None"; }
function topBreakdown(values: Record<string, number>) { const entries = Object.entries(values ?? {}).sort((left, right) => right[1] - left[1]).slice(0, 3); return entries.length ? entries.map(([name, count]) => `${name} (${count})`).join(", ") : "No dominant value"; }

function AnalysisHistory({ snapshots, latestId, selectedId, caseId, pageNumber, total, onPage, navigate }: { snapshots: AnalysisSnapshot[]; latestId: string | null; selectedId: string | null; caseId: string; pageNumber: number; total: number; onPage: (page: number) => void; navigate: (path: string) => void }) {
  if (!snapshots.length) return <EmptyState title="No analysis history" message="This case has no persisted batch-analysis snapshots yet."/>;
  return <section className="table-panel analysis-history"><div className="filter-row"><div><strong>{total} persisted snapshots</strong><p>Select a snapshot to pin all analysis result tabs to its immutable analysis ID.</p></div></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th>Analysis ID</th><th>Status</th><th>Created at</th><th>Version</th><th>Results</th></tr></thead><tbody>{snapshots.map(snapshot => { const latest = snapshot.analysis_id === latestId; const selected = snapshot.analysis_id === (selectedId ?? latestId); return <tr key={snapshot.analysis_id} className={selected ? "selected" : ""}><td><code>{snapshot.analysis_id}</code>{latest && <span className="snapshot-chip latest">Latest</span>}{selectedId === snapshot.analysis_id && !latest && <span className="snapshot-chip historical">Selected</span>}</td><td>{snapshot.status}</td><td>{snapshot.created_at}<small>UTC</small></td><td>Persisted snapshot</td><td><Button variant={selected ? "secondary" : "primary"} onClick={() => navigate(`/cases/${caseId}/findings${serializeQuery({ analysis: snapshot.analysis_id })}`)}>{selected ? "Viewing" : "View results"}</Button></td></tr>; })}</tbody></table></div>{total > 25 && <div className="table-footer"><Button disabled={pageNumber === 1} onClick={() => onPage(pageNumber - 1)}>Previous</Button><span>Page {pageNumber} · showing up to 25 of {total}</span><Button disabled={pageNumber * 25 >= total} onClick={() => onPage(pageNumber + 1)}>Next</Button></div>}</section>;
}

function SectionEmpty({ section, filtered, analyzed, snapshotLabel, caseId, onClear, navigate, onRun, runDisabled }: { section: string; filtered: boolean; analyzed: boolean; snapshotLabel: string; caseId: string; onClear: () => void; navigate: (path: string) => void; onRun: () => void; runDisabled: boolean }) {
  if (filtered) return <EmptyState title={`No ${section} match this filter`} message="The persisted result set is unchanged; clear the active filter to see it." action="Clear filter" onAction={onClear}/>;
  if (section === "evidence") return <EmptyState title="No evidence imported" message="This case has no persisted evidence. Import a supported CSV or JSON file to begin." action="Import evidence" onAction={() => navigate(`/import?case=${caseId}`)}/>;
  if (analysisSections.has(section) && !analyzed) return <NoAnalysis onRun={onRun} disabled={runDisabled}/>;
  if (section === "findings" && analyzed) return <EmptyState title="Analysis completed with no findings" message={`The persisted ${snapshotLabel} completed successfully and produced zero findings.`}/>;
  return <EmptyState title={analyzed && analysisSections.has(section) ? `Analysis completed with no ${section}` : `No ${section}`} message={analyzed && analysisSections.has(section) ? `The persisted ${snapshotLabel} produced no ${section}.` : "The backend returned no persisted records for this case."}/>;
}

function NoAnalysis({ onRun, disabled }: { onRun: () => void; disabled: boolean }) { return <EmptyState title="No analysis has run" message="This case has no persisted analysis snapshot, so analysis result sections are not available yet." action={disabled ? "Running analysis…" : "Run analysis"} actionDisabled={disabled} onAction={onRun}/>; }
function EmptyState({ title, message, action, onAction, actionDisabled = false }: { title: string; message: string; action?: string; onAction?: () => void; actionDisabled?: boolean }) { return <div className="state-box"><strong>{title}</strong><p>{message}</p>{action && onAction && <Button disabled={actionDisabled} onClick={onAction}>{action}</Button>}</div>; }

function RecordTable({ section, items, columns: requested, selectedId, onSelect }: { section: string; items: Record<string, unknown>[]; columns?: string[]; selectedId?: string; onSelect?: (item: InvestigationRecordViewModel) => void }) {
  if (!items.length) return <EmptyState title={`No ${section}`} message="The backend returned no persisted records for this section."/>;
  const kind = section.split(" ")[0] as InvestigationRecordKind; const mapped = mapInvestigationRecords(kind, items);
  const visible = requested?.filter(column => items.some(item => column in item || (column === "risk_score" && ("risk" in item || "score" in item)))) ?? Object.keys(items[0]).filter(key => typeof items[0][key] !== "object").slice(0, 6);
  return <div className="data-table-wrap"><table className="data-table"><thead><tr>{visible.map(column => <th key={column}>{heading(column)}</th>)}{onSelect && <th>Details</th>}</tr></thead><tbody>{mapped.map(item => <tr key={item.id} className={selectedId === item.id ? "selected" : ""}>{visible.map(column => <td key={column}>{display(valueFor(item.source as Record<string, unknown>, column))}</td>)}{onSelect && <td><button className="record-inspect" onClick={() => onSelect(item)} aria-label={`Inspect ${item.id}`}>Inspect</button></td>}</tr>)}</tbody></table></div>;
}

function RecordDetail({ item, caseId, analysisId, navigate, onClose }: { item: InvestigationRecordViewModel; caseId: string; analysisId?: string | null; navigate: (path: string) => void; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [workflowStatus, setWorkflowStatus] = useState(String((item.source as Record<string, unknown>).workflow_status ?? "pending"));
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [item.id, onClose]);
  const changeWorkflow = async (status: "pending" | "acknowledged" | "resolved" | "suppressed") => { setWorkflowBusy(true); setWorkflowError(null); try { const updated = await apiClient.request<Record<string, unknown>>(`/cases/${caseId}/alerts/${item.id}`, { method: "PATCH", body: JSON.stringify({ status, actor: "Investigator" }) }); setWorkflowStatus(String(updated.workflow_status ?? status)); } catch (reason) { setWorkflowError(normalizeApiError(reason).message); } finally { setWorkflowBusy(false); } };
  return <div className="record-detail-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><aside className="record-detail-panel" role="dialog" aria-modal="true" aria-label={`Details for ${item.id}`}><header><div><span>{heading(item.kind)} record</span><h2>{item.title}</h2><code>{item.id}</code></div><button ref={closeRef} className="record-detail-close" onClick={onClose} aria-label="Close record details">×</button></header>{item.kind === "alerts" && <div className="alert-workflow"><strong>Workflow · {workflowStatus}</strong><div>{(["pending", "acknowledged", "resolved", "suppressed"] as const).map(status => <Button key={status} disabled={workflowBusy || status === workflowStatus} onClick={() => void changeWorkflow(status)}>{heading(status)}</Button>)}</div>{workflowError && <p role="alert">{workflowError}</p>}</div>}{item.kind === "findings" && <FindingAnalysis source={item.source as Record<string, unknown>}/>} {item.kind === "incidents" && <IncidentAnalysis source={item.source as Record<string, unknown>}/>}
      {/* Step 11: notify about this deterministic artifact directly. No
          report is required and no PDF is attached; approval is pinned to
          the artifact's content hash. */}
      {(item.kind === "alerts" || item.kind === "incidents") && <ArtifactNotificationPanel caseId={Number(caseId)} subjectType={item.kind === "alerts" ? "alert" : "incident"} subjectId={item.id}/>}
      <details className="raw-record-details"><summary>All persisted fields</summary><dl className="record-details">{Object.entries(item.source).map(([key, value]) => <DetailValue key={key} name={key} value={value} caseId={caseId} analysisId={analysisId} navigate={navigate}/>)}</dl></details></aside></div>;
}

function FindingAnalysis({ source }: { source: Record<string, unknown> }) {
  const classification = record(source.classification); const risk = record(source.risk);
  const factors = Array.isArray(risk.factors) ? risk.factors.map(record) : []; const penalties = Array.isArray(risk.penalties) ? risk.penalties.map(record) : [];
  const score = Number(risk.score ?? source.risk_score ?? 0); const baseScore = Number(risk.base_score ?? score);
  const tags = Array.isArray(classification.tags) ? classification.tags.map(String) : [];
  return <section className="finding-explainer" aria-label="Finding classification and risk explanation">
    <div className="classification-banner"><div><span>{classificationLabel(String(classification.source ?? "unknown"))}</span><h3>{String(classification.display_name ?? source.title ?? "Classified finding")}</h3><p>{heading(String(classification.category ?? "uncategorized"))} <b>→</b> {heading(String(classification.subcategory ?? "unclassified"))}</p></div><span className={`risk-orb risk-${String(risk.band ?? riskBand(score)).toLowerCase()}`}><b>{score}</b><small>{String(risk.band ?? riskBand(score))}</small></span></div>
    <div className="confidence-grid"><div><span>Affected device</span><b>{String(source.entity_id ?? "Identity unavailable")}</b><small>Canonical identity shared across evidence</small></div><div><span>Classification confidence</span><b>{percent(classification.confidence ?? source.classification_confidence)}</b><small>How certain the category is</small></div><div><span>Evidence confidence</span><b>{percent(source.evidence_confidence)}</b><small>How strongly records support it</small></div><div><span>Classification input</span><b>{String(classification.source_field ?? "Derived fields")}</b><small>{String(classification.source_value ?? "No source label")}</small></div></div>
    {tags.length > 0 && <div className="classification-tags" aria-label="Classification tags">{tags.map(tag => <span key={tag}>{heading(tag)}</span>)}</div>}
    <div className="risk-equation"><span>Risk calculation</span><h3><b>{baseScore}</b> base score {penalties.length ? <><i>−</i> <b>{penalties.reduce((sum, penalty) => sum + Number(penalty.points ?? 0), 0)}</b> penalties</> : null} <i>=</i> <strong>{score}</strong></h3><p>Risk factors are weighted contributions. Explicit penalties reduce the score when evidence quality or confidence is limited.</p></div>
    <div className="risk-factor-list">{factors.length ? factors.map((factor, index) => { const points = Number(factor.weighted_points ?? 0); return <article key={`${String(factor.name)}-${index}`}><header><span>{heading(String(factor.name ?? "factor"))}</span><b>+{points.toFixed(1)}</b></header><div><i style={{ width: `${Math.min(100, Math.max(2, points))}%` }}/></div><p>{String(factor.explanation ?? `Score ${factor.score ?? "—"} × weight ${factor.weight ?? "—"}`)}</p></article>; }) : <p>No factor-level breakdown was persisted for this finding.</p>}</div>
    {penalties.length > 0 && <div className="risk-penalties"><strong>Score adjustments</strong>{penalties.map((penalty, index) => <p key={index}><b>−{String(penalty.points ?? 0)}</b> {String(penalty.explanation ?? heading(String(penalty.reason ?? "penalty")))}</p>)}</div>}
  </section>;
}

function IncidentAnalysis({ source }: { source: Record<string, unknown> }) {
  const tags = Array.isArray(source.tags) ? source.tags.map(String) : [];
  const entityIds = Array.isArray(source.entity_ids) ? source.entity_ids.map(String) : [];
  const bounded = source.grouping_policy === "finding_centered_bounded_session";
  const summary = String(source.summary ?? "");
  return <section className="incident-explainer" aria-label="Incident scope"><header><div><span>Correlated investigation unit</span><h3>{String(source.severity ?? "unrated")} severity · risk {String(source.maximum_risk ?? 0)}</h3>
    {/* The deterministic summary is backend-authored and computed before any
        AI narration, so it leads the panel as the authoritative account. */}
    {summary && <p className="incident-deterministic-summary"><b>Deterministic summary</b> · {summary}</p>}
    <p>{bounded ? `Finding-centred session · ${String(source.inactivity_window_seconds)}s inactivity boundary · ${String(source.maximum_trigger_span_seconds)}s maximum trigger span` : "Legacy transitive correlation component"}</p>{entityIds.length > 0 && <p>Affected identities: {entityIds.join(", ")}</p>}</div></header><div><span><b>{String(source.finding_count ?? (Array.isArray(source.finding_ids) ? source.finding_ids.length : 0))}</b> findings</span><span><b>{String(source.evidence_count ?? 0)}</b> evidence files</span><span><b>{String(source.entity_count ?? 0)}</b> entities</span><span><b>{String(source.correlation_edge_count ?? 0)}</b> correlations</span></div>{tags.length > 0 && <p>{tags.map(tag => <i key={tag}>{heading(tag)}</i>)}</p>}</section>;
}

function percent(value: unknown) { const numeric = Number(value); if (!Number.isFinite(numeric)) return "—"; return `${Math.round((numeric <= 1 ? numeric * 100 : numeric))}%`; }

function DetailValue({ name, value, caseId, analysisId, navigate }: { name: string; value: unknown; caseId: string; analysisId?: string | null; navigate: (path: string) => void }) {
  if ((name === "evidence_ids" || name === "event_ids" || name === "trigger_event_ids") && Array.isArray(value)) {
    const target = name === "evidence_ids" ? "evidence" : "event";
    const visible = value.slice(0, 100);
    return <div><dt>{heading(name)}</dt><dd className="reference-links">{visible.map(id => <button key={String(id)} onClick={() => navigate(`/cases/${caseId}/${target === "evidence" ? "evidence" : "events"}${serializeQuery({ [target]: String(id), analysis: analysisId })}`)}>{String(id)}</button>)}{value.length > visible.length && <small>Showing the first {visible.length.toLocaleString()} of {value.length.toLocaleString()} persisted references.</small>}</dd></div>;
  }
  if (Array.isArray(value)) { const visible = value.slice(0, 100); return <div><dt>{heading(name)}</dt><dd>{value.length ? <details className="detail-array"><summary>{value.length.toLocaleString()} persisted item{value.length === 1 ? "" : "s"}</summary><ol className="structured-list">{visible.map((entry, index) => <li key={index}>{typeof entry === "object" && entry !== null ? <NestedFields value={record(entry)}/> : display(entry)}</li>)}</ol>{value.length > visible.length && <small>Showing the first {visible.length.toLocaleString()} items to keep this panel responsive.</small>}</details> : "—"}</dd></div>; }
  if (value && typeof value === "object") return <div><dt>{heading(name)}</dt><dd><NestedFields value={record(value)}/></dd></div>;
  return <div><dt>{heading(name)}</dt><dd>{display(value)}</dd></div>;
}

function NestedFields({ value }: { value: Record<string, unknown> }) { return <dl className="nested-fields">{Object.entries(value).map(([key, nested]) => <div key={key}><dt>{heading(key)}</dt><dd><NestedValue value={nested}/></dd></div>)}</dl>; }
function NestedValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) return value.length ? <ol className="structured-list">{value.map((entry, index) => <li key={index}><NestedValue value={entry}/></li>)}</ol> : <>—</>;
  if (value && typeof value === "object") return <NestedFields value={record(value)}/>;
  return <>{display(value)}</>;
}
