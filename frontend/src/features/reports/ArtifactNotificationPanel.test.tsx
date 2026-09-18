import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactNotificationPanel } from "./ArtifactNotificationPanel";

const ALERT_ID = "44444444-4444-4444-8444-444444444444";
const PREVIEW = {
  subject_type: "alert", subject_id: ALERT_ID,
  subject: "[Traceveil] CRITICAL alert AUTH-001 - Case Seven",
  body: "Alert: " + ALERT_ID + "\nRule: AUTH-001\nRisk score: 90/100",
};

function draft(overrides: Record<string, unknown> = {}) {
  return {
    draft_id: "draft-1", report_id: null, case_id: 7, subject_type: "alert",
    subject_id: ALERT_ID, recipient: "security@example.test",
    subject: PREVIEW.subject, body: PREVIEW.body, status: "draft",
    approved_by: null, approved_at: null, sent_at: null, delivery_error: null,
    ...overrides,
  };
}

/**
 * Routes are matched by method + path suffix so a test states exactly the
 * calls it expects. `calls` records every request, which is how the tests
 * assert what the panel actually sent rather than only what it rendered.
 */
function respond(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://traceveil.test").pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    const key = Object.keys(routes).find(route => {
      const [routeMethod, suffix] = route.split(" ");
      return routeMethod === method && path.endsWith(suffix);
    });
    const value = key ? routes[key] : null;
    const resolved = typeof value === "function" ? (value as () => unknown)() : value;
    return Promise.resolve(new Response(
      JSON.stringify(resolved ?? { code: "not_found", message: "Not found", retryable: false }),
      { status: resolved ? 200 : 404, headers: { "Content-Type": "application/json" } }));
  }));
  return calls;
}

const panel = () => render(<ArtifactNotificationPanel caseId={7} subjectType="alert" subjectId={ALERT_ID}/>);

describe("ArtifactNotificationPanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a draft from a recipient alone and never supplies its own text", async () => {
    // The listing starts empty and returns the draft once it exists, the
    // way the backend does - the panel re-lists after every write.
    let stored: Record<string, unknown>[] = [];
    const calls = respond({
      "GET /cases/7/email-drafts": () => ({ items: stored }),
      [`GET /alerts/${ALERT_ID}/notification-preview`]: PREVIEW,
      [`POST /alerts/${ALERT_ID}/email-drafts`]: () => { stored = [draft()]; return stored[0]; },
    });
    panel();

    fireEvent.change(await screen.findByLabelText("Notification recipient"),
                     { target: { value: "security@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Create notification draft" }));

    await waitFor(() => expect(screen.getByLabelText("Notification subject")).toHaveValue(PREVIEW.subject));
    const created = calls.find(call => call.method === "POST");
    // The body carries only the recipient: composing the text is the
    // backend's job, so the browser cannot introduce ungrounded wording.
    expect(created?.body).toEqual({ recipient: "security@example.test" });
  });

  it("reopens an existing draft instead of creating a duplicate", async () => {
    respond({
      "GET /cases/7/email-drafts": { items: [draft({ status: "approved", approved_at: "2026-09-15T00:00:00Z" })] },
      [`GET /alerts/${ALERT_ID}/notification-preview`]: PREVIEW,
    });
    panel();

    expect(await screen.findByLabelText("Notification subject")).toHaveValue(PREVIEW.subject);
    expect(screen.getByLabelText("Notification message")).toHaveValue(PREVIEW.body);
    expect(screen.queryByRole("button", { name: "Create notification draft" })).not.toBeInTheDocument();
  });

  it("requires edits to be saved before approval, and sending after approval", async () => {
    let current = draft();
    respond({
      "GET /cases/7/email-drafts": () => ({ items: [current] }),
      [`GET /alerts/${ALERT_ID}/notification-preview`]: PREVIEW,
      "PATCH /email-drafts/draft-1": () => { current = draft({ subject: "Edited" }); return current; },
      "POST /email-drafts/draft-1/approve": () => { current = draft({ subject: "Edited", status: "approved", approved_at: "2026-09-15T00:00:00Z" }); return current; },
    });
    panel();

    const subject = await screen.findByLabelText("Notification subject");
    fireEvent.change(subject, { target: { value: "Edited" } });
    // An unsaved edit must not be approvable: approval is pinned to the
    // stored content hash, so approving here would pin the wrong text.
    expect(screen.getByRole("button", { name: "Approve notification" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Confirm and send" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Save edits" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve notification" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Confirm and send" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Approve notification" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm and send" })).toBeEnabled());
  });

  it("surfaces a refused send rather than reporting success", async () => {
    respond({
      "GET /cases/7/email-drafts": { items: [draft({ status: "approved", approved_at: "2026-09-15T00:00:00Z" })] },
      [`GET /alerts/${ALERT_ID}/notification-preview`]: PREVIEW,
    });
    panel();

    fireEvent.click(await screen.findByRole("button", { name: "Confirm and send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Notification action failed|Not found/);
  });

  it("locks a sent notification against further editing", async () => {
    respond({
      "GET /cases/7/email-drafts": { items: [draft({ status: "sent", approved_at: "2026-09-15T00:00:00Z", sent_at: "2026-09-15T00:05:00Z" })] },
      [`GET /alerts/${ALERT_ID}/notification-preview`]: PREVIEW,
    });
    panel();

    expect(await screen.findByLabelText("Notification subject")).toBeDisabled();
    expect(screen.getByLabelText("Notification message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Confirm and send" })).toBeDisabled();
  });
});
