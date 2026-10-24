
"""Offline tests using a copy of the real baseline."""

import json
import shutil
import sqlite3
from uuid import uuid4

from handlers.change_handler import sync_snapshot
from storage.database import DB_PATH


def test_simulated_changes(tmp_path):
    # Never modify the real database during this test.
    test_db = tmp_path / "asset_sync_test.db"
    shutil.copy2(DB_PATH, test_db)

    with sqlite3.connect(test_db) as conn:
        items = [
            json.loads(row[0])
            for row in conn.execute(
                "SELECT raw_json FROM items"
            )
        ]

        collections = [
            json.loads(row[0])
            for row in conn.execute(
                "SELECT raw_json FROM collections"
            )
        ]

        locations = {
            row[0]: row[1]
            for row in conn.execute(
                "SELECT item_id, location FROM item_locations"
            )
        }

    # TEST A: Modify an existing item.
    items[0]["name"] += " [SIMULATED UPDATE]"

    # TEST B: Move an existing item.
    moved_id = next(iter(locations))

    black_box = "BIM Centre, D108C, Black Box"
    white_box = "BIM Centre, D108G, White Box"

    locations[moved_id] = (
        black_box
        if locations[moved_id] != black_box
        else white_box
    )

    # TEST C: Add a new item.
    new_item_id = str(uuid4())

    items.append({
        "id": new_item_id,
        "name": "Test Asset",
        "serial": "TEST-001",
        "archived": False,
    })

    # TEST D: Add a new Collection.
    collections.append({
        "id": str(uuid4()),
        "name": "Test Collection",
        "type": "COLLECTION",
        "parent": None,
    })

    # Apply all four simulated changes.
    events = sync_snapshot(
        items,
        collections,
        locations,
        db_path=test_db,
    )

    print("\n--- SIMULATED EVENTS ---")

    for event in events:
        print(event["event_type"])

    event_types = [event["event_type"] for event in events]

    assert len(events) == 4
    assert event_types.count("ITEM_ADDED") == 1
    assert event_types.count("ITEM_UPDATED") == 1
    assert event_types.count("ITEM_LOCATION_CHANGED") == 1
    assert event_types.count("COLLECTION_ADDED") == 1

    # Repeating the identical snapshot must create no events.
    repeated_events = sync_snapshot(
        items,
        collections,
        locations,
        db_path=test_db,
    )

    assert repeated_events == []

    print("\nRepeated sync: 0 new events")
    print("All simulated change detection tests passed!")
