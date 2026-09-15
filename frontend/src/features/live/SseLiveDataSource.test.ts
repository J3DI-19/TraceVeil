import { describe, expect, it, vi } from "vitest";
import { SseLiveDataSource, type ConnectionState } from "./SseLiveDataSource";

describe("SseLiveDataSource", () => {
  it("parses typed envelopes, reports malformed messages, and cleans up on abort", async () => {
    const controller = new AbortController(); const states: ConnectionState[] = []; const messages: unknown[] = []; const errors: string[] = [];
    const encoded = new TextEncoder().encode('id: 42\nevent: event.accepted\ndata: {"schema_version":"1.0","id":42,"topic":"event.accepted","payload":{"event_id":"EV-42"}}\n\ndata: not-json\n\n');
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(encoded); } }), { status: 200 })));
    const source = new SseLiveDataSource();
    await source.connect({ caseId: 7, signal: controller.signal, onState: state => states.push(state), onMessage: message => { messages.push(message); controller.abort(); }, onError: message => errors.push(message) });
    expect(states).toEqual(["connecting", "connected", "disconnected"]);
    expect(messages).toEqual([expect.objectContaining({ id: 42, topic: "event.accepted" })]);
    expect(errors).toContain("A malformed stream message was ignored.");
  });

  it("reconnects after a dropped stream and resumes from the last id", async () => {
    // Step 7: a temporary disconnection must be survivable, and the retry
    // must carry Last-Event-ID so the backend replays strictly the frames
    // this client has not seen - no gap, no duplicate.
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const states: ConnectionState[] = [];
      const headers: (HeadersInit | undefined)[] = [];
      const frame = new TextEncoder().encode(
        'id: 7\nevent: event.accepted\ndata: {"schema_version":"1.0","id":7,"topic":"event.accepted"}\n\n',
      );
      let call = 0;
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        headers.push(init?.headers);
        call += 1;
        if (call === 1) {
          // Deliver one frame, then close the body to simulate a drop.
          return new Response(
            new ReadableStream({ start(stream) { stream.enqueue(frame); stream.close(); } }),
            { status: 200 },
          );
        }
        controller.abort();
        return new Response(new ReadableStream({ start(stream) { stream.close(); } }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const connected = new SseLiveDataSource().connect({
        caseId: 7, signal: controller.signal,
        onState: state => states.push(state), onMessage: () => undefined, onError: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await connected;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(states).toContain("reconnecting");
      expect(headers[0]).toBeUndefined();
      expect(headers[1]).toEqual({ "Last-Event-ID": "7" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops with a terminal error for non-retryable client responses", async () => {
    const states: ConnectionState[] = []; const errors: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    await new SseLiveDataSource().connect({ caseId: 7, signal: new AbortController().signal, onState: state => states.push(state), onMessage: () => undefined, onError: message => errors.push(message) });
    expect(states).toEqual(["connecting", "terminal-error"]);
    expect(errors[0]).toContain("401");
  });
});
