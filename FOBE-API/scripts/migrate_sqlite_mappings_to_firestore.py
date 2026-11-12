"""One-way, explicitly invoked migration from the legacy SQLite mapping table.

Run with --dry-run first. This never updates SQLite and never overwrites an
existing Firestore document, avoiding an unsynchronised dual-write system.
"""

import argparse
import sqlite3
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))

from firestore_mapping_store import (
    FirestoreMappingStore,
    MappingAlreadyExists,
    MappingConfirmed,
    MappingNotFound,
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sqlite", required=True, type=Path, help="Legacy asset_sync.db path")
    parser.add_argument("--apply", action="store_true", help="Write only non-conflicting records to Firestore")
    args = parser.parse_args()
    if not args.sqlite.is_file():
        raise SystemExit(f"SQLite database not found: {args.sqlite}")

    with sqlite3.connect(args.sqlite) as conn:
        has_table = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ifc_item_mapping'").fetchone()
        if not has_table:
            raise SystemExit("Legacy ifc_item_mapping table does not exist; nothing to migrate.")
        rows = conn.execute(
            """SELECT m.model_key, m.ifc_global_id, m.itemit_item_id, m.mapping_status,
                      m.mapping_method, m.notes
                 FROM ifc_item_mapping m JOIN items i ON i.id = m.itemit_item_id
                 ORDER BY m.model_key, m.ifc_global_id"""
        ).fetchall()

    print(f"Found {len(rows)} valid legacy mappings.")
    if not args.apply:
        print("Dry run only. Re-run with --apply after reviewing this count.")
        return

    store = FirestoreMappingStore()
    migrated = skipped = conflicts = 0
    for row in rows:
        record = dict(zip(("model_key", "ifc_global_id", "itemit_item_id", "mapping_status", "mapping_method", "notes"), row))
        record["authenticated_user"] = "sqlite-migration"
        try:
            store.get(record["model_key"], record["ifc_global_id"])
            conflicts += 1
            print(f"CONFLICT (left unchanged): {record['model_key']}:{record['ifc_global_id']}")
        except MappingNotFound:
            try:
                store.create(record)
                migrated += 1
            except (MappingAlreadyExists, MappingConfirmed):
                skipped += 1
    print(f"Migrated: {migrated}; concurrent skips: {skipped}; existing conflicts: {conflicts}.")
    if conflicts:
        raise SystemExit("Resolve Firestore conflicts manually; SQLite was not changed.")


if __name__ == "__main__":
    main()
