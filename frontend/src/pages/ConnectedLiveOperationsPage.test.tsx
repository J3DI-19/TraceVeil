import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedLiveOperationsPage } from "./ConnectedLiveOperationsPage";

/**
 * Step 7 - real-time browser delivery.
 *
 * These tests drive the page through a stubbed `fetch` router so the
 * SSE frames, the investigation API and the live API are all exercised
 * together. The important property is that a `timeline.updated` frame
 * carries no chronology of its own: it must cause the page to REFETCH
 * the timeline from the investigation API, so what the operator sees is
 * always backend-authored.
 */

const CASE_ID = 4;
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const sseFrame = (id: number, topic: string, payload: Record<string, unknown>) =>
  `id: ${id}\nevent: ${topic}\ndata: ${JSON.stringify({ schema_version: "1.0", id, topic, case_id: CASE_ID, payload })}\n\n`;

const timelinePage = (titles: string[]) => ({
  items: titles.map((title, index) => ({
    entry_id: `entry-${index}`,
    entry_type: "event",
    title,
    occurred_at: `2026-09-14T10:0${index}:00Z`,
    ingested_at: `2026-09-14T10:0${index}:05Z`,
    timestamp_basis: "observed",
    severity: "medium",
    risk_score: 40,
    event_ids: [],
    evidence_ids: [],
  })),
  page: 1,
  page_size: 50,
  total: titles.length,
});

/** Builds a fetch stub. `frames` are delivered once on the SSE stream. */
function stubFetch(options: { frames?: string[]; timelinePages?: unknown[]; devicePages?: Record<string, unknown>[][] } = {}) {
  const frames = options.frames ?? [];
  const timelinePages = options.timelinePages ?? [timelinePage([])];
  const deviceStates = options.devicePages ?? [[]];
  let timelineCalls = 0;
  let deviceCalls = 0;
  const calls: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);

    if (url.includes("/live/stream")) {
      const body = frames.join("");
      return new Response(
        new ReadableStream({
          start(controller) {
            if (body) controller.enqueue(new TextEncoder().encode(body));
            // Leave the stream open: the page aborts it on unmount.
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/timeline")) {
      const page = timelinePages[Math.min(timelineCalls, timelinePages.length - 1)];
      timelineCalls += 1;
      return json(page);
    }
    if (url.includes("/live-sessions")) {
      return json({ items: [{ session_id: SESSION_ID, case_id: CASE_ID, label: "lab", source_ids: ["live-lab-01"], status: "active", stale_after_seconds: 30, accepted_count: 1, malformed_count: 0, started_at: "2026-09-14T10:00:00Z", stopped_at: null, updated_at: "2026-09-14T10:00:00Z" }], page: 1, page_size: 1, total: 1 });
    }
    if (url.includes("/live/metrics")) {
      return json({ case_id: CASE_ID, session_id: SESSION_ID, device_count: 1, event_count: 1, alert_count: 0, malformed_count: 0, updated_at: "2026-09-14T10:00:00Z" });
    }
    if (url.includes("/live/devices")) {
      const state = deviceStates[Math.min(deviceCalls, deviceStates.length - 1)];
      deviceCalls += 1;
      return json({ items: state, page: 1, page_size: state.length, total: state.length });
    }
    if (url.includes("/cases")) {
      return json({ items: [{ id: CASE_ID, name: "Live case" }], page: 1, page_size: 1, total: 1 });
    }
    return json({});
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls, timelineCalls: () => timelineCalls, deviceCalls: () => deviceCalls };
}

describe("ConnectedLiveOperationsPage - real-time delivery", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders the backend-authored timeline fetched on load", async () => {
    stubFetch({ timelinePages: [timelinePage(["Initial persisted entry"])] });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);

    expect(await screen.findByText("Initial persisted entry")).toBeTruthy();
  });

  it("refetches the timeline when a timeline.updated frame arrives", async () => {
    // First fetch (on load) returns one entry; the refetch triggered by
    // the stream frame returns two.
    const harness = stubFetch({
      frames: [sseFrame(9, "timeline.updated", { case_id: CASE_ID, analysis_id: "an-1", entry_count: 2 })],
      timelinePages: [
        timelinePage(["Entry one"]),
        timelinePage(["Entry one", "Entry two (after live event)"]),
      ],
    });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);

    // The new entry can only appear if the page refetched from the API -
    // the stream frame itself contains no timeline values.
    expect(await screen.findByText("Entry two (after live event)")).toBeTruthy();
    await waitFor(() => expect(harness.timelineCalls()).toBeGreaterThan(1));
  });

  it("does not apply a duplicate stream id twice", async () => {
    // The same event.accepted frame is delivered twice; the page keeps a
    // seen-id set so the row must appear only once.
    const duplicate = sseFrame(12, "event.accepted", {
      event_id: "EV-DUPLICATE", observed_at: "2026-09-14T10:05:00Z", event_type: "telemetry",
    });
    stubFetch({ frames: [duplicate, duplicate] });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);

    await screen.findByText("EV-DUPLICATE");
    await waitFor(() => expect(screen.getAllByText("EV-DUPLICATE")).toHaveLength(1));
  });

  it("distinguishes Offline from Stale and from Online", async () => {
    // A device whose link is down can still carry a recent timestamp.
    // Collapsing the three states would render it as Online.
    stubFetch({ devicePages: [[
      { case_id: CASE_ID, session_id: SESSION_ID, device_id: "door", source_id: "live-lab-01", last_seen_at: "2026-09-14T10:00:00Z", last_observed_at: "2026-09-14T10:00:00Z", latest_metrics: { link_status: "offline" }, event_count: 1, stale: true, connection_state: "offline", stale_after_seconds: 30 },
      { case_id: CASE_ID, session_id: SESSION_ID, device_id: "hall", source_id: "live-lab-01", last_seen_at: "2026-09-14T09:00:00Z", last_observed_at: "2026-09-14T09:00:00Z", latest_metrics: {}, event_count: 1, stale: true, connection_state: "stale", stale_after_seconds: 30 },
      { case_id: CASE_ID, session_id: SESSION_ID, device_id: "gate", source_id: "live-lab-01", last_seen_at: "2026-09-14T10:02:00Z", last_observed_at: "2026-09-14T10:02:00Z", latest_metrics: {}, event_count: 1, stale: false, connection_state: "online", stale_after_seconds: 30 },
    ]] });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);

    expect(await screen.findByText("Offline")).toBeTruthy();
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
  });

  it("refetches device status on an idle heartbeat", async () => {
    // Nothing is being reported, so the heartbeat is the only tick that
    // can age a silent device out. The transition is backend-authored,
    // which is why it must come from a refetch rather than a local timer.
    const harness = stubFetch({
      frames: [`event: heartbeat\ndata: ${JSON.stringify({ schema_version: "1.0", topic: "heartbeat" })}\n\n`],
      devicePages: [
        [{ case_id: CASE_ID, session_id: SESSION_ID, device_id: "door", source_id: "live-lab-01", last_seen_at: "2026-09-14T10:00:00Z", last_observed_at: "2026-09-14T10:00:00Z", latest_metrics: {}, event_count: 1, stale: false, connection_state: "online", stale_after_seconds: 30 }],
        [{ case_id: CASE_ID, session_id: SESSION_ID, device_id: "door", source_id: "live-lab-01", last_seen_at: "2026-09-14T10:00:00Z", last_observed_at: "2026-09-14T10:00:00Z", latest_metrics: {}, event_count: 1, stale: true, connection_state: "stale", stale_after_seconds: 30 }],
      ],
    });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);

    expect(await screen.findByText("Stale")).toBeTruthy();
    await waitFor(() => expect(harness.deviceCalls()).toBeGreaterThan(1));
  });

  it("rebuilds from the authoritative APIs when replay falls outside retention", async () => {
    // A gap must never be silent. The reset frame discards the display
    // buffers and refetches, so the feed cannot keep showing a partial
    // history as though it were complete.
    const harness = stubFetch({
      frames: [
        sseFrame(3, "event.accepted", { event_id: "EV-BEFORE-RESET", observed_at: "2026-09-14T10:01:00Z", event_type: "telemetry" }),
        sseFrame(4, "stream.reset", { schema_version: "1.0", reason: "cursor_expired", requested_from: 1, earliest_retained: 9, resume_from: 8, resynchronize: ["devices", "metrics", "timeline", "events", "alerts"] }),
      ],
      timelinePages: [timelinePage(["Before reset"]), timelinePage(["After authoritative refetch"])],
    });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);

    expect(await screen.findByText("After authoritative refetch")).toBeTruthy();
    // The buffered row is discarded rather than left behind as a partial view.
    await waitFor(() => expect(screen.queryByText("EV-BEFORE-RESET")).toBeNull());
    await waitFor(() => expect(harness.timelineCalls()).toBeGreaterThan(1));
  });

  it("keeps one stream open across a display pause", async () => {
    // Pause is a display concern. Rebuilding the data source would reset
    // its private Last-Event-ID and replay retained history.
    const harness = stubFetch({});
    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);
    await waitFor(() => expect(harness.calls.filter(url => url.includes("/live/stream"))).toHaveLength(1));

    fireEvent.click(await screen.findByRole("button", { name: "Pause display" }));
    await screen.findByRole("button", { name: "Resume display" });
    fireEvent.click(screen.getByRole("button", { name: "Resume display" }));
    await screen.findByRole("button", { name: "Pause display" });

    expect(harness.calls.filter(url => url.includes("/live/stream"))).toHaveLength(1);
  });
});
