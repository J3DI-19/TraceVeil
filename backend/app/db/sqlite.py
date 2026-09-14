import sqlite3
from threading import RLock
from pathlib import Path
from uuid import UUID

from app.evidence.schemas import EvidenceValidationReport


class SQLiteRepository:
    def __init__(self, database_url: str):
        self.database_url = database_url
        self.connection: sqlite3.Connection | None = None
        self.write_lock = RLock()

    def _database_path(self) -> str:
        if self.database_url == "sqlite:///:memory:":
            return ":memory:"
        if not self.database_url.startswith("sqlite:///"):
            raise ValueError("DATABASE_URL must use the sqlite:/// scheme")
        path = self.database_url.removeprefix("sqlite:///")
        database_path = Path(path)
        if not database_path.is_absolute():
            database_path = Path.cwd() / database_path
        database_path.parent.mkdir(parents=True, exist_ok=True)
        return str(database_path)

    def initialize(self) -> None:
        if self.connection is None:
            self.connection = sqlite3.connect(self._database_path(), check_same_thread=False)
            self.connection.row_factory = sqlite3.Row
            self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS cases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS evidence_metadata (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                case_id INTEGER,
                source_name TEXT NOT NULL,
                source_hash TEXT,
                adapter_version TEXT,
                evidence_id TEXT UNIQUE,
                original_filename TEXT,
                sanitized_filename TEXT,
                media_type TEXT,
                byte_size INTEGER,
                source_type TEXT,
                dataset_profile TEXT,
                validator_version TEXT,
                validation_status TEXT,
                total_records INTEGER,
                accepted_records INTEGER,
                rejected_records INTEGER,
                received_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (case_id) REFERENCES cases(id)
            );

            CREATE TABLE IF NOT EXISTS evidence_validation_issues (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                evidence_metadata_id INTEGER NOT NULL,
                level TEXT NOT NULL,
                error_code TEXT NOT NULL,
                message TEXT NOT NULL,
                row_number INTEGER,
                field_name TEXT,
                rejected_value TEXT,
                FOREIGN KEY (evidence_metadata_id) REFERENCES evidence_metadata(id)
            );

            CREATE TABLE IF NOT EXISTS configuration_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS import_jobs (
                import_id TEXT PRIMARY KEY, case_id INTEGER NOT NULL, evidence_id TEXT,
                filename TEXT NOT NULL, file_path TEXT NOT NULL, source_type TEXT NOT NULL,
                configuration_json TEXT NOT NULL, status TEXT NOT NULL,
                validation_json TEXT, error_json TEXT, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, FOREIGN KEY (case_id) REFERENCES cases(id)
            );
            CREATE TABLE IF NOT EXISTS canonical_events (
                event_id TEXT PRIMARY KEY, case_id INTEGER NOT NULL, evidence_id TEXT NOT NULL,
                observed_at TEXT, ingested_at TEXT NOT NULL, origin TEXT NOT NULL,
                event_type TEXT NOT NULL, entity_id TEXT, source_label TEXT,
                raw_record_json TEXT NOT NULL, canonical_json TEXT NOT NULL,
                FOREIGN KEY (case_id) REFERENCES cases(id)
            );
            CREATE INDEX IF NOT EXISTS idx_events_case_time ON canonical_events(case_id, observed_at, event_id);
            CREATE TABLE IF NOT EXISTS analysis_runs (
                analysis_id TEXT PRIMARY KEY, case_id INTEGER NOT NULL, status TEXT NOT NULL,
                result_json TEXT NOT NULL, created_at TEXT NOT NULL,
                FOREIGN KEY (case_id) REFERENCES cases(id)
            );
            CREATE TABLE IF NOT EXISTS analysis_artifacts (
                analysis_id TEXT NOT NULL, case_id INTEGER NOT NULL, kind TEXT NOT NULL,
                item_id TEXT NOT NULL, occurred_at TEXT, severity TEXT, risk INTEGER,
                payload_json TEXT NOT NULL, PRIMARY KEY (analysis_id, kind, item_id),
                FOREIGN KEY (analysis_id) REFERENCES analysis_runs(analysis_id)
            );
            CREATE INDEX IF NOT EXISTS idx_artifacts_case_kind ON analysis_artifacts(case_id, kind, occurred_at, item_id);
            CREATE TABLE IF NOT EXISTS live_sessions (
                session_id TEXT PRIMARY KEY, case_id INTEGER NOT NULL, label TEXT NOT NULL,
                source_ids_json TEXT NOT NULL, status TEXT NOT NULL, stale_after_seconds INTEGER NOT NULL,
                accepted_count INTEGER NOT NULL DEFAULT 0, malformed_count INTEGER NOT NULL DEFAULT 0,
                started_at TEXT NOT NULL, stopped_at TEXT, updated_at TEXT NOT NULL,
                FOREIGN KEY (case_id) REFERENCES cases(id)
            );
            CREATE TABLE IF NOT EXISTS live_receipts (
                receipt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, case_id INTEGER NOT NULL,
                evidence_id TEXT NOT NULL, source_id TEXT NOT NULL, device_id TEXT NOT NULL,
                sequence INTEGER, dedupe_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
                raw_json TEXT NOT NULL, status TEXT NOT NULL, event_id TEXT, error_json TEXT,
                received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE(session_id, dedupe_key), FOREIGN KEY (session_id) REFERENCES live_sessions(session_id)
            );
            CREATE INDEX IF NOT EXISTS idx_live_receipts_status ON live_receipts(status, received_at);
            CREATE INDEX IF NOT EXISTS idx_live_receipts_source_seq ON live_receipts(source_id, sequence);
            -- TV5-11: source-level (not session-level) high-water sequence
            -- state. The ESP32 monotonic counter survives reboot, so this
            -- state is keyed by source_id and persists across sessions.
            CREATE TABLE IF NOT EXISTS live_source_sequence_state (
                source_id TEXT PRIMARY KEY,
                high_water_sequence INTEGER NOT NULL,
                high_water_payload_hash TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS live_evidence_records (
                evidence_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE, case_id INTEGER NOT NULL,
                session_id TEXT NOT NULL, source_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
                raw_json TEXT NOT NULL, received_at TEXT NOT NULL,
                FOREIGN KEY (receipt_id) REFERENCES live_receipts(receipt_id)
            );
            CREATE TABLE IF NOT EXISTS live_ingest_issues (
                issue_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, case_id INTEGER,
                source_id TEXT, code TEXT NOT NULL, message TEXT NOT NULL, raw_json TEXT,
                occurred_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS device_states (
                case_id INTEGER NOT NULL, session_id TEXT NOT NULL, device_id TEXT NOT NULL,
                source_id TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_observed_at TEXT NOT NULL,
                latest_metrics_json TEXT NOT NULL, event_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (session_id, device_id)
            );
            CREATE TABLE IF NOT EXISTS stream_messages (
                stream_id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL,
                session_id TEXT, topic TEXT NOT NULL, occurred_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_stream_case_id ON stream_messages(case_id, stream_id);
            CREATE TABLE IF NOT EXISTS live_alert_first_seen (
                case_id INTEGER NOT NULL, alert_id TEXT NOT NULL, first_seen_at TEXT NOT NULL,
                PRIMARY KEY (case_id, alert_id)
            );
            CREATE TABLE IF NOT EXISTS alert_workflow (
                case_id INTEGER NOT NULL, alert_id TEXT NOT NULL,
                status TEXT NOT NULL, actor TEXT NOT NULL,
                notification_status TEXT NOT NULL DEFAULT 'not_requested',
                notification_error TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (case_id, alert_id),
                FOREIGN KEY (case_id) REFERENCES cases(id)
            );
            CREATE TABLE IF NOT EXISTS audit_events (
                audit_id TEXT PRIMARY KEY, case_id INTEGER, action TEXT NOT NULL, subject_type TEXT NOT NULL,
                subject_id TEXT, actor TEXT NOT NULL, request_id TEXT, details_json TEXT NOT NULL,
                occurred_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_audit_case_time ON audit_events(case_id, occurred_at, audit_id);
            CREATE TABLE IF NOT EXISTS assistant_sessions (
                session_id TEXT PRIMARY KEY, scope TEXT NOT NULL, case_ids_json TEXT NOT NULL,
                reference_ids_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS assistant_messages (
                message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL,
                text TEXT NOT NULL, citations_json TEXT NOT NULL, caveats_json TEXT NOT NULL,
                visualization_json TEXT, model TEXT, created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES assistant_sessions(session_id)
            );
            CREATE TABLE IF NOT EXISTS assistant_jobs (
                job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_message_id TEXT NOT NULL,
                status TEXT NOT NULL, context_json TEXT, result_message_id TEXT, error_json TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS reports (
                report_id TEXT PRIMARY KEY, case_id INTEGER NOT NULL, title TEXT NOT NULL,
                sections_json TEXT NOT NULL, status TEXT NOT NULL, narrative TEXT,
                file_path TEXT, content_hash TEXT, approved_by TEXT, approved_at TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS report_versions (
                version_id TEXT PRIMARY KEY, report_id TEXT NOT NULL, version_number INTEGER NOT NULL,
                file_path TEXT NOT NULL, content_hash TEXT NOT NULL, approved_by TEXT, approved_at TEXT,
                created_at TEXT NOT NULL, UNIQUE(report_id, version_number),
                FOREIGN KEY (report_id) REFERENCES reports(report_id)
            );
            CREATE TABLE IF NOT EXISTS approval_records (
                approval_id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
                content_hash TEXT NOT NULL, approver TEXT NOT NULL, approved_at TEXT NOT NULL
            );
            -- Step 11: drafts are subject-agnostic. A draft may notify about a
            -- report (report_id set), or directly about an alert or a live
            -- incident (report_id NULL, subject_type/subject_id naming the
            -- deterministic artifact). Approval, content hashing and the
            -- recipient allow-list apply identically to all three.
            CREATE TABLE IF NOT EXISTS email_drafts (
                draft_id TEXT PRIMARY KEY, report_id TEXT, recipient TEXT NOT NULL,
                subject TEXT NOT NULL, body TEXT NOT NULL, content_hash TEXT NOT NULL,
                status TEXT NOT NULL, approved_by TEXT, approved_at TEXT, sent_at TEXT,
                smtp_message_id TEXT, delivery_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                subject_type TEXT NOT NULL DEFAULT 'report', subject_id TEXT NOT NULL DEFAULT '',
                case_id INTEGER,
                FOREIGN KEY (report_id) REFERENCES reports(report_id)
            );
            CREATE TABLE IF NOT EXISTS delivery_attempts (
                attempt_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, request_id TEXT,
                status TEXT NOT NULL, message_id TEXT, error TEXT, attempted_at TEXT NOT NULL
            );
            """
        )
        self._migrate_evidence_metadata()
        self._migrate_cases()
        self._migrate_alert_workflow()
        self._migrate_email_drafts()
        self.connection.commit()

    def _migrate_evidence_metadata(self) -> None:
        """Add Step 3 columns when opening a database created by Step 1."""

        if self.connection is None:
            raise RuntimeError("repository is not initialized")
        existing = {
            row["name"]
            for row in self.connection.execute("PRAGMA table_info(evidence_metadata)").fetchall()
        }
        columns = {
            "evidence_id": "TEXT",
            "original_filename": "TEXT",
            "sanitized_filename": "TEXT",
            "media_type": "TEXT",
            "byte_size": "INTEGER",
            "source_type": "TEXT",
            "dataset_profile": "TEXT",
            "validator_version": "TEXT",
            "validation_status": "TEXT",
            "total_records": "INTEGER",
            "accepted_records": "INTEGER",
            "rejected_records": "INTEGER",
            "received_at": "TEXT",
            "file_path": "TEXT",
            "committed_at": "TEXT",
        }
        for name, definition in columns.items():
            if name not in existing:
                # Names and definitions are constants declared above, never user input.
                self.connection.execute(
                    f"ALTER TABLE evidence_metadata ADD COLUMN {name} {definition}"
                )
        self.connection.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_metadata_evidence_id
            ON evidence_metadata(evidence_id)
            WHERE evidence_id IS NOT NULL
            """
        )

    def _migrate_cases(self) -> None:
        if self.connection is None: raise RuntimeError("repository is not initialized")
        existing = {row["name"] for row in self.connection.execute("PRAGMA table_info(cases)").fetchall()}
        columns = {"description": "TEXT NOT NULL DEFAULT ''", "case_type": "TEXT NOT NULL DEFAULT 'batch'", "status": "TEXT NOT NULL DEFAULT 'active'", "owner": "TEXT NOT NULL DEFAULT 'Investigator'", "updated_at": "TEXT"}
        for name, definition in columns.items():
            if name not in existing: self.connection.execute(f"ALTER TABLE cases ADD COLUMN {name} {definition}")

    def _migrate_email_drafts(self) -> None:
        """Step 11: widen email_drafts from report-only to subject-agnostic.

        The new columns are added in place. `report_id` keeps its original
        NOT NULL constraint on pre-existing databases, which is harmless:
        legacy rows are all report-bound, and alert/incident drafts created
        afterwards are written by the rebuilt schema below.
        """
        if self.connection is None: raise RuntimeError("repository is not initialized")
        existing = {row["name"] for row in self.connection.execute("PRAGMA table_info(email_drafts)").fetchall()}
        columns = {
            "subject_type": "TEXT NOT NULL DEFAULT 'report'",
            "subject_id": "TEXT NOT NULL DEFAULT ''",
            "case_id": "INTEGER",
        }
        for name, definition in columns.items():
            if name not in existing:
                self.connection.execute(f"ALTER TABLE email_drafts ADD COLUMN {name} {definition}")
        # Legacy rows predate subject_id; point them at their own report.
        if "subject_type" not in existing:
            self.connection.execute(
                "UPDATE email_drafts SET subject_type='report', subject_id=report_id"
                " WHERE subject_id='' AND report_id IS NOT NULL")
        # SQLite cannot drop a NOT NULL constraint in place. If the legacy
        # constraint is still on report_id, rebuild the table so alert and
        # incident drafts (which have no report) can be stored.
        report_column = next(
            (row for row in self.connection.execute("PRAGMA table_info(email_drafts)").fetchall()
             if row["name"] == "report_id"), None)
        if report_column is not None and report_column["notnull"]:
            self.connection.execute("PRAGMA foreign_keys=OFF")
            self.connection.executescript(
                """
                CREATE TABLE email_drafts_rebuilt (
                    draft_id TEXT PRIMARY KEY, report_id TEXT, recipient TEXT NOT NULL,
                    subject TEXT NOT NULL, body TEXT NOT NULL, content_hash TEXT NOT NULL,
                    status TEXT NOT NULL, approved_by TEXT, approved_at TEXT, sent_at TEXT,
                    smtp_message_id TEXT, delivery_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    subject_type TEXT NOT NULL DEFAULT 'report', subject_id TEXT NOT NULL DEFAULT '',
                    case_id INTEGER,
                    FOREIGN KEY (report_id) REFERENCES reports(report_id)
                );
                INSERT INTO email_drafts_rebuilt (
                    draft_id, report_id, recipient, subject, body, content_hash, status,
                    approved_by, approved_at, sent_at, smtp_message_id, delivery_error,
                    created_at, updated_at, subject_type, subject_id, case_id)
                SELECT draft_id, report_id, recipient, subject, body, content_hash, status,
                    approved_by, approved_at, sent_at, smtp_message_id, delivery_error,
                    created_at, updated_at, subject_type, subject_id, case_id
                FROM email_drafts;
                DROP TABLE email_drafts;
                ALTER TABLE email_drafts_rebuilt RENAME TO email_drafts;
                """
            )
            self.connection.execute("PRAGMA foreign_keys=ON")

    def _migrate_alert_workflow(self) -> None:
        if self.connection is None: raise RuntimeError("repository is not initialized")
        existing = {row["name"] for row in self.connection.execute("PRAGMA table_info(alert_workflow)").fetchall()}
        columns = {"notification_status": "TEXT NOT NULL DEFAULT 'not_requested'", "notification_error": "TEXT"}
        for name, definition in columns.items():
            if name not in existing: self.connection.execute(f"ALTER TABLE alert_workflow ADD COLUMN {name} {definition}")

    def is_available(self) -> bool:
        if self.connection is None:
            return False
        try:
            self.connection.execute("SELECT 1").fetchone()
            return True
        except sqlite3.Error:
            return False

    def find_evidence_by_hash(self, case_id: int, source_hash: str) -> UUID | None:
        if self.connection is None:
            raise RuntimeError("repository is not initialized")
        row = self.connection.execute(
            """
            SELECT evidence_id
            FROM evidence_metadata
            WHERE case_id = ? AND source_hash = ? AND evidence_id IS NOT NULL
            ORDER BY id ASC
            LIMIT 1
            """,
            (case_id, source_hash),
        ).fetchone()
        return UUID(row["evidence_id"]) if row is not None else None

    def find_committed_evidence_by_hash(
        self, case_id: int, source_hash: str
    ) -> UUID | None:
        if self.connection is None:
            raise RuntimeError("repository is not initialized")
        row = self.connection.execute(
            """
            SELECT evidence_id
            FROM evidence_metadata
            WHERE case_id = ?
              AND source_hash = ?
              AND evidence_id IS NOT NULL
              AND committed_at IS NOT NULL
            ORDER BY id ASC
            LIMIT 1
            """,
            (case_id, source_hash),
        ).fetchone()
        return UUID(row["evidence_id"]) if row is not None else None

    def store_evidence_validation(self, report: EvidenceValidationReport) -> None:
        if self.connection is None:
            raise RuntimeError("repository is not initialized")
        metadata = report.metadata
        with self.write_lock, self.connection:
            cursor = self.connection.execute(
                """
                INSERT INTO evidence_metadata (
                    case_id, source_name, source_hash, adapter_version,
                    evidence_id, original_filename, sanitized_filename, media_type,
                    byte_size, source_type, dataset_profile, validator_version,
                    validation_status, total_records, accepted_records, rejected_records,
                    received_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    metadata.case_id,
                    metadata.sanitized_filename,
                    metadata.sha256,
                    None,
                    str(metadata.evidence_id),
                    metadata.original_filename,
                    metadata.sanitized_filename,
                    metadata.media_type,
                    metadata.byte_size,
                    metadata.source_type.value,
                    metadata.dataset_profile,
                    metadata.validator_version,
                    report.status.value,
                    report.total_records,
                    report.accepted_records,
                    report.rejected_records,
                    metadata.received_at.isoformat(),
                ),
            )
            evidence_metadata_id = cursor.lastrowid
            self.connection.executemany(
                """
                INSERT INTO evidence_validation_issues (
                    evidence_metadata_id, level, error_code, message,
                    row_number, field_name, rejected_value
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        evidence_metadata_id,
                        issue.level.value,
                        issue.code,
                        issue.message,
                        issue.row_number,
                        issue.field,
                        issue.rejected_value,
                    )
                    for issue in report.issues
                ],
            )

    def close(self) -> None:
        if self.connection is not None:
            self.connection.close()
            self.connection = None

