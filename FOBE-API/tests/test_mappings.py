import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))
import main as api
from firestore_mapping_store import MappingAlreadyExists, MappingNotFound, MappingStoreUnavailable, mapping_document_id


class IsolatedFirestore:
    """Credential-free isolated Firestore resource for API contract tests."""

    def __init__(self):
        self.records = {}

    def create(self, record):
        key = mapping_document_id(record["model_key"], record["ifc_global_id"])
        if key in self.records:
            raise MappingAlreadyExists()
        now = datetime.now(timezone.utc).isoformat()
        self.records[key] = {**record, "created_at": now, "updated_at": now}
        return self.records[key].copy()

    def get(self, model_key, ifc_global_id):
        try:
            return self.records[mapping_document_id(model_key, ifc_global_id)].copy()
        except KeyError as error:
            raise MappingNotFound() from error

    def list(self, model_key=None, itemit_item_id=None):
        return [
            row.copy() for row in self.records.values()
            if (not model_key or row["model_key"] == model_key)
            and (not itemit_item_id or row["itemit_item_id"] == itemit_item_id)
        ]

    def update(self, model_key, ifc_global_id, changes):
        key = mapping_document_id(model_key, ifc_global_id)
        if key not in self.records:
            raise MappingNotFound()
        self.records[key].update(changes)
        self.records[key]["updated_at"] = datetime.now(timezone.utc).isoformat()
        return self.records[key].copy()

    def delete(self, model_key, ifc_global_id):
        key = mapping_document_id(model_key, ifc_global_id)
        if key not in self.records:
            raise MappingNotFound()
        del self.records[key]


def database_with_inventory(tmp_path, monkeypatch):
    db_path = tmp_path / "asset_sync.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute("""CREATE TABLE items (
            id TEXT PRIMARY KEY, name TEXT, serial TEXT, archived INTEGER,
            raw_json TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
        )""")
        conn.execute("INSERT INTO items (id, raw_json) VALUES (?, ?)", ("item-a", '{"id":"item-a","name":"Asset A"}'))
        conn.execute("INSERT INTO items (id, raw_json) VALUES (?, ?)", ("item-b", '{"id":"item-b","name":"Asset B"}'))
    store = IsolatedFirestore()
    monkeypatch.setattr(api, "DATABASE_PATH", db_path)
    monkeypatch.setattr(api, "MAPPING_STORE_FACTORY", lambda: store)
    monkeypatch.setenv("FOBE_ENABLE_MAPPING_WRITES", "true")
    return store


def payload(itemit_item_id="item-a"):
    return {"model_key": "foyer", "ifc_global_id": "2aBcD3", "itemit_item_id": itemit_item_id, "notes": "Verified on site"}


def test_document_identifier_uses_complete_pair():
    assert mapping_document_id("a:b", "c") != mapping_document_id("a", "b:c")
    assert mapping_document_id("foyer", "2aBcD3") == mapping_document_id("foyer", "2aBcD3")


def test_firestore_mapping_crud_duplicate_validation_and_persistence(tmp_path, monkeypatch):
    store = database_with_inventory(tmp_path, monkeypatch)
    route_paths = {route.path for route in api.app.routes}
    assert {"/mappings", "/mappings/status", "/mappings/{model_key}/{ifc_global_id}"} <= route_paths
    created = api.create_mapping(api.MappingCreate(**payload()))
    assert created["mapping_status"] == "PROVISIONAL"
    assert created["mapping_method"] == "MANUAL"
    assert created["authenticated_user"] == "local-unverified"

    with pytest.raises(HTTPException) as duplicate:
        api.create_mapping(api.MappingCreate(**payload()))
    assert duplicate.value.status_code == 409
    with pytest.raises(HTTPException) as invalid_item:
        api.create_mapping(api.MappingCreate(**payload("missing-item")))
    assert invalid_item.value.status_code == 422

    assert api.get_mapping_status("foyer", "2aBcD3")["itemit_item_id"] == "item-a"
    assert api.list_mappings(model_key="foyer")[0]["ifc_global_id"] == "2aBcD3"
    remapped = api.update_mapping("foyer", "2aBcD3", api.MappingUpdate(itemit_item_id="item-b", mapping_status="CONFIRMED"))
    assert remapped["itemit_item_id"] == "item-b"
    assert remapped["mapping_status"] == "CONFIRMED"

    second_model = api.create_mapping(api.MappingCreate(**{**payload("item-b"), "model_key": "building"}))
    assert second_model["itemit_item_id"] == "item-b"
    assert len(store.records) == 2

    with pytest.raises(HTTPException) as same_model_conflict:
        api.create_mapping(api.MappingCreate(**{**payload("item-b"), "ifc_global_id": "other-ifc"}))
    assert same_model_conflict.value.status_code == 409

    assert api.delete_mapping("foyer", "2aBcD3").status_code == 204
    with pytest.raises(HTTPException) as missing:
        api.get_mapping_status("foyer", "2aBcD3")
    assert missing.value.status_code == 404
    assert len(store.records) == 1


def test_mapping_writes_are_disabled_by_default(tmp_path, monkeypatch):
    database_with_inventory(tmp_path, monkeypatch)
    monkeypatch.delenv("FOBE_ENABLE_MAPPING_WRITES")
    with pytest.raises(HTTPException) as disabled:
        api.create_mapping(api.MappingCreate(**payload()))
    assert disabled.value.status_code == 403


def test_firestore_connection_failure_is_not_reported_as_unmapped(tmp_path, monkeypatch):
    database_with_inventory(tmp_path, monkeypatch)

    class FailingStore:
        def get(self, *_):
            raise MappingStoreUnavailable("Firestore is unavailable; check Firebase configuration")

    monkeypatch.setattr(api, "MAPPING_STORE_FACTORY", FailingStore)
    with pytest.raises(HTTPException) as failure:
        api.get_mapping_status("foyer", "2aBcD3")
    assert failure.value.status_code == 503
