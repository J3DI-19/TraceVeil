import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/** Let pending timers and promises land, with React updates flushed inside
 *  `act` so a state change that arrives while the test waits is not reported
 *  as an unwrapped update. */
const settle = async (ms = 80) => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
};

/** Select a case, waiting for its option to exist first. Setting a select
 *  to a value that has no matching option is a silent no-op, so a test that
 *  switches too early asserts against a case that never changed. The Pause
 *  button is not a proxy for this: it renders before the case list loads. */
const selectCase = async (id: number, label: string) => {
  await screen.findByRole("option", { name: label });
  fireEvent.change(screen.getByLabelText("Live case"), { target: { value: String(id) } });
  await waitFor(() => expect((screen.getByLabelText("Live case") as HTMLSelectElement).value).toBe(String(id)));
};

const CASE_ID = 4;
const OTHER_CASE_ID = 5;
const OTHER_SESSION_ID = "99999999-8888-7777-6666-555555555555";
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
function stubFetch(options: { frames?: string[]; lateFrames?: string[]; timelinePages?: unknown[]; timelineDelays?: number[]; devicePages?: Record<string, unknown>[][]; sessionIdSwitches?: boolean; eventHold?: Promise<unknown>; alertHold?: Promise<unknown>; eventFails?: boolean; alertFails?: boolean } = {}) {
  const frames = options.frames ?? [];
  const lateFrames = options.lateFrames ?? [];
  const timelineDelays = options.timelineDelays ?? [];
  const timelinePages = options.timelinePages ?? [timelinePage([])];
  const deviceStates = options.devicePages ?? [[]];
  let timelineCalls = 0;
  let deviceCalls = 0;
  let eventCalls = 0;
  let alertCalls = 0;
  let metricsCalls = 0;
  let sessionCalls = 0;
  const eventHold = options.eventHold;
  const alertHold = options.alertHold;
  // Failures are created at call time and returned straight into the fetch
  // chain, so the rejection always has a consumer. A pre-built rejected
  // promise sitting in an options object is unhandled until the stub is
  // reached, which the runner reports as an unhandled rejection and fails
  // the run on - even though every assertion passed.
  const eventFails = options.eventFails ?? false;
  const alertFails = options.alertFails ?? false;
  let streamConnections = 0;
  const sessionIdSwitches = options.sessionIdSwitches ?? false;
  const calls: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);

    if (url.includes("/live/stream")) {
      // The real endpoint filters by case, so the stub does too: a frame
      // for one case must never be delivered on another's stream.
      const streamCase = Number(new URL(url, "http://traceveil.test").searchParams.get("case_id"));
      streamConnections += 1;
      // Frames are delivered once, on the first connection. A real stream
      // resumes from Last-Event-ID and does not re-send what the client
      // has already seen, so replaying them on every reconnect would let
      // the stub, rather than the page, decide what is on screen.
      const first = streamConnections === 1;
      const body = streamCase === CASE_ID && first ? frames.join("") : "";
      const late = streamCase === CASE_ID && first ? lateFrames.join("") : "";
      return new Response(
        new ReadableStream({
          start(controller) {
            if (body) controller.enqueue(new TextEncoder().encode(body));
            // Late frames arrive after the test has had a chance to act,
            // which is what makes the paused-queue path reachable.
            if (late) setTimeout(() => { try { controller.enqueue(new TextEncoder().encode(late)); } catch { /* stream closed */ } }, 40);
            // Leave the stream open: the page aborts it on unmount.
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/timeline")) {
      const index = Math.min(timelineCalls, timelinePages.length - 1);
      const page = timelinePages[index];
      const delay = timelineDelays[Math.min(timelineCalls, timelineDelays.length - 1)] ?? 0;
      timelineCalls += 1;
      // A per-call delay lets a test resolve a newer request before an
      // older one, which is the ordering hazard being guarded against.
      if (delay) return new Promise(resolve => setTimeout(() => resolve(json(page)), delay));
      return json(page);
    }
    if (url.includes("/live-sessions")) {
      const sessionCase = Number(new URL(url, "http://traceveil.test").searchParams.get("case_id") ?? url.split("/cases/")[1]?.split("/")[0]);
      sessionCalls += 1;
      // A second call for the same case reports a different session, the
      // way a restarted capture does.
      const id = sessionCalls > 1 && sessionIdSwitches ? OTHER_SESSION_ID : SESSION_ID;
      void sessionCase;
      return json({ items: [{ session_id: id, case_id: CASE_ID, label: "lab", source_ids: ["live-lab-01"], status: "active", stale_after_seconds: 30, accepted_count: 1, malformed_count: 0, started_at: "2026-09-14T10:00:00Z", stopped_at: null, updated_at: "2026-09-14T10:00:00Z" }], page: 1, page_size: 1, total: 1 });
    }
    if (url.includes("/live/metrics")) {
      metricsCalls += 1;
      return json({ case_id: CASE_ID, session_id: SESSION_ID, device_count: 1, event_count: 1, alert_count: 0, malformed_count: 0, updated_at: "2026-09-14T10:00:00Z" });
    }
    if (url.includes("/events")) {
      eventCalls += 1;
      // The stub enforces the backend's real page_size ceiling. A
      // permissive mock is what let a 422-on-every-recovery bug ship.
      const size = Number(new URL(url, "http://traceveil.test").searchParams.get("page_size") ?? "50");
      if (size > 200) return new Response(JSON.stringify({ code: "request_validation_error", message: "Input should be less than or equal to 200", retryable: false }), { status: 422, headers: { "Content-Type": "application/json" } });
      // Only the first request is held, so a superseded recovery and the
      // one that replaced it are distinguishable.
      if (eventFails && eventCalls === 1) return Promise.reject(new Error("network down"));
      if (eventHold && eventCalls === 1) return eventHold.then(body => json(body));
      return json({ items: [{ event_id: "EV-PERSISTED", observed_at: "2026-09-14T10:09:00Z", event_type: "telemetry" }], page: 1, page_size: 1, total: 1 });
    }
    if (url.includes("/alerts")) {
      alertCalls += 1;
      const size = Number(new URL(url, "http://traceveil.test").searchParams.get("page_size") ?? "50");
      if (size > 200) return new Response(JSON.stringify({ code: "request_validation_error", message: "Input should be less than or equal to 200", retryable: false }), { status: 422, headers: { "Content-Type": "application/json" } });
      if (alertFails && alertCalls === 1) return Promise.reject(new Error("case four is gone"));
      if (alertHold && alertCalls === 1) return alertHold.then(body => json(body));
      return json({ items: [{ alert_id: "AL-PERSISTED", severity: "high", title: "Persisted alert" }], page: 1, page_size: 1, total: 1 });
    }
    if (url.includes("/live/devices")) {
      const state = deviceStates[Math.min(deviceCalls, deviceStates.length - 1)];
      deviceCalls += 1;
      return json({ items: state, page: 1, page_size: state.length, total: state.length });
    }
    if (url.includes("/cases")) {
      return json({ items: [{ id: CASE_ID, name: "Live case" }, { id: OTHER_CASE_ID, name: "Other case" }], page: 1, page_size: 2, total: 2 });
    }
    return json({});
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls, timelineCalls: () => timelineCalls, deviceCalls: () => deviceCalls, eventCalls: () => eventCalls, alertCalls: () => alertCalls, metricsCalls: () => metricsCalls };
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

  it("reloads every resource the reset names, not just the ones it can clear", async () => {
    // Clearing a feed is not a rebuild. After a gap the persisted events
    // and alerts are what the backend actually kept, so they are read
    // back rather than left blank.
    const harness = stubFetch({
      frames: [
        sseFrame(3, "event.accepted", { event_id: "EV-STALE-BUFFER", observed_at: "2026-09-14T10:01:00Z", event_type: "telemetry" }),
        sseFrame(4, "stream.reset", { schema_version: "1.0", reason: "cursor_expired", requested_from: 1, earliest_retained: 9, resume_from: 8, resynchronize: ["devices", "metrics", "timeline", "events", "alerts"] }),
      ],
      timelinePages: [timelinePage(["Before reset"]), timelinePage(["After authoritative refetch"])],
    });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);

    // Persisted records replace the discarded buffer rather than an empty panel.
    expect(await screen.findByText("EV-PERSISTED")).toBeTruthy();
    expect(await screen.findByText("Persisted alert")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("EV-STALE-BUFFER")).toBeNull());
    await waitFor(() => expect(harness.timelineCalls()).toBeGreaterThan(1));
    expect(harness.deviceCalls()).toBeGreaterThan(0);
    expect(harness.eventCalls()).toBeGreaterThan(0);
    expect(harness.alertCalls()).toBeGreaterThan(0);
    // Every name in `resynchronize` must actually be reloaded, metrics included.
    expect(harness.metricsCalls()).toBeGreaterThan(0);
  });

  it("announces a cursor that could not be resumed, whatever the reason", async () => {
    stubFetch({
      frames: [sseFrame(4, "stream.reset", { schema_version: "1.0", reason: "cursor_ahead", requested_from: 9999, earliest_retained: 1, latest_retained: 4, resume_from: 4, resynchronize: ["devices", "metrics", "timeline", "events", "alerts"] })],
    });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);
    expect(await screen.findByText(/could not be resumed/i)).toBeTruthy();
  });

  it("never flushes a message queued in one case into another", async () => {
    // The failure this prevents: pause on case A, a frame arrives, the
    // investigator switches to case B, resumes - and case A's activity
    // appears under case B.
    stubFetch({
      lateFrames: [sseFrame(21, "event.accepted", { event_id: "EV-CASE-A-ONLY", observed_at: "2026-09-14T10:07:00Z", event_type: "telemetry" })],
    });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);
    // Pause before the late frame lands, so it is queued rather than shown.
    fireEvent.click(await screen.findByRole("button", { name: "Pause display" }));
    await settle(120);
    expect(screen.queryByText("EV-CASE-A-ONLY")).toBeNull();

    await selectCase(OTHER_CASE_ID, "Other case");

    fireEvent.click(screen.getByRole("button", { name: "Resume display" }));
    await screen.findByRole("button", { name: "Pause display" });
    await settle(60);

    expect(screen.queryByText("EV-CASE-A-ONLY")).toBeNull();
  });

  it("clears the displayed feed when the selected case changes", async () => {
    stubFetch({
      frames: [sseFrame(31, "event.accepted", { event_id: "EV-SHOWN-ON-A", observed_at: "2026-09-14T10:08:00Z", event_type: "telemetry" })],
    });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);
    expect(await screen.findByText("EV-SHOWN-ON-A")).toBeTruthy();

    await selectCase(OTHER_CASE_ID, "Other case");
    await waitFor(() => expect(screen.queryByText("EV-SHOWN-ON-A")).toBeNull());
  });

  it("does not let an older timeline response replace a newer one", async () => {
    // Two signals arrive back to back. The first response is delayed so
    // it lands after the second; the stale chronology must be discarded
    // rather than overwrite the newer analysis on screen.
    stubFetch({
      frames: [
        sseFrame(41, "timeline.updated", { case_id: CASE_ID, analysis_id: "an-1", entry_count: 1 }),
        sseFrame(42, "timeline.updated", { case_id: CASE_ID, analysis_id: "an-2", entry_count: 2 }),
      ],
      timelinePages: [
        timelinePage(["Initial load"]),
        timelinePage(["Older analysis entry"]),
        timelinePage(["Newer analysis entry"]),
      ],
      timelineDelays: [0, 150, 0],
    });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);

    expect(await screen.findByText("Newer analysis entry")).toBeTruthy();
    // Give the delayed older response time to land and be rejected.
    await settle(250);
    expect(screen.queryByText("Older analysis entry")).toBeNull();
    expect(screen.getByText("Newer analysis entry")).toBeTruthy();
  });

  it("keeps the timeline and stays silent when a refresh is superseded", async () => {
    // A superseded request is ordinary operation, not a fault: it must
    // neither blank the chronology nor raise a connection notice.
    stubFetch({
      frames: [
        sseFrame(51, "timeline.updated", { case_id: CASE_ID, analysis_id: "an-1", entry_count: 1 }),
        sseFrame(52, "timeline.updated", { case_id: CASE_ID, analysis_id: "an-2", entry_count: 2 }),
      ],
      timelinePages: [
        timelinePage(["Initial load"]),
        timelinePage(["Superseded"]),
        timelinePage(["Current chronology"]),
      ],
      timelineDelays: [0, 120, 0],
    });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);

    expect(await screen.findByText("Current chronology")).toBeTruthy();
    await settle(220);
    expect(screen.getByText("Current chronology")).toBeTruthy();
    expect(screen.queryByText("Live connection notice")).toBeNull();
  });

  it("clears the feed when the live session changes, not only the case", async () => {
    // A restarted capture is a new scope on the same case. Carrying the
    // previous session's records across would attribute one capture's
    // activity to another.
    stubFetch({
      sessionIdSwitches: true,
      frames: [sseFrame(61, "event.accepted", { event_id: "EV-SESSION-ONE", observed_at: "2026-09-14T10:10:00Z", event_type: "telemetry" })],
    });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);
    expect(await screen.findByText("EV-SESSION-ONE")).toBeTruthy();

    // Re-selecting the case re-reads sessions, which now reports a new one.
    fireEvent.change(screen.getByLabelText("Live case"), { target: { value: String(OTHER_CASE_ID) } });
    await waitFor(() => expect(screen.queryByText("EV-SESSION-ONE")).toBeNull());
    await selectCase(CASE_ID, "Live case");

    await waitFor(() => expect(screen.getByText(/Session/)).toBeTruthy());
    expect(screen.queryByText("EV-SESSION-ONE")).toBeNull();
  });

  it("asks for the snapshot the signal named rather than for latest", async () => {
    // Pinning the request to the analysis id is stronger than sorting out
    // two answers to "latest" by arrival order.
    const harness = stubFetch({
      frames: [sseFrame(71, "timeline.updated", { case_id: CASE_ID, analysis_id: "an-pinned", entry_count: 1 })],
      timelinePages: [timelinePage(["Initial"]), timelinePage(["Pinned snapshot entry"])],
    });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);

    expect(await screen.findByText("Pinned snapshot entry")).toBeTruthy();
    expect(harness.calls.some(url => url.includes("/timeline") && url.includes("analysis_id=an-pinned"))).toBe(true);
    // The initial load, which has no signal behind it, still asks for latest.
    expect(harness.calls.some(url => url.includes("/timeline") && !url.includes("analysis_id="))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Reset recovery must issue a request the backend will actually accept
  // -------------------------------------------------------------------------
  const RESET = (id: number) => sseFrame(id, "stream.reset", { schema_version: "1.0", reason: "cursor_expired", requested_from: 1, earliest_retained: 9, resume_from: 8, resynchronize: ["devices", "metrics", "timeline", "events", "alerts"] });

  it("asks for a page size the events API accepts", async () => {
    // The display buffer is 500; the endpoint caps page_size at 200.
    // Asking for the buffer size returned 422 and rebuilt nothing, while
    // the UI reported a successful authoritative rebuild.
    const harness = stubFetch({ frames: [RESET(4)] });
    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);

    await waitFor(() => expect(harness.eventCalls()).toBeGreaterThan(0));
    const eventRequests = harness.calls.filter(url => url.includes("/events"));
    expect(eventRequests.length).toBeGreaterThan(0);
    for (const url of eventRequests) {
      const size = Number(new URL(url, "http://traceveil.test").searchParams.get("page_size"));
      expect(size).toBeLessThanOrEqual(200);
      expect(size).toBeGreaterThan(0);
    }
    for (const url of harness.calls.filter(u => u.includes("/alerts"))) {
      expect(Number(new URL(url, "http://traceveil.test").searchParams.get("page_size"))).toBeLessThanOrEqual(200);
    }
    // And the feed is actually rebuilt from the response.
    expect(await screen.findByText("EV-PERSISTED")).toBeTruthy();
  });

  it("requests the most recent records, not the oldest page", async () => {
    // Page 1 ascending is the oldest history of the case. Recovery has to
    // say which end it wants.
    const harness = stubFetch({ frames: [RESET(4)] });
    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);

    await waitFor(() => expect(harness.eventCalls()).toBeGreaterThan(0));
    const recovery = harness.calls.filter(url => url.includes("/events"));
    expect(recovery.every(url => new URL(url, "http://traceveil.test").searchParams.get("order") === "desc")).toBe(true);
  });

  it("reports a failed reload instead of an empty rebuild", async () => {
    // A refused refetch must not read as a completed authoritative
    // rebuild - the operator would trust an empty panel.
    const harness = stubFetch({
      frames: [RESET(4)],
      eventFails: true,
    });
    harness.calls.length = 0;
    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);

    expect(await screen.findByText(/could not be reloaded/i)).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // No response may cross a case or session boundary
  // -------------------------------------------------------------------------
  it("discards a delayed alert response from the previous case", async () => {
    // The reproduced sequence: reset on case 4, hold its alerts response,
    // switch to case 5, then release the old response.
    let release!: (value: unknown) => void;
    const held = new Promise(resolve => { release = resolve; });
    const harness = stubFetch({ frames: [RESET(4)], alertHold: held });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);
    // The reset must have reached the page and started the alerts request
    // before the scope changes: a request that was never issued proves
    // nothing about how its response is handled.
    await waitFor(() => expect(harness.alertCalls()).toBeGreaterThan(0));

    await selectCase(OTHER_CASE_ID, "Other case");

    release({ items: [{ alert_id: "AL-OLD", severity: "critical", title: "OLD CASE A ALERT" }], page: 1, page_size: 1, total: 1 });
    await settle(80);

    expect(screen.queryByText("OLD CASE A ALERT")).toBeNull();
  });

  it("discards a delayed event response from the previous case", async () => {
    let release!: (value: unknown) => void;
    const held = new Promise(resolve => { release = resolve; });
    const harness = stubFetch({ frames: [RESET(4)], eventHold: held });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);
    // The reset must have reached the page and started the events request
    // before the scope changes: a request that was never issued proves
    // nothing about how its response is handled.
    await waitFor(() => expect(harness.eventCalls()).toBeGreaterThan(0));

    await selectCase(OTHER_CASE_ID, "Other case");

    release({ items: [{ event_id: "EV-OLD-CASE-A", observed_at: "2026-09-14T10:00:00Z", event_type: "telemetry" }], page: 1, page_size: 1, total: 1 });
    await settle(80);

    expect(screen.queryByText("EV-OLD-CASE-A")).toBeNull();
  });

  it("discards a stale rejection instead of blaming the current case", async () => {
    // The doc's case: reject an old request *after* switching scope. An
    // old failure must not raise a notice against the case that replaced
    // it, and the transport does not honour abort, so only the scope
    // check can stop it.
    let reject!: (reason: unknown) => void;
    const held = new Promise((_resolve, fail) => { reject = fail; });
    const harness = stubFetch({ frames: [RESET(4)], alertHold: held });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);
    await waitFor(() => expect(harness.alertCalls()).toBeGreaterThan(0));

    await selectCase(OTHER_CASE_ID, "Other case");

    reject(new Error("case four is gone"));
    await settle(80);

    expect(screen.queryByText(/case four is gone/i)).toBeNull();
  });

  it("discards a response from a previous live session on the same case", async () => {
    let release!: (value: unknown) => void;
    const held = new Promise(resolve => { release = resolve; });
    const harness = stubFetch({ sessionIdSwitches: true, frames: [RESET(4)], alertHold: held });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);
    await waitFor(() => expect(harness.alertCalls()).toBeGreaterThan(0));

    // Re-reading sessions reports a restarted capture: same case, new scope.
    await selectCase(OTHER_CASE_ID, "Other case");
    await selectCase(CASE_ID, "Live case");

    release({ items: [{ alert_id: "AL-OLD-SESSION", severity: "high", title: "PREVIOUS SESSION ALERT" }], page: 1, page_size: 1, total: 1 });
    await settle(100);

    expect(screen.queryByText("PREVIOUS SESSION ALERT")).toBeNull();
  });

  it("keeps the newer recovery authoritative when an older one resolves late", async () => {
    // Two resets inside one scope: the scope check passes for both, so
    // only the recovery sequence separates them.
    let release!: (value: unknown) => void;
    const held = new Promise(resolve => { release = resolve; });
    const harness = stubFetch({
      frames: [RESET(4)],
      lateFrames: [RESET(5)],
      alertHold: held,
    });

    render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);
    // Both recoveries must actually run: the first issues the held
    // request, the late reset supersedes it.
    await waitFor(() => expect(harness.alertCalls()).toBeGreaterThan(1));
    release({ items: [{ alert_id: "AL-SUPERSEDED", severity: "low", title: "SUPERSEDED RECOVERY" }], page: 1, page_size: 1, total: 1 });
    await settle(80);

    expect(screen.queryByText("SUPERSEDED RECOVERY")).toBeNull();
  });

  it("makes outstanding requests inert after unmount", async () => {
    let release!: (value: unknown) => void;
    const held = new Promise(resolve => { release = resolve; });
    const harness = stubFetch({ frames: [RESET(4)], alertHold: held });

    const { unmount } = render(<ConnectedLiveOperationsPage navigate={vi.fn()} />);
    await waitFor(() => expect(harness.alertCalls()).toBeGreaterThan(0));
    unmount();

    release({ items: [{ alert_id: "AL-AFTER-UNMOUNT", severity: "high", title: "AFTER UNMOUNT" }], page: 1, page_size: 1, total: 1 });
    await settle(80);
    // Nothing rendered, and no state update warning escaped the teardown.
    expect(screen.queryByText("AFTER UNMOUNT")).toBeNull();
  });
});
