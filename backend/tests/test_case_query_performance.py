def test_latest_analysis_lookup_uses_covering_index(client):
    db = client.app.state.repository.connection
    plan = db.execute(
        "EXPLAIN QUERY PLAN SELECT analysis_id FROM analysis_runs "
        "WHERE case_id=? ORDER BY created_at DESC LIMIT 1", (8,)
    ).fetchall()
    details = " ".join(row[3] for row in plan)
    assert "COVERING INDEX idx_analysis_case_created" in details
    assert "TEMP B-TREE" not in details


def test_live_stream_database_polling_runs_off_event_loop(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from app.api.phase3 import live_stream

    calls = []
    def check_thread(*args):
        # A synchronous database wait must never hold the ASGI loop.
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            calls.append(True)
            return None if len(calls) == 1 else []
        raise AssertionError("database polling blocked the event loop")

    service = SimpleNamespace(stream_gap=check_thread, stream_after=check_thread)
    monkeypatch.setattr("app.api.phase3.service", lambda request: service)
    class Request:
        async def is_disconnected(self):
            return len(calls) > 1
    async def run():
        response = await live_stream(Request(), case_id=8, last_event_id=None)
        async for _ in response.body_iterator:
            pass
    asyncio.run(run())
    assert len(calls) == 2
