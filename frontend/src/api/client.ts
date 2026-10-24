import type { ImportDataError } from "../features/evidence-import/types";

export class ApiClientError extends Error implements ImportDataError {
  code: string; retryable: boolean; status?: number; requestId?: string; details?: unknown;
  constructor(error: ImportDataError) {
    super(error.message); this.name = "ApiClientError"; this.code = error.code; this.retryable = error.retryable;
    this.status = error.status; this.requestId = error.requestId; this.details = error.details;
  }
}

export function serializeQuery(values: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== null) params.set(key, String(value)); });
  const query = params.toString(); return query ? `?${query}` : "";
}

export function normalizeApiError(error: unknown): ApiClientError {
  if (error instanceof ApiClientError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new ApiClientError({ code: "request_cancelled", message: "The request was cancelled.", retryable: true });
  if (error instanceof SyntaxError) return new ApiClientError({ code: "invalid_response", message: "The service returned an unreadable response.", retryable: true });
  if (error instanceof TypeError) return new ApiClientError({ code: "network_error", message: "The backend API could not be reached. Check that the backend is running, then try again.", retryable: true });
  return new ApiClientError({ code: "network_error", message: error instanceof Error ? error.message : "The service could not be reached.", retryable: true });
}

export class ApiClient {
  constructor(private readonly baseUrl = "/api/v1", private readonly timeoutMs = 15_000) {}
  async response(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<Response> {
    const timeout = new AbortController(); const timer = window.setTimeout(() => timeout.abort(), timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
    try {
      const requestId = globalThis.crypto?.randomUUID?.() ?? `web-${Date.now()}`;
      const response = await fetch(`${this.baseUrl}${path}`, { ...init, signal, headers: { Accept: "application/json", "X-Request-ID": requestId, ...init.headers } });
      const responseRequestId = response.headers.get("x-request-id") ?? requestId;
      if (!response.ok) {
        let details: unknown; try { details = await response.json(); } catch { details = undefined; }
        const problem = details && typeof details === "object" ? details as Record<string, unknown> : undefined;
        throw new ApiClientError({ code: typeof problem?.code === "string" ? problem.code : "http_error", message: typeof problem?.message === "string" ? problem.message : `Request failed with status ${response.status}.`, retryable: typeof problem?.retryable === "boolean" ? problem.retryable : response.status >= 500 || response.status === 429, status: response.status, requestId: typeof problem?.request_id === "string" ? problem.request_id : responseRequestId, details: problem?.details ?? details });
      }
      return response;
    } catch (error) {
      if (timeout.signal.aborted && !init.signal?.aborted) throw new ApiClientError({ code: "request_timeout", message: "The backend took too long to respond. Try again.", retryable: true });
      throw normalizeApiError(error);
    }
    finally { window.clearTimeout(timer); }
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.response(path, init);
    try { return await response.json() as T; } catch (error) { throw normalizeApiError(error); }
  }
  async download(path: string, signal?: AbortSignal): Promise<Blob> {
    return (await this.response(path, { signal })).blob();
  }
}
