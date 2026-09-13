import { useEffect, useState, type DragEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { InvestigationTimeline, RiskBreakdown } from "../components/traceveil/domain";
import { MetricCard, RiskBadge, SeverityBadge } from "../components/ui/core";
import { visualizationDatasets, type VisualizationComponentSpec, type VisualizationSpec } from "../mocks/assistant";
import type { Severity, TimelineEntry } from "../types/domain";

const tooltipStyle = { background: "#0b1322", border: "1px solid #21304a", borderRadius: 8, color: "#dce8f7", fontSize: 11 };
type RendererProps = { data: unknown; spec: VisualizationComponentSpec };
type ChartRow = Record<string, string | number>;

function Metric({ data, spec }: RendererProps) {
  const item = data as { value: string; detail: string; tone?: "danger" | "cyan" };
  return <MetricCard label={spec.title} value={item.value} detail={item.detail} tone={item.tone}/>;
}

function MultiBar({ data }: RendererProps) {
  const rows = data as ChartRow[]; const keys = Object.keys(rows[0] || {}).filter(k => k !== "label");
  return <div className="dynamic-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={rows}><CartesianGrid stroke="#18253a" vertical={false}/><XAxis dataKey="label" stroke="#63738a" tickLine={false}/><YAxis stroke="#63738a" tickLine={false}/><Tooltip contentStyle={tooltipStyle}/>{keys.map((key,index)=><Bar key={key} dataKey={key} fill={["#27c2e8","#3869e8","#8866f2"][index]} radius={[5,5,0,0]}/>)}</BarChart></ResponsiveContainer></div>;
}

function ActivityArea({ data }: RendererProps) {
  return <div className="dynamic-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data as ChartRow[]}><defs><linearGradient id="areaEvents" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#27c2e8" stopOpacity=".4"/><stop offset="1" stopColor="#27c2e8" stopOpacity="0"/></linearGradient></defs><CartesianGrid stroke="#18253a" vertical={false}/><XAxis dataKey="label" stroke="#63738a" tickLine={false}/><YAxis stroke="#63738a" tickLine={false}/><Tooltip contentStyle={tooltipStyle}/><Area type="monotone" dataKey="Events" stroke="#27c2e8" fill="url(#areaEvents)" strokeWidth={2}/><Area type="monotone" dataKey="Alerts" stroke="#fb5f68" fill="transparent" strokeWidth={2}/></AreaChart></ResponsiveContainer></div>;
}

function Distribution({ data }: RendererProps) {
  const rows = data as { name: string; value: number; color: string }[];
  return <div className="dynamic-pie"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={rows} dataKey="value" nameKey="name" innerRadius={38} outerRadius={62} paddingAngle={3}>{rows.map(row=><Cell key={row.name} fill={row.color}/>)}</Pie><Tooltip contentStyle={tooltipStyle}/></PieChart></ResponsiveContainer><div className="mini-legend">{rows.map(row=><span key={row.name}><i style={{background:row.color}}/>{row.name} <b>{row.value}%</b></span>)}</div></div>;
}

function SeverityDistribution({ data }: RendererProps) {
  const rows = data as { name: string; value: number; color: string }[];
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return <div className="dynamic-pie"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={rows} dataKey="value" nameKey="name" innerRadius={38} outerRadius={62} paddingAngle={3}>{rows.map(row=><Cell key={row.name} fill={row.color}/>)}</Pie><Tooltip contentStyle={tooltipStyle} formatter={(value) => [`${value} finding${Number(value) === 1 ? "" : "s"}`, "Count"]}/></PieChart></ResponsiveContainer><div className="mini-legend" aria-label="Finding severity distribution">{rows.map(row=><span key={row.name}><i style={{background:row.color}}/>{row.name} <b>{row.value} · {total ? Math.round(row.value / total * 100) : 0}%</b></span>)}</div></div>;
}

function TopEntities({ data }: RendererProps) {
  const rows = data as { id:string; label:string; kind:string; eventCount:number; maximumRisk:number }[];
  return <div className="top-entities" aria-label="Top entities ranking">{rows.map((row, index)=><div className="top-entity" key={row.id}><b>{index + 1}</b><div><span>{row.label}</span><small>{row.kind} · {row.eventCount.toLocaleString("en-US")} event{row.eventCount === 1 ? "" : "s"}</small><i><em style={{width:`${row.maximumRisk}%`}}/></i></div><RiskBadge score={row.maximumRisk}/></div>)}</div>;
}

function TopFindings({ data }: RendererProps) {
  const rows = data as { id:string; title:string; summary:string; severity:Severity; risk:number; confidence:number; entity:string; eventCount:number }[];
  return <div className="top-findings" aria-label="Top findings ranking">{rows.map((row, index)=><article key={row.id}><b>{index + 1}</b><div><header><span>{row.title}</span><code>{row.entity}</code></header><p>{row.summary}</p><small>{row.eventCount.toLocaleString("en-US")} supporting event{row.eventCount === 1 ? "" : "s"} · {row.confidence}% confidence</small></div><div><SeverityBadge severity={row.severity}/><RiskBadge score={row.risk}/></div></article>)}</div>;
}

function EvidenceTable({ data }: RendererProps) {
  const rows = data as { id:string; time:string; device:string; event:string; severity:Severity }[];
  return <div className="dynamic-table-wrap"><table className="dynamic-table"><thead><tr><th>Time</th><th>Evidence</th><th>Device</th><th>Event</th><th>Severity</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td><code>{row.time}</code></td><td><code>{row.id}</code></td><td>{row.device}</td><td>{row.event}</td><td><SeverityBadge severity={row.severity}/></td></tr>)}</tbody></table></div>;
}

function AlertList({ data }: RendererProps) {
  const rows = data as { id:string; time:string; title:string; severity:Severity; risk:number; status:string }[];
  return <div className="dynamic-table-wrap"><table className="dynamic-table"><thead><tr><th>Time</th><th>Alert</th><th>Severity</th><th>Risk</th><th>Status</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td><code>{row.time}</code></td><td>{row.title}</td><td><SeverityBadge severity={row.severity}/></td><td><RiskBadge score={row.risk}/></td><td>{row.status}</td></tr>)}</tbody></table></div>;
}

function Timeline({ data }: RendererProps) { return <div className="dynamic-timeline"><InvestigationTimeline entries={data as TimelineEntry[]}/></div>; }

function Summary({ data }: RendererProps) {
  const item = data as { lead:string; text:string; refs:string[] };
  return <div className="visual-summary"><span>✓ {item.lead}</span><p>{item.text}</p><div>{item.refs.map(ref=><code key={ref}>{ref}</code>)}</div></div>;
}

function Finding({ data }: RendererProps) {
  const item = data as { id:string; title:string; severity:Severity; score:number; text:string };
  return <div className="visual-finding"><div><code>{item.id}</code><SeverityBadge severity={item.severity}/></div><h4>{item.title}</h4><p>{item.text}</p><RiskBadge score={item.score}/></div>;
}

function Risk({ data }: RendererProps) { return <RiskBreakdown factors={data as {label:string;value:number}[]}/>; }

function DeviceGraph({ data }: RendererProps) {
  const graph = data as { nodes:{id:string;label:string;kind:string;x:number;y:number}[]; edges:{from:string;to:string;label:string}[] };
  const node = (id:string) => graph.nodes.find(n => n.id === id)!;
  return <div className="dynamic-graph"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Correlation graph">{graph.edges.map(edge=>{const from=node(edge.from),to=node(edge.to);return <g key={`${edge.from}-${edge.to}`}><line x1={from.x+6} y1={from.y} x2={to.x} y2={to.y} /><text x={(from.x+to.x)/2} y={(from.y+to.y)/2-2}>{edge.label}</text></g>})}</svg>{graph.nodes.map(n=><div key={n.id} className={`graph-chip graph-${n.kind}`} style={{left:`${n.x}%`,top:`${n.y}%`}}><i/>{n.label}<small>{n.kind}</small></div>)}</div>;
}

const dynamicVisualizationRegistry: Record<string, (props: RendererProps) => React.JSX.Element> = {
  "metric-card": Metric, "bar-chart": MultiBar, "line-chart": ActivityArea, "area-chart": ActivityArea, "pie-chart": Distribution,
  "evidence-table": EvidenceTable, "investigation-timeline": Timeline, "device-graph": DeviceGraph,
  "finding-panel": Finding, "risk-breakdown": Risk, "text-summary": Summary,
  "timeline": Timeline, "risk_breakdown": Risk, "event_activity": ActivityArea,
  "severity_distribution": SeverityDistribution, "entity_graph": DeviceGraph, "evidence_table": EvidenceTable, "alert_list": AlertList,
  "top_entities": TopEntities, "top_findings": TopFindings,
};

const visualIcons: Record<string, string> = {
  timeline: "⌁", event_activity: "⌇", severity_distribution: "◒",
  entity_graph: "⌘", top_entities: "◇", top_findings: "✦",
};

function DragHandleIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="5" cy="4" r="1"/><circle cx="11" cy="4" r="1"/><circle cx="5" cy="8" r="1"/><circle cx="11" cy="8" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="11" cy="12" r="1"/></svg>;
}

function ZoomIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3H3v3M10 3h3v3M6 13H3v-3M10 13h3v-3"/></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m4 4 8 8M12 4l-8 8"/></svg>;
}

function VisualizationFallback({ spec, reason }: { spec: VisualizationComponentSpec; reason: "unknown-component" | "missing-data" }) {
  return <div className="visualization-fallback" role="status"><span>◇</span><strong>Visualization unavailable</strong><p>{reason === "unknown-component" ? `“${spec.type}” is not in the approved registry.` : `Dataset “${spec.dataRef}” could not be resolved.`}</p></div>;
}

export function DynamicVisualizationRenderer({ specification, datasets = visualizationDatasets }: { specification: VisualizationSpec; datasets?: Record<string, unknown> }) {
  const componentKey = specification.components.map(component => component.id).join("|");
  const [order, setOrder] = useState(() => specification.components.map(component => component.id));
  const [hidden, setHidden] = useState<string[]>([]);
  const [dragged, setDragged] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  useEffect(() => {
    const availableIds = specification.components.map(component => component.id);
    setOrder(current => [...current.filter(id => availableIds.includes(id)), ...availableIds.filter(id => !current.includes(id))]);
    setHidden(current => current.filter(id => availableIds.includes(id)));
    setDragged(null);
    setFocused(current => current && availableIds.includes(current) ? current : null);
  }, [specification.id, componentKey]);
  const ordered = order.map(id => specification.components.find(component => component.id === id)).filter((component): component is VisualizationComponentSpec => Boolean(component));
  const visible = ordered.filter(component => !hidden.includes(component.id));
  const move = (sourceId: string, targetId: string) => setOrder(current => {
    const source = current.indexOf(sourceId); const target = current.indexOf(targetId);
    if (source < 0 || target < 0 || source === target) return current;
    const next = [...current]; const [item] = next.splice(source, 1); next.splice(target, 0, item); return next;
  });
  const moveByKeyboard = (id: string, direction: -1 | 1) => setOrder(current => {
    const source = current.indexOf(id); const target = source + direction;
    if (source < 0 || target < 0 || target >= current.length) return current;
    const next = [...current]; [next[source], next[target]] = [next[target], next[source]]; return next;
  });
  const handleDragStart = (event: DragEvent<HTMLElement>, id: string) => { setDragged(id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); };
  const handleDrop = (event: DragEvent<HTMLElement>, targetId: string) => { event.preventDefault(); const sourceId = dragged ?? event.dataTransfer.getData("text/plain"); if (sourceId) move(sourceId, targetId); setDragged(null); };
  const handleHandleKey = (event: KeyboardEvent<HTMLElement>, id: string) => { if (!event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); moveByKeyboard(id, event.key === "ArrowLeft" ? -1 : 1); };
  useEffect(() => {
    if (!focused) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setFocused(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [focused]);
  const focusedSpec = focused ? specification.components.find(component => component.id === focused) ?? null : null;
  const renderVisual = (spec: VisualizationComponentSpec) => {
    const Component = dynamicVisualizationRegistry[spec.type]; const data = datasets[spec.dataRef];
    return !Component ? <VisualizationFallback spec={spec} reason="unknown-component"/> : data === undefined ? <VisualizationFallback spec={spec} reason="missing-data"/> : <Component data={data} spec={spec}/>;
  };
  if (!visible.length) return <div className="visual-empty-canvas" role="status"><span>◇</span><strong>Visual canvas cleared</strong><p>Restore the closed cards whenever you need them.</p><button type="button" onClick={() => setHidden([])}>Restore {hidden.length} visual{hidden.length === 1 ? "" : "s"}</button></div>;
  return <><div className="visual-layout-shell">{hidden.length > 0 && <div className="visual-layout-toolbar"><span>{hidden.length} closed visual{hidden.length === 1 ? "" : "s"}</span><button type="button" onClick={() => setHidden([])}>Restore closed</button></div>}<div className={`dynamic-layout ${visible.length === 1 ? "dynamic-layout-single" : ""}`} key={specification.id}>{visible.map(spec => <section className={`visual-panel visual-span-${spec.span || 1} visual-height-${spec.height || "standard"} ${dragged === spec.id ? "visual-panel-dragging" : ""}`} key={spec.id} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={event => handleDrop(event, spec.id)}><header draggable onDragStart={event => handleDragStart(event, spec.id)} onDragEnd={() => setDragged(null)} onKeyDown={event => handleHandleKey(event, spec.id)} tabIndex={0} aria-label={`Move ${spec.title} visual. Use Alt plus arrow keys to reorder.`}><div className="visual-title-group"><b className="visual-title-icon" aria-hidden="true">{visualIcons[spec.type] ?? "◇"}</b><div><span>Verified data view</span><h3>{spec.title}</h3></div></div><div className="visual-panel-actions"><code>{spec.type.replaceAll("_", " ")}</code><span className="visual-drag-grip" title="Drag to reorder"><DragHandleIcon/></span><button className="visual-zoom" type="button" draggable={false} aria-label={`Enlarge ${spec.title} visual`} title="Enlarge visual" onClick={event => { event.stopPropagation(); setFocused(spec.id); }}><ZoomIcon/></button><button className="visual-close" type="button" draggable={false} aria-label={`Close ${spec.title} visual`} title="Close visual" onClick={event => { event.stopPropagation(); setHidden(current => [...current, spec.id]); }}><CloseIcon/></button></div></header><div className="visual-panel-body">{renderVisual(spec)}</div></section>)}</div></div>{focusedSpec && createPortal(<div className="visual-focus-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) setFocused(null); }}><section className="visual-focus-dialog" role="dialog" aria-modal="true" aria-labelledby={`visual-focus-title-${focusedSpec.id}`}><header><div className="visual-title-group"><b className="visual-title-icon" aria-hidden="true">{visualIcons[focusedSpec.type] ?? "◇"}</b><div><span>Focused investigation view</span><h2 id={`visual-focus-title-${focusedSpec.id}`}>{focusedSpec.title}</h2></div></div><button className="visual-focus-close" type="button" aria-label={`Close ${focusedSpec.title} preview`} title="Close preview" autoFocus onClick={() => setFocused(null)}><CloseIcon/></button></header><div className="visual-focus-body">{renderVisual(focusedSpec)}</div></section></div>, document.body)}</>;
}
