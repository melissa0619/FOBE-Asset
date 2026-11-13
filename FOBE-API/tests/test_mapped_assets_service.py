import json
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))

import main as api
from display_name import FALLBACK_DISPLAY_NAME, default_display_name, resolved_display_name
from firestore_mapping_store import MappingStoreUnavailable
from ifc_index_store import IfcIndexError, IfcIndexStore
from mapped_assets_service import COLUMNS, MappedAssetsService


class Store:
    def __init__(self, rows):
        self.rows = rows

    def list(self):
        return self.rows


def write_indexes(tmp_path, elements_by_model):
    models = []
    for key, elements in elements_by_model.items():
        filename = f"{key}.index.json"
        (tmp_path / filename).write_text(json.dumps({
            "schemaVersion": "1.0", "modelKey": key, "elements": elements,
        }), encoding="utf-8")
        models.append({"key": key, "file": filename})
    (tmp_path / "manifest.json").write_text(json.dumps({"schemaVersion": "1.0", "models": models}), encoding="utf-8")


def element(model, global_id="gid"):
    return {"identity": {"modelKey": model, "globalId": global_id, "stableKey": f"{model}:{global_id}"}, "name": "Desk", "ifcType": "IFCFURNISHINGELEMENT", "description": "d", "objectType": "Desk", "tag": "T1", "candidate": {"classification": "LIKELY_ASSET"}}


def mapping(model="white", global_id="gid", item_id="item-1", status="CONFIRMED", is_mapped=True):
    return {"model_key": model, "ifc_global_id": global_id, "itemit_item_id": item_id, "is_mapped": is_mapped, "mapping_status": status, "mapping_method": "MANUAL", "notes": "checked", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z"}


def asset(item_id="item-1", active=True):
    return {"id": item_id, "name": "Desk Asset", "serial": "S1", "is_active": active, "archived": False, "current_location": "White Box", "collection_memberships": [{"id": "c1", "name": "Furniture", "source": "itemit_api"}], "collections": ["Furniture"]}


def service(tmp_path, mappings, assets, indexes=None):
    write_indexes(tmp_path, indexes or {"white": [element("white")]})
    return MappedAssetsService(Store(mappings), IfcIndexStore(tmp_path), lambda **_: assets)


def test_three_way_join_uses_is_mapped_and_csv(tmp_path):
    unified = service(tmp_path, [mapping(), mapping(status="CONFIRMED", is_mapped=False)], [asset()])
    records = unified.records()
    assert len(records) == 1
    assert list(records[0]) == COLUMNS
    assert records[0]["ifc_name"] == "Desk"
    assert records[0]["itemit_name"] == "Desk Asset"
    assert records[0]["ifc_found"] is True and records[0]["itemit_found"] is True
    assert '"Furniture"' in unified.csv()


def test_legacy_confirmed_mapping_without_is_mapped_remains_active(tmp_path):
    legacy = mapping()
    legacy.pop("is_mapped")
    assert len(service(tmp_path, [legacy], [asset()]).records()) == 1


def test_missing_ifc_and_itemit_are_retained_with_integrity_flags(tmp_path):
    unified = service(tmp_path, [mapping(global_id="missing", item_id="gone")], [])
    row = unified.records()[0]
    assert row["ifc_found"] is False and row["itemit_found"] is False
    assert row["ifc_name"] is None and row["itemit_name"] is None


def test_inactive_itemit_asset_is_included(tmp_path):
    row = service(tmp_path, [mapping()], [asset(active=False)]).records()[0]
    assert row["itemit_found"] is True
    assert row["itemit_is_active"] is False


def test_empty_dataset_has_stable_schema_and_header_only_csv(tmp_path):
    unified = service(tmp_path, [], [])
    assert unified.records() == []
    assert unified.csv().strip().split(",") == COLUMNS


def test_duplicate_mapping_and_index_identities_are_rejected(tmp_path):
    with pytest.raises(ValueError, match="Duplicate confirmed"):
        service(tmp_path, [mapping(), mapping()], [asset()]).dataframe()
    duplicate = [element("white"), element("white")]
    write_indexes(tmp_path, {"white": duplicate})
    with pytest.raises(IfcIndexError, match="duplicate identity"):
        IfcIndexStore(tmp_path).records()


def test_building_overview_resolution_matches_frontend_semantics(tmp_path):
    write_indexes(tmp_path, {"building": [element("building")], "white": [element("white")]})
    indexes = IfcIndexStore(tmp_path)
    assert indexes.resolve_mapping_identity("building", "gid") == ("white", "gid")
    assert indexes.get("white", "gid")["model_key"] == "white"


def test_firestore_failure_is_not_converted_to_empty_result(tmp_path):
    class FailingStore:
        def list(self):
            raise MappingStoreUnavailable("Firestore unavailable")
    write_indexes(tmp_path, {"white": [element("white")]})
    unified = MappedAssetsService(FailingStore(), IfcIndexStore(tmp_path), lambda **_: [])
    with pytest.raises(MappingStoreUnavailable):
        unified.records()


def test_json_and_csv_endpoints_use_the_same_service(monkeypatch):
    class FakeService:
        def records(self):
            return [{"ok": True}]
        def csv(self):
            return "ok\ntrue\n"
    monkeypatch.setattr(api, "mapped_assets_service", lambda: FakeService())
    assert api.list_mapped_assets() == [{"ok": True}]
    response = api.export_mapped_assets_csv()
    assert response.body == b"ok\ntrue\n"
    assert response.headers["content-disposition"] == "attachment; filename=mapped-assets.csv"


def test_display_name_selection_and_legacy_dataframe_fallback(tmp_path):
    assert default_display_name("Long IFC Asset", "Desk") == "Desk"
    assert default_display_name("Desk", "Long itemit asset") == "Desk"
    assert default_display_name("Same", "Size") == "Same"  # IFC wins ties.
    assert default_display_name("  ", " Item ") == "Item"
    assert default_display_name(None, None) == FALLBACK_DISPLAY_NAME

    # IFC index labels may have Revit-style colon-qualified details.  Compare
    # the same human label the Mapping Review UI presents to users.
    assert default_display_name(
        "  1 Gang 1 Way Switch:1 Gang 1 Way Switch  ",
        "4 FOLD PUSH BUTTON, WHITE c/w FRAME",
    ) == "1 Gang 1 Way Switch"

    # New provenance protects any explicitly edited label, even if it is
    # longer than either source name.
    assert resolved_display_name(
        {"display_name": "Custom user label", "display_name_source": "CUSTOM"},
        "Desk:Desk", "Chair",
    ) == "Custom user label"

    # A legacy value matching the old generated value and never updated is
    # safely re-resolved without mutating Firestore.
    legacy_auto = {
        "display_name": "4 FOLD PUSH BUTTON, WHITE c/w FRAME",
        "created_at": "2026-11-12T13:11:41.580000+00:00",
        "updated_at": "2026-11-12T13:11:41.580000+00:00",
    }
    assert resolved_display_name(
        legacy_auto,
        "1 Gang 1 Way Switch:1 Gang 1 Way Switch",
        "4 FOLD PUSH BUTTON, WHITE c/w FRAME",
    ) == "1 Gang 1 Way Switch"
    legacy_custom = {**legacy_auto, "updated_at": "2026-11-12T14:00:00+00:00"}
    assert resolved_display_name(
        legacy_custom,
        "1 Gang 1 Way Switch:1 Gang 1 Way Switch",
        "4 FOLD PUSH BUTTON, WHITE c/w FRAME",
    ) == "4 FOLD PUSH BUTTON, WHITE c/w FRAME"

    switch_index = {
        "white": [{**element("white"), "name": "1 Gang 1 Way Switch:1 Gang 1 Way Switch"}],
    }
    switch_asset = {**asset(), "name": "4 FOLD PUSH BUTTON, WHITE c/w FRAME"}
    exported = service(tmp_path, [{**mapping(), **legacy_auto}], [switch_asset], switch_index)
    assert exported.records()[0]["display_name"] == "1 Gang 1 Way Switch"
    assert "1 Gang 1 Way Switch" in exported.csv()

    row = service(tmp_path, [mapping()], [asset()]).records()[0]
    assert row["display_name"] == "Desk"
    persisted = service(tmp_path, [{**mapping(), "display_name": "  Edited Desk  "}], [asset()]).records()[0]
    assert persisted["display_name"] == "Edited Desk"
