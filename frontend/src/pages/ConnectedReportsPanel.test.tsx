import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { phase3Api, type ReportRecord } from "../api/phase3";
import { ConnectedReportsPanel } from "./ConnectedReportsPanel";

vi.mock("../api/phase3", () => ({
  phase3Api: {
    reports: vi.fn(),
    downloadReport: vi.fn(),
    cancelReport: vi.fn(),
  },
}));

const generatedReport: ReportRecord = {
  report_id: "4d7262b2-7754-4731-9887-dc46b4b8a043",
  case_id: 7,
  title: "Review report",
  sections: [],
  status: "generated",
  narrative: null,
  content_hash: "abc123",
  approved_by: null,
  approved_at: null,
  created_at: "2026-09-29T00:00:00Z",
  updated_at: "2026-09-29T00:00:00Z",
};

describe("ConnectedReportsPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("previews the generated PDF and only deletes after confirmation", async () => {
    const reports = vi.mocked(phase3Api.reports);
    reports.mockResolvedValueOnce({ items: [generatedReport], total: 1, page: 1, page_size: 1 });
    reports.mockResolvedValueOnce({ items: [], total: 0, page: 1, page_size: 0 });
    vi.mocked(phase3Api.downloadReport).mockResolvedValue(new Blob(["%PDF"], { type: "application/pdf" }));
    vi.mocked(phase3Api.cancelReport).mockResolvedValue(new Response(null, { status: 204 }));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:report-preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });

    render(<ConnectedReportsPanel caseId={7} />);
    expect(await screen.findByTitle("Preview of Review report")).toHaveAttribute("src", "blob:report-preview#toolbar=0");
    fireEvent.click(screen.getByRole("button", { name: "Cancel report" }));
    expect(phase3Api.cancelReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete report" }));
    await waitFor(() => expect(phase3Api.cancelReport).toHaveBeenCalledWith(generatedReport.report_id));
    expect(await screen.findByText("No reports yet")).toBeInTheDocument();
  });
});
