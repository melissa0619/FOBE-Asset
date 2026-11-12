import json
import sqlite3
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))
import main as api
from matching import normalize_ifc_element, normalize_location


def candidate_database(tmp_path, monkeypatch, count=4):
    path = tmp_path / "assets.db"
    with sqlite3.connect(path) as conn:
        conn.executescript("""
            CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, serial TEXT, archived INTEGER, raw_json TEXT NOT NULL, is_active INTEGER NOT NULL);
            CREATE TABLE item_locations (item_id TEXT PRIMARY KEY, location TEXT NOT NULL);
            CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT, raw_json TEXT, is_active INTEGER);
            CREATE TABLE item_collections (item_id TEXT, collection_id TEXT, source TEXT NOT NULL DEFAULT 'itemit_pdf_2026-10-18');
        """)
        conn.executemany(
            "INSERT INTO collections VALUES (?, ?, NULL, '{}', 1)",
            [("c1", "Furniture"), ("c2", "White Box"), ("c3", "Empty Collection")],
        )
        for number in range(count):
            item_id = f"item-{number:03d}"
            name = "Stick Chair" if number < 33 else f"Asset {number:03d}"
            raw = json.dumps({"id": item_id, "name": name, "serial": f"D108G/A{number:02d}"})
            conn.execute("INSERT INTO items VALUES (?, ?, ?, 0, ?, 1)", (item_id, name, f"D108G/A{number:02d}", raw))
            conn.execute("INSERT INTO item_locations VALUES (?, ?)", (item_id, "White Box (D108G)" if number < 33 else "Foyer"))
            conn.execute("INSERT INTO item_collections VALUES (?, 'c1', 'itemit_pdf_2026-10-18')", (item_id,))
            if number == 0:
                conn.execute("INSERT INTO item_collections VALUES (?, 'c2', 'itemit_pdf_2026-10-18')", (item_id,))
    monkeypatch.setattr(api, "DATABASE_PATH", path)


def test_normalization_handles_missing_generic_and_room_aliases():
    normalized = normalize_ifc_element({"modelKey": "white", "ifcType": "IfcBuildingElementProxy", "room": {"name": "D108G"}})
    assert normalized["model_key"] == "white"
    assert normalized["category"] is None
    assert normalized["room"] == "white-box"
    assert normalize_location("Wrong Room") == "wrong room"


def test_ifc_export_name_keeps_raw_value_but_derives_room_and_tokens():
    normalized = normalize_ifc_element({"name": "Table (White Box):Table D108G:447608", "ifcType": "IfcFurnishingElement"})
    assert normalized["name"] == "table white box table d108g 447608"
    assert normalized["room"] == "white-box"
    assert normalized["room_source"] == "NAME_INFERENCE"
    assert "table" in normalized["name_tokens"]


def test_assets_include_multiple_collections_and_pagination(tmp_path, monkeypatch):
    candidate_database(tmp_path, monkeypatch, count=320)
    first = api.list_assets(limit=100, offset=0)
    last = api.list_assets(limit=100, offset=300)
    assert len(first) == 100
    assert len(last) == 20
    chair = api.get_asset("item-000")
    assert {entry["name"] for entry in chair["collection_memberships"]} == {"Furniture", "White Box"}


def test_collections_include_empty_collections_and_support_lookup(tmp_path, monkeypatch):
    candidate_database(tmp_path, monkeypatch, count=2)
    collections = api.list_collections(limit=100, offset=0)
    empty = next(collection for collection in collections if collection["id"] == "c3")
    assert empty == {
        "id": "c3", "name": "Empty Collection", "parent_id": None, "is_active": True,
    }
    assert api.get_collection("c3") == empty


def test_candidate_filters_are_explicit_and_repeated_chairs_remain_available(tmp_path, monkeypatch):
    candidate_database(tmp_path, monkeypatch, count=40)
    request = api.CandidateRequest(
        model_key="white", global_id="abc", name="Generic proxy", ifc_type="IfcBuildingElementProxy",
        room={"name": "Wrong Room"}, filters={"name": "Stick Chair", "location": "D108G"}, limit=25,
    )
    first = api.retrieve_candidates(request)
    assert first["total"] == 33
    assert len(first["candidates"]) == 25
    assert first["ifc"]["normalized"]["room"] == "wrong room"
    second = api.retrieve_candidates(request.model_copy(update={"offset": 25}))
    assert len(second["candidates"]) == 8
    assert all(item["name"] == "Stick Chair" for item in first["candidates"] + second["candidates"])


def test_candidate_retrieval_never_calls_mapping_storage(tmp_path, monkeypatch):
    candidate_database(tmp_path, monkeypatch, count=2)
    response = api.retrieve_candidates(api.CandidateRequest())
    assert response["total"] == 2
    assert "mapping" in response["notice"].lower()


