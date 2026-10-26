import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path


from handlers.change_handler import get_pending_removals, sync_snapshot


def sample_items():
    return [
        {
            "id": f"item-{i}",
            "name": f"Asset {i}",
            "serial": f"SER-{i}",
            "archived": False,
            "description": "",
        }
        for i in range(1, 5)
    ]


def sample_collections():
    return [
        {
            "id": "root",
            "name": "Furniture",
            "parent": None,
            "colour": "#111111",
        },
        {
            "id": "deleted-subcollection",
            "name": "Testing sub",
            "parent": {"id": "root"},
            "colour": "#222222",
        },
        {
            "id": "other",
            "name": "Electronic",
            "parent": None,
            "colour": "#333333",
        },
    ]



def create_legacy_db(db_path):
    with closing(sqlite3.connect(db_path)) as conn, conn:
        conn.executescript("""
            CREATE TABLE items (
                id TEXT PRIMARY KEY,
                name TEXT,
                serial TEXT,
                archived INTEGER,
                raw_json TEXT NOT NULL
            );

            CREATE TABLE collections (
                id TEXT PRIMARY KEY,
                name TEXT,
                parent_id TEXT,
                raw_json TEXT NOT NULL
            );

            CREATE TABLE item_locations (
                item_id TEXT PRIMARY KEY,
                location TEXT NOT NULL,
                FOREIGN KEY (item_id) REFERENCES items(id)
            );

            CREATE TABLE sync_metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE change_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                item_id TEXT,
                previous_value TEXT,
                new_value TEXT,
                detected_at TEXT NOT NULL
            );

            CREATE TABLE item_collections (
                item_id TEXT NOT NULL REFERENCES items(id),
                collection_id TEXT NOT NULL REFERENCES collections(id),
                source TEXT NOT NULL,
                evidence_serial TEXT NOT NULL,
                evidence_path TEXT NOT NULL,
                imported_at TEXT NOT NULL,
                PRIMARY KEY (item_id, collection_id)
            );

            INSERT INTO sync_metadata
            VALUES ('baseline_initialized', '2026-10-18');
        """)

        for item in sample_items():
            conn.execute(
                "INSERT INTO items VALUES (?, ?, ?, ?, ?)",
                (
                    item["id"],
                    item["name"],
                    item["serial"],
                    0,
                    json.dumps(item),
                ),
            )

            conn.execute(
                "INSERT INTO item_locations VALUES (?, ?)",
                (item["id"], "Lab"),
            )

        for coll in sample_collections():
            conn.execute(
                "INSERT INTO collections VALUES (?, ?, ?, ?)",
                (
                    coll["id"],
                    coll["name"],
                    (coll.get("parent") or {}).get("id"),
                    json.dumps(coll),
                ),
            )

        conn.execute(
            "INSERT INTO item_collections VALUES (?, ?, ?, ?, ?, ?)",
            (
                "item-1",
                "deleted-subcollection",
                "pdf",
                "SER-1",
                "Path",
                "2026-10-18",
            ),
        )


class DeletionHandlerTests(unittest.TestCase):

    def setUp(self):
        self.workdir = tempfile.TemporaryDirectory()
        self.db = Path(self.workdir.name) / "asset_sync.db"

        create_legacy_db(self.db)

        self.items = sample_items()
        self.collections = sample_collections()

        self.locations = {
            item["id"]: "Lab"
            for item in self.items
        }

    def tearDown(self):
        self.workdir.cleanup()

    def sync(self, items=None, collections=None, locations=None, **kwargs):
        return sync_snapshot(
            self.items if items is None else items,
            self.collections if collections is None else collections,
            self.locations if locations is None else locations,
            db_path=self.db,
            **kwargs,
        )

    def get_flag(self, table, id_):
        with closing(sqlite3.connect(self.db)) as conn, conn:
            return conn.execute(
                f"SELECT is_active FROM {table} WHERE id = ?",
                (id_,),
            ).fetchone()[0]

    def test_requires_confirmation_and_soft_deletes_exactly_once(self):
        remaining_collections = [
            c for c in self.collections
            if c["id"] != "deleted-subcollection"
        ]

        self.assertEqual(
            get_pending_removals(
                self.items,
                remaining_collections,
                self.db,
            ),
            (set(), {"deleted-subcollection"}),
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "not independently confirmed",
        ):
            self.sync(collections=remaining_collections)

        events = self.sync(
            collections=remaining_collections,
            confirmed_removed_collection_ids={
                "deleted-subcollection"
            },
        )

        self.assertEqual(
            [e["event_type"] for e in events],
            ["COLLECTION_REMOVED"],
        )

        self.assertEqual(
            self.get_flag("collections", "deleted-subcollection"),
            0,
        )

        with closing(sqlite3.connect(self.db)) as conn, conn:
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM collections"
                ).fetchone()[0],
                3,
            )

            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM item_collections"
                ).fetchone()[0],
                1,
            )

        events = self.sync(collections=remaining_collections)

        self.assertEqual(events, [])

        self.assertEqual(
            get_pending_removals(
                self.items,
                remaining_collections,
                self.db,
            ),
            (set(), set()),
        )

        kept_items = self.items[:-1]

        kept_locations = {
            item["id"]: "Lab"
            for item in kept_items
        }

        events = self.sync(
            items=kept_items,
            collections=remaining_collections,
            locations=kept_locations,
            confirmed_removed_item_ids={"item-4"},
        )

        self.assertEqual(
            [e["event_type"] for e in events],
            ["ITEM_REMOVED"],
        )

        self.assertEqual(
            self.get_flag("items", "item-4"),
            0,
        )

        self.assertEqual(
            self.sync(
                items=kept_items,
                collections=remaining_collections,
                locations=kept_locations,
            ),
            [],
        )

        # Historical location is retained for removed items.
        with closing(sqlite3.connect(self.db)) as conn, conn:
            self.assertEqual(
                conn.execute(
                    "SELECT location FROM item_locations "
                    "WHERE item_id = 'item-4'"
                ).fetchone()[0],
                "Lab",
            )

        events = self.sync(collections=remaining_collections)

        self.assertEqual(
            [e["event_type"] for e in events],
            ["ITEM_RESTORED"],
        )

        self.assertEqual(
            self.get_flag("items", "item-4"),
            1,
        )

        events = self.sync()

        self.assertEqual(
            [e["event_type"] for e in events],
            ["COLLECTION_RESTORED"],
        )

        self.assertEqual(
            self.get_flag("collections", "deleted-subcollection"),
            1,
        )

    def test_archival_is_update_and_location_change_is_not_deletion(self):
        archived = sample_items()
        archived[0]["archived"] = True

        locations = dict(self.locations)
        locations["item-2"] = "Meeting Room"

        events = self.sync(
            items=archived,
            locations=locations,
        )

        types = {
            event["event_type"]
            for event in events
        }

        self.assertEqual(
            types,
            {"ITEM_UPDATED", "ITEM_LOCATION_CHANGED"},
        )

        self.assertEqual(
            self.get_flag("items", "item-1"),
            1,
        )

    def test_large_deletion_requires_manual_review_without_db_changes(self):
        kept_items = self.items[:1]
        kept_locations = {"item-1": "Lab"}

        with self.assertRaisesRegex(
            RuntimeError,
            "Suspicious mass removal",
        ):
            self.sync(
                items=kept_items,
                locations=kept_locations,
                confirmed_removed_item_ids={
                    "item-2",
                    "item-3",
                    "item-4",
                },
            )

        with closing(sqlite3.connect(self.db)) as conn, conn:
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM change_events"
                ).fetchone()[0],
                0,
            )

            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM items"
                ).fetchone()[0],
                4,
            )

    def test_incomplete_location_response_cancels_transaction(self):
        with self.assertRaisesRegex(
            RuntimeError,
            "Too many location assignments",
        ):
            self.sync(locations={})

        with closing(sqlite3.connect(self.db)) as conn, conn:
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM change_events"
                ).fetchone()[0],
                0,
            )

    def test_structure_hides_soft_deleted_rows(self):
        from handlers.structure_handler import build_structure

        remaining_collections = [
            c for c in self.collections
            if c["id"] != "deleted-subcollection"
        ]

        kept_items = self.items[1:]

        kept_locations = {
            item["id"]: "Lab"
            for item in kept_items
        }

        self.sync(
            items=kept_items,
            collections=remaining_collections,
            locations=kept_locations,
            confirmed_removed_item_ids={"item-1"},
            confirmed_removed_collection_ids={
                "deleted-subcollection"
            },
        )

        structure = build_structure(self.db)

        self.assertEqual(
            structure["summary"]["database_items"],
            3,
        )

        self.assertEqual(
            structure["summary"]["hidden_collection_nodes"],
            1,
        )

        self.assertEqual(
            structure["summary"]["skipped_membership_rows"],
            1,
        )

        all_ids = {
            item["id"]
            for item in structure["uncategorized"]["items"]
        }

        self.assertEqual(
            all_ids,
            {"item-2", "item-3", "item-4"},
        )


if __name__ == "__main__":
    unittest.main()
