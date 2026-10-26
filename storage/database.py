import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path("data/asset_sync.db")


def ensure_deletion_columns(conn):
    """Migrate an existing database without dropping or resetting any data.

    Call inside a transaction when modifying existing data.
    """
    for table in ("items", "collections"):
        columns = {
            row[1] for row in conn.execute(f"PRAGMA table_info({table})")
        }
        if "is_active" not in columns:
            conn.execute(
                f"ALTER TABLE {table} "
                "ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1"
            )


def save_initial_baseline(items, collections, current_locations):
    """Store the first snapshot without producing change events."""

    if not items or not collections:
        raise ValueError("Cannot initialize an empty baseline.")

    item_ids = [item.get("id") for item in items]
    collection_ids = [col.get("id") for col in collections]

    if (
        any(not item_id for item_id in item_ids)
        or len(item_ids) != len(set(item_ids))
    ):
        raise ValueError("Invalid or duplicate item IDs.")

    if (
        any(not col_id for col_id in collection_ids)
        or len(collection_ids) != len(set(collection_ids))
    ):
        raise ValueError("Invalid or duplicate collection IDs.")

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    with closing(sqlite3.connect(DB_PATH)) as conn, conn:
        conn.execute("PRAGMA foreign_keys = ON")

        conn.executescript("""
            CREATE TABLE IF NOT EXISTS items (
                id TEXT PRIMARY KEY,
                name TEXT,
                serial TEXT,
                archived INTEGER,
                raw_json TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS collections (
                id TEXT PRIMARY KEY,
                name TEXT,
                parent_id TEXT,
                raw_json TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS item_locations (
                item_id TEXT PRIMARY KEY,
                location TEXT NOT NULL,
                FOREIGN KEY (item_id) REFERENCES items(id)
            );

            CREATE TABLE IF NOT EXISTS sync_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS change_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                item_id TEXT,
                previous_value TEXT,
                new_value TEXT,
                detected_at TEXT NOT NULL
            );
        """)

        # Also upgrades older baselines that predate is_active.
        ensure_deletion_columns(conn)

        existing = conn.execute(
            "SELECT value FROM sync_metadata "
            "WHERE key = 'baseline_initialized'"
        ).fetchone()

        if existing:
            print("Baseline already exists. No data overwritten.")
            return False

        with conn:
            for item in items:
                conn.execute(
                    """
                    INSERT INTO items
                    (id, name, serial, archived, raw_json)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        item["id"],
                        item.get("name"),
                        item.get("serial"),
                        int(bool(item.get("archived", False))),
                        json.dumps(item, ensure_ascii=False),
                    ),
                )

            for collection in collections:
                parent = collection.get("parent") or {}
                conn.execute(
                    """
                    INSERT INTO collections
                    (id, name, parent_id, raw_json)
                    VALUES (?, ?, ?, ?)
                    """,
                    (
                        collection["id"],
                        collection.get("name"),
                        parent.get("id"),
                        json.dumps(collection, ensure_ascii=False),
                    ),
                )

            known_ids = set(item_ids)
            for item_id, location in current_locations.items():
                if item_id not in known_ids:
                    continue
                conn.execute(
                    """
                    INSERT INTO item_locations (item_id, location)
                    VALUES (?, ?)
                    """,
                    (item_id, location),
                )

            conn.execute(
                """
                INSERT INTO sync_metadata (key, value)
                VALUES (?, ?)
                """,
                (
                    "baseline_initialized",
                    datetime.now(timezone.utc).isoformat(),
                ),
            )

    print("\nInitial baseline successfully created!")
    print("Items stored:", len(items))
    print("Collections stored:", len(collections))
    print("Items with locations:", len(set(current_locations) & set(item_ids)))
    print("Change events: 0")
    return True
