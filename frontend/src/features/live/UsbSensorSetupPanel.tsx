import { useEffect, useRef, useState } from "react";
import type { ApiCase } from "../../api/batch";
import { normalizeApiError } from "../../api/client";
import { usbSensorApi, type UsbSensorStatus } from "../../api/usbSensor";
import { Button } from "../../components/ui/core";

export function UsbSensorSetupPanel({ cases, onReady }: { cases: ApiCase[]; onReady: (caseId: number, sessionId: string) => void }) {
  const [target, setTarget] = useState("new");
  const [name, setName] = useState(() => `ESP32 DHT22 · ${new Date().toLocaleDateString("en-GB")}`);
  const [port, setPort] = useState("");
  const [ports, setPorts] = useState<{ port: string; description: string }[]>([]);
  const [status, setStatus] = useState<UsbSensorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ready = useRef(onReady); ready.current = onReady;
  const shownSession = useRef<string | null>(null);
  const accept = (next: UsbSensorStatus) => {
    if (!next?.state) return;
    setStatus(next);
    if (next.state === "capturing" && next.case_id && next.session_id && shownSession.current !== next.session_id) {
      shownSession.current = next.session_id;
      ready.current(next.case_id, next.session_id);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await usbSensorApi.status(controller.signal); if (!controller.signal.aborted) accept(next); }
      catch { /* The main connection banner handles backend availability. */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1200);
    };
    void poll();
    void usbSensorApi.ports(controller.signal).then(result => { if (!controller.signal.aborted) setPorts(result.items ?? []); }).catch(() => {});
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const busy = submitting || Boolean(status && ["connecting", "flashing", "waiting", "capturing"].includes(status.state));
  const start = async () => {
    if (busy) return;
    setSubmitting(true); setError(null);
    try { accept(await usbSensorApi.start(target === "new" ? null : Number(target), name.trim() || "ESP32 DHT22 USB capture", port || null)); }
    catch (reason) { setError(normalizeApiError(reason).message); }
    finally { setSubmitting(false); }
  };
  const detect = async () => {
    try { const result = await usbSensorApi.ports(); setPorts(result.items); setPort(""); setError(result.items.length ? null : "No ESP32 found. Connect its USB data cable, then try again."); }
    catch (reason) { setError(normalizeApiError(reason).message); }
  };
  return <section className={`usb-sensor-setup ${status?.state === "capturing" ? "is-capturing" : ""}`} aria-label="USB sensor setup">
    <div className="usb-setup-heading"><div><span className="eyebrow">Plug in & start</span><h2>USB sensor setup</h2><p>ESP32 + DHT22 · no Wi-Fi setup needed</p></div><span className="usb-port-label">{status?.port ?? (ports.length === 1 ? ports[0].port : "USB data cable")}</span></div>
    {!busy && <div className="usb-setup-controls">
      <label>Save readings to<select aria-label="USB capture case" value={target} onChange={event => setTarget(event.target.value)}><option value="new">Create a new case</option>{cases.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {target === "new" && <label>Case name<input aria-label="USB case name" value={name} maxLength={200} onChange={event => setName(event.target.value)}/></label>}
      {ports.length > 1 && <label>USB board<select aria-label="USB board port" value={port} onChange={event => setPort(event.target.value)}><option value="">Select a board</option>{ports.map(item => <option key={item.port} value={item.port}>{item.port} · {item.description}</option>)}</select></label>}
      <Button variant="primary" disabled={target === "new" && !name.trim()} onClick={start}>Connect & start</Button><Button onClick={detect}>Detect USB</Button>
    </div>}
    <p className="usb-setup-status" role="status">{error ?? status?.message ?? "Connect your board, choose a case and click Connect & start."}{status?.state === "capturing" && ` ${status.readings.toLocaleString()} readings received.`}</p>
    {busy && <div className="usb-setup-running"><span>{status?.state === "capturing" ? "Capture continues when you switch pages. Keep USB connected." : "Keep the board plugged in. First setup may take a minute."}</span><Button onClick={async () => { try { accept(await usbSensorApi.stop()); } catch (reason) { setError(normalizeApiError(reason).message); } }}>Stop USB capture</Button></div>}
    {!busy && <p className="usb-setup-note">First use installs USB capture firmware. OUT must be wired to GPIO 4. Times use this laptop’s UTC clock. Moving to another case ends the board’s previous capture.</p>}
  </section>;
}
