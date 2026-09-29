import { useEffect, useState } from "react";
import { phase3Api, type EmailDraft, type ReportRecord } from "../api/phase3";
import { normalizeApiError } from "../api/client";
import { Button, Input, StatusBadge } from "../components/ui/core";

export function ConnectedReportsPanel({ caseId }: { caseId: number }) {
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [selected, setSelected] = useState<ReportRecord | null>(null);
  const [title, setTitle] = useState("Investigation report");
  const [approver, setApprover] = useState("Local investigator");
  const [recipient, setRecipient] = useState("");
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ reportId: string; url: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState(false);

  const refresh = async () => {
    const result = await phase3Api.reports(caseId);
    const items = Array.isArray(result.items) ? result.items : [];
    setReports(items);
    setSelected(current => items.find(item => item.report_id === current?.report_id) ?? items[0] ?? null);
  };

  useEffect(() => {
    const controller = new AbortController();
    void phase3Api.reports(caseId, controller.signal).then(result => {
      const items = Array.isArray(result.items) ? result.items : [];
      setReports(items);
      setSelected(items[0] ?? null);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(normalizeApiError(reason).message);
    });
    return () => controller.abort();
  }, [caseId]);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!selected || selected.status === "draft") return;
    const controller = new AbortController();
    let url: string | null = null;
    void phase3Api.downloadReport(selected.report_id, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      setPreview({ reportId: selected.report_id, url });
    }).catch(reason => {
      if (!controller.signal.aborted) setPreviewError(normalizeApiError(reason).message);
    });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [selected?.report_id, selected?.status, selected?.content_hash]);

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await operation(); await refresh(); }
    catch (reason) { setError(normalizeApiError(reason).message); }
    finally { setBusy(false); }
  };

  const download = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await phase3Api.downloadReport(selected.report_id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${selected.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "report"}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) { setError(normalizeApiError(reason).message); }
    finally { setBusy(false); }
  };

  const createDraft = async () => {
    if (!selected || !recipient) return;
    setBusy(true);
    setError(null);
    try { setDraft(await phase3Api.createEmailDraft(selected.report_id, recipient, selected.title, `Attached is the approved ${selected.title}.`)); }
    catch (reason) { setError(normalizeApiError(reason).message); }
    finally { setBusy(false); }
  };

  const cancelReport = async () => {
    if (!selected || selected.status !== "generated") return;
    setBusy(true);
    setError(null);
    try {
      await phase3Api.cancelReport(selected.report_id);
      setCancelPending(false);
      setDraft(null);
      await refresh();
    } catch (reason) { setError(normalizeApiError(reason).message); }
    finally { setBusy(false); }
  };

  return <section className="table-panel case-report-panel" aria-labelledby="reports-title">
    <div className="panel-head case-report-header">
      <div>
        <span className="eyebrow">Controlled delivery</span>
        <h2 id="reports-title">Report delivery</h2>
        <p>Create a report from this investigation, then review and approve it before download or email.</p>
      </div>
    </div>

    {error && <div className="state-box case-report-error" role="alert"><strong>Report action failed</strong><p>{error}</p></div>}

    <div className="case-report-body">
      <section className="case-report-create" aria-labelledby="create-report-title">
        <div className="case-report-section-heading">
          <span className="case-report-step">01</span>
          <div><h3 id="create-report-title">Create a draft</h3><p>Give the report a clear name. You can generate its PDF after creation.</p></div>
        </div>
        <div className="case-report-create-fields">
          <label htmlFor="case-report-title">Report title</label>
          <div className="case-report-input-row">
            <input id="case-report-title" className="input" value={title} onChange={event => setTitle(event.target.value)} />
            <Button variant="primary" disabled={busy || !title.trim()} onClick={() => run(() => phase3Api.createReport(caseId, title.trim()))}>Create report</Button>
          </div>
        </div>
      </section>

      <section className="case-report-list" aria-labelledby="case-report-list-title">
        <div className="case-report-section-heading">
          <span className="case-report-step">02</span>
          <div><h3 id="case-report-list-title">Case reports</h3><p>Select a report to generate, approve, or deliver.</p></div>
          {reports.length > 0 && <span className="case-report-count">{reports.length} {reports.length === 1 ? "report" : "reports"}</span>}
        </div>
        {reports.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Report</th><th>Status</th><th>Hash</th></tr></thead><tbody>{reports.map(report => <tr key={report.report_id} className={selected?.report_id === report.report_id ? "selected" : ""}><td><button className="link-button" onClick={() => { setSelected(report); setDraft(null); setCancelPending(false); }}>{report.title}</button></td><td><StatusBadge status={report.status}/></td><td><code>{report.content_hash?.slice(0, 16) ?? "Not generated"}</code></td></tr>)}</tbody></table></div> : <div className="case-report-empty"><span className="case-report-empty-icon" aria-hidden="true">▤</span><strong>No reports yet</strong><p>Create a draft when the investigation is ready for review.</p></div>}
      </section>

      {selected && <section className="case-report-workflow" aria-labelledby="case-report-selected-title">
        <div className="case-report-section-heading">
          <span className="case-report-step">03</span>
          <div><h3 id="case-report-selected-title">{selected.title}</h3><p>Report ID <code>{selected.report_id}</code></p></div>
          <StatusBadge status={selected.status}/>
        </div>
        <div className="case-report-action-grid">
          <div className="case-report-action"><h4>Generate PDF</h4><p>Build the PDF from the saved investigation.</p><Button disabled={busy} onClick={() => run(() => phase3Api.generateReport(selected.report_id))}>Generate PDF</Button></div>
          <div className="case-report-action"><h4>Approve report</h4><p>Record who reviewed the generated PDF.</p><span className="case-report-field-label">Approver</span><Input ariaLabel="Report approver" value={approver} onChange={setApprover}/><Button variant="primary" disabled={busy || selected.status !== "generated" || !approver.trim()} onClick={() => run(() => phase3Api.approveReport(selected.report_id, approver.trim()))}>Approve report</Button></div>
          <div className="case-report-action"><h4>Download</h4><p>Available after report approval.</p><Button disabled={busy || selected.status !== "approved"} onClick={download}>Download approved PDF</Button></div>
        </div>
        {selected.status !== "draft" && <div className="case-report-preview" aria-label="Generated report preview">
          <div className="case-report-preview-head"><div><h4>PDF preview</h4><p>Review the generated report before approval.</p></div>{selected.status === "generated" && <Button variant="danger" disabled={busy} onClick={() => setCancelPending(true)}>Cancel report</Button>}</div>
          {cancelPending && selected.status === "generated" && <div className="case-report-cancel" role="group" aria-label="Confirm report cancellation"><p>Delete “{selected.title}” and its generated PDF? This cannot be undone.</p><div><Button variant="danger" disabled={busy} onClick={cancelReport}>Delete report</Button><Button disabled={busy} onClick={() => setCancelPending(false)}>Keep report</Button></div></div>}
          {preview?.reportId === selected.report_id ? <iframe title={`Preview of ${selected.title}`} src={`${preview.url}#toolbar=0`} /> : <div className="case-report-preview-state" role="status">{previewError ? `Preview unavailable: ${previewError}` : "Loading PDF preview…"}</div>}
        </div>}
        {selected.status === "approved" && <div className="case-report-email"><div><h4>Email delivery</h4><p>Create and approve an email draft before confirming send.</p></div><div className="case-report-email-fields"><span className="case-report-field-label">Recipient email</span><div className="case-report-input-row"><Input ariaLabel="Recipient email" placeholder="recipient@example.test" value={recipient} onChange={setRecipient}/><Button disabled={busy || !recipient} onClick={createDraft}>Create email draft</Button></div></div>{draft && <div className="case-report-email-draft"><strong>Email draft: {draft.status}</strong><p>{draft.recipient} · {draft.subject}</p><div className="case-report-email-actions"><Button disabled={busy || draft.status !== "draft"} onClick={async () => { setBusy(true); try { setDraft(await phase3Api.approveEmail(draft.draft_id, approver)); } catch (reason) { setError(normalizeApiError(reason).message); } finally { setBusy(false); } }}>Approve email</Button><Button variant="danger" disabled={busy || draft.status !== "approved"} onClick={async () => { setBusy(true); try { setDraft(await phase3Api.sendEmail(draft.draft_id)); } catch (reason) { setError(normalizeApiError(reason).message); } finally { setBusy(false); } }}>Confirm and send</Button></div>{draft.delivery_error && <p role="alert">{draft.delivery_error}</p>}</div>}</div>}
      </section>}
    </div>
  </section>;
}
