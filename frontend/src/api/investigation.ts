import { apiClient } from "./batch";
import { serializeQuery } from "./client";
import type { components } from "./generated";

export type CaseSummary = components["schemas"]["CaseSummaryPublic"];
export type DashboardSummary = components["schemas"]["DashboardSummaryPublic"];
export type AnalysisResult = components["schemas"]["AnalysisResult"];
export type AnalysisSnapshot = components["schemas"]["AnalysisSnapshotPublic"];
export type ReanalysisResult = components["schemas"]["ReanalysisPublic"];
export type AnalysisHistoryPage = components["schemas"]["PageResponse_AnalysisSnapshotPublic_"];
export type EvidencePage = components["schemas"]["PageResponse_EvidencePublic_"];
export type EventPage = components["schemas"]["PageResponse_EventPublic_"];
export type FindingPage = components["schemas"]["PageResponse_DetectionFinding_"];
export type AlertPage = components["schemas"]["PageResponse_Alert_"];
export type IncidentPage = components["schemas"]["PageResponse_Incident_"];
export type TimelinePage = components["schemas"]["PageResponse_TimelineEntry_"];
export type ChartPage = components["schemas"]["PageResponse_ChartPoint_"];
export type GraphResult = components["schemas"]["GraphPublic"];
export type EvidenceRecord = components["schemas"]["EvidencePublic"];
export type EventRecord = components["schemas"]["EventPublic"];
export type FindingRecord = components["schemas"]["DetectionFinding"];
export type AlertRecord = components["schemas"]["Alert"];
export type IncidentRecord = components["schemas"]["Incident"];
export type TimelineRecord = components["schemas"]["TimelineEntry"];
export type ChartRecord = components["schemas"]["ChartPoint"];
export type GraphNodeRecord = components["schemas"]["GraphNode"];
export type GraphEdgeRecord = components["schemas"]["GraphEdge"];
export type InvestigationRecord = EvidenceRecord | EventRecord | FindingRecord | AlertRecord | IncidentRecord | TimelineRecord | ChartRecord | GraphNodeRecord | GraphEdgeRecord;
export type InvestigationResponse = CaseSummary | AnalysisResult | AnalysisHistoryPage | EvidencePage | EventPage | FindingPage | AlertPage | IncidentPage | TimelinePage | ChartPage | GraphResult;

export interface InvestigationFilters {
  page?: number;
  pageSize?: number;
  source?: string;
  eventType?: string;
  entity?: string;
  severity?: string;
  startTime?: string;
  endTime?: string;
  analysisId?: string | null;
  /** Chronological direction. Defaults to `asc` server-side; `desc` is what
   *  live recovery needs, since page 1 ascending is the oldest history of
   *  the case rather than the feed the operator was watching. */
  order?: "asc" | "desc";
}

const pageQuery = (filters: InvestigationFilters) => serializeQuery({
  page: filters.page ?? 1,
  page_size: filters.pageSize ?? 50,
  source: filters.source,
  event_type: filters.eventType,
  entity: filters.entity,
  severity: filters.severity,
  start_time: filters.startTime,
  end_time: filters.endTime,
  analysis_id: filters.analysisId,
  order: filters.order,
});

export const investigationApi = {
  dashboard(signal?: AbortSignal) { return apiClient.request<DashboardSummary>("/dashboard/summary", { signal }); },
  summary(caseId: number, signal?: AbortSignal) { return apiClient.request<CaseSummary>(`/cases/${caseId}/summary`, { signal }); },
  history(caseId: number, signal?: AbortSignal) { return apiClient.request<AnalysisHistoryPage>(`/cases/${caseId}/analyses?page=1&page_size=100`, { signal }); },
  analysis(caseId: number, analysisId: string, signal?: AbortSignal) { return apiClient.request<AnalysisResult>(`/cases/${caseId}/analyses/${analysisId}`, { signal }); },
  evidence(caseId: number, filters: InvestigationFilters, signal?: AbortSignal) { return apiClient.request<EvidencePage>(`/cases/${caseId}/evidence${pageQuery(filters)}`, { signal }); },
  events(caseId: number, filters: InvestigationFilters, signal?: AbortSignal) { return apiClient.request<EventPage>(`/cases/${caseId}/events${pageQuery(filters)}`, { signal }); },
  findings(caseId: number, filters: InvestigationFilters, signal?: AbortSignal) { return apiClient.request<FindingPage>(`/cases/${caseId}/findings${pageQuery(filters)}`, { signal }); },
  alerts(caseId: number, filters: InvestigationFilters, signal?: AbortSignal) { return apiClient.request<AlertPage>(`/cases/${caseId}/alerts${pageQuery(filters)}`, { signal }); },
  incidents(caseId: number, filters: InvestigationFilters, signal?: AbortSignal) { return apiClient.request<IncidentPage>(`/cases/${caseId}/incidents${pageQuery(filters)}`, { signal }); },
  timeline(caseId: number, filters: InvestigationFilters, signal?: AbortSignal) { return apiClient.request<TimelinePage>(`/cases/${caseId}/timeline${pageQuery(filters)}`, { signal }); },
  graph(caseId: number, analysisId: string | null, signal?: AbortSignal) { return apiClient.request<GraphResult>(`/cases/${caseId}/graph${serializeQuery({ analysis_id: analysisId })}`, { signal }); },
  charts(caseId: number, analysisId: string | null, signal?: AbortSignal) { return apiClient.request<ChartPage>(`/cases/${caseId}/charts${serializeQuery({ analysis_id: analysisId })}`, { signal }); },
  reanalyze(caseId: number, signal?: AbortSignal) { return apiClient.request<ReanalysisResult>(`/cases/${caseId}/analyses`, { method: "POST", signal }); },
};
