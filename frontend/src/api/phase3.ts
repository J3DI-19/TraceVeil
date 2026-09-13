import { apiClient } from "./batch";

export interface LiveSession { session_id: string; case_id: number; label: string; source_ids: string[]; status: "active" | "completed"; stale_after_seconds: number; accepted_count: number; malformed_count: number; started_at: string; stopped_at: string | null; updated_at: string }
export interface LiveMetrics { case_id: number; session_id: string | null; device_count: number; event_count: number; alert_count: number; malformed_count: number; updated_at: string | null }
export interface DeviceState { case_id: number; session_id: string; device_id: string; source_id: string; last_seen_at: string; last_observed_at: string; latest_metrics: Record<string, string | number | boolean | null>; event_count: number; stale: boolean }
export type StreamTopic = "event.accepted" | "alert.created" | "device.updated" | "metrics.updated" | "session.updated" | "heartbeat";
export interface StreamEnvelope { schema_version: "1.0"; id?: number; topic: StreamTopic; case_id?: number; session_id?: string | null; occurred_at?: string; payload?: Record<string, unknown> }
export type VisualizationType = "timeline" | "risk_breakdown" | "severity_distribution" | "event_activity" | "entity_graph" | "evidence_table" | "alert_list" | "top_entities" | "top_findings";
export interface VisualizationComponent { id: string; type: VisualizationType; title: string; data_ref: string; span: 1 | 2 | 3; height: "compact" | "standard" | "tall" }
export interface VisualizationLayout { schema_version: "1.0"; layout_id: string; title: string; components: VisualizationComponent[] }
export interface ResolvedVisualization { schema_version: "1.0"; layout: VisualizationLayout; datasets: Record<string, unknown>; analysis_ids: Record<string, string> }
export interface AssistantSession { session_id: string; scope: "auto" | "all_cases" | "specific_case" | "selected_references"; case_ids: number[]; reference_ids: string[]; title: string; message_count: number; created_at: string; updated_at: string }
export interface AssistantMessage { message_id: string; role: "user" | "assistant"; kind: string; text: string; citations: string[]; caveats: string[]; visualization: VisualizationLayout | null; model: string | null; created_at: string }
export interface AssistantJob { job_id: string; session_id: string; status: "queued" | "processing" | "completed" | "failed"; error: { code: string; message: string; retryable: boolean } | null }
export type AssistantVisualizationMode = "none" | "auto" | "timeline" | "severity_distribution" | "event_activity" | "entity_graph" | "top_entities" | "top_findings";
export interface ReportRecord { report_id: string; case_id: number; title: string; sections: string[]; status: "draft" | "generated" | "approved"; narrative: string | null; content_hash: string | null; approved_by: string | null; approved_at: string | null; created_at: string; updated_at: string }
export interface EmailDraft { draft_id: string; report_id: string; recipient: string; subject: string; body: string; status: "draft" | "approved" | "sent" | "delivery_unknown"; approved_at: string | null; delivery_error: string | null }
export interface AuditEvent { audit_id: string; case_id: number | null; action: string; actor: string; subject_type: string; subject_id: string | null; request_id: string | null; details: Record<string, unknown>; occurred_at: string }
interface Page<T> { items: T[]; total: number; page: number; page_size: number }

export const phase3Api = {
  startSession(caseId: number, sourceIds = ["live-lab-01"], signal?: AbortSignal) { return apiClient.request<LiveSession>(`/cases/${caseId}/live-sessions`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Controlled live capture", source_ids: sourceIds, stale_after_seconds: 30 }) }); },
  sessions(caseId: number, signal?: AbortSignal) { return apiClient.request<Page<LiveSession>>(`/cases/${caseId}/live-sessions`, { signal }); },
  stopSession(sessionId: string, signal?: AbortSignal) { return apiClient.request<LiveSession>(`/live-sessions/${sessionId}/stop`, { method: "POST", signal }); },
  metrics(caseId: number, sessionId?: string, signal?: AbortSignal) { return apiClient.request<LiveMetrics>(`/cases/${caseId}/live/metrics${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`, { signal }); },
  devices(caseId: number, sessionId?: string, signal?: AbortSignal) { return apiClient.request<Page<DeviceState>>(`/cases/${caseId}/live/devices${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`, { signal }); },
  createAssistantSession(caseIds: number[] = [], referenceIds: string[] = [], signal?: AbortSignal) { return apiClient.request<AssistantSession>("/assistant/sessions", { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: referenceIds.length ? "selected_references" : caseIds.length ? "specific_case" : "auto", case_ids: caseIds, reference_ids: referenceIds }) }); },
  assistantSessions(caseId?: number | null, signal?: AbortSignal) { return apiClient.request<Page<AssistantSession>>(`/assistant/sessions${caseId ? `?case_id=${caseId}` : ""}`, { signal }); },
  assistantSession(sessionId: string, signal?: AbortSignal) { return apiClient.request<AssistantSession>(`/assistant/sessions/${sessionId}`, { signal }); },
  ask(sessionId: string, question: string, includeEvidence: boolean, visualizationMode: AssistantVisualizationMode, signal?: AbortSignal) { return apiClient.request<AssistantJob>(`/assistant/sessions/${sessionId}/messages`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, include_evidence: includeEvidence, visualization_mode: visualizationMode }) }); },
  assistantJob(jobId: string, signal?: AbortSignal) { return apiClient.request<AssistantJob>(`/assistant/jobs/${jobId}`, { signal }); },
  messages(sessionId: string, signal?: AbortSignal) { return apiClient.request<Page<AssistantMessage>>(`/assistant/sessions/${sessionId}/messages`, { signal }); },
  resolveVisualization(layout: VisualizationLayout, signal?: AbortSignal) { return apiClient.request<ResolvedVisualization>("/visualizations/resolve", { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout }) }); },
  fallbackVisualization(caseId: number, analysisId?: string, signal?: AbortSignal) { const query = new URLSearchParams({ intent: "overview" }); if (analysisId) query.set("analysis_id", analysisId); return apiClient.request<ResolvedVisualization>(`/cases/${caseId}/visualizations/fallback?${query}`, { signal }); },
  reports(caseId: number, signal?: AbortSignal) { return apiClient.request<Page<ReportRecord>>(`/cases/${caseId}/reports`, { signal }); },
  createReport(caseId: number, title: string, signal?: AbortSignal) { return apiClient.request<ReportRecord>(`/cases/${caseId}/reports`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) }); },
  generateReport(reportId: string, signal?: AbortSignal) { return apiClient.request<ReportRecord>(`/reports/${reportId}/generate`, { method: "POST", signal }); },
  approveReport(reportId: string, approver: string, signal?: AbortSignal) { return apiClient.request<ReportRecord>(`/reports/${reportId}/approve`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approver, confirmed: true }) }); },
  downloadReport(reportId: string, signal?: AbortSignal) { return apiClient.download(`/reports/${reportId}/export`, signal); },
  createEmailDraft(reportId: string, recipient: string, subject: string, body: string, signal?: AbortSignal) { return apiClient.request<EmailDraft>(`/reports/${reportId}/email-drafts`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipient, subject, body }) }); },
  approveEmail(draftId: string, approver: string, signal?: AbortSignal) { return apiClient.request<EmailDraft>(`/email-drafts/${draftId}/approve`, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approver, confirmed: true }) }); },
  sendEmail(draftId: string, signal?: AbortSignal) { return apiClient.request<EmailDraft>(`/email-drafts/${draftId}/send`, { method: "POST", signal }); },
  audit(caseId: number, signal?: AbortSignal) { return apiClient.request<Page<AuditEvent>>(`/cases/${caseId}/audit?page=1&page_size=100`, { signal }); },
};
