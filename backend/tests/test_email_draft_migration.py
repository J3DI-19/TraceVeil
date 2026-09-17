"""Step 11 - legacy `email_drafts` migration.

Widening `email_drafts` from report-only to subject-agnostic relaxes
`report_id` from NOT NULL to nullable, which SQLite can only do by
rebuilding the table. That table holds investigator approvals and
delivery history, none of which can be reconstructed from anything else,
so the rebuild is covered here rather than left to the feature tests.
"""
from __future__ import annotations

import sqlite3

import pytest

from app.db.sqlite import SQLiteRepository


LEGACY_DRAFT = {
    "draft_id": "draft-legacy-0001",
    "report_id": "report-legacy-0001",
    "recipient": "legacy@example.test",
    "subject": "Approved investigation report",
    "body": "Attached is the approved investigation report.",
    "content_hash": "a" * 64,
    "status": "approved",
    "approved_by": "Legacy investigator",
    "approved_at": "2026-01-02T03:04:05+00:00",
    "sent_at": None,
    "smtp_message_id": None,
    "delivery_error": None,
    "created_at": "2026-01-02T03:00:00+00:00",
    "updated_at": "2026-01-02T03:04:05+00:00",
}

LEGACY_ATTEMPT = {
    "attempt_id": "attempt-legacy-0001",
    "draft_id": "draft-legacy-0001",
    "request_id": "request-legacy-0001",
    "status": "delivery_unknown",
    "message_id": None,
    "error": "smtp_unavailable",
    "attempted_at": "2026-01-02T03:05:00+00:00",
}


def _legacy_database(path) -> None:
    """Create a database with the pre-Step-11 `email_drafts` schema.

    `report_id` is NOT NULL and the subject columns do not exist, which is
    exactly the shape every database created before this step carries.
    """
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE cases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE reports (
            report_id TEXT PRIMARY KEY, case_id INTEGER NOT NULL, title TEXT NOT NULL,
            sections_json TEXT NOT NULL, status TEXT NOT NULL, narrative TEXT,
            file_path TEXT, content_hash TEXT, approved_by TEXT, approved_at TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE email_drafts (
            draft_id TEXT PRIMARY KEY, report_id TEXT NOT NULL, recipient TEXT NOT NULL,
            subject TEXT NOT NULL, body TEXT NOT NULL, content_hash TEXT NOT NULL,
            status TEXT NOT NULL, approved_by TEXT, approved_at TEXT, sent_at TEXT,
            smtp_message_id TEXT, delivery_error TEXT, created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (report_id) REFERENCES reports(report_id)
        );
        CREATE TABLE delivery_attempts (
            attempt_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, request_id TEXT,
            status TEXT NOT NULL, message_id TEXT, error TEXT, attempted_at TEXT NOT NULL
        );
        INSERT INTO cases (id, name) VALUES (1, 'Legacy case');
        """
    )
    connection.execute(
        "INSERT INTO reports VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        ("report-legacy-0001", 1, "Legacy report", "[]", "approved", None,
         "/tmp/legacy.pdf", "b" * 64, "Legacy investigator",
         "2026-01-02T02:00:00+00:00", "2026-01-02T01:00:00+00:00",
         "2026-01-02T02:00:00+00:00"))
    connection.execute(
        f"INSERT INTO email_drafts ({','.join(LEGACY_DRAFT)}) "
        f"VALUES ({','.join('?' * len(LEGACY_DRAFT))})",
        tuple(LEGACY_DRAFT.values()))
    connection.execute(
        f"INSERT INTO delivery_attempts ({','.join(LEGACY_ATTEMPT)}) "
        f"VALUES ({','.join('?' * len(LEGACY_ATTEMPT))})",
        tuple(LEGACY_ATTEMPT.values()))
    connection.commit()
    connection.close()


@pytest.fixture()
def migrated(tmp_path):
    database_path = tmp_path / "legacy-drafts.db"
    _legacy_database(database_path)
    repository = SQLiteRepository(f"sqlite:///{database_path}")
    # Running initialize twice proves the migration is idempotent: the
    # second call must find the rebuild already done and change nothing.
    repository.initialize()
    repository.initialize()
    yield repository
    repository.close()


def _columns(repository) -> dict[str, sqlite3.Row]:
    return {row["name"]: row
            for row in repository.connection.execute("PRAGMA table_info(email_drafts)")}


def test_legacy_draft_survives_the_rebuild_unchanged(migrated):
    """Every legacy value must cross the rebuild byte for byte. An approval
    silently lost here would let an unapproved message be sent later."""
    row = migrated.connection.execute(
        "SELECT * FROM email_drafts WHERE draft_id=?", (LEGACY_DRAFT["draft_id"],)).fetchone()
    assert row is not None, "the legacy draft did not survive the migration"
    for column, value in LEGACY_DRAFT.items():
        assert row[column] == value, f"{column} changed during migration"


def test_legacy_draft_is_backfilled_as_report_bound(migrated):
    """A legacy row has no subject columns, so the migration must place it
    in the new model as a draft about its own report."""
    row = migrated.connection.execute(
        "SELECT subject_type, subject_id, report_id FROM email_drafts WHERE draft_id=?",
        (LEGACY_DRAFT["draft_id"],)).fetchone()
    assert row["subject_type"] == "report"
    assert row["subject_id"] == LEGACY_DRAFT["report_id"]
    assert row["report_id"] == LEGACY_DRAFT["report_id"]


def test_legacy_draft_recovers_its_case_from_its_report(migrated):
    """Drafts are listed by case. A legacy row predates the case_id column,
    so an unrecovered case would drop it out of the UI entirely."""
    row = migrated.connection.execute(
        "SELECT case_id FROM email_drafts WHERE draft_id=?",
        (LEGACY_DRAFT["draft_id"],)).fetchone()
    assert row["case_id"] == 1


def test_report_id_becomes_nullable_and_new_columns_exist(migrated):
    columns = _columns(migrated)
    assert {"subject_type", "subject_id", "case_id"} <= set(columns)
    assert not columns["report_id"]["notnull"], "report_id is still NOT NULL"
    # The relaxed constraint is what the whole rebuild exists for: an alert
    # draft has no report at all.
    migrated.connection.execute(
        "INSERT INTO email_drafts (draft_id, report_id, recipient, subject, body,"
        " content_hash, status, created_at, updated_at, subject_type, subject_id, case_id)"
        " VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?)",
        ("draft-alert-0001", "alerts@example.test", "Alert raised", "AUTH-001 triggered.",
         "c" * 64, "draft", "2026-01-03T00:00:00+00:00", "2026-01-03T00:00:00+00:00",
         "alert", "alert-0001", 1))
    migrated.connection.commit()


def test_delivery_history_and_report_relationship_are_intact(migrated):
    attempt = migrated.connection.execute(
        "SELECT * FROM delivery_attempts WHERE attempt_id=?",
        (LEGACY_ATTEMPT["attempt_id"],)).fetchone()
    assert attempt is not None, "delivery history was lost"
    for column, value in LEGACY_ATTEMPT.items():
        assert attempt[column] == value, f"{column} changed during migration"
    # The rebuilt table must still point at a real report.
    joined = migrated.connection.execute(
        "SELECT reports.title FROM email_drafts JOIN reports"
        " ON reports.report_id = email_drafts.report_id WHERE draft_id=?",
        (LEGACY_DRAFT["draft_id"],)).fetchone()
    assert joined["title"] == "Legacy report"


def test_foreign_keys_are_enforced_and_consistent_after_migration(migrated):
    """The rebuild disables foreign keys for the rename. Leaving them off
    would silently drop enforcement for the rest of the process."""
    assert migrated.connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert migrated.connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_no_scratch_table_survives_the_migration(migrated):
    tables = {row["name"] for row in migrated.connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "email_drafts_rebuilt" not in tables
    assert "email_drafts" in tables


class _FailingConnection:
    """A real connection that refuses one specific statement.

    `sqlite3.Connection` is immutable, so the failure is injected by
    wrapping rather than patching. Everything except the named statement
    is delegated untouched, so the migration runs for real up to the
    point of failure.
    """

    def __init__(self, connection: sqlite3.Connection, failing_fragment: str) -> None:
        self._connection = connection
        self._failing_fragment = failing_fragment

    def execute(self, statement, *arguments):
        if self._failing_fragment in statement:
            raise sqlite3.OperationalError("simulated failure during rebuild")
        return self._connection.execute(statement, *arguments)

    def __getattr__(self, name):
        return getattr(self._connection, name)


def test_failed_rebuild_leaves_the_legacy_table_intact(tmp_path):
    """The rebuild is only safe if a failure rolls back. Force one partway
    through and assert the legacy approval is still readable afterwards."""
    database_path = tmp_path / "failing-drafts.db"
    _legacy_database(database_path)
    repository = SQLiteRepository(f"sqlite:///{database_path}")
    raw = sqlite3.connect(database_path, check_same_thread=False)
    raw.row_factory = sqlite3.Row
    repository.connection = _FailingConnection(raw, "RENAME TO email_drafts")

    with pytest.raises(sqlite3.OperationalError):
        repository.initialize()
    raw.close()

    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    row = connection.execute(
        "SELECT * FROM email_drafts WHERE draft_id=?", (LEGACY_DRAFT["draft_id"],)).fetchone()
    assert row is not None, "a failed rebuild destroyed the legacy drafts"
    assert row["approved_by"] == LEGACY_DRAFT["approved_by"]
    assert row["content_hash"] == LEGACY_DRAFT["content_hash"]
    tables = {item["name"] for item in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "email_drafts_rebuilt" not in tables, "a failed rebuild left its scratch table behind"
    connection.close()

    # A later run must still be able to complete the migration.
    retried = SQLiteRepository(f"sqlite:///{database_path}")
    retried.initialize()
    assert not _columns(retried)["report_id"]["notnull"]
    retried.close()
