import { useCallback, useEffect, useState } from "react";
import { phase3Api, type EmailDraft } from "../../api/phase3";
import { normalizeApiError } from "../../api/client";
import { Button, Input, StatusBadge } from "../../components/ui/core";

/**
 * Step 11 - notify about a deterministic alert or live incident.
 *
 * The same component serves both subjects because the backend treats them
 * identically: no report is required, no PDF is attached, and approval is
 * pinned to the artifact's own content hash, so re-analysis that changes
 * the alert or incident revokes an approval that was already given.
 *
 * The initial subject and body are composed by the backend from the
 * persisted artifact. This panel never invents notification text; it
 * shows what the backend wrote, lets the investigator edit it, and sends
 * only after an explicit approval step.
 */
export function ArtifactNotificationPanel({ caseId, subjectType, subjectId }: {
  caseId: number; subjectType: "alert" | "incident"; subjectId: string;
}) {
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [active, setActive] = useState<EmailDraft | null>(null);
  const [recipient, setRecipient] = useState("");
  const [approver, setApprover] = useState("Local investigator");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const select = useCallback((draft: EmailDraft | null) => {
    setActive(draft);
    setError(null);
    if (draft) { setRecipient(draft.recipient); setSubject(draft.subject); setBody(draft.body); }
  }, []);

  // Existing drafts are loaded on mount so a draft awaiting approval is
  // reopened rather than duplicated after a refresh or navigation.
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      phase3Api.emailDrafts(caseId, subjectType, subjectId, controller.signal),
      phase3Api.notificationPreview(caseId, subjectType, subjectId, controller.signal).catch(() => null),
    ]).then(([listed, composed]) => {
      if (controller.signal.aborted) return;
      setDrafts(listed.items);
      setPreview(composed ? `${composed.subject}\n\n${composed.body}` : "");
      select(listed.items[0] ?? null);
    }).catch(reason => { if (!controller.signal.aborted) setError(normalizeApiError(reason).message); });
    return () => controller.abort();
  }, [caseId, subjectType, subjectId, select]);

  const refresh = async (keep?: string) => {
    const listed = await phase3Api.emailDrafts(caseId, subjectType, subjectId);
    setDrafts(listed.items);
    select(listed.items.find(item => item.draft_id === keep) ?? listed.items[0] ?? null);
  };

  const run = async (operation: () => Promise<EmailDraft>) => {
    setBusy(true); setError(null);
    try { const result = await operation(); await refresh(result.draft_id); }
    catch (reason) { setError(normalizeApiError(reason).message); }
    finally { setBusy(false); }
  };

  const edited = Boolean(active) && (recipient !== active?.recipient || subject !== active?.subject || body !== active?.body);
  const label = subjectType === "alert" ? "alert" : "incident";

  return <section className="artifact-notification" aria-labelledby={`notify-${subjectId}`}>
    <header>
      <span className="eyebrow">Approval-gated notification</span>
      <h3 id={`notify-${subjectId}`}>Notify about this {label}</h3>
    </header>
    <p>
      Traceveil writes the initial message from this {label}'s persisted
      values. No report and no PDF are required. Nothing is sent until you
      approve it, and editing an approved draft revokes that approval.
    </p>
    {error && <div className="state-box" role="alert"><strong>Notification action failed</strong><p>{error}</p></div>}

    {drafts.length > 0 && <div className="filter-row" aria-label="Existing drafts">
      {drafts.map(draft => <button key={draft.draft_id} className={`link-button ${draft.draft_id === active?.draft_id ? "active" : ""}`} onClick={() => select(draft)}>
        {draft.recipient} <StatusBadge status={draft.status}/>
      </button>)}
      <Button disabled={busy} onClick={() => select(null)}>New draft</Button>
    </div>}

    {!active && <div className="filter-row">
      <Input ariaLabel="Notification recipient" placeholder="recipient@example.test" value={recipient} onChange={setRecipient}/>
      <Button variant="primary" disabled={busy || !recipient.trim()}
              onClick={() => void run(() => phase3Api.createArtifactEmailDraft(caseId, subjectType, subjectId, recipient.trim()))}>
        Create notification draft
      </Button>
    </div>}
    {!active && preview && <details className="raw-record-details">
      <summary>Preview the text Traceveil will write</summary>
      <pre className="notification-preview">{preview}</pre>
    </details>}

    {active && <div className="panel notification-controls">
      <div className="filter-row">
        <Input ariaLabel="Notification recipient" value={recipient} onChange={setRecipient}/>
        <StatusBadge status={active.status}/>
      </div>
      <label className="notification-field">
        <span>Subject</span>
        <input className="input" aria-label="Notification subject" value={subject}
               disabled={Boolean(active.sent_at)} onChange={event => setSubject(event.target.value)}/>
      </label>
      <label className="notification-field">
        <span>Message</span>
        <textarea className="input notification-body" aria-label="Notification message" rows={12}
                  value={body} disabled={Boolean(active.sent_at)}
                  onChange={event => setBody(event.target.value)}/>
      </label>
      <div className="filter-row">
        <Button disabled={busy || !edited || Boolean(active.sent_at)}
                onClick={() => void run(() => phase3Api.updateEmailDraft(active.draft_id, recipient.trim(), subject, body))}>
          Save edits
        </Button>
        <Input ariaLabel="Notification approver" value={approver} onChange={setApprover}/>
        <Button variant="primary" disabled={busy || edited || active.status !== "draft" || !approver.trim()}
                onClick={() => void run(() => phase3Api.approveEmail(active.draft_id, approver.trim()))}>
          Approve notification
        </Button>
        <Button variant="danger" disabled={busy || edited || active.status !== "approved"}
                onClick={() => void run(() => phase3Api.sendEmail(active.draft_id))}>
          Confirm and send
        </Button>
      </div>
      {edited && <p className="notification-hint">Unsaved edits. Save them before approving.</p>}
      {active.delivery_error && <p role="alert">{active.delivery_error}</p>}
      {active.sent_at && <p className="notification-hint">Sent {active.sent_at}. A sent notification cannot be edited or resent.</p>}
    </div>}
  </section>;
}
