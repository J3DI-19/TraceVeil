import { normalizeApiError } from "../../api/client";
import type { StreamEnvelope } from "../../api/phase3";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "stale" | "disconnected" | "terminal-error";

export class SseLiveDataSource {
  private lastId = 0;
  async connect(options: { caseId: number; sessionId?: string; topics?: string[]; signal: AbortSignal; onState: (state: ConnectionState) => void; onMessage: (message: StreamEnvelope) => void; onError: (message: string) => void }) {
    let attempt = 0; options.onState("connecting");
    while (!options.signal.aborted) {
      try {
        const query = new URLSearchParams({ case_id: String(options.caseId) }); if (options.sessionId) query.set("session_id", options.sessionId); if (options.topics?.length) query.set("topics", options.topics.join(","));
        const response = await fetch(`/api/v1/live/stream?${query}`, { signal: options.signal, headers: this.lastId ? { "Last-Event-ID": String(this.lastId) } : undefined });
        if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
          options.onState("terminal-error"); options.onError(`Stream access failed with status ${response.status}.`); return;
        }
        if (!response.ok || !response.body) throw new Error(`Stream failed with status ${response.status}`);
        options.onState("connected"); attempt = 0;
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
        while (!options.signal.aborted) {
          const { value, done } = await reader.read(); if (done) throw new Error("Stream disconnected");
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); boundary = buffer.indexOf("\n\n");
            let data = ""; for (const line of block.split("\n")) { if (line.startsWith("id:")) this.lastId = Number(line.slice(3).trim()) || this.lastId; if (line.startsWith("data:")) data += line.slice(5).trim(); }
            if (data) { try { options.onMessage(JSON.parse(data) as StreamEnvelope); } catch { options.onError("A malformed stream message was ignored."); } }
          }
        }
      } catch (error) {
        if (options.signal.aborted) break;
        attempt += 1; options.onState(attempt > 8 ? "stale" : "reconnecting"); options.onError(normalizeApiError(error).message);
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)) * (0.8 + Math.random() * 0.4);
        await new Promise<void>((resolve, reject) => { const timer = window.setTimeout(resolve, delay); options.signal.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true }); }).catch(() => undefined);
      }
    }
    options.onState("disconnected");
  }
}
