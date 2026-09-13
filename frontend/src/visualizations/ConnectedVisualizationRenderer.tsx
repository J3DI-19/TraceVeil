import { useEffect, useState } from "react";
import { normalizeApiError } from "../api/client";
import { phase3Api, type ResolvedVisualization, type VisualizationLayout } from "../api/phase3";
import type { VisualizationSpec } from "../mocks/assistant";
import { DynamicVisualizationRenderer } from "./DynamicVisualizationRenderer";

function rendererSpec(value: ResolvedVisualization): VisualizationSpec {
  return {
    id: value.layout.layout_id,
    name: value.layout.title,
    description: "Resolved from persisted investigation data",
    evidenceRefs: Object.values(value.analysis_ids),
    components: value.layout.components.map(component => ({
      id: component.id,
      type: component.type,
      title: component.title,
      dataRef: component.id,
      span: component.span,
      height: component.height,
    })),
  };
}

export function ConnectedVisualizationRenderer({ layout, initial }: { layout?: VisualizationLayout | null; initial?: ResolvedVisualization | null }) {
  const [resolved, setResolved] = useState<ResolvedVisualization | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!layout) { setResolved(initial ?? null); return; }
    const controller = new AbortController(); setError(null); setResolved(null);
    void phase3Api.resolveVisualization(layout, controller.signal).then(setResolved).catch(reason => {
      if (!controller.signal.aborted) setError(normalizeApiError(reason).message);
    });
    return () => controller.abort();
  }, [layout, initial, retry]);
  if (error) return <div className="visualization-fallback" role="alert"><strong>Visualization unavailable</strong><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></div>;
  if (!resolved) return <div className="state-box" role="status"><strong>Resolving verified data</strong><p>Loading persisted visualization datasets…</p></div>;
  return <DynamicVisualizationRenderer specification={rendererSpec(resolved)} datasets={resolved.datasets}/>;
}
