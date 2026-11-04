from api.itemit_client import ItemitClient


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
