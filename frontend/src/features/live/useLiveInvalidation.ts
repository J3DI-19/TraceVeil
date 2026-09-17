import { useEffect, useRef } from "react";
import { SseLiveDataSource, type ConnectionState } from "./SseLiveDataSource";
import type { StreamEnvelope, StreamReset, StreamTopic } from "../../api/phase3";

/**
 * Subscribe a case-scoped view to live invalidation signals.
 *
 * Step 7 delivered live updates only to Live Monitor, which left an
 * investigator working in the case workspace unaware of newly accepted
 * events until they navigated away and back. This hook exists so both
 * screens consume the same stream through the same parsing, rather than
 * each page growing its own copy.
 *
 * Two properties are deliberate:
 *
 * * **One connection per case and session.** `paused` and the handler are
 *   held in refs, so pausing the display or re-rendering with a new
 *   callback never tears down the stream and never resets the source's
 *   private `Last-Event-ID`. Only a change of case or session does that,
 *   because only then does the cursor belong to a different scope.
 * * **Signals carry identifiers, not records.** The handler is expected
 *   to refetch from the investigation API. Nothing here renders stream
 *   payloads, so a displayed chronology can never be assembled in the
 *   browser.
 */
export function useLiveInvalidation(options: {
  caseId: number | null;
  sessionId?: string | null;
  active?: boolean;
  topics?: StreamTopic[];
  paused?: boolean;
  /** Bound on frames buffered while paused; the oldest are dropped first. */
  maxQueued?: number;
  onMessage: (message: StreamEnvelope) => void;
  /** A `stream.reset` frame: the cursor could not be honoured and every
   *  named resource must be refetched from its authoritative API. */
  onReset?: (reset: StreamReset) => void;
  onState?: (state: ConnectionState) => void;
  onError?: (message: string) => void;
  onDrop?: (count: number) => void;
}) {
  const { caseId, sessionId, active = true, paused = false, maxQueued = 250 } = options;
  const handler = useRef(options.onMessage); handler.current = options.onMessage;
  const resetHandler = useRef(options.onReset); resetHandler.current = options.onReset;
  const dropHandler = useRef(options.onDrop); dropHandler.current = options.onDrop;
  const stateHandler = useRef(options.onState); stateHandler.current = options.onState;
  const errorHandler = useRef(options.onError); errorHandler.current = options.onError;
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const queued = useRef<StreamEnvelope[]>([]);
  const topicKey = (options.topics ?? []).join(",");

  useEffect(() => {
    // A queued frame belongs to the scope it arrived in. Carrying it
    // across a case or session change would flush one case's activity
    // into another's display, so the buffer is dropped on entry and on
    // exit rather than only on unmount.
    queued.current = [];
    if (!caseId || !active) return;
    const controller = new AbortController();
    const source = new SseLiveDataSource();
    void source.connect({
      caseId,
      sessionId: sessionId ?? undefined,
      topics: topicKey ? topicKey.split(",") : undefined,
      signal: controller.signal,
      onState: state => stateHandler.current?.(state),
      onError: message => errorHandler.current?.(message),
      onMessage: message => {
        // A reset says the cursor could not be honoured, so what is on
        // screen is already wrong. It is delivered immediately even while
        // paused - a paused display holding post-gap data is the failure
        // this signal exists to prevent - and anything queued behind it
        // predates the gap, so it is discarded rather than replayed.
        if (message.topic === "stream.reset") {
          queued.current = [];
          resetHandler.current?.((message.payload ?? {}) as unknown as StreamReset);
          return;
        }
        // Queueing happens here rather than in the effect's dependencies,
        // which is what lets pause be a display concern only.
        if (pausedRef.current) {
          queued.current.push(message);
          if (queued.current.length > maxQueued) { queued.current.shift(); dropHandler.current?.(1); }
          return;
        }
        handler.current(message);
      },
    });
    return () => { controller.abort(); queued.current = []; };
  }, [caseId, sessionId, active, topicKey, maxQueued]);

  /** Applies and clears anything buffered while the display was paused. */
  return {
    flush: () => { const pending = queued.current.splice(0); pending.forEach(message => handler.current(message)); return pending.length; },
    queuedCount: () => queued.current.length,
  };
}
