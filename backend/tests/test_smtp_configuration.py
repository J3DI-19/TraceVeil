from fastapi import HTTPException

from app.api.phase3 import require_local_smtp_control
from app.core.config import Settings


def test_smtp_settings_save_without_returning_password(client, tmp_path, monkeypatch):
    path = tmp_path / ".env"
    path.write_text("APP_NAME=Traceveil\n", encoding="utf-8")
    client.app.state.smtp_env_path = path
    configuration = {
        "host": "smtp.example.test", "port": 587, "starttls": True,
        "username": "reports@example.test", "password": "sample-secret-$!",
        "clear_password": False, "from_address": "reports@example.test",
        "allowed_recipient_domains": ["example.test"],
    }
    saved = client.patch("/api/v1/email-delivery/configuration", json=configuration)
    assert saved.status_code == 200, saved.text
    assert saved.json()["configured"] is True
    assert saved.json()["password_set"] is True
    assert "password" not in saved.json()
    assert "sample-secret-$!" not in saved.text
    assert client.get("/api/v1/email-delivery/configuration").json()["password_set"] is True
    assert client.get("/api/v1/email-delivery/status").json() == {"configured": True}
    assert "APP_NAME=Traceveil" in path.read_text(encoding="utf-8")
    assert Settings(_env_file=path).smtp_password == "sample-secret-$!"

    configuration.update(host="smtp2.example.test", password=None)
    kept = client.patch("/api/v1/email-delivery/configuration", json=configuration)
    assert kept.status_code == 200
    assert Settings(_env_file=path).smtp_password == "sample-secret-$!"
    assert client.app.state.phase3_service.settings.smtp_host == "smtp2.example.test"

    smtp_calls = []
    class FakeSMTP:
        def __init__(self, host, port, timeout):
            smtp_calls.append((host, port, timeout))
        def __enter__(self): return self
        def __exit__(self, *args): return None
        def starttls(self): pass
        def login(self, username, password):
            assert (username, password) == ("reports@example.test", "sample-secret-$!")
        def send_message(self, message):
            assert message["To"] == "security@example.test"
    monkeypatch.setattr("app.services.phase3.smtplib.SMTP", FakeSMTP)
    case_id = client.post("/api/v1/cases", json={"name": "SMTP setup test"}).json()["id"]
    report = client.post(f"/api/v1/cases/{case_id}/reports", json={"title": "Setup report"}).json()
    client.post(f"/api/v1/reports/{report['report_id']}/generate")
    client.post(f"/api/v1/reports/{report['report_id']}/approve", json={"approver": "Investigator", "confirmed": True})
    draft = client.post(f"/api/v1/reports/{report['report_id']}/email-drafts", json={"recipient": "security@example.test", "subject": "Setup report", "body": "Attached."}).json()
    client.post(f"/api/v1/email-drafts/{draft['draft_id']}/approve", json={"approver": "Investigator", "confirmed": True})
    delivered = client.post(f"/api/v1/email-drafts/{draft['draft_id']}/send")
    assert delivered.status_code == 200
    assert delivered.json()["status"] == "sent"
    assert smtp_calls == [("smtp2.example.test", 587, 10)]

    before = path.read_bytes()
    configuration["allowed_recipient_domains"] = ["invalid domain"]
    invalid = client.patch("/api/v1/email-delivery/configuration", json=configuration)
    assert invalid.status_code == 422
    assert "sample-secret-$!" not in invalid.text
    assert path.read_bytes() == before

    configuration.update(allowed_recipient_domains=["example.test"], clear_password=True)
    cleared = client.patch("/api/v1/email-delivery/configuration", json=configuration)
    assert cleared.status_code == 200
    assert cleared.json()["password_set"] is False
    assert cleared.json()["configured"] is False
    assert Settings(_env_file=path).smtp_password == ""


def test_smtp_settings_require_local_client():
    from types import SimpleNamespace

    try:
        require_local_smtp_control(SimpleNamespace(client=SimpleNamespace(host="192.0.2.10")))
    except HTTPException as error:
        assert error.status_code == 403
    else:
        raise AssertionError("remote client was allowed to change SMTP settings")
