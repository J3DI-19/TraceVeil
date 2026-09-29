import { useEffect, useState } from "react";
import { normalizeApiError } from "../../api/client";
import { phase3Api, type EmailDraft, type ReportRecord } from "../../api/phase3";
import { Button, StatusBadge } from "../../components/ui/core";

const validRecipient = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && value.length <= 320;

export function ReportEmailPanel({ caseId, report }: { caseId: number; report: ReportRecord }) {
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [active, setActive] = useState<EmailDraft | null>(null);
  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState(report.title);
  const [body, setBody] = useState(`Attached is the approved ${report.title}.`);
  const [approver, setApprover] = useState("Local investigator");
  const [loading, setLoading] = useState(true);
  const [deliveryConfigured, setDeliveryConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void phase3Api.emailDeliveryStatus(controller.signal).then(status => {
      if (!controller.signal.aborted) setDeliveryConfigured(status.configured);
    }).catch(() => { /* The send endpoint remains the authority if this check is unavailable. */ });
    void phase3Api.emailDrafts(caseId, "report", report.report_id, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const items = Array.isArray(result.items) ? result.items : [];
      setDrafts(items);
      if (items[0]) {
        setActive(items[0]);
        setRecipient(items[0].recipient);
        setSubject(items[0].subject);
        setBody(items[0].body);
      }
    }).catch(reason => {
      if (!controller.signal.aborted) setError(normalizeApiError(reason).message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [caseId, report.report_id]);

  const select = (draft: EmailDraft | null) => {
    setActive(draft);
    setRecipient(draft?.recipient ?? "");
    setSubject(draft?.subject ?? report.title);
    setBody(draft?.body ?? `Attached is the approved ${report.title}.`);
    setConfirmSend(false);
    setError(null);
  };

  const run = async (operation: () => Promise<EmailDraft>) => {
    setBusy(true);
    setError(null);
    setConfirmSend(false);
    try {
      const result = await operation();
      setDrafts(current => [result, ...current.filter(item => item.draft_id !== result.draft_id)]);
      select(result);
    } catch (reason) {
      setError(normalizeApiError(reason).message);
    } finally {
      setBusy(false);
    }
  };

  const edited = Boolean(active) && (recipient !== active?.recipient || subject !== active?.subject || body !== active?.body);
  const locked = active?.status === "sent" || active?.status === "delivery_unknown";
  const valid = validRecipient(recipient.trim()) && subject.trim().length > 0 && subject.length <= 300 && body.trim().length > 0 && body.length <= 20000;
  const attachment = `traceveil-${report.report_id}.pdf`;

  return <section className="case-report-email" aria-labelledby="report-email-title">
    <header className="case-report-email-header">
      <div><span className="eyebrow">Final delivery</span><h4 id="report-email-title">Email this report</h4><p>Review the complete message and attached PDF. Sending requires a separate email approval.</p></div>
      {active && <StatusBadge status={active.status} />}
    </header>

    {error && <div className="state-box" role="alert"><strong>Email action failed</strong><p>{error === "smtp_not_configured" ? "Email delivery is not configured. Set the SMTP host and sender address before sending." : error}</p></div>}
    {deliveryConfigured === false && <div className="case-report-email-notice" role="status"><strong>Delivery setup needed</strong><p>You can prepare and approve this email, but sending is unavailable until the SMTP host, sender address, and recipient domain allowlist are configured.</p></div>}
    {loading ? <p role="status">Loading email drafts…</p> : <>
      {drafts.length > 0 && <div className="case-report-email-drafts" aria-label="Saved report emails">
        <span className="case-report-field-label">Saved emails</span>
        <div className="case-report-email-draft-list">
          {drafts.map(draft => <button key={draft.draft_id} type="button" className={`case-report-email-draft-choice ${active?.draft_id === draft.draft_id ? "selected" : ""}`} onClick={() => select(draft)} disabled={busy} aria-pressed={active?.draft_id === draft.draft_id}>
            <span>{draft.recipient}</span><StatusBadge status={draft.status} />
          </button>)}
          <Button disabled={busy} onClick={() => select(null)}>New email</Button>
        </div>
      </div>}

      <div className="case-report-email-layout">
        <div className="case-report-email-editor">
          <div className="case-report-email-subhead"><h5>{active ? "Edit message" : "Compose message"}</h5><p>{locked ? "This delivery record is read only." : "Changes to an approved email require a fresh approval."}</p></div>
          <label className="case-report-email-field">To<input className="input" type="email" value={recipient} disabled={busy || locked} onChange={event => { setRecipient(event.target.value); setConfirmSend(false); }} placeholder="recipient@example.com" /></label>
          <label className="case-report-email-field">Subject<input className="input" value={subject} maxLength={300} disabled={busy || locked} onChange={event => { setSubject(event.target.value); setConfirmSend(false); }} /></label>
          <label className="case-report-email-field">Message<textarea className="input" rows={8} value={body} maxLength={20000} disabled={busy || locked} onChange={event => { setBody(event.target.value); setConfirmSend(false); }} /></label>
          {edited && <p className="case-report-email-hint" role="status">Unsaved changes. Save before approving or sending.</p>}
          {!active ? <Button variant="primary" disabled={busy || !valid} onClick={() => void run(() => phase3Api.createEmailDraft(report.report_id, recipient.trim(), subject.trim(), body))}>Save email draft</Button> : !locked && <Button disabled={busy || !edited || !valid} onClick={() => void run(() => phase3Api.updateEmailDraft(active.draft_id, recipient.trim(), subject.trim(), body))}>Save changes</Button>}
        </div>

        <aside className="case-report-email-preview" aria-label="Email preview">
          <div className="case-report-email-preview-heading"><span className="eyebrow">Message preview</span>{edited && <span className="case-report-email-unsaved">Unsaved</span>}</div>
          <dl><dt>To</dt><dd>{recipient.trim() || "Add a recipient"}</dd><dt>Subject</dt><dd>{subject.trim() || "Add a subject"}</dd></dl>
          <div className="case-report-email-preview-body">{body || "Write a message"}</div>
          <div className="case-report-email-attachment"><span aria-hidden="true">▤</span><div><strong>{attachment}</strong><small>Approved PDF attachment</small></div></div>
        </aside>
      </div>

      {active && <div className="case-report-email-review">
        <div><h5>Approval and send</h5><p>{active.status === "sent" ? `Sent ${active.sent_at ?? "successfully"}.` : active.status === "delivery_unknown" ? "Delivery outcome is unknown. Check the recipient or mail server before creating another email." : "Approve the saved message, then confirm delivery to the recipient shown above."}</p></div>
        {!locked && <div className="case-report-email-actions">
          <label className="case-report-email-approver">Email approver<input className="input" value={approver} disabled={busy} onChange={event => setApprover(event.target.value)} /></label>
          <Button variant="primary" disabled={busy || edited || active.status !== "draft" || !approver.trim()} onClick={() => void run(() => phase3Api.approveEmail(active.draft_id, approver.trim()))}>Approve email</Button>
          <Button disabled={busy || edited || active.status !== "approved" || deliveryConfigured === false} onClick={() => setConfirmSend(true)}>Review send</Button>
        </div>}
        {active.delivery_error && <p role="alert">{active.delivery_error}</p>}
        {confirmSend && active.status === "approved" && !edited && <div className="case-report-email-confirm" role="group" aria-label="Confirm email delivery">
          <p>Send <strong>{active.subject}</strong> to <strong>{active.recipient}</strong> with <strong>{attachment}</strong> attached?</p>
          <div><Button variant="danger" disabled={busy} onClick={() => void run(() => phase3Api.sendEmail(active.draft_id))}>Send email</Button><Button disabled={busy} onClick={() => setConfirmSend(false)}>Keep draft</Button></div>
        </div>}
      </div>}
    </>}
  </section>;
}
