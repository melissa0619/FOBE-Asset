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
    MappingAssetAssigned,
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
                if self.records[key].get("is_mapped", self.records[key]["mapping_status"] == "CONFIRMED"):
                    raise MappingConfirmed()
                raise MappingAlreadyExists()
            if any(existing.get("model_key") == record["model_key"]
                   and existing.get("itemit_item_id") == record["itemit_item_id"]
                   and existing.get("is_mapped", existing.get("mapping_status") == "CONFIRMED")
                   for existing in self.records.values()):
                raise MappingAssetAssigned()
            now = datetime.now(timezone.utc).isoformat()
            self.records[key] = {**record, "mapping_id": key, "document_id": key,
                                 "is_mapped": True, "mapping_status": "CONFIRMED",
                                 "created_at": now, "updated_at": now}
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
            if self.records[key].get("is_mapped", self.records[key]["mapping_status"] == "CONFIRMED"):
                raise MappingConfirmed()
            self.records[key].update(changes)
            self.records[key]["updated_at"] = datetime.now(timezone.utc).isoformat()
            return self.records[key].copy()

    def update_display_name(self, model_key, ifc_global_id, display_name):
        key = mapping_document_id(model_key, ifc_global_id)
        with self.lock:
            if key not in self.records:
                raise MappingNotFound()
            self.records[key]["display_name"] = display_name
            self.records[key]["display_name_source"] = "CUSTOM"
            self.records[key]["updated_at"] = datetime.now(timezone.utc).isoformat()
            return self.records[key].copy()

    def delete(self, model_key, ifc_global_id):
        key = mapping_document_id(model_key, ifc_global_id)
        with self.lock:
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
    class Index:
        def resolve_mapping_identity(self, model_key, ifc_global_id):
            return model_key, ifc_global_id
        def get(self, model_key, ifc_global_id):
            return {"model_key": model_key, "ifc_global_id": ifc_global_id, "ifc_name": "IFC Asset"}
    monkeypatch.setattr(api, "DATABASE_PATH", db_path)
    monkeypatch.setattr(api, "MAPPING_STORE_FACTORY", lambda: store)
    monkeypatch.setattr(api, "IFC_INDEX_STORE", Index())
    monkeypatch.setenv("FOBE_ENABLE_MAPPING_WRITES", "true")
    return store


def payload(itemit_item_id="item-a"):
    return {"model_key": "foyer", "ifc_global_id": "2aBcD3", "itemit_item_id": itemit_item_id, "notes": "Verified on site"}


def test_document_identifier_uses_complete_pair():
    assert mapping_document_id("a:b", "c") != mapping_document_id("a", "b:c")
    assert mapping_document_id("foyer", "2aBcD3") == mapping_document_id("foyer", "2aBcD3")


def test_transaction_snapshot_accepts_current_firestore_generator_api():
    class Snapshot:
        exists = False
    class Transaction:
        def get(self, _):
            yield Snapshot()
    assert FirestoreMappingStore._transaction_snapshot(Transaction(), object()).exists is False


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
            if isinstance(ref, Collection):
                return []
            return Snapshot(self.client.records.get(ref.key))

        def create(self, ref, data):
            assert ref.key not in self.client.records
            self.client.records[ref.key] = data.copy()

    class Collection:
        def __init__(self, client):
            self.client = client

        def document(self, key):
            return Ref(self.client, key)

        def where(self, *_):
            return self

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
    assert created["is_mapped"] is True
    assert created["mapping_id"] == mapping_document_id("foyer", "2aBcD3")
    assert created["document_id"] == created["mapping_id"]
    assert created["ifc_name"] == "IFC Asset"
    assert created["itemit_name"] == "Asset A"
    assert created["mapping_method"] == "MANUAL"
    assert created["display_name"] == "Asset A"
    assert created["display_name_source"] == "AUTO"
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

    assert api.delete_mapping("foyer", "2aBcD3").status_code == 204
    with pytest.raises(HTTPException) as missing:
        api.get_mapping_status("foyer", "2aBcD3")
    assert missing.value.status_code == 404
    assert len(store.records) == 0


def test_unmapping_allows_remapping_with_a_fresh_automatic_display_name(tmp_path, monkeypatch):
    store = database_with_inventory(tmp_path, monkeypatch)
    created = api.create_mapping(api.MappingCreate(**payload("item-a")))
    api.update_mapping_display_name(api.DisplayNameUpdate(
        model_key="foyer", ifc_global_id="2aBcD3", display_name="Custom label"
    ))
    assert api.delete_mapping("foyer", "2aBcD3").status_code == 204
    remapped = api.create_mapping(api.MappingCreate(**payload("item-b")))
    assert remapped["mapping_id"] == created["mapping_id"]
    assert remapped["itemit_item_id"] == "item-b"
    assert remapped["display_name"] == "Asset B"
    assert remapped["display_name_source"] == "AUTO"


def test_same_model_itemit_assignment_is_rejected_and_released_by_unmapping(tmp_path, monkeypatch):
    database_with_inventory(tmp_path, monkeypatch)
    api.create_mapping(api.MappingCreate(**payload("item-a")))
    with pytest.raises(HTTPException) as assigned:
        api.create_mapping(api.MappingCreate(**{**payload("item-a"), "ifc_global_id": "other"}))
    assert assigned.value.status_code == 409
    assert "already mapped to another" in assigned.value.detail
    api.delete_mapping("foyer", "2aBcD3")
    assert api.create_mapping(api.MappingCreate(**{**payload("item-a"), "ifc_global_id": "other"}))["is_mapped"] is True


def test_confirmed_display_name_can_change_without_changing_identity(tmp_path, monkeypatch):
    store = database_with_inventory(tmp_path, monkeypatch)
    created = api.create_mapping(api.MappingCreate(**payload()))
    updated = api.update_mapping_display_name(api.DisplayNameUpdate(
        model_key="foyer", ifc_global_id="2aBcD3", display_name="  Edited Asset  "
    ))
    assert updated["display_name"] == "Edited Asset"
    assert updated["display_name_source"] == "CUSTOM"
    assert updated["model_key"] == created["model_key"]
    assert updated["ifc_global_id"] == created["ifc_global_id"]
    assert updated["itemit_item_id"] == created["itemit_item_id"]
    assert updated["mapping_status"] == "CONFIRMED"
    with pytest.raises(HTTPException) as blank:
        api.update_mapping_display_name(api.DisplayNameUpdate(model_key="foyer", ifc_global_id="2aBcD3", display_name="   "))
    assert blank.value.status_code == 400


def test_display_name_update_missing_mapping_and_firestore_failure(tmp_path, monkeypatch):
    database_with_inventory(tmp_path, monkeypatch)
    with pytest.raises(HTTPException) as missing:
        api.update_mapping_display_name(api.DisplayNameUpdate(model_key="foyer", ifc_global_id="missing", display_name="Name"))
    assert missing.value.status_code == 404
    class FailingStore:
        def update_display_name(self, *_):
            raise MappingStoreUnavailable("Firestore unavailable")
    monkeypatch.setattr(api, "MAPPING_STORE_FACTORY", FailingStore)
    with pytest.raises(HTTPException) as unavailable:
        api.update_mapping_display_name(api.DisplayNameUpdate(model_key="foyer", ifc_global_id="id", display_name="Name"))
    assert unavailable.value.status_code == 503


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


def test_concurrent_creation_cannot_assign_one_asset_twice(tmp_path, monkeypatch):
    store = database_with_inventory(tmp_path, monkeypatch)

    def create(global_id):
        try:
            return api.create_mapping(api.MappingCreate(**{**payload("item-a"), "ifc_global_id": global_id}))
        except HTTPException as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(create, ["one", "two"]))
    assert len([outcome for outcome in outcomes if isinstance(outcome, dict)]) == 1
    conflicts = [outcome for outcome in outcomes if isinstance(outcome, HTTPException)]
    assert len(conflicts) == 1 and conflicts[0].status_code == 409
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
