from api.itemit_client import ItemitClient, ItemitRequestManager


class Response:
    def __init__(self, status_code=200, payload=None, headers=None):
        self.status_code = status_code
        self._payload = payload or {}
        self.headers = headers or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


class Session:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def get(self, path, params, timeout):
        self.calls.append((path, params, timeout))
        return self.responses.pop(0)


def client_with_detail(detail):
    client = object.__new__(ItemitClient)
    client.get_item = lambda _item_id: detail
    return client


def test_complete_and_explicit_zero_memberships_are_classified():
    client = client_with_detail(None)
    records = client.resolve_item_collection_memberships([
        {"id": "zero", "collections": {"total": 0, "results": []}},
        {"id": "many", "collections": {"total": 2, "results": [{"id": "c1"}, {"id": "c2"}]}},
    ])
    assert [(row["status"], row["memberships"]) for row in records] == [("EMPTY", []), ("COMPLETE", ["c1", "c2"])]


def test_missing_collection_field_remains_unknown():
    client = client_with_detail({"id": "item", "name": "Asset"})
    record = client.resolve_item_collection_memberships([{"id": "item", "name": "Asset"}])[0]
    assert record["status"] == "UNKNOWN"
    assert record["raw_item"]["name"] == "Asset"
    assert "collections" not in record["raw_item"]


def test_incomplete_nested_response_remains_incomplete():
    client = client_with_detail({"id": "item", "collections": {"total": 2, "results": [{"id": "c1"}]}})
    assert client.resolve_item_collection_memberships([{"id": "item", "collections": {"total": 2, "results": [{"id": "c1"}]}}])[0]["status"] == "INCOMPLETE"


def test_detail_fallback_can_resolve_memberships():
    detail = {"id": "item", "collections": {"total": 2, "results": [{"id": "c1"}, {"id": "c2"}]}}
    record = client_with_detail(detail).resolve_item_collection_memberships([{"id": "item", "name": "Asset"}])[0]
    assert record["status"] == "COMPLETE"
    assert record["source"] == "ITEM_DETAIL"


def test_detail_failure_does_not_block_inventory_membership_classification():
    client = object.__new__(ItemitClient)
    client.get_item = lambda _item_id: (_ for _ in ()).throw(RuntimeError("network down"))
    record = client.resolve_item_collection_memberships([{"id": "item", "name": "Asset"}])[0]
    assert record["status"] == "UNKNOWN"
    assert "network down" in record["detail_error"]


def test_item_pagination_failure_is_not_accepted():
    client = object.__new__(ItemitClient)
    client.get_items = lambda **_: {"total": 2, "results": []}
    try:
        client.get_all_items()
    except RuntimeError as error:
        assert "Pagination" in str(error)
    else:
        raise AssertionError("Incomplete pagination must fail")


def test_request_manager_caches_identical_gets():
    session = Session([Response(payload={"results": ["one"]})])
    manager = ItemitRequestManager(session, requests_per_minute=100, sleep=lambda _: None)
    assert manager.get_json("items", params={"skip": 0}, cache_ttl=60) == {"results": ["one"]}
    assert manager.get_json("items", params={"skip": 0}, cache_ttl=60) == {"results": ["one"]}
    assert len(session.calls) == 1
    assert manager.metrics()["cache_hits"] == 1


def test_request_manager_retries_429_after_retry_after():
    delays = []
    session = Session([
        Response(status_code=429, headers={"Retry-After": "3"}),
        Response(payload={"ok": True}),
    ])
    manager = ItemitRequestManager(session, requests_per_minute=100, sleep=delays.append)
    assert manager.get_json("items") == {"ok": True}
    assert len(session.calls) == 2
    assert 3 in delays
    assert manager.metrics()["rate_limit_responses"] == 1
    assert manager.metrics()["retry_attempts"] == 1


def test_missing_detail_memberships_probes_once_then_stops():
    calls = []
    client = object.__new__(ItemitClient)
    client.get_item = lambda item_id: calls.append(item_id) or {"id": item_id, "name": "Asset"}
    records = client.resolve_item_collection_memberships([
        {"id": "one", "name": "One"}, {"id": "two", "name": "Two"},
    ])
    assert calls == ["one"]
    assert [record["status"] for record in records] == ["UNKNOWN", "UNKNOWN"]
    assert "skipped" in records[1]["detail_error"]


def test_collection_profiles_resolve_memberships_without_item_details():
    client = object.__new__(ItemitClient)
    records = client.resolve_collection_profile_memberships(
        [{"id": "i1"}, {"id": "i2"}, {"id": "i3"}],
        [{"id": "c1"}, {"id": "c2"}],
        [
            {"id": "c1", "items": {"total": 2, "results": [{"id": "i1"}, {"id": "i2"}]}},
            {"id": "c2", "items": {"total": 1, "results": [{"id": "i1"}]}},
        ],
    )
    assert records == [
        {"item_id": "i1", "status": "COMPLETE", "memberships": ["c1", "c2"], "source": "COLLECTION_PROFILE"},
        {"item_id": "i2", "status": "COMPLETE", "memberships": ["c1"], "source": "COLLECTION_PROFILE"},
        {"item_id": "i3", "status": "EMPTY", "memberships": [], "source": "COLLECTION_PROFILE"},
    ]


def test_incomplete_collection_profile_is_additive_only():
    client = object.__new__(ItemitClient)
    records = client.resolve_collection_profile_memberships(
        [{"id": "i1"}], [{"id": "c1"}],
        [{"id": "c1", "items": {"total": 2, "results": [{"id": "i1"}]}}],
    )
    assert records[0]["status"] == "PARTIAL"
    assert records[0]["memberships"] == ["c1"]
    assert "truncated" in records[0]["detail_error"]


def test_missing_collection_profile_preserves_all_memberships_as_unknown():
    client = object.__new__(ItemitClient)
    records = client.resolve_collection_profile_memberships(
        [{"id": "i1"}], [{"id": "c1"}], [],
    )
    assert records[0]["status"] == "UNKNOWN"
    assert "missing Collection profiles" in records[0]["detail_error"]
