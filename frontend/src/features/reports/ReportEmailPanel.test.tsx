import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { phase3Api, type EmailDraft, type ReportRecord } from "../../api/phase3";
import { ReportEmailPanel } from "./ReportEmailPanel";

vi.mock("../../api/phase3", () => ({
  phase3Api: {
    emailDrafts: vi.fn(),
    emailDeliveryStatus: vi.fn(),
    createEmailDraft: vi.fn(),
    updateEmailDraft: vi.fn(),
    approveEmail: vi.fn(),
    sendEmail: vi.fn(),
  },
}));

const report: ReportRecord = {
  report_id: "4d7262b2-7754-4731-9887-dc46b4b8a043",
  case_id: 7,
  title: "Review report",
  sections: [],
  status: "approved",
  narrative: null,
  content_hash: "abc123",
  approved_by: "Investigator",
  approved_at: "2026-09-29T00:00:00Z",
  created_at: "2026-09-29T00:00:00Z",
  updated_at: "2026-09-29T00:00:00Z",
};

const draft: EmailDraft = {
  draft_id: "draft-1",
  report_id: report.report_id,
  case_id: 7,
  subject_type: "report",
  subject_id: report.report_id,
  recipient: "security@example.test",
  subject: "Review report",
  body: "Please review the attached report.",
  status: "draft",
  approved_by: null,
  approved_at: null,
  sent_at: null,
  delivery_error: null,
};

describe("ReportEmailPanel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(phase3Api.emailDeliveryStatus).mockResolvedValue({ configured: true });
  });

  it("restores a saved draft, previews edits, and requires save, approval, and final confirmation", async () => {
    vi.mocked(phase3Api.emailDrafts).mockResolvedValue({ items: [draft] });
    vi.mocked(phase3Api.updateEmailDraft).mockResolvedValue({ ...draft, body: "Updated message." });
    vi.mocked(phase3Api.approveEmail).mockResolvedValue({ ...draft, body: "Updated message.", status: "approved", approved_by: "Local investigator", approved_at: "2026-09-29T01:00:00Z" });
    vi.mocked(phase3Api.sendEmail).mockResolvedValue({ ...draft, body: "Updated message.", status: "sent", approved_by: "Local investigator", approved_at: "2026-09-29T01:00:00Z", sent_at: "2026-09-29T01:01:00Z" });

    render(<ReportEmailPanel caseId={7} report={report} />);
    await waitFor(() => expect(phase3Api.emailDrafts).toHaveBeenCalledWith(7, "report", report.report_id, expect.any(AbortSignal)));
    const preview = screen.getByLabelText("Email preview");
    expect(within(preview).getByText("Please review the attached report.")).toBeInTheDocument();
    expect(within(preview).getByText(`traceveil-${report.report_id}.pdf`)).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Updated message." } });
    expect(within(preview).getByText("Updated message.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve email" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(phase3Api.updateEmailDraft).toHaveBeenCalledWith(draft.draft_id, draft.recipient, draft.subject, "Updated message."));
    fireEvent.click(screen.getByRole("button", { name: "Approve email" }));
    await waitFor(() => expect(phase3Api.approveEmail).toHaveBeenCalledWith(draft.draft_id, "Local investigator"));
    expect(phase3Api.sendEmail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review send" }));
    expect(screen.getByRole("group", { name: "Confirm email delivery" })).toHaveTextContent(`Send Review report to security@example.test with traceveil-${report.report_id}.pdf attached?`);
    expect(phase3Api.sendEmail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    await waitFor(() => expect(phase3Api.sendEmail).toHaveBeenCalledWith(draft.draft_id));
    expect(await screen.findByText(/Sent 2026-09-29/)).toBeInTheDocument();
  });

  it("keeps an uncertain delivery read only", async () => {
    vi.mocked(phase3Api.emailDrafts).mockResolvedValue({ items: [{ ...draft, status: "delivery_unknown", delivery_error: "connection closed" }] });
    render(<ReportEmailPanel caseId={7} report={report} />);
    expect(await screen.findByText(/Delivery outcome is unknown/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Review send" })).not.toBeInTheDocument();
  });

  it("shows missing SMTP setup before allowing a send", async () => {
    vi.mocked(phase3Api.emailDeliveryStatus).mockResolvedValue({ configured: false });
    vi.mocked(phase3Api.emailDrafts).mockResolvedValue({ items: [{ ...draft, status: "approved", approved_by: "Investigator", approved_at: "2026-09-29T01:00:00Z" }] });
    render(<ReportEmailPanel caseId={7} report={report} />);
    expect(await screen.findByText("Delivery setup needed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up email delivery in System Status" })).toHaveAttribute("href", "/status#email-delivery");
    expect(screen.getByRole("button", { name: "Review send" })).toBeDisabled();
  });
});
