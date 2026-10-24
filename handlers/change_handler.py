import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from storage.database import DB_PATH


def build_index(records, label):
    """Validate UUIDs and index records by ID."""
    if not isinstance(records, list) or not records:
        raise ValueError(f"{label} data is empty or invalid")

    result = {}

    for record in records:
        if not isinstance(record, dict) or not record.get("id"):
            raise ValueError(f"{label} contains a record without an ID")

        record_id = record["id"]

        if record_id in result:
            raise ValueError(f"Duplicate {label} ID: {record_id}")

        result[record_id] = record

    return result


def item_fields(item):
    """Only meaningful asset fields generate ITEM_UPDATED."""
    return {
        "name": item.get("name"),
        "serial": item.get("serial"),
        "description": item.get("description") or "",
        "archived": bool(item.get("archived", False)),
    }


def collection_fields(collection):
    """Track category names, parents and colours."""
    parent = collection.get("parent") or {}

    return {
        "name": collection.get("name"),
        "parent_id": parent.get("id"),
        "colour": collection.get("colour"),
    }


def sync_snapshot(
    items,
    collections,
    current_locations,
    db_path=DB_PATH,
    ignored_missing_collection_ids=None,
):
    """Compare a complete snapshot and update SQLite atomically."""

    db_path = Path(db_path)

    if not db_path.is_file():
        raise FileNotFoundError(
            "Baseline database not found. Run initialization first."
        )

    new_items = build_index(items, "Items")
    new_collections = build_index(collections, "Collections")

    if not isinstance(current_locations, dict):
        raise ValueError("Current locations must be a dictionary")

    detected_at = datetime.now(timezone.utc).isoformat()
    events = []

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("BEGIN IMMEDIATE")

        baseline = conn.execute(
            "SELECT value FROM sync_metadata "
            "WHERE key = 'baseline_initialized'"
        ).fetchone()

        if not baseline:
            raise RuntimeError("Initial baseline has not been created")

        old_items = {
            row["id"]: json.loads(row["raw_json"])
            for row in conn.execute("SELECT id, raw_json FROM items")
        }

        old_collections = {
            row["id"]: json.loads(row["raw_json"])
            for row in conn.execute(
                "SELECT id, raw_json FROM collections"
            )
        }

        old_locations = {
            row["item_id"]: row["location"]
            for row in conn.execute(
                "SELECT item_id, location FROM item_locations"
            )
        }

        # Safety: deletion handling is not implemented yet.
        missing_items = set(old_items) - set(new_items)
        missing_collections = set(old_collections) - set(new_collections)

        
        missing_items = set(old_items) - set(new_items)
        missing_collections = set(old_collections) - set(new_collections)

        ignored = set(ignored_missing_collection_ids or [])
        unexpected_missing = missing_collections - ignored


        print("\n--- MISSING COLLECTION DEBUG ---")

        for collection_id in sorted(missing_collections):
            print("Collection:", old_collections[collection_id].get("name"))
            print("UUID:", collection_id)
            print("Ignored:", collection_id in ignored)
            print("---")


        if missing_items or unexpected_missing:
            raise RuntimeError(
                "Synchronization cancelled. "
                f"Missing items: {len(missing_items)}, "
                f"unconfirmed missing collections: "
                f"{len(unexpected_missing)}"
            )

        # Protect against a badly incomplete location response.
        if old_locations and (
            len(current_locations) < len(old_locations) * 0.8
        ):
            raise RuntimeError(
                "Too many location assignments are missing. "
                "Check the API response before synchronizing."
            )

        # Extend the existing change_events table safely.
        existing_columns = {
            row["name"]
            for row in conn.execute(
                "PRAGMA table_info(change_events)"
            )
        }

        if "entity_type" not in existing_columns:
            conn.execute(
                "ALTER TABLE change_events "
                "ADD COLUMN entity_type TEXT"
            )

        if "entity_id" not in existing_columns:
            conn.execute(
                "ALTER TABLE change_events "
                "ADD COLUMN entity_id TEXT"
            )

        def add_event(event_type, entity_type, entity_id, old, new):
            event = {
                "event_type": event_type,
                "entity_type": entity_type,
                "entity_id": entity_id,
                "previous_value": old,
                "new_value": new,
                "detected_at": detected_at,
            }

            events.append(event)

            conn.execute(
                """
                INSERT INTO change_events (
                    event_type,
                    item_id,
                    previous_value,
                    new_value,
                    detected_at,
                    entity_type,
                    entity_id
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_type,
                    entity_id if entity_type == "ITEM" else None,
                    json.dumps(old, ensure_ascii=False),
                    json.dumps(new, ensure_ascii=False),
                    detected_at,
                    entity_type,
                    entity_id,
                ),
            )

        # 1. Detect and store Item changes.
        for item_id, item in new_items.items():
            previous = old_items.get(item_id)
            latest_fields = item_fields(item)

            if previous is None:
                add_event(
                    "ITEM_ADDED",
                    "ITEM",
                    item_id,
                    None,
                    {
                        **latest_fields,
                        "location": current_locations.get(item_id),
                    },
                )

            elif item_fields(previous) != latest_fields:
                add_event(
                    "ITEM_UPDATED",
                    "ITEM",
                    item_id,
                    item_fields(previous),
                    latest_fields,
                )

            conn.execute(
                """
                INSERT INTO items (
                    id, name, serial, archived, raw_json
                )
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    serial = excluded.serial,
                    archived = excluded.archived,
                    raw_json = excluded.raw_json
                """,
                (
                    item_id,
                    item.get("name"),
                    item.get("serial"),
                    int(bool(item.get("archived", False))),
                    json.dumps(item, ensure_ascii=False),
                ),
            )

        # 2. Detect and store Collection changes.
        for collection_id, collection in new_collections.items():
            previous = old_collections.get(collection_id)
            latest_fields = collection_fields(collection)

            if previous is None:
                add_event(
                    "COLLECTION_ADDED",
                    "COLLECTION",
                    collection_id,
                    None,
                    latest_fields,
                )

            elif collection_fields(previous) != latest_fields:
                add_event(
                    "COLLECTION_UPDATED",
                    "COLLECTION",
                    collection_id,
                    collection_fields(previous),
                    latest_fields,
                )

            parent = collection.get("parent") or {}

            conn.execute(
                """
                INSERT INTO collections (
                    id, name, parent_id, raw_json
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    parent_id = excluded.parent_id,
                    raw_json = excluded.raw_json
                """,
                (
                    collection_id,
                    collection.get("name"),
                    parent.get("id"),
                    json.dumps(collection, ensure_ascii=False),
                ),
            )

        # 3. Detect and store current-location changes.
        for item_id in new_items:
            old_location = old_locations.get(item_id)
            new_location = current_locations.get(item_id)

            # New items already have an ITEM_ADDED event.
            if (
                item_id in old_items
                and old_location != new_location
            ):
                add_event(
                    "ITEM_LOCATION_CHANGED",
                    "ITEM",
                    item_id,
                    old_location,
                    new_location,
                )

            if new_location:
                conn.execute(
                    """
                    INSERT INTO item_locations (item_id, location)
                    VALUES (?, ?)
                    ON CONFLICT(item_id) DO UPDATE SET
                        location = excluded.location
                    """,
                    (item_id, new_location),
                )
            else:
                conn.execute(
                    "DELETE FROM item_locations WHERE item_id = ?",
                    (item_id,),
                )

        # Transaction commits only if all operations succeed.

    return events
