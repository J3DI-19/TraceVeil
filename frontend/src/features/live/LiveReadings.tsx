import type { DeviceState } from "../../api/phase3";
import { StatusBadge } from "../../components/ui/core";

const metricNames: Record<string, { label: string; unit: string }> = {
  temperature_c: { label: "Temperature", unit: "°C" },
  humidity_pct: { label: "Humidity", unit: "%" },
};

export function metricLabel(key: string) {
  return metricNames[key]?.label ?? key.replace(/_/g, " ");
}

export function metricValue(key: string, value: unknown) {
  if (value === null || value === undefined) return "—";
  const display = typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
    : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  return `${display}${metricNames[key] ? ` ${metricNames[key].unit}` : ""}`;
}

export function measurementEntries(values: Record<string, unknown>) {
  const order = ["temperature_c", "humidity_pct"];
  const priority = (key: string) => order.includes(key) ? order.indexOf(key) : order.length;
  return Object.entries(values).filter(([key]) => !["sequence", "capture_transport", "timestamp_source"].includes(key))
    .sort(([left], [right]) => priority(left) - priority(right));
}

export function inputMetrics(event: Record<string, unknown>): Record<string, unknown> {
  const raw = event.raw_record as Record<string, unknown> | undefined;
  const values = raw?.metrics ?? event.attributes;
  return values && typeof values === "object" && !Array.isArray(values) ? values as Record<string, unknown> : {};
}

export function readingTime(value: unknown) {
  if (!value) return "Not received yet";
  const date = new Date(String(value));
  return Number.isNaN(date.valueOf()) ? String(value) : `${date.toISOString().slice(11, 19)} UTC`;
}

export function deviceStatusLabel(device: DeviceState) {
  if (device.connection_state === "offline") return "Offline";
  if (device.connection_state === "stale") return "Stale";
  if (device.connection_state === "online") return "Online";
  return device.stale ? "Stale" : "Online";
}

export function LiveReadings({ devices }: { devices: DeviceState[] }) {
  return <section className="monitor-readings" aria-label="Latest sensor readings">
    <div className="monitor-section-heading"><div><span className="eyebrow">Live input</span><h2>Latest readings</h2></div><span>Updated as readings arrive</span></div>
    {devices.length ? <div className="monitor-sensor-grid" style={devices.filter(device => device.source_id !== "traceveil-simulator").length <= 1 ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}>{devices.map(device => {
      if (device.source_id === "traceveil-simulator") return <article className="monitor-simulation-device" key={`${device.session_id}-${device.device_id}`}><div><strong>Alert simulation</strong><p>Login-failure test · {device.device_id}</p></div><StatusBadge status="Simulated"/></article>;
      const values = measurementEntries(device.latest_metrics);
      const status = deviceStatusLabel(device);
      return <article className={`monitor-sensor-card sensor-${status.toLowerCase()}`} key={`${device.session_id}-${device.device_id}`}>
        <header><div><h3>{device.device_id}</h3>{device.source_id !== device.device_id && <p>{device.source_id}</p>}</div><StatusBadge status={status}/></header>
        <dl className="monitor-values">{values.length ? values.map(([key, value]) => <div key={key} className={key === "temperature_c" ? "reading-temperature" : key === "humidity_pct" ? "reading-humidity" : ""}><dt>{metricLabel(key)}</dt><dd>{metricValue(key, value)}</dd></div>) : <div><dt>Measurements</dt><dd className="monitor-no-value">Waiting for input</dd></div>}</dl>
        <footer><span title={device.last_observed_at}>{device.latest_metrics.capture_transport === "usb" ? "Received" : "Measured"} {readingTime(device.last_observed_at)}</span><span>{device.event_count.toLocaleString()} inputs saved</span></footer>
        {status !== "Online" && <p className="monitor-sensor-warning">{status === "Stale" ? "No recent input. Showing the last saved reading." : "Device reported a disconnected link. Showing the last saved reading."}</p>}
      </article>;
    })}</div> : <div className="monitor-empty"><strong>Waiting for sensor input</strong><p>Power on your device with capture running. Its readings will appear here.</p></div>}
  </section>;
}
