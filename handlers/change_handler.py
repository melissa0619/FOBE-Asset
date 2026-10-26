import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from contextlib import closing

from storage.database import DB_PATH, ensure_deletion_columns


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


def get_pending_removals(items, collections, db_path=DB_PATH):
    """Find active SQLite UUIDs missing from the latest API snapshot.

    Read-only: this does not mark or delete records. Used by main.py to
    decide whether to request a second, independent complete API snapshot.
    """
    new_item_ids = set(build_index(items, "Items"))
    new_collection_ids = set(build_index(collections, "Collections"))
    db_path = Path(db_path)
    if not db_path.is_file():
        raise FileNotFoundError(f"Baseline database not found: {db_path}")

    with closing(sqlite3.connect(db_path)) as conn, conn:
        # Older databases may not yet have is_active.
        def active_ids(table):
            columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
            if "is_active" in columns:
                query = f"SELECT id FROM {table} WHERE is_active = 1"
            else:
                query = f"SELECT id FROM {table}"
            return {row[0] for row in conn.execute(query)}

        stored_items = active_ids("items")
        stored_collections = active_ids("collections")

    return (
        stored_items - new_item_ids,
        stored_collections - new_collection_ids,
    )


def sync_snapshot(
    items,
    collections,
    current_locations,
    db_path=DB_PATH,
    confirmed_removed_item_ids=None,
    confirmed_removed_collection_ids=None,
):
    """Atomically compare API snapshot and SQLite, preserving removed records.

    Caller MUST independently re-fetch all pages and confirm missing IDs
    before passing them in confirmed_removed_*_ids.
    """
    db_path = Path(db_path)
    if not db_path.is_file():
        raise FileNotFoundError(
            "Baseline database not found. Run initialization first."
        )

    new_items = build_index(items, "Items")
    new_collections = build_index(collections, "Collections")
    if not isinstance(current_locations, dict):
        raise ValueError("Current locations must be a dictionary")

    confirmed_items = set(confirmed_removed_item_ids or ())
    confirmed_collections = set(confirmed_removed_collection_ids or ())
    detected_at = datetime.now(timezone.utc).isoformat()
    events = []

    with closing(sqlite3.connect(db_path)) as conn, conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("BEGIN IMMEDIATE")
        baseline = conn.execute(
            "SELECT value FROM sync_metadata "
            "WHERE key = 'baseline_initialized'"
        ).fetchone()
        if not baseline:
            raise RuntimeError("Initial baseline has not been created")

        ensure_deletion_columns(conn)  # safe migration inside transaction

        # Keep inactive rows for audit and possible restoration.
        stored_items = {
            row["id"]: (json.loads(row["raw_json"]), bool(row["is_active"]))
            for row in conn.execute("SELECT id, raw_json, is_active FROM items")
        }
        stored_collections = {
            row["id"]: (json.loads(row["raw_json"]), bool(row["is_active"]))
            for row in conn.execute(
                "SELECT id, raw_json, is_active FROM collections"
            )
        }
        active_items = {
            item_id: record
            for item_id, (record, active) in stored_items.items() if active
        }
        active_collections = {
            col_id: record
            for col_id, (record, active) in stored_collections.items() if active
        }
        old_locations = {
            row["item_id"]: row["location"]
            for row in conn.execute(
                "SELECT item_id, location FROM item_locations"
            )
        }

        missing_items = set(active_items) - set(new_items)
        missing_collections = set(active_collections) - set(new_collections)

        # Explicit confirmation is mandatory, not an ignore list.
        unconfirmed_items = missing_items - confirmed_items
        unconfirmed_collections = missing_collections - confirmed_collections
        if unconfirmed_items or unconfirmed_collections:
            raise RuntimeError(
                "Synchronization cancelled: deletion not independently "
                "confirmed. Missing items: "
                f"{sorted(unconfirmed_items)}; "
                f"missing collections: {sorted(unconfirmed_collections)}"
            )
        if (confirmed_items - missing_items or
                confirmed_collections - missing_collections):
            raise RuntimeError(
                "Confirmation IDs do not match the current database snapshot. "
                "Retry synchronization."
            )

        # A large change suggests pagination, permissions, or API trouble.
        for label, missing, old in (
            ("items", missing_items, active_items),
            ("collections", missing_collections, active_collections),
        ):
            if len(missing) >= 3 and len(missing) > len(old) * 0.10:
                raise RuntimeError(
                    f"Suspicious mass removal of {len(missing)} {label}. "
                    "Manual review required; nothing saved."
                )

        # Evaluate only the retained active items when guarding location coverage.
        continuing_item_ids = set(active_items) & set(new_items)
        previously_located = {
            item_id for item_id in old_locations
            if item_id in continuing_item_ids
        }
        currently_located = {
            item_id for item_id in current_locations
            if item_id in continuing_item_ids and current_locations[item_id]
        }
        if previously_located and (
            len(currently_located) < len(previously_located) * 0.8
        ):
            raise RuntimeError(
                "Too many location assignments are missing. "
                "Check the API response before synchronizing."
            )

        # Backwards-compatible event table migration.
        existing_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(change_events)")
        }
        if "entity_type" not in existing_columns:
            conn.execute("ALTER TABLE change_events ADD COLUMN entity_type TEXT")
        if "entity_id" not in existing_columns:
            conn.execute("ALTER TABLE change_events ADD COLUMN entity_id TEXT")

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
                    event_type, item_id, previous_value, new_value,
                    detected_at, entity_type, entity_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
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

        # 1. Regular item additions, updates, or reappearances.
        for item_id, item in new_items.items():
            old_entry = stored_items.get(item_id)
            latest_fields = item_fields(item)
            if old_entry is None:
                add_event(
                    "ITEM_ADDED", "ITEM", item_id, None,
                    {**latest_fields, "location": current_locations.get(item_id)},
                )
            elif not old_entry[1]:
                add_event(
                    "ITEM_RESTORED", "ITEM", item_id,
                    item_fields(old_entry[0]), latest_fields,
                )
            elif item_fields(old_entry[0]) != latest_fields:
                add_event(
                    "ITEM_UPDATED", "ITEM", item_id,
                    item_fields(old_entry[0]), latest_fields,
                )

            conn.execute(
                """
                INSERT INTO items (
                    id, name, serial, archived, raw_json, is_active
                ) VALUES (?, ?, ?, ?, ?, 1)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    serial = excluded.serial,
                    archived = excluded.archived,
                    raw_json = excluded.raw_json,
                    is_active = 1
                """,
                (
                    item_id, item.get("name"), item.get("serial"),
                    int(bool(item.get("archived", False))),
                    json.dumps(item, ensure_ascii=False),
                ),
            )

        # 2. Regular Collection additions, updates, or reappearances.
        for collection_id, collection in new_collections.items():
            old_entry = stored_collections.get(collection_id)
            latest_fields = collection_fields(collection)
            if old_entry is None:
                add_event(
                    "COLLECTION_ADDED", "COLLECTION", collection_id,
                    None, latest_fields,
                )
            elif not old_entry[1]:
                add_event(
                    "COLLECTION_RESTORED", "COLLECTION", collection_id,
                    collection_fields(old_entry[0]), latest_fields,
                )
            elif collection_fields(old_entry[0]) != latest_fields:
                add_event(
                    "COLLECTION_UPDATED", "COLLECTION", collection_id,
                    collection_fields(old_entry[0]), latest_fields,
                )

            parent = collection.get("parent") or {}
            conn.execute(
                """
                INSERT INTO collections (
                    id, name, parent_id, raw_json, is_active
                ) VALUES (?, ?, ?, ?, 1)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    parent_id = excluded.parent_id,
                    raw_json = excluded.raw_json,
                    is_active = 1
                """,
                (
                    collection_id, collection.get("name"),
                    parent.get("id"),
                    json.dumps(collection, ensure_ascii=False),
                ),
            )

        # 3. Record confirmed removals. Keep rows, locations and PDF mappings.
        for item_id in sorted(missing_items):
            add_event(
                "ITEM_REMOVED", "ITEM", item_id,
                {**item_fields(active_items[item_id]),
                 "location": old_locations.get(item_id)},
                None,
            )
            conn.execute(
                "UPDATE items SET is_active = 0 WHERE id = ?", (item_id,)
            )

        for collection_id in sorted(missing_collections):
            add_event(
                "COLLECTION_REMOVED", "COLLECTION", collection_id,
                collection_fields(active_collections[collection_id]), None,
            )
            conn.execute(
                "UPDATE collections SET is_active = 0 WHERE id = ?",
                (collection_id,),
            )

        # 4. Current-location changes for continuing active items only.
        for item_id in new_items:
            old_location = old_locations.get(item_id)
            new_location = current_locations.get(item_id)
            if item_id in active_items and old_location != new_location:
                add_event(
                    "ITEM_LOCATION_CHANGED", "ITEM", item_id,
                    old_location, new_location,
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
                    "DELETE FROM item_locations WHERE item_id = ?", (item_id,)
                )

    return events
