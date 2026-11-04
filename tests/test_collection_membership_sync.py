import sqlite3
import pytest
from handlers.collection_membership_sync import reconcile


def database():
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript("""CREATE TABLE items (id TEXT PRIMARY KEY); CREATE TABLE collections (id TEXT PRIMARY KEY);
        INSERT INTO items VALUES ('i1'), ('i2'), ('i3'); INSERT INTO collections VALUES ('c1'), ('c2');""")
    return conn


def records():
    return [{"item_id": "i1", "status": "COMPLETE", "memberships": ["c1", "c2"]},
            {"item_id": "i2", "status": "EMPTY", "memberships": []}]


def test_dry_run_and_idempotent_apply():
    conn = database()
    assert reconcile(conn, records(), dry_run=True)["added"] == 2
    assert reconcile(conn, records(), dry_run=False)["added"] == 2
    assert reconcile(conn, records(), dry_run=False)["added"] == 0


def test_unknown_items_preserve_existing_pdf_memberships():
    conn = database()
    reconcile(conn, [{"item_id": "i3", "status": "COMPLETE", "memberships": ["c1"]}], dry_run=False)
    conn.execute("UPDATE item_collections SET source = 'itemit_pdf_2026-10-18'")
    summary = reconcile(conn, [{"item_id": "i3", "status": "UNKNOWN", "memberships": []}], dry_run=False)
    assert summary["removed"] == 0
    assert summary["pdf_derived_remain"] is True
    assert conn.execute("SELECT source FROM item_collections").fetchone()[0] == "itemit_pdf_2026-10-18"


def test_new_collection_reference_is_validated():
    conn = database()
    with pytest.raises(ValueError):
        reconcile(conn, [{"item_id": "i1", "status": "COMPLETE", "memberships": ["nope"]}], dry_run=False)


def test_rollback_leaves_relationships_untouched():
    conn = database()
    reconcile(conn, [{"item_id": "i1", "status": "COMPLETE", "memberships": ["c1"]}], dry_run=False)
    conn.execute("""CREATE TRIGGER reject_audit BEFORE INSERT ON item_collection_audit
                    BEGIN SELECT RAISE(ABORT, 'no audit'); END""")
    with pytest.raises(sqlite3.IntegrityError):
        reconcile(conn, [{"item_id": "i1", "status": "EMPTY", "memberships": []}], dry_run=False)
    assert conn.execute("SELECT item_id, collection_id FROM item_collections").fetchall() == [("i1", "c1")]
