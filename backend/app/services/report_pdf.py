"""Deterministic, paginated rendering for persisted investigation reports."""

from __future__ import annotations

import io
import re

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import LETTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen.canvas import Canvas


INK = HexColor("#14243A")
MUTED = HexColor("#52647A")
BLUE = HexColor("#2867D8")
CYAN = HexColor("#39B9D6")
LINE = HexColor("#DDE5ED")
PALE = HexColor("#F3F7FB")
WHITE = HexColor("#FFFFFF")
NAVY = HexColor("#0C1A2B")
MARGIN = 48
WIDTH, HEIGHT = LETTER
CONTENT_WIDTH = WIDTH - 2 * MARGIN


def _clean(value: object) -> str:
    text = str(value if value is not None else "")
    text = text.translate(str.maketrans({"‐": "-", "‑": "-", "–": "-", "—": "-", "‘": "'", "’": "'", "“": "\"", "”": "\""}))
    return re.sub(r"\s+", " ", text).strip()


def _wrap(text: object, font: str, size: float, max_width: float) -> list[str]:
    """Wrap without dropping long hashes, URLs, or identifiers."""
    words = _clean(text).split(" ")
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if pdfmetrics.stringWidth(candidate, font, size) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ""
        while pdfmetrics.stringWidth(word, font, size) > max_width:
            low, high = 1, len(word)
            while low < high:
                mid = (low + high + 1) // 2
                if pdfmetrics.stringWidth(word[:mid], font, size) <= max_width:
                    low = mid
                else:
                    high = mid - 1
            cut = low
            lines.append(word[:cut])
            word = word[cut:]
        current = word
    if current:
        lines.append(current)
    return lines or [""]


class _ReportCanvas:
    def __init__(self, case_id: int, output: io.BytesIO):
        self.canvas = Canvas(output, pagesize=LETTER, invariant=1, pageCompression=1)
        self.case_id = case_id
        self.page = 0
        self.y = 0.0
        self.section_number = 0
        self.new_page(first=True)

    def new_page(self, *, first: bool = False) -> None:
        if self.page:
            self.canvas.showPage()
        self.page += 1
        c = self.canvas
        c.setFillColor(WHITE)
        c.rect(0, 0, WIDTH, HEIGHT, fill=1, stroke=0)
        if first:
            c.setFillColor(NAVY)
            c.rect(0, HEIGHT - 105, WIDTH, 105, fill=1, stroke=0)
            c.setFillColor(CYAN)
            c.roundRect(MARGIN, HEIGHT - 67, 28, 28, 5, fill=1, stroke=0)
            c.setFillColor(NAVY)
            c.setFont("Helvetica-Bold", 17)
            c.drawCentredString(MARGIN + 14, HEIGHT - 59, "T")
            c.setFillColor(WHITE)
            c.setFont("Helvetica-Bold", 12)
            c.drawString(MARGIN + 40, HEIGHT - 50, "TRACEVEIL")
            c.setFillColor(HexColor("#91ABC7"))
            c.setFont("Helvetica", 8)
            c.drawString(MARGIN + 40, HEIGHT - 64, "DIGITAL FORENSICS / INCIDENT RESPONSE")
            c.setFillColor(HexColor("#BED0E2"))
            c.setFont("Helvetica-Bold", 8)
            c.drawRightString(WIDTH - MARGIN, HEIGHT - 55, "CONFIDENTIAL")
            self.y = HEIGHT - 141
        else:
            c.setFillColor(NAVY)
            c.rect(0, HEIGHT - 8, WIDTH, 8, fill=1, stroke=0)
            c.setFillColor(INK)
            c.setFont("Helvetica-Bold", 9)
            c.drawString(MARGIN, HEIGHT - 42, "TRACEVEIL")
            c.setFillColor(MUTED)
            c.setFont("Helvetica", 8)
            c.drawRightString(WIDTH - MARGIN, HEIGHT - 42, f"CASE-{self.case_id:04d} / INVESTIGATION REPORT")
            c.setStrokeColor(LINE)
            c.line(MARGIN, HEIGHT - 53, WIDTH - MARGIN, HEIGHT - 53)
            self.y = HEIGHT - 80
        c.setStrokeColor(LINE)
        c.line(MARGIN, 46, WIDTH - MARGIN, 46)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 7.5)
        c.drawString(MARGIN, 32, f"TRACEVEIL  /  CASE-{self.case_id:04d}")
        c.drawRightString(WIDTH - MARGIN, 32, f"PAGE {self.page:02d}")

    def ensure(self, height: float) -> None:
        if self.y - height < 67:
            self.new_page()

    def paragraph(self, text: object, *, x: float = MARGIN, width: float = CONTENT_WIDTH,
                  font: str = "Helvetica", size: float = 9.5, leading: float = 15,
                  color=MUTED, after: float = 0) -> None:
        lines = _wrap(text, font, size, width)
        for line in lines:
            self.ensure(leading)
            self.canvas.setFillColor(color)
            self.canvas.setFont(font, size)
            self.canvas.drawString(x, self.y, line)
            self.y -= leading
        self.y -= after

    def section(self, title: str) -> None:
        self.ensure(67)
        self.y -= 15
        self.section_number += 1
        c = self.canvas
        c.setFillColor(BLUE)
        c.roundRect(MARGIN, self.y - 5, 27, 23, 4, fill=1, stroke=0)
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 8)
        c.drawCentredString(MARGIN + 13.5, self.y + 3, f"{self.section_number:02d}")
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 12)
        c.drawString(MARGIN + 38, self.y + 2, title)
        self.y -= 20
        c.setStrokeColor(LINE)
        c.line(MARGIN, self.y, WIDTH - MARGIN, self.y)
        self.y -= 20

    def record(self, label: object, body: object, *, meta: object | None = None) -> None:
        self.ensure(58)
        self.paragraph(label, font="Helvetica-Bold", size=9.5, leading=14, color=INK, after=2)
        self.paragraph(body or "No summary available.", size=9, leading=14, after=2)
        if meta:
            self.paragraph(meta, font="Courier", size=7.4, leading=11, color=MUTED, after=1)
        self.ensure(13)
        self.canvas.setStrokeColor(LINE)
        self.canvas.line(MARGIN, self.y, WIDTH - MARGIN, self.y)
        self.y -= 16

    def empty(self, text: str) -> None:
        self.ensure(54)
        self.canvas.setFillColor(PALE)
        self.canvas.roundRect(MARGIN, self.y - 37, CONTENT_WIDTH, 48, 5, fill=1, stroke=0)
        self.y -= 9
        self.paragraph(text, x=MARGIN + 14, width=CONTENT_WIDTH - 28, size=9, leading=14, after=16)

    def finish(self) -> None:
        self.canvas.save()


def build_report_pdf(report: dict, case: dict, evidence: list[dict],
                     artifacts: dict[str, list[dict]]) -> bytes:
    """Render only persisted report, case, evidence, and analysis values."""
    output = io.BytesIO()
    layout = _ReportCanvas(case["id"], output)
    c = layout.canvas

    c.setFillColor(BLUE)
    c.setFont("Helvetica-Bold", 8)
    c.drawString(MARGIN, layout.y, "INVESTIGATION REPORT")
    layout.y -= 25
    layout.paragraph(report["title"], font="Helvetica-Bold", size=23, leading=28,
                     color=INK, after=3)
    layout.paragraph(f"{case['name']}  /  CASE-{case['id']:04d}", size=10.5,
                     leading=16, color=MUTED, after=20)

    layout.ensure(87)
    card_top = layout.y + 12
    c.setFillColor(PALE)
    c.roundRect(MARGIN, card_top - 79, CONTENT_WIDTH, 79, 7, fill=1, stroke=0)
    metadata = (
        ("CASE REFERENCE", f"CASE-{case['id']:04d}"),
        ("REPORT ID", report["report_id"][:19] + " " + report["report_id"][19:]),
        ("CREATED UTC", report["created_at"]),
    )
    column_width = CONTENT_WIDTH / 3
    for index, (label, value) in enumerate(metadata):
        x = MARGIN + 14 + index * column_width
        c.setFillColor(MUTED)
        c.setFont("Helvetica-Bold", 7)
        c.drawString(x, card_top - 21, label)
        lines = _wrap(value, "Helvetica", 8, column_width - 30)
        c.setFillColor(INK)
        c.setFont("Helvetica", 8)
        for line_index, line in enumerate(lines[:3]):
            c.drawString(x, card_top - 38 - line_index * 11, line)
    layout.y = card_top - 103

    counts = (
        ("EVIDENCE SOURCES", len(evidence)),
        ("FINDINGS", len(artifacts.get("finding", []))),
        ("INCIDENTS", len(artifacts.get("incident", []))),
        ("TIMELINE ENTRIES", len(artifacts.get("timeline", []))),
    )
    layout.ensure(78)
    for index, (label, count) in enumerate(counts):
        x = MARGIN + index * (CONTENT_WIDTH / 4)
        c.setFillColor(WHITE)
        c.setStrokeColor(LINE)
        c.roundRect(x + (5 if index else 0), layout.y - 55, CONTENT_WIDTH / 4 - 7, 62, 5,
                    fill=1, stroke=1)
        c.setFillColor(BLUE)
        c.setFont("Helvetica-Bold", 18)
        c.drawString(x + 13, layout.y - 20, str(count))
        c.setFillColor(MUTED)
        c.setFont("Helvetica-Bold", 6.5)
        c.drawString(x + 13, layout.y - 38, label)
    layout.y -= 84

    layout.section("EXECUTIVE SUMMARY")
    layout.paragraph(
        "This report compiles persisted evidence and the latest saved analysis for this case. "
        "Findings, incidents, and timeline entries below are backend-authored; report approval "
        "and delivery are recorded separately.",
        after=6,
    )
    incidents = artifacts.get("incident", [])
    if incidents:
        layout.section("DETERMINISTIC INCIDENT SUMMARIES")
        for item in incidents[:100]:
            layout.record(item.get("title") or item.get("incident_id") or "Incident",
                          item.get("summary") or "No deterministic summary available.",
                          meta=item.get("incident_id"))
    if report.get("narrative"):
        layout.section("AI NARRATIVE (NON-AUTHORITATIVE)")
        layout.paragraph(report["narrative"], after=4)

    layout.section("EVIDENCE REGISTER")
    if evidence:
        for item in evidence:
            accepted = item.get("accepted_records") or 0
            rejected = item.get("rejected_records") or 0
            layout.record(
                item.get("original_filename") or item.get("evidence_id") or "Evidence source",
                f"Source type: {item.get('source_type') or 'Unknown'}   |   "
                f"Accepted records: {accepted:,}   |   Rejected records: {rejected:,}",
                meta=f"ID {item.get('evidence_id') or 'Unavailable'}  /  SHA-256 {item.get('source_hash') or 'Unavailable'}",
            )
    else:
        layout.empty("No evidence sources are recorded for this case.")

    for title, kind in (("FINDINGS", "finding"), ("INCIDENTS", "incident"),
                        ("FORENSIC TIMELINE", "timeline")):
        layout.section(title)
        items = artifacts.get(kind, [])
        if not items:
            layout.empty(f"No {kind} records are present in the latest saved analysis.")
            continue
        for item in items[:100]:
            identifier = item.get(f"{kind}_id") or item.get("entry_id") or "Record"
            summary = item.get("title") or item.get("summary") or item.get("event_type")
            if not summary:
                summary = "No summary available."
            detail = item.get("summary") if item.get("title") else None
            layout.record(summary, detail or identifier, meta=identifier)

    layout.finish()
    return output.getvalue()
