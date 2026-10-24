from pathlib import Path

from app.core.config import Settings


def test_origin_and_recipient_lists_support_existing_json_and_csv_env_formats():
    for origins, domains in [
        ('["http://localhost:5173", "http://127.0.0.1:5173"]', '["Example.test"]'),
        ('http://localhost:5173,http://127.0.0.1:5173', 'Example.test'),
    ]:
        settings = Settings(_env_file=None, frontend_origins=origins, smtp_allowed_recipient_domains=domains)
        assert settings.frontend_origins == ["http://localhost:5173", "http://127.0.0.1:5173"]
        assert settings.smtp_allowed_recipient_domains == ["example.test"]


def test_example_environment_is_safe_for_batch_only_use():
    example = Path(__file__).parents[2] / ".env.example"

    settings = Settings(_env_file=example)

    assert settings.database_url == "sqlite:///../data/traceveil.db"
    assert settings.evidence_storage_path == "../data/evidence"
    assert settings.report_storage_path == "../data/reports"
    assert settings.live_source_tokens == {}
    assert not settings.smtp_host
    assert not settings.smtp_username
    assert not settings.smtp_password
    assert all("replace" not in token.lower() for token in settings.live_source_tokens.values())
