import { useEffect, useState } from "react";
import { normalizeApiError } from "../../api/client";
import { phase3Api, type SmtpConfiguration } from "../../api/phase3";
import { Button, Panel, StatusBadge } from "../../components/ui/core";

export function SmtpSettingsPanel() {
  const [configuration, setConfiguration] = useState<SmtpConfiguration | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [starttls, setStarttls] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [fromAddress, setFromAddress] = useState("");
  const [domains, setDomains] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const fill = (value: SmtpConfiguration) => {
    setConfiguration(value);
    setHost(value.host);
    setPort(String(value.port));
    setStarttls(value.starttls);
    setUsername(value.username);
    setFromAddress(value.from_address);
    setDomains(value.allowed_recipient_domains.join(", "));
    setPassword("");
    setClearPassword(false);
  };

  useEffect(() => {
    const controller = new AbortController();
    void phase3Api.emailDeliveryConfiguration(controller.signal).then(value => {
      if (!controller.signal.aborted) fill(value);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(normalizeApiError(reason).message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const parsedPort = Number(port);
  const validPort = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;
  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const value = await phase3Api.updateEmailDeliveryConfiguration({
        host: host.trim(), port: parsedPort, starttls, username: username.trim(),
        password: clearPassword || !password ? null : password,
        clear_password: clearPassword,
        from_address: fromAddress.trim(),
        allowed_recipient_domains: domains.split(/[\s,]+/).map(domain => domain.trim().toLowerCase()).filter(Boolean),
      });
      fill(value);
      setSaved(true);
    } catch (reason) {
      setError(normalizeApiError(reason).message);
    } finally {
      setSaving(false);
    }
  };

  return <section id="email-delivery" className="smtp-settings-anchor" aria-label="Email delivery settings">
    <Panel className="smtp-settings-panel" title="Email delivery">
      <div className="smtp-settings-intro"><div><p>Connect an SMTP server to send approved report emails. Settings take effect as soon as you save.</p><p>Use a verified sender address and list the recipient domains your team permits.</p></div><StatusBadge status={configuration?.configured ? "Configured" : "Setup needed"} /></div>
      {error && <div className="state-box" role="alert"><strong>Could not load or save email settings</strong><p>{error}</p></div>}
      {saved && <p className="smtp-settings-success" role="status">Email settings saved. {configuration?.configured ? "Delivery is configured; send a test report to verify the server accepts it." : "Complete the missing fields before sending."}</p>}
      {loading ? <p role="status">Loading email settings…</p> : <>
        <div className="smtp-settings-grid">
          <label>SMTP host<input className="input" value={host} onChange={event => setHost(event.target.value)} placeholder="smtp.example.com" autoComplete="off" /></label>
          <label>Port<input className="input" type="number" min={1} max={65535} value={port} onChange={event => setPort(event.target.value)} /></label>
          <label>Sender address<input className="input" type="email" value={fromAddress} onChange={event => setFromAddress(event.target.value)} placeholder="reports@example.com" autoComplete="off" /></label>
          <label>SMTP username<input className="input" value={username} onChange={event => setUsername(event.target.value)} placeholder="Optional if your server needs no login" autoComplete="off" /></label>
          <label>SMTP password<input className="input" aria-label="SMTP password" type="password" value={password} disabled={clearPassword} onChange={event => setPassword(event.target.value)} placeholder={configuration?.password_set ? "Saved password · leave blank to keep" : "Enter SMTP credential if required"} autoComplete="new-password" /><small>{configuration?.password_set ? "A password is saved on this computer. Enter a new one to replace it." : "Saved in the local backend .env file; never returned by the API."}</small></label>
          <label>Allowed recipient domains<input className="input" value={domains} onChange={event => setDomains(event.target.value)} placeholder="example.com, example.org" /><small>Comma separated. Only these domains can receive reports.</small></label>
        </div>
        <div className="smtp-settings-options">
          <label><input type="checkbox" checked={starttls} onChange={event => setStarttls(event.target.checked)} /> Use STARTTLS</label>
          {configuration?.password_set && <label><input type="checkbox" checked={clearPassword} onChange={event => { setClearPassword(event.target.checked); setPassword(""); }} /> Remove saved password</label>}
        </div>
        <div className="smtp-settings-footer"><Button variant="primary" disabled={saving || !validPort} onClick={() => void save()}>{saving ? "Saving…" : "Save email settings"}</Button><p>Configuration means the required fields are present. Send an approved test report to verify actual delivery.</p></div>
      </>}
    </Panel>
  </section>;
}
