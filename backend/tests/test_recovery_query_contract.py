"""Step 7.9 - the contract live recovery actually depends on.

Reset recovery rebuilds its feeds from the investigation API, so the
query it issues has to be one the API accepts. It previously asked for
`page_size=500` against an endpoint capped at 200: every recovery
request was refused with 422 and the feed was never rebuilt, while the
browser reported a successful authoritative rebuild.

These tests lock the limit down from the backend side so it cannot be
quietly widened to match a browser buffer, and pin the ordering recovery
relies on.
"""
from __future__ import annotations

from time import monotonic, sleep


TOKEN = "traceveil-demo-token"
SOURCE = "live-lab-01"
API = "/api/v1"


def _case(client, name="Recovery contract") -> int:
    return client.post(f"{API}/cases", json={"name": name}).json()["id"]


def _seed_events(client, case_id: int, count: int = 3) -> None:
    client.post(f"{API}/cases/{case_id}/live-sessions",
                json={"label": "recovery", "source_ids": [SOURCE]})
    for sequence in range(count):
        payload = {
            "schema_version": "1.0", "case_id": case_id, "source_id": SOURCE,
            "device_id": "door-controller", "event_type": "telemetry",
            # Minutes apart so oldest-versus-newest is unambiguous.
            "observed_at": f"2026-09-17T10:{sequence:02d}:00Z", "sequence": sequence,
            "metrics": {"temperature_c": 20.0 + sequence},
        }
        accepted = client.post(f"{API}/live/telemetry", json=payload,
                               headers={"X-Traceveil-Source-Token": TOKEN})
        assert accepted.status_code == 202, accepted.text
        deadline = monotonic() + 30.0
        while monotonic() < deadline:
            body = client.get(f"{API}/live/receipts/{accepted.json()['receipt_id']}").json()
            if body["status"] in {"completed", "failed", "rejected"}:
                assert body["status"] == "completed", body
                break
            sleep(0.02)
        else:
            raise AssertionError("receipt never completed")


def test_event_page_size_limit_is_two_hundred(client):
    """The limit recovery must respect. Raising it to match a 500-record
    browser buffer would be the wrong fix, so it is asserted here."""
    case_id = _case(client)
    assert client.get(f"{API}/cases/{case_id}/events",
                      params={"page": 1, "page_size": 200}).status_code == 200
    for rejected in (201, 500):
        response = client.get(f"{API}/cases/{case_id}/events",
                              params={"page": 1, "page_size": rejected})
        assert response.status_code == 422, f"page_size={rejected} was accepted"
        assert response.json()["code"] == "request_validation_error"


def test_alert_page_size_limit_is_two_hundred(client):
    case_id = _case(client)
    assert client.get(f"{API}/cases/{case_id}/alerts",
                      params={"page": 1, "page_size": 200}).status_code == 200
    assert client.get(f"{API}/cases/{case_id}/alerts",
                      params={"page": 1, "page_size": 500}).status_code == 422


def test_events_default_to_oldest_first(client):
    """The pre-existing contract, unchanged - which is exactly why
    recovery cannot simply take page 1."""
    case_id = _case(client, "ordering default")
    _seed_events(client, case_id, 3)
    items = client.get(f"{API}/cases/{case_id}/events").json()["items"]
    observed = [item["observed_at"] for item in items]
    assert observed == sorted(observed), "default order is no longer ascending"


def test_events_can_be_requested_newest_first(client):
    """The capability recovery uses. Without it the browser would have to
    guess which page holds the recent feed."""
    case_id = _case(client, "ordering desc")
    _seed_events(client, case_id, 3)
    items = client.get(f"{API}/cases/{case_id}/events", params={"order": "desc"}).json()["items"]
    observed = [item["observed_at"] for item in items]
    assert observed == sorted(observed, reverse=True), "desc did not return newest first"

    # The same records, in the opposite direction - not a different set.
    ascending = client.get(f"{API}/cases/{case_id}/events", params={"order": "asc"}).json()["items"]
    assert {item["event_id"] for item in items} == {item["event_id"] for item in ascending}


def test_a_bounded_page_returns_the_newest_records(client):
    """Recovery asks for one bounded page. Newest-first is what makes a
    single page the right records rather than the oldest history."""
    case_id = _case(client, "bounded newest")
    _seed_events(client, case_id, 3)
    newest = client.get(f"{API}/cases/{case_id}/events",
                        params={"order": "desc", "page_size": 2}).json()
    assert len(newest["items"]) == 2
    assert newest["total"] == 3
    everything = client.get(f"{API}/cases/{case_id}/events", params={"order": "asc"}).json()["items"]
    assert [item["event_id"] for item in newest["items"]] == \
        [item["event_id"] for item in reversed(everything)][:2]


def test_alerts_accept_the_same_ordering_capability(client):
    case_id = _case(client, "alert ordering")
    for order in ("asc", "desc"):
        assert client.get(f"{API}/cases/{case_id}/alerts",
                          params={"order": order}).status_code == 200


def test_an_unknown_order_is_refused(client):
    """A closed vocabulary: the value reaches an ORDER BY clause, so it
    must never be free text."""
    case_id = _case(client)
    response = client.get(f"{API}/cases/{case_id}/events", params={"order": "sideways"})
    assert response.status_code == 422
    response = client.get(f"{API}/cases/{case_id}/events",
                          params={"order": "asc; DROP TABLE canonical_events"})
    assert response.status_code == 422
    # The table is still there.
    assert client.get(f"{API}/cases/{case_id}/events").status_code == 200


def test_empty_and_single_page_recovery_reads(client):
    """Zero records, fewer than one page, and exactly one page all answer
    successfully - recovery must not depend on a case being busy."""
    empty = _case(client, "empty recovery")
    body = client.get(f"{API}/cases/{empty}/events",
                      params={"order": "desc", "page_size": 200}).json()
    assert body["items"] == [] and body["total"] == 0

    small = _case(client, "small recovery")
    _seed_events(client, small, 2)
    body = client.get(f"{API}/cases/{small}/events",
                      params={"order": "desc", "page_size": 200}).json()
    assert len(body["items"]) == 2 == body["total"]
    identifiers = [item["event_id"] for item in body["items"]]
    assert len(set(identifiers)) == len(identifiers), "recovery page contains duplicates"


def test_multiple_pages_are_consistent_and_free_of_duplicates(client):
    """More records than one page holds. Recovery reads a single bounded
    page, but the contract it relies on must page cleanly - otherwise the
    bound would silently be hiding a paging defect."""
    case_id = _case(client, "multi page")
    _seed_events(client, case_id, 5)

    first = client.get(f"{API}/cases/{case_id}/events",
                       params={"order": "desc", "page": 1, "page_size": 2}).json()
    second = client.get(f"{API}/cases/{case_id}/events",
                        params={"order": "desc", "page": 2, "page_size": 2}).json()
    third = client.get(f"{API}/cases/{case_id}/events",
                       params={"order": "desc", "page": 3, "page_size": 2}).json()

    assert [first["total"], second["total"], third["total"]] == [5, 5, 5]
    assert [len(first["items"]), len(second["items"]), len(third["items"])] == [2, 2, 1]
    paged = [item["event_id"] for page in (first, second, third) for item in page["items"]]
    assert len(set(paged)) == 5, "paging returned a duplicate record"

    # Paging preserves the requested order across page boundaries.
    everything = client.get(f"{API}/cases/{case_id}/events",
                            params={"order": "desc", "page_size": 200}).json()["items"]
    assert paged == [item["event_id"] for item in everything]

    # A page beyond the end is empty, not an error.
    beyond = client.get(f"{API}/cases/{case_id}/events",
                        params={"order": "desc", "page": 99, "page_size": 2}).json()
    assert beyond["items"] == [] and beyond["total"] == 5


def test_recovery_reads_the_newest_page_when_records_exceed_its_bound(client):
    """When a case holds more records than recovery's single page, the page
    it takes must be the newest ones - the bound trims history, never the
    present."""
    case_id = _case(client, "beyond bound")
    _seed_events(client, case_id, 5)
    # Two stands in for the 200-record bound: the property is the same.
    bounded = client.get(f"{API}/cases/{case_id}/events",
                         params={"order": "desc", "page": 1, "page_size": 2}).json()
    everything = client.get(f"{API}/cases/{case_id}/events",
                            params={"order": "asc", "page_size": 200}).json()["items"]

    assert bounded["total"] == 5, "the total still reports everything retained"
    newest_two = [item["event_id"] for item in reversed(everything)][:2]
    assert [item["event_id"] for item in bounded["items"]] == newest_two
