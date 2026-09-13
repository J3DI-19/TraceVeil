import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DynamicVisualizationRenderer } from "./DynamicVisualizationRenderer";

describe("DynamicVisualizationRenderer", () => {
  it("fails safely for component types outside the allow-list", () => {
    render(<DynamicVisualizationRenderer specification={{ id: "unsafe", name: "Unsafe", description: "", evidenceRefs: [], components: [{ id: "x", type: "generated-react-component", title: "Unknown", dataRef: "incident-risk" }] }}/>);
    expect(screen.getByText("Visualization unavailable")).toBeInTheDocument();
    expect(screen.getByText(/not in the approved registry/i)).toBeInTheDocument();
  });

  it("fails safely when a deterministic data reference is missing", () => {
    render(<DynamicVisualizationRenderer specification={{ id: "missing", name: "Missing", description: "", evidenceRefs: [], components: [{ id: "x", type: "metric-card", title: "Missing", dataRef: "does-not-exist" }] }}/>);
    expect(screen.getByText(/could not be resolved/i)).toBeInTheDocument();
  });

  it("renders an allow-listed production dataset supplied by the backend", () => {
    render(<DynamicVisualizationRenderer datasets={{ alerts: [{ id: "a-1", time: "2026-09-10T10:00:00Z", title: "Persisted alert", severity: "High", risk: 81, status: "pending" }] }} specification={{ id: "safe", name: "Safe", description: "", evidenceRefs: [], components: [{ id: "alerts", type: "alert_list", title: "Alerts", dataRef: "alerts" }] }}/>);
    expect(screen.getByText("Persisted alert")).toBeInTheDocument();
    expect(screen.getByText(/81 risk/i)).toBeInTheDocument();
  });

  it("renders finding severity as a pie with counts and percentages", () => {
    render(<DynamicVisualizationRenderer datasets={{ severity: [{ name: "High", value: 3, color: "#fb5f68" }, { name: "Low", value: 1, color: "#27c2e8" }] }} specification={{ id: "severity", name: "Severity", description: "", evidenceRefs: [], components: [{ id: "severity", type: "severity_distribution", title: "Finding severity distribution", dataRef: "severity" }] }}/>);
    expect(screen.getByLabelText("Finding severity distribution")).toHaveTextContent("High 3 · 75%");
    expect(screen.getByLabelText("Finding severity distribution")).toHaveTextContent("Low 1 · 25%");
  });

  it("renders ranked entities and findings from persisted datasets", () => {
    const { rerender } = render(<DynamicVisualizationRenderer datasets={{ entities: [{ id: "entity-1", label: "Fridge-01", kind: "device", eventCount: 42, maximumRisk: 87 }] }} specification={{ id: "entities", name: "Entities", description: "", evidenceRefs: [], components: [{ id: "entities", type: "top_entities", title: "Top entities", dataRef: "entities" }] }}/>);
    expect(screen.getByLabelText("Top entities ranking")).toHaveTextContent("Fridge-01");
    expect(screen.getByLabelText("Top entities ranking")).toHaveTextContent("42 events");

    rerender(<DynamicVisualizationRenderer datasets={{ findings: [{ id: "finding-1", title: "Unusual telemetry", summary: "A persisted anomaly was detected.", severity: "High", risk: 87, confidence: 92, entity: "Fridge-01", eventCount: 4 }] }} specification={{ id: "findings", name: "Findings", description: "", evidenceRefs: [], components: [{ id: "findings", type: "top_findings", title: "Top findings", dataRef: "findings" }] }}/>);
    expect(screen.getByLabelText("Top findings ranking")).toHaveTextContent("Unusual telemetry");
    expect(screen.getByLabelText("Top findings ranking")).toHaveTextContent("4 supporting events · 92% confidence");
  });

  it("lets the investigator close and restore visual cards", () => {
    render(<DynamicVisualizationRenderer datasets={{ alerts: [{ id: "a-1", time: "2026-09-10T10:00:00Z", title: "Persisted alert", severity: "High", risk: 81, status: "pending" }] }} specification={{ id: "safe", name: "Safe", description: "", evidenceRefs: [], components: [{ id: "alerts", type: "alert_list", title: "Alerts", dataRef: "alerts" }] }}/>);
    fireEvent.click(screen.getByRole("button", { name: "Close Alerts visual" }));
    expect(screen.getByText("Visual canvas cleared")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore 1 visual" }));
    expect(screen.getByText("Persisted alert")).toBeInTheDocument();
  });

  it("opens a focused visual preview and closes it with Escape", () => {
    render(<DynamicVisualizationRenderer datasets={{ alerts: [{ id: "a-1", time: "2026-09-10T10:00:00Z", title: "Persisted alert", severity: "High", risk: 81, status: "pending" }] }} specification={{ id: "safe", name: "Safe", description: "", evidenceRefs: [], components: [{ id: "alerts", type: "alert_list", title: "Alerts", dataRef: "alerts" }] }}/>);

    fireEvent.click(screen.getByRole("button", { name: "Enlarge Alerts visual" }));
    expect(screen.getByRole("dialog", { name: "Alerts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Alerts preview" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Alerts" })).not.toBeInTheDocument();
  });

  it("keeps existing card state when a new visual is added", () => {
    const alerts = { id: "alerts", type: "alert_list", title: "Alerts", dataRef: "alerts" };
    const activity = { id: "activity", type: "event_activity", title: "Activity", dataRef: "activity" };
    const datasets = { alerts: [], activity: [{ label: "10:00", Events: 4, Alerts: 1 }] };
    const { rerender } = render(<DynamicVisualizationRenderer datasets={datasets} specification={{ id: "one", name: "One", description: "", evidenceRefs: [], components: [alerts] }}/>);

    fireEvent.click(screen.getByRole("button", { name: "Close Alerts visual" }));
    rerender(<DynamicVisualizationRenderer datasets={datasets} specification={{ id: "two", name: "Two", description: "", evidenceRefs: [], components: [alerts, activity] }}/>);

    expect(screen.queryByRole("button", { name: "Close Alerts visual" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Activity visual" })).toBeInTheDocument();
    expect(screen.getByText("1 closed visual")).toBeInTheDocument();
  });

  it("supports accessible keyboard reordering for visual cards", () => {
    render(<DynamicVisualizationRenderer datasets={{ alerts: [] }} specification={{ id: "safe", name: "Safe", description: "", evidenceRefs: [], components: [{ id: "first", type: "alert_list", title: "First visual", dataRef: "alerts" }, { id: "second", type: "alert_list", title: "Second visual", dataRef: "alerts" }] }}/>);
    fireEvent.keyDown(screen.getByLabelText(/Move Second visual/), { key: "ArrowLeft", altKey: true });
    expect(screen.getAllByRole("heading", { level: 3 }).map(heading => heading.textContent)).toEqual(["Second visual", "First visual"]);
  });
});
