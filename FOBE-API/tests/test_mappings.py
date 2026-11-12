import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

import pytest
from firebase_admin import firestore as admin_firestore
from fastapi import HTTPException

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))
import main as api
from firestore_mapping_store import (
    FirestoreMappingStore,
    MappingAlreadyExists,
    MappingConfirmed,
    MappingNotFound,
    MappingStoreUnavailable,
    mapping_document_id,
)


class IsolatedFirestore:
    """Credential-free isolated Firestore resource for API contract tests."""

    def __init__(self):
        self.records = {}
        self.lock = Lock()

    def create(self, record):
        key = mapping_document_id(record["model_key"], record["ifc_global_id"])
        with self.lock:
            if key in self.records:
                if self.records[key]["mapping_status"] == "CONFIRMED":
                    raise MappingConfirmed()
                raise MappingAlreadyExists()
            now = datetime.now(timezone.utc).isoformat()
            self.records[key] = {**record, "mapping_status": "CONFIRMED", "created_at": now, "updated_at": now}
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
        with self.lock:
            if key not in self.records:
                raise MappingNotFound()
            if self.records[key]["mapping_status"] == "CONFIRMED":
                raise MappingConfirmed()
            self.records[key].update(changes)
            self.records[key]["updated_at"] = datetime.now(timezone.utc).isoformat()
            return self.records[key].copy()

    def delete(self, model_key, ifc_global_id):
        key = mapping_document_id(model_key, ifc_global_id)
        with self.lock:
            if key not in self.records:
                raise MappingNotFound()
            if self.records[key]["mapping_status"] == "CONFIRMED":
                raise MappingConfirmed()
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


def test_firestore_store_uses_transaction_to_preserve_confirmed_mapping(monkeypatch):
    class Snapshot:
        def __init__(self, record):
            self.record = record
            self.exists = record is not None

        def to_dict(self):
            return self.record.copy() if self.record else None

    class Ref:
        def __init__(self, client, key):
            self.client = client
            self.key = key
            self.id = key

        def get(self):
            return Snapshot(self.client.records.get(self.key))

    class Transaction:
        def __init__(self, client):
            self.client = client

        def get(self, ref):
            return Snapshot(self.client.records.get(ref.key))

        def create(self, ref, data):
            assert ref.key not in self.client.records
            self.client.records[ref.key] = data.copy()

    class Collection:
        def __init__(self, client):
            self.client = client

        def document(self, key):
            return Ref(self.client, key)

    class Client:
        def __init__(self):
            self.records = {}
            self.transaction_count = 0

        def collection(self, _):
            return Collection(self)

        def transaction(self):
            self.transaction_count += 1
            return Transaction(self)

    client = Client()
    monkeypatch.setattr(admin_firestore, "transactional", lambda fn: fn)
    store = FirestoreMappingStore(client=client)
    record = {**payload(), "mapping_status": "PROVISIONAL"}
    first = store.create(record)
    assert first["mapping_status"] == "CONFIRMED"
    with pytest.raises(MappingConfirmed):
        store.create({**record, "itemit_item_id": "item-b"})
    assert client.transaction_count == 2
    assert store.get("foyer", "2aBcD3")["itemit_item_id"] == "item-a"


def test_confirmed_mapping_is_created_once_and_remains_queryable(tmp_path, monkeypatch):
    store = database_with_inventory(tmp_path, monkeypatch)
    route_paths = {route.path for route in api.app.routes}
    assert {"/mappings", "/mappings/status", "/mappings/{model_key}/{ifc_global_id}"} <= route_paths
    created = api.create_mapping(api.MappingCreate(**payload()))
    assert created["mapping_status"] == "CONFIRMED"
    assert created["mapping_method"] == "MANUAL"
    assert created["authenticated_user"] == "local-unverified"

    with pytest.raises(HTTPException) as duplicate:
        api.create_mapping(api.MappingCreate(**{**payload("item-b"), "notes": "Attempted replacement"}))
    assert duplicate.value.status_code == 409
    assert duplicate.value.detail == "This IFC element is already mapped and confirmed."
    with pytest.raises(HTTPException) as invalid_item:
        api.create_mapping(api.MappingCreate(**payload("missing-item")))
    assert invalid_item.value.status_code == 422

    current = api.get_mapping_status("foyer", "2aBcD3")
    assert current["itemit_item_id"] == "item-a"
    assert current["mapping_status"] == "CONFIRMED"
    assert api.list_mappings(model_key="foyer") == [current]

    with pytest.raises(HTTPException) as update:
        api.update_mapping("foyer", "2aBcD3", api.MappingUpdate(itemit_item_id="item-b"))
    assert update.value.status_code == 409
    assert update.value.detail == "This IFC element is already mapped and confirmed."

    with pytest.raises(HTTPException) as delete:
        api.delete_mapping("foyer", "2aBcD3")
    assert delete.value.status_code == 409
    assert delete.value.detail == "This IFC element is already mapped and confirmed."
    assert api.get_mapping_status("foyer", "2aBcD3") == current
    assert len(store.records) == 1


def test_concurrent_creation_cannot_overwrite_confirmed_mapping(tmp_path, monkeypatch):
    store = database_with_inventory(tmp_path, monkeypatch)

    def create(item_id):
        try:
            return api.create_mapping(api.MappingCreate(**payload(item_id)))
        except HTTPException as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(create, ["item-a", "item-b"]))

    successes = [outcome for outcome in outcomes if isinstance(outcome, dict)]
    conflicts = [outcome for outcome in outcomes if isinstance(outcome, HTTPException)]
    assert len(successes) == 1
    assert len(conflicts) == 1
    assert conflicts[0].status_code == 409
    assert conflicts[0].detail == "This IFC element is already mapped and confirmed."
    stored = api.get_mapping_status("foyer", "2aBcD3")
    assert stored["mapping_status"] == "CONFIRMED"
    assert stored["itemit_item_id"] == successes[0]["itemit_item_id"]
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
