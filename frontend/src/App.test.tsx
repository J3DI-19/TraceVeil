import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

describe("Traceveil investigation interface", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      const response = path.endsWith("/dashboard/summary")
        ? { case_count: 1, event_count: 12, active_cases: 1, recent_cases: [{ id: 1, name: "Persisted demo", created_at: "2026-01-01T00:00:00Z", updated_at: null }] }
        : path.includes("/cases/1/analyses?page=")
        ? { items: [], page: 1, page_size: 100, total: 0 }
        : path.endsWith("/cases/1/summary")
        ? { case: { id: 1, name: "Persisted demo", description: "", case_type: "batch", status: "active", owner: "Investigator", created_at: "2026-01-01T00:00:00Z", updated_at: null }, event_count: 0, entity_count: 0, finding_count: 0, alert_count: 0, incident_count: 0, maximum_risk: 0, analysis_id: null }
        : /\/cases\/1\/(?:evidence|events|findings|alerts|incidents|timeline|charts)/.test(path)
        ? { items: [], page: 1, page_size: 50, total: 0 }
        : path.includes("/cases/1/graph")
        ? { nodes: [], edges: [], truncated: false }
        : path.includes("/cases?page=")
        ? { items: [{ id: 1, name: "Persisted demo", description: "", case_type: "batch", status: "active", owner: "Investigator", created_at: "2026-01-01T00:00:00Z", updated_at: null }], page: 1, page_size: 100, total: 1 }
        : path.endsWith("/assistant/sessions")
        ? { session_id: "11111111-1111-4111-8111-111111111111", scope: "auto", case_ids: [], reference_ids: [] }
        : path.includes("/live-sessions")
        ? { items: [], page: 1, page_size: 0, total: 0 }
        : path.includes("/live/metrics")
        ? { case_id: 1, session_id: null, device_count: 0, event_count: 0, alert_count: 0, malformed_count: 0, updated_at: null }
        : path.includes("/live/devices")
        ? { items: [], page: 1, page_size: 0, total: 0 }
        : path.endsWith("/ai")
        ? { service: "ollama", available: false, model_installed: false }
        : { service: path.endsWith("/db") ? "database" : "api", status: "ok" };
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    }));
  });

  it("renders the investigation overview", async () => {
    window.history.replaceState({}, "", "/");
    render(<App />);
    await waitFor(() => expect(screen.getByText("Investigation overview")).toBeInTheDocument());
    expect(screen.getByText("Canonical events")).toBeInTheDocument();
    expect(screen.getByText("Recent persisted cases")).toBeInTheDocument();
    expect(screen.getByText("Persisted demo")).toBeInTheDocument();
  });

  it("renders the connected Assistant with bounded case context and a safe layout boundary", async () => {
    window.history.replaceState({}, "", "/assistant?case=1&alert=ALT-8831");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Traceveil Assistant" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("Ready").length).toBeGreaterThan(0));
    expect(screen.getByText("Scoped to persisted case 1")).toBeInTheDocument();
    const scope = screen.getByLabelText("Investigation scope");
    expect(scope).toHaveValue("1");
    expect(within(scope).getByRole("option", { name: "Case 1 · Persisted demo" })).toBeInTheDocument();
    expect(screen.getByLabelText("Chat history")).toBeInTheDocument();
    expect(screen.getByText(/1 selected reference/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Include investigation evidence/ })).toBeChecked();
    expect(screen.getByRole("button", { name: /New chat/ })).toBeInTheDocument();
    const composer = screen.getByLabelText("Assistant message");
    const askButton = screen.getByRole("button", { name: /Ask/ });
    expect(askButton).toBeDisabled();
    fireEvent.change(composer, { target: { value: "hey" } });
    expect(askButton).toBeEnabled();

    const thread = screen.getByLabelText("Conversation messages");
    Object.defineProperties(thread, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    fireEvent.scroll(thread);
    const jumpButton = screen.getByRole("button", { name: "↓ Jump to latest" });
    fireEvent.click(jumpButton);
    expect(thread.scrollTop).toBe(1_000);
    expect(screen.queryByRole("button", { name: "↓ Jump to latest" })).not.toBeInTheDocument();
    expect(screen.getByText("No visual for this response")).toBeInTheDocument();
    expect(screen.getByText(/Choose a visual before sending/)).toBeInTheDocument();
    expect(screen.getByLabelText("Response visual")).toHaveValue("none");
    const visualSelector = within(screen.getByLabelText("Response visual"));
    expect(visualSelector.getByRole("option", { name: "Severity mix · Pie" })).toBeInTheDocument();
    expect(visualSelector.getByRole("option", { name: "Top entities · Bars" })).toBeInTheDocument();
    expect(visualSelector.getByRole("option", { name: "Top findings · Ranked" })).toBeInTheDocument();
    expect(visualSelector.queryByRole("option", { name: /Risk factors/i })).not.toBeInTheDocument();
    expect(visualSelector.queryByRole("option", { name: /Evidence records/i })).not.toBeInTheDocument();
    expect(visualSelector.queryByRole("option", { name: /Alerts · Table/i })).not.toBeInTheDocument();
  });

  it("opens the Assistant in Auto scope without requiring case selection", async () => {
    window.history.replaceState({}, "", "/assistant");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Traceveil Assistant" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Auto retrieval across persisted cases")).toBeInTheDocument());
    expect(screen.getByLabelText("Investigation scope")).toHaveValue("all");
    expect(screen.getByRole("option", { name: "All persisted cases" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Case 1 · Persisted demo" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Include investigation evidence/ })).not.toBeChecked();
    expect(screen.getByPlaceholderText("Message Traceveil Assistant…")).toBeInTheDocument();
    expect(screen.getByText("Start with a question—or just say hello")).toBeInTheDocument();
    expect(screen.getByText(/Enter to send/)).toBeInTheDocument();
  });

  it("restores a useful chat without creating or listing abandoned empty sessions", async () => {
    const existing = { session_id: "11111111-1111-4111-8111-111111111111", scope: "auto", case_ids: [], reference_ids: [], title: "Existing investigation", message_count: 2, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:01:00Z" };
    const abandoned = { ...existing, session_id: "22222222-2222-4222-8222-222222222222", title: "New investigation chat", message_count: 0 };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const response = path.includes("/cases?page=")
        ? { items: [{ id: 1, name: "Persisted demo", description: "", case_type: "batch", status: "active", owner: "Investigator", created_at: "2026-01-01T00:00:00Z", updated_at: null }], page: 1, page_size: 100, total: 1 }
        : path.endsWith("/assistant/sessions") && init?.method !== "POST"
        ? { items: [abandoned, existing], page: 1, page_size: 100, total: 2 }
        : path.endsWith(`/assistant/sessions/${existing.session_id}/messages`)
        ? { items: [{ message_id: "m1", role: "user", kind: "question", text: "Existing investigation", citations: [], caveats: [], visualization: null, model: null, created_at: "2026-01-01T00:00:00Z" }, { message_id: "m2", role: "assistant", kind: "narration", text: "Ready to continue.", citations: [], caveats: [], visualization: null, model: "qwen", created_at: "2026-01-01T00:01:00Z" }], page: 1, page_size: 100, total: 2 }
        : { service: path.endsWith("/db") ? "database" : "api", status: "ok" };
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/assistant");
    render(<App />);

    const history = await screen.findByLabelText("Chat history");
    await waitFor(() => expect(history).toHaveValue(existing.session_id));
    expect(within(history).getByRole("option", { name: "Existing investigation · 1 turn" })).toBeInTheDocument();
    expect(within(history).queryByRole("option", { name: "New chat" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).endsWith("/assistant/sessions") && options?.method === "POST")).toBe(false);
  });

  it("keeps a response visual open until the investigator closes it", async () => {
    const session = { session_id: "33333333-3333-4333-8333-333333333333", scope: "specific_case", case_ids: [1], reference_ids: [], title: "Show activity", message_count: 4, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:03:00Z" };
    const layout = { schema_version: "1.0", layout_id: "activity-view", title: "Pinned activity", components: [{ id: "activity", type: "event_activity", title: "Event activity", data_ref: "case:1:analysis:11111111-1111-4111-8111-111111111111:event_activity", span: 3, height: "standard" }] };
    const messages = [
      { message_id: "m1", role: "user", kind: "grounded_question:event_activity", text: "Show activity", citations: [], caveats: [], visualization: null, model: null, created_at: "2026-01-01T00:00:00Z" },
      { message_id: "m2", role: "assistant", kind: "narration", text: "Here is the activity.", citations: ["case:1"], caveats: [], visualization: layout, model: "qwen", created_at: "2026-01-01T00:01:00Z" },
      { message_id: "m3", role: "user", kind: "grounded_question:none", text: "Summarize it", citations: [], caveats: [], visualization: null, model: null, created_at: "2026-01-01T00:02:00Z" },
      { message_id: "m4", role: "assistant", kind: "narration", text: "Summary without a visual.", citations: ["case:1"], caveats: [], visualization: null, model: "qwen", created_at: "2026-01-01T00:03:00Z" },
    ];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const response = path.includes("/cases?page=")
        ? { items: [{ id: 1, name: "Persisted demo", description: "", case_type: "batch", status: "active", owner: "Investigator", created_at: "2026-01-01T00:00:00Z", updated_at: null }], page: 1, page_size: 100, total: 1 }
        : path.includes("/assistant/sessions?case_id=1") && init?.method !== "POST"
        ? { items: [session], page: 1, page_size: 100, total: 1 }
        : path.endsWith(`/assistant/sessions/${session.session_id}/messages`)
        ? { items: messages, page: 1, page_size: 100, total: 4 }
        : path.endsWith("/visualizations/resolve")
        ? { schema_version: "1.0", layout, datasets: { activity: [] }, analysis_ids: { activity: "11111111-1111-4111-8111-111111111111" } }
        : { service: path.endsWith("/db") ? "database" : "api", status: "ok" };
      return Promise.resolve(new Response(JSON.stringify(response), { status: 200 }));
    }));
    window.history.replaceState({}, "", "/assistant?case=1");
    render(<App />);

    expect(await screen.findByText("Summary without a visual.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Pinned activity" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Visual open ↗" }));
    expect(screen.getByText("No visual for this response")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open visual ↗" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Pinned activity" })).toBeInTheDocument());
  });

  it("renders a consolidated live monitoring hierarchy", async () => {
    window.history.replaceState({}, "", "/live");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Live monitor" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Start capture" })).toBeEnabled());
    expect(screen.getByText("SSE connection")).toBeInTheDocument();
    expect(screen.getByText("Persisted live event feed")).toBeInTheDocument();
    expect(screen.getByText("New deterministic alerts")).toBeInTheDocument();
    expect(screen.getByText("No live events yet")).toBeInTheDocument();
    expect(screen.getByText("Pausing never stops collection or backend analysis.")).toBeInTheDocument();
  });

  it("keeps the cases register dominant and the case summary compact", async () => {
    window.history.replaceState({}, "", "/cases");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Cases" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Case status summary")).toHaveTextContent("1Cases1Active"));
    expect(screen.queryByText("Findings generated")).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Updated (UTC)" })).toBeInTheDocument();
  });

  it("renders a connected case overview without fixture-authored case chrome", async () => {
    window.history.replaceState({}, "", "/cases/1/overview");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Case overview" })).toBeInTheDocument();
    const tabs = screen.getByRole("navigation", { name: "Connected case views" });
    expect(within(tabs).getByRole("button", { name: "reports" })).toBeInTheDocument();
    expect(screen.queryByText("Incident assessment")).not.toBeInTheDocument();
  });

  it("keeps the shell navigation-only and provides functional global search", async () => {
    window.history.replaceState({}, "", "/cases/1/evidence");
    render(<App />);
    expect(screen.queryByText("Collector active")).not.toBeInTheDocument();
    expect(screen.queryByText("Local Workspace")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Notifications" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Investigation Assistant" })).toBeInTheDocument();
    expect(screen.queryByText("Traceveil", { selector: ".breadcrumbs button" })).not.toBeInTheDocument();
    const search = screen.getByLabelText("Global search");
    fireEvent.change(search, { target: { value: "Live Monitor" } });
    expect(screen.getByRole("option", { name: /Live Monitor/ })).toBeInTheDocument();
  });

  it("does not expose legacy fixture-backed case routes", async () => {
    window.history.replaceState({}, "", "/cases/case-024/assistant");
    render(<App />);
    expect(await screen.findByText("Legacy demonstration case unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open cases" })).toBeInTheDocument();
    expect(screen.queryByText("Selected finding")).not.toBeInTheDocument();
  });

  it("renders connected findings without frontend risk calculation", async () => {
    window.history.replaceState({}, "", "/cases/1/findings");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Findings" })).toBeInTheDocument();
    expect(screen.getByText("No analysis has run")).toBeInTheDocument();
    expect(screen.queryByText("Risk model")).not.toBeInTheDocument();
  });

  it("redirects the legacy analytics view into persisted visuals", async () => {
    window.history.replaceState({}, "", "/cases/1/analytics");
    const { unmount } = render(<App />);
    expect(await screen.findByRole("heading", { name: "Visuals" })).toBeInTheDocument();
    expect(screen.getByText(/Connected records and visual summaries/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Live capture" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Live Monitor" })).toBeInTheDocument();
    unmount();
    window.history.replaceState({}, "", "/live?case=1");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Live monitor" })).toBeInTheDocument();
    expect(screen.getByText("Accepted records stream after durable persistence.")).toBeInTheDocument();
  });

  it("provides approval-gated connected report delivery", async () => {
    window.history.replaceState({}, "", "/cases/1/reports");
    render(<App />);
    expect(await screen.findByText("Reports and email")).toBeInTheDocument();
    expect(screen.getByText(/email is never sent automatically/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create report" })).toBeInTheDocument();
  });

  it("renders stateful settings with honest capability boundaries", async () => {
    window.history.replaceState({}, "", "/settings");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Frontend preference boundary")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save preferences" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Compact evidence rows" }));
    expect(screen.getByText("Unsaved session changes")).toBeInTheDocument();
    fireEvent.click(save);
    expect(screen.getByText(/Settings applied to this browser session/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Model settings/ }));
    expect(screen.getByText("Optional AI runtime")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Email delivery/ }));
    expect(screen.getByText("Delivery is server-configured")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save email delivery" })).toBeDisabled();
  });

  it("routes to a truthful empty import workflow", async () => {
    window.history.replaceState({}, "", "/import");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Import evidence" })).toBeInTheDocument();
    expect(screen.getByText("No validation result")).toBeInTheDocument();
    expect(screen.getAllByText("Mock adapter").length).toBeGreaterThan(0);
    expect(screen.queryByText("northbridge-toniot.csv")).not.toBeInTheDocument();
  });
});
