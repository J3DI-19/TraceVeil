import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedCaseWorkspaceV3Page } from "./ConnectedCaseWorkspaceV3Page";

const summary = (analysisId: string | null) => ({ case: { id: 7, name: "Case Seven", description: "Dataset overview: This is a simple explanation of the imported smart-device data." }, event_count: 2, entity_count: 1, finding_count: 0, alert_count: 0, incident_count: 0, maximum_risk: 0, analysis_id: analysisId });
const page = (items: Record<string, unknown>[]) => ({ items, page: 1, page_size: 50, total: items.length });
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function respond(routes: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://traceveil.test").pathname;
    const match = Object.entries(routes).find(([suffix]) => path.endsWith(suffix));
    return Promise.resolve(new Response(JSON.stringify(match?.[1] ?? { code: "not_found", message: "Not found", retryable: false }), { status: match ? 200 : 404, headers: { "Content-Type": "application/json" } }));
  }));
}


/**
 * Step 7 - the case workspace must respond to live invalidation too, not
 * only Live Monitor. This responder adds an SSE stream and lets the
 * timeline endpoint return a different page on each call, so a test can
 * prove the view was refetched rather than re-rendered from a payload.
 */
function respondLive(routes: Record<string, unknown[]>, frames: string[] = []) {
  const counts: Record<string, number> = {};
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const path = new URL(url, "http://traceveil.test").pathname;
    calls.push(url);
    if (path.endsWith("/live/stream")) {
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) { if (frames.length) controller.enqueue(new TextEncoder().encode(frames.join(""))); },
      }), { status: 200 }));
    }
    const suffix = Object.keys(routes).find(route => path.endsWith(route));
    if (!suffix) return Promise.resolve(new Response(JSON.stringify({ code: "not_found", message: "Not found", retryable: false }), { status: 404, headers: { "Content-Type": "application/json" } }));
    const index = Math.min(counts[suffix] ?? 0, routes[suffix].length - 1);
    counts[suffix] = (counts[suffix] ?? 0) + 1;
    return Promise.resolve(new Response(JSON.stringify(routes[suffix][index]), { status: 200, headers: { "Content-Type": "application/json" } }));
  }));
  return { calls, count: (suffix: string) => counts[suffix] ?? 0 };
}

const timelineFrame = (id: number, analysisId: string) =>
  `id: ${id}\nevent: timeline.updated\ndata: ${JSON.stringify({ schema_version: "1.0", id, topic: "timeline.updated", case_id: 7, payload: { case_id: 7, analysis_id: analysisId, entry_count: 2 } })}\n\n`;

const timelineWindows = (label: string) => ({ items: [{ key: label, started_at: "2026-09-01T00:05:00Z", ended_at: "2026-09-01T00:05:59Z", record_count: 1, category_counts: { event: 1 }, peak_severity: "high" }], page: 1, page_size: 10, total: 1, record_total: 1 });

describe("ConnectedCaseWorkspaceV3Page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("distinguishes no analysis from a successful zero-finding analysis", async () => {
    respond({ "/cases/7/summary": summary(null), "/cases/7/findings": page([]) });
    const { unmount } = render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" navigate={vi.fn()}/>);
    expect(await screen.findByText("No analysis has run")).toBeInTheDocument(); unmount();
    respond({ "/cases/7/summary": summary("analysis-1"), "/cases/7/findings": page([]) });
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" navigate={vi.fn()}/>);
    expect(await screen.findByText("Analysis completed with no findings")).toBeInTheDocument();
  });

  it("opens an exact persisted reference outside the current page", async () => {
    const evidenceId = "11111111-1111-4111-8111-111111111111";
    respond({ "/cases/7/summary": summary("analysis-1"), "/cases/7/evidence": page([]), [`/cases/7/evidence/${evidenceId}`]: { evidence_id: evidenceId, original_name: "source.csv", source_type: "simulation", sha256: "abc", issues: [] } });
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/evidence" search={`?evidence=${evidenceId}`} navigate={vi.fn()}/>);
    expect(await screen.findByLabelText(`Details for ${evidenceId}`)).toHaveTextContent("source.csv");
    expect(screen.queryByText("Source reference unavailable")).not.toBeInTheDocument();
  });

  it("keeps results visible when a source reference is stale and links supporting records", async () => {
    const eventId = "22222222-2222-4222-8222-222222222222"; const evidenceId = "33333333-3333-4333-8333-333333333333"; const navigate = vi.fn();
    respond({ "/cases/7/summary": summary("analysis-1"), "/cases/7/findings": page([{ finding_id: "finding-1", title: "Persisted finding", severity: "high", rule_id: "RULE-1", event_ids: [eventId], evidence_ids: [evidenceId], condition_trace: [{ field: "label", matched: true }], risk: { score: 80, factors: [{ name: "severity", weighted_points: 30 }] } }]) });
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" navigate={navigate}/>);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect finding-1" }));
    expect(screen.getByLabelText("Details for finding-1")).toHaveTextContent("condition trace");
    fireEvent.click(screen.getByRole("button", { name: eventId }));
    expect(navigate).toHaveBeenCalledWith(`/cases/7/events?event=${eventId}`);
    fireEvent.click(screen.getByRole("button", { name: evidenceId }));
    expect(navigate).toHaveBeenCalledWith(`/cases/7/evidence?evidence=${evidenceId}`);

    respond({ "/cases/7/summary": summary("analysis-1"), "/cases/7/evidence": page([{ evidence_id: evidenceId, original_filename: "visible.csv" }]) });
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/evidence" search="?evidence=not-a-uuid" navigate={vi.fn()}/>);
    expect(await screen.findByText("Source reference unavailable")).toBeInTheDocument();
    expect(screen.getByText("visible.csv")).toBeInTheDocument();
  });

  it("lists persisted analysis history and opens the selected snapshot", async () => {
    const latestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; const historicalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; const navigate = vi.fn();
    respond({ "/cases/7/summary": summary(latestId), "/cases/7/analyses": page([
      { analysis_id: latestId, case_id: 7, status: "completed", created_at: "2026-09-01T12:00:00Z" },
      { analysis_id: historicalId, case_id: 7, status: "completed", created_at: "2026-08-31T12:00:00Z" },
    ]) });
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/history" navigate={navigate}/>);
    expect(await screen.findByText("2 persisted snapshots")).toBeInTheDocument();
    expect(screen.getAllByText("Latest").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "View results" }));
    expect(navigate).toHaveBeenCalledWith(`/cases/7/findings?analysis=${historicalId}`);
  });

  it("loads and preserves an explicitly selected historical snapshot", async () => {
    const latestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; const historicalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; const navigate = vi.fn();
    respond({ "/cases/7/summary": summary(latestId), "/cases/7/findings": page([{ finding_id: "historical-finding", title: "Historical finding", severity: "medium" }]), [`/cases/7/analyses/${historicalId}`]: { analysis_id: historicalId, case_id: 7 } });
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" search={`?analysis=${historicalId}`} navigate={navigate}/>);
    expect(await screen.findByText("Historical snapshot")).toBeInTheDocument();
    expect(screen.getByText(historicalId)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(`/cases/7/findings?page=1&page_size=50&analysis_id=${historicalId}`))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "timeline" }));
    expect(navigate).toHaveBeenCalledWith(`/cases/7/timeline?analysis=${historicalId}`);
  });

  it("loads historical chart data and rejects malformed snapshot IDs", async () => {
    const latestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; const historicalId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    respond({ "/cases/7/summary": summary(latestId), "/cases/7/charts": page([{ series: "event_type", category: "motion", value: 2 }]), "/cases/7/graph": { nodes: [], edges: [], truncated: false }, [`/cases/7/analyses/${historicalId}`]: { analysis_id: historicalId, case_id: 7 } });
    const { unmount } = render(<ConnectedCaseWorkspaceV3Page path="/cases/7/charts" search={`?analysis=${historicalId}`} navigate={vi.fn()}/>);
    expect(await screen.findByRole("heading", { name: "Event types" })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(`/cases/7/charts?analysis_id=${historicalId}`))).toBe(true); unmount();

    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" search="?analysis=invalid" navigate={vi.fn()}/>);
    expect(await screen.findByText("Selected analysis unavailable")).toBeInTheDocument();
    expect(screen.getByText(/selected analysis ID is malformed/i)).toBeInTheDocument();
  });
  it("refreshes the exact filtered page and selected snapshot", async () => {
    const analysisId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://traceveil.test");
      if (url.pathname.endsWith("/cases/7/summary")) return Promise.resolve(jsonResponse(summary(analysisId)));
      if (url.pathname.endsWith(`/cases/7/analyses/${analysisId}`)) return Promise.resolve(jsonResponse({ analysis_id: analysisId, case_id: 7 }));
      if (url.pathname.endsWith("/cases/7/findings")) { requests.push(url.toString()); return Promise.resolve(jsonResponse({ items: [{ finding_id: "finding-1", title: "Filtered finding", severity: "high" }], page: Number(url.searchParams.get("page")), page_size: 50, total: 51 })); }
      return Promise.resolve(jsonResponse({ code: "not_found", message: "Not found", retryable: false }, 404));
    }));
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" search={`?analysis=${analysisId}`} navigate={vi.fn()}/>);
    expect(await screen.findByText("Filtered finding")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter findings"), { target: { value: "high" } });
    await waitFor(() => expect(requests.at(-1)).toContain("severity=high"));
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(requests.at(-1)).toContain("page=2"));
    const beforeRefresh = requests.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(requests.length).toBeGreaterThan(beforeRefresh));
    expect(requests.at(-1)).toContain("page=2");
    expect(requests.at(-1)).toContain("severity=high");
    expect(requests.at(-1)).toContain(`analysis_id=${analysisId}`);
    expect(screen.getByLabelText("Filter findings")).toHaveValue("high");
  });

  it("keeps existing results visible when refresh fails and retries the request directly", async () => {
    const analysisId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; let failNextFinding = false; let findingRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://traceveil.test");
      if (url.pathname.endsWith("/cases/7/summary")) return Promise.resolve(jsonResponse(summary(analysisId)));
      if (url.pathname.endsWith(`/cases/7/analyses/${analysisId}`)) return Promise.resolve(jsonResponse({ analysis_id: analysisId, case_id: 7 }));
      if (url.pathname.endsWith("/cases/7/findings")) {
        findingRequests += 1;
        if (failNextFinding) { failNextFinding = false; return Promise.resolve(jsonResponse({ code: "temporary_failure", message: "Temporary backend failure.", retryable: true }, 503)); }
        return Promise.resolve(jsonResponse(page([{ finding_id: "finding-1", title: "Persisted finding", severity: "high" }])));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" search={`?analysis=${analysisId}`} navigate={vi.fn()}/>);
    expect(await screen.findByText("Persisted finding")).toBeInTheDocument();
    failNextFinding = true; fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Refresh failed")).toBeInTheDocument();
    expect(screen.getByText("Persisted finding")).toBeInTheDocument();
    const beforeRetry = findingRequests;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(findingRequests).toBeGreaterThan(beforeRetry));
    await waitFor(() => expect(screen.queryByText("Refresh failed")).not.toBeInTheDocument());
    expect(screen.getByText("Persisted finding")).toBeInTheDocument();
  });

  it("ignores a superseded response even when the transport does not honor abort", async () => {
    const analysisId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; let resolveOld: ((response: Response) => void) | undefined; let unfilteredRequests = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://traceveil.test");
      if (url.pathname.endsWith("/cases/7/summary")) return Promise.resolve(jsonResponse(summary(analysisId)));
      if (url.pathname.endsWith("/cases/7/findings")) {
        const severity = url.searchParams.get("severity");
        if (!severity && ++unfilteredRequests === 2) return new Promise<Response>(resolve => { resolveOld = resolve; });
        const title = severity === "new" ? "Newest result" : "Initial result";
        return Promise.resolve(jsonResponse(page([{ finding_id: severity ?? "initial", title, severity: severity ?? "low" }])));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" navigate={vi.fn()}/>);
    expect(await screen.findByText("Initial result")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(resolveOld).toBeDefined());
    fireEvent.change(screen.getByLabelText("Filter findings"), { target: { value: "new" } });
    expect(await screen.findByText("Newest result")).toBeInTheDocument();
    await act(async () => { resolveOld?.(jsonResponse(page([{ finding_id: "old", title: "Stale result", severity: "old" }]))); await Promise.resolve(); });
    expect(screen.getByText("Newest result")).toBeInTheDocument();
    expect(screen.queryByText("Stale result")).not.toBeInTheDocument();
  });

  it.each([
    ["created", "New analysis snapshot created"],
    ["reused", "Identical analysis snapshot reused"],
  ] as const)("handles a %s reanalysis on the exact Findings route", async (outcome, notice) => {
    const analysisId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; const navigate = vi.fn(); let posts = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://traceveil.test");
      if (init?.method === "POST" && url.pathname.endsWith("/cases/7/analyses")) { posts += 1; return Promise.resolve(jsonResponse({ analysis_id: analysisId, case_id: 7, status: "completed", created_at: "2026-09-02T00:00:00Z", outcome }, 202)); }
      if (url.pathname.endsWith("/cases/7/summary")) return Promise.resolve(jsonResponse(summary(analysisId)));
      if (url.pathname.endsWith(`/cases/7/analyses/${analysisId}`)) return Promise.resolve(jsonResponse({ analysis_id: analysisId, case_id: 7 }));
      if (url.pathname.endsWith("/cases/7/findings")) return Promise.resolve(jsonResponse(page([{ finding_id: "finding-1", title: posts ? "Refreshed finding" : "Existing finding", severity: "high" }])));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" search={`?analysis=${analysisId}`} navigate={navigate}/>);
    expect(await screen.findByText("Existing finding")).toBeInTheDocument();
    const control = screen.getByRole("button", { name: "Reanalyze" }); fireEvent.click(control); fireEvent.click(control);
    expect(await screen.findByText(notice)).toBeInTheDocument();
    expect(posts).toBe(1);
    expect(await screen.findByText("Refreshed finding")).toBeInTheDocument();
    expect(navigate).toHaveBeenCalledWith(`/cases/7/findings?analysis=${analysisId}`);
    expect(screen.getByRole("button", { name: "Reanalyze" })).toBeEnabled();
  });

  it("recovers from reanalysis failure without hiding current results", async () => {
    const analysisId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://traceveil.test");
      if (init?.method === "POST") return Promise.resolve(jsonResponse({ code: "temporary_failure", message: "Analysis service failed.", retryable: true }, 503));
      if (url.pathname.endsWith("/cases/7/summary")) return Promise.resolve(jsonResponse(summary(analysisId)));
      if (url.pathname.endsWith(`/cases/7/analyses/${analysisId}`)) return Promise.resolve(jsonResponse({ analysis_id: analysisId, case_id: 7 }));
      if (url.pathname.endsWith("/cases/7/findings")) return Promise.resolve(jsonResponse(page([{ finding_id: "finding-1", title: "Existing finding", severity: "high" }])));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" search={`?analysis=${analysisId}`} navigate={vi.fn()}/>);
    expect(await screen.findByText("Existing finding")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reanalyze" }));
    expect(await screen.findByText("Reanalysis failed")).toBeInTheDocument();
    expect(screen.getByText("Existing finding")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reanalyze" })).toBeEnabled();
  });

  it("uses six primary sections and opens Inspect in a dismissible detail drawer", async () => {
    respond({ "/cases/7/summary": summary("analysis-1"), "/cases/7/findings": page([{ finding_id: "finding-1", title: "Persisted finding", severity: "medium" }]) });
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" navigate={vi.fn()}/>);
    const navigation = await screen.findByRole("navigation", { name: "Connected case views" });
    expect(navigation.querySelectorAll("button")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Inspect finding-1" }));
    expect(screen.getByRole("dialog", { name: "Details for finding-1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close record details" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Details for finding-1" })).not.toBeInTheDocument();
  });

  it("shows incident context and exposes a dedicated incident destination", async () => {
    const incidentId = "44444444-4444-4444-8444-444444444444";
    respond({ "/cases/7/summary": summary("analysis-1"), "/cases/7/findings": page([{ finding_id: "finding-1", title: "Grouped finding", severity: "high" }]), "/cases/7/incidents": page([{ incident_id: incidentId, finding_ids: ["finding-1"], event_ids: ["event-1", "event-2"], maximum_risk: 81, correlation_edge_count: 4, started_at: "2026-09-01T00:00:00Z", ended_at: "2026-09-01T00:01:00Z" }]) });
    const navigate = vi.fn();
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" navigate={navigate}/>);
    expect(await screen.findByText("1 incidents organize these findings")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Incidents" }));
    expect(navigate).toHaveBeenCalledWith("/cases/7/incidents");
    fireEvent.click(screen.getByRole("button", { name: `Inspect ${incidentId}` }));
    expect(screen.getByRole("dialog", { name: `Details for ${incidentId}` })).toBeInTheDocument();
  });

  it("renders a readable entity inventory when a mixed case has no graph edges", async () => {
    respond({ "/cases/7/summary": summary("analysis-1"), "/cases/7/charts": page([{ series: "attack_class", category: "normal", value: 10 }]), "/cases/7/graph": { nodes: [{ node_id: "sensor-1", label: "Kitchen sensor", kind: "device", event_count: 5000, maximum_risk: 0 }, { node_id: "fridge-1", label: "Fridge", kind: "device", event_count: 1400, maximum_risk: 89 }], edges: [], truncated: false } });
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/visuals" navigate={vi.fn()}/>);
    expect(await screen.findByLabelText("Entity activity inventory")).toHaveTextContent("Kitchen sensor");
    expect(screen.getByLabelText("Entity activity inventory")).toHaveTextContent("Fridge");
    expect(screen.getByText(/no cross-entity relationships were persisted/i)).toBeInTheDocument();
  });
  it("pages timeline summaries and loads dense minute records only when expanded", async () => {
    const windows = Array.from({ length: 11 }, (_, index) => ({ key: `2026-09-01T00:${String(index).padStart(2, "0")}`, started_at: `2026-09-01T00:${String(index).padStart(2, "0")}:01Z`, ended_at: `2026-09-01T00:${String(index).padStart(2, "0")}:59Z`, record_count: 20, category_counts: { event: 20 }, peak_severity: null }));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://traceveil.test");
      if (url.pathname.endsWith("/cases/7/summary")) return Promise.resolve(jsonResponse(summary("analysis-1")));
      if (url.pathname.endsWith("/cases/7/charts")) return Promise.resolve(jsonResponse(page([{ series: "activity_minute", category: "2026-09-01T00:00:00Z", value: 3 }])));
      if (url.pathname.endsWith("/cases/7/timeline/windows")) {
        const items = url.searchParams.get("page") === "2" ? windows.slice(10) : windows.slice(0, 10);
        return Promise.resolve(jsonResponse({ items, page: Number(url.searchParams.get("page")), page_size: 10, total: 11, record_total: 220 }));
      }
      if (url.pathname.endsWith("/cases/7/timeline")) return Promise.resolve(jsonResponse({ items: [{ entry_id: "event-11", entry_type: "event", occurred_at: windows[10].started_at, title: "telemetry", event_ids: ["event-11"] }], page: 1, page_size: 200, total: 20 }));
      return Promise.resolve(jsonResponse({ code: "not_found", message: "Not found", retryable: false }, 404));
    }));
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/timeline" navigate={vi.fn()}/>);
    expect(await screen.findByRole("heading", { name: "Activity across the full snapshot" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Chronological investigation timeline" }).children).toHaveLength(10);
    expect(document.querySelector(".timeline-pagination")).toHaveTextContent("Minute blocks 1–10 of 11");
    expect(vi.mocked(fetch).mock.calls.some(([input]) => new URL(String(input), "http://traceveil.test").pathname.endsWith("/timeline") )).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("list", { name: "Chronological investigation timeline" }).children).toHaveLength(1));
    expect(document.querySelector(".timeline-pagination")).toHaveTextContent("Minute blocks 11–11 of 11");
    fireEvent.click(screen.getByText("Review records in this minute"));
    expect(await screen.findByRole("button", { name: "Inspect event-11" })).toBeInTheDocument();
    expect(screen.getByText("Showing the first 1 of 20 records in this dense minute.")).toBeInTheDocument();
  });

  it("does not render rows from the previous tab as timeline windows during client navigation", async () => {
    const timelineWindow = { key: "2026-09-01T00:05", started_at: "2026-09-01T00:05:00Z", ended_at: "2026-09-01T00:05:59Z", record_count: 4, category_counts: { event: 4 }, peak_severity: "medium" };
    respond({
      "/cases/7/summary": summary("analysis-1"),
      "/cases/7/findings": page([{ finding_id: "finding-before-navigation", title: "Finding from previous tab", severity: "high" }]),
      "/cases/7/timeline/windows": { items: [timelineWindow], page: 1, page_size: 10, total: 1, record_total: 4 },
      "/cases/7/charts": page([{ series: "activity_minute", category: "2026-09-01T00:05:00Z", value: 4 }]),
      "/cases/7/activity-windows": page([]),
    });

    const { rerender } = render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" navigate={vi.fn()}/>);
    expect(await screen.findByText("Finding from previous tab")).toBeInTheDocument();

    rerender(<ConnectedCaseWorkspaceV3Page path="/cases/7/timeline" navigate={vi.fn()}/>);
    expect(screen.getByText("Loading persisted timeline…")).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Chronological investigation timeline" })).toBeInTheDocument();
    expect(screen.queryByText("Finding from previous tab")).not.toBeInTheDocument();
  });

  it("turns the overview into a decision summary with distinct analysis layers", async () => {
    respond({
      "/cases/7/summary": { ...summary("analysis-1"), event_count: 180, finding_count: 2, alert_count: 1, incident_count: 1, maximum_risk: 82 },
      "/cases/7/findings": page([{ finding_id: "finding-1", title: "Suspicious network burst", entity_id: "edge-device-01", risk: { score: 82 }, classification: { source: "dataset_label" } }]),
      "/cases/7/alerts": page([{ alert_id: "alert-1", workflow_status: "pending" }]),
      "/cases/7/incidents": page([{ incident_id: "incident-1" }]),
      "/cases/7/evidence": page([{ evidence_id: "evidence-1", source_type: "hai_ics_blind" }, { evidence_id: "evidence-2", source_type: "iot23_zeek_blind" }]),
    });
    const navigate = vi.fn();
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/overview" navigate={navigate}/>);
    const datasetOverview = await screen.findByLabelText("Case dataset sources");
    expect(screen.getByRole("heading", { name: "Case Seven" })).toBeInTheDocument();
    expect(screen.getByText("This is a simple explanation of the imported smart-device data.")).toBeInTheDocument();
    expect(datasetOverview).toHaveTextContent("2 dataset sources");
    expect(datasetOverview).toHaveTextContent("hai ics blind");
    const summaryPanel = await screen.findByLabelText("Case analysis summary");
    expect(summaryPanel).toHaveTextContent("Prioritized investigation required");
    expect(summaryPanel).toHaveTextContent("Dataset supplied");
    expect(summaryPanel).toHaveTextContent("1 alert need review");
    expect(summaryPanel).toHaveTextContent("hai ics blind + iot23 zeek blind");
    expect(summaryPanel).toHaveTextContent("edge-device-01");
    fireEvent.click(screen.getByRole("button", { name: "Review alerts" }));
    expect(navigate).toHaveBeenCalledWith("/cases/7/alerts");
  });

  it("explains classification provenance and the persisted risk equation", async () => {
    respond({ "/cases/7/summary": summary("analysis-1"), "/cases/7/findings": page([{ finding_id: "finding-1", title: "DDoS-labelled traffic", entity_id: "edge-camera-01", severity: "high", evidence_confidence: 0.8, classification_confidence: 0.95, classification: { display_name: "Distributed denial of service", category: "availability", subcategory: "ddos", source: "dataset_label", source_field: "attack_type", source_value: "DDoS", confidence: 0.95, tags: ["network", "availability"] }, risk: { base_score: 88, score: 78, band: "high", factors: [{ name: "severity", weighted_points: 40, explanation: "High source severity" }], penalties: [{ reason: "limited_evidence", points: 10, explanation: "Limited corroborating evidence" }] } }]) });
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/findings" navigate={vi.fn()}/>);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect finding-1" }));
    const explanation = screen.getByLabelText("Finding classification and risk explanation");
    expect(explanation).toHaveTextContent("Dataset supplied");
    expect(explanation).toHaveTextContent("attack_type");
    expect(explanation).toHaveTextContent("edge-camera-01");
    expect(explanation).toHaveTextContent("88 base score");
    expect(explanation).toHaveTextContent("10 penalties");
    expect(explanation).toHaveTextContent("Limited corroborating evidence");
  });

  it("lets investigators select an anomalous minute and see whether its cause is attributable", async () => {
    const timelineWindow = { key: "2026-09-01T00:05", started_at: "2026-09-01T00:05:00Z", ended_at: "2026-09-01T00:05:59Z", record_count: 60, category_counts: { event: 60 }, peak_severity: "high" };
    const explanation = { activity_explanation_version: "1.0", window_id: "2026-09-01T00:05:00Z", window_start: "2026-09-01T00:05:00Z", event_count: 60, baseline_count: 10, deviation_ratio: 6, is_volume_anomaly: true, cause_status: "undetermined", explanation: "Activity is elevated without a dominant classified cause.", top_event_types: { network: 40 }, top_devices: { gateway: 35 }, source_classifications: [], finding_ids: [], incident_ids: [] };
    respond({ "/cases/7/summary": summary("analysis-1"), "/cases/7/charts": page([{ series: "activity_minute", category: "2026-09-01T00:05:00Z", value: 60 }]), "/cases/7/timeline/windows": { items: [timelineWindow], page: 1, page_size: 10, total: 1, record_total: 60 }, "/cases/7/activity-windows": page([explanation]) });
    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/timeline" navigate={vi.fn()}/>);
    const attribution = await screen.findByLabelText("Timeline spike attribution");
    expect(attribution).toHaveTextContent("6.00× baseline");
    expect(attribution).toHaveTextContent("undetermined");
    expect(attribution).toHaveTextContent("not a DDoS conclusion");
  });

  it("refreshes an open latest-snapshot timeline when live analysis lands", async () => {
    // The signal carries identifiers only, so the newer window can only
    // appear if the page refetched from the investigation API.
    const harness = respondLive({
      "/cases/7/summary": [summary("analysis-1")],
      "/cases/7/timeline/windows": [timelineWindows("2026-09-01T00:05"), timelineWindows("2026-09-01T00:06")],
      "/cases/7/charts": [page([])],
      "/cases/7/activity-windows": [page([])],
    }, [timelineFrame(9, "analysis-2")]);

    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/timeline" navigate={vi.fn()}/>);

    await waitFor(() => expect(harness.count("/cases/7/timeline/windows")).toBeGreaterThan(1));
  });

  it("never replaces a pinned historical snapshot with live results", async () => {
    // Reviewing a fixed past analysis is deliberate; live activity must
    // not pull the investigator forward out of it.
    const harness = respondLive({
      "/cases/7/summary": [summary("analysis-9")],
      "/cases/7/analyses/55555555-5555-4555-8555-555555555555": [{ analysis_id: "55555555-5555-4555-8555-555555555555", case_id: 7, status: "completed", created_at: "2026-09-01T00:00:00Z" }],
      "/cases/7/timeline/windows": [timelineWindows("2026-09-01T00:05"), timelineWindows("2026-09-01T00:06")],
      "/cases/7/charts": [page([])],
      "/cases/7/activity-windows": [page([])],
    }, [timelineFrame(9, "analysis-2")]);

    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/timeline" search="?analysis=55555555-5555-4555-8555-555555555555" navigate={vi.fn()}/>);

    await waitFor(() => expect(harness.count("/cases/7/timeline/windows")).toBeGreaterThan(0));
    // No live stream is opened at all while a snapshot is pinned.
    expect(harness.calls.filter(url => url.includes("/live/stream"))).toHaveLength(0);
    await waitFor(() => expect(harness.count("/cases/7/timeline/windows")).toBe(1));
  });

  it("offers rather than forces a refresh while a record is open", async () => {
    const harness = respondLive({
      "/cases/7/summary": [summary("analysis-1")],
      "/cases/7/incidents": [page([{ incident_id: "incident-1", summary: "Highest severity high; maximum risk 78/100 across 3 findings.", severity: "high", maximum_risk: 78, finding_count: 3, evidence_count: 4, entity_count: 2, entity_ids: ["door"], started_at: "2026-09-01T00:00:00Z", ended_at: "2026-09-01T00:05:00Z" }])],
      "/cases/7/email-drafts": [{ items: [] }],
      "/incidents/incident-1/notification-preview": [{ subject_type: "incident", subject_id: "incident-1", subject: "s", body: "b" }],
    }, []);

    render(<ConnectedCaseWorkspaceV3Page path="/cases/7/incidents" navigate={vi.fn()}/>);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect incident-1" }));
    const drawer = screen.getByLabelText("Details for incident-1");
    // The deterministic summary is surfaced, not buried in the raw fields.
    expect(drawer).toHaveTextContent("Deterministic summary");
    expect(drawer).toHaveTextContent("maximum risk 78/100");
    expect(harness.count("/cases/7/summary")).toBeGreaterThan(0);
  });
});
