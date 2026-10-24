import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, normalizeApiError, serializeQuery } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("API client foundation", () => {
  it("distinguishes a backend timeout from explicit cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn((_input, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    await expect(new ApiClient("/api", 5).request("/slow")).rejects.toMatchObject({ code: "request_timeout", message: "The backend took too long to respond. Try again." });
    const controller = new AbortController();
    const request = new ApiClient("/api", 100).request("/cancel", { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "request_cancelled" });
  });
  it("serializes defined query values only", () => {
    expect(serializeQuery({ page: 2, filter: undefined, active: false, empty: null })).toBe("?page=2&active=false");
  });
  it("normalizes non-2xx responses with request metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "busy" }), { status: 503, headers: { "x-request-id": "req-1" } })));
    await expect(new ApiClient("/api", 100).request("/future")).rejects.toMatchObject({ code: "http_error", status: 503, requestId: "req-1", retryable: true });
  });
  it("normalizes malformed JSON and cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    await expect(new ApiClient("/api", 100).request("/future")).rejects.toMatchObject({ code: "invalid_response" });
    expect(normalizeApiError(new DOMException("Aborted", "AbortError"))).toMatchObject({ code: "request_cancelled", retryable: true });
  });
  it("normalizes browser network failures into an actionable backend message", () => {
    expect(normalizeApiError(new TypeError("Failed to fetch"))).toMatchObject({
      code: "network_error",
      message: "The backend API could not be reached. Check that the backend is running, then try again.",
      retryable: true,
    });
  });
  it("sends a request ID for backend audit correlation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await new ApiClient("/api", 100).request("/health");
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get("x-request-id")).toBeTruthy();
  });
});
