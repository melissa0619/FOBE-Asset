"""Safe, partial reconciliation of itemit Collection memberships."""
from datetime import datetime, timezone


VERIFIED_STATUSES = {"COMPLETE", "EMPTY"}
ADDITIVE_ONLY_STATUSES = {"PARTIAL"}


def ensure_table(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS item_collections (
        item_id TEXT NOT NULL REFERENCES items(id), collection_id TEXT NOT NULL REFERENCES collections(id),
        source TEXT NOT NULL, evidence_serial TEXT NOT NULL DEFAULT '', evidence_path TEXT NOT NULL DEFAULT '',
        imported_at TEXT NOT NULL, PRIMARY KEY (item_id, collection_id))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS item_collection_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, collection_id TEXT NOT NULL,
        action TEXT NOT NULL, previous_source TEXT, recorded_at TEXT NOT NULL)""")


def _normalise(records):
    """Accept classified records; retain compatibility with validated raw rows."""
    normalised = []
    for record in records:
        if "status" in record:
            normalised.append(record)
            continue
        nested = record.get("collections", {})
        total, rows = nested.get("total"), nested.get("results")
        ids = [row.get("id") for row in rows or [] if isinstance(row, dict)]
        status = "EMPTY" if total == 0 and rows == [] else "COMPLETE"
        if not isinstance(total, int) or not isinstance(rows, list) or total != len(ids) or len(ids) != len(set(ids)):
            status = "INCOMPLETE"
        normalised.append({"item_id": record.get("id"), "status": status, "memberships": ids})
    return normalised


def reconcile(conn, membership_records, dry_run=True):
    """Reconcile only API-verified items, never interpreting unknown as empty."""
    records = _normalise(membership_records)
    verified = [record for record in records if record.get("status") in VERIFIED_STATUSES]
    partial = [record for record in records if record.get("status") in ADDITIVE_ONLY_STATUSES]
    unresolved = sorted(record.get("item_id") for record in records
                        if record.get("status") not in VERIFIED_STATUSES | ADDITIVE_ONLY_STATUSES
                        and record.get("item_id"))
    desired = {(record["item_id"], collection_id)
               for record in verified + partial for collection_id in record.get("memberships", [])}
    verified_items = {record.get("item_id") for record in verified}

    item_ids = {row[0] for row in conn.execute("SELECT id FROM items")}
    collection_ids = {row[0] for row in conn.execute("SELECT id FROM collections")}
    invalid = [(item_id, collection_id) for item_id, collection_id in desired
               if item_id not in item_ids or collection_id not in collection_ids]
    if invalid:
        raise ValueError(f"Unresolved itemit IDs in memberships: {invalid[:3]}")
    if not verified_items.issubset(item_ids):
        raise ValueError("Membership records refer to unknown items")

    has_membership_table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item_collections'"
    ).fetchone()
    if has_membership_table:
        existing_rows = {(row[0], row[1]): row[2] for row in conn.execute(
            "SELECT item_id, collection_id, source FROM item_collections")}
    else:
        existing_rows = {}
    existing = set(existing_rows)
    scoped_existing = {pair for pair in existing if pair[0] in verified_items}
    changes = {"added": desired - existing, "removed": scoped_existing - desired,
               "unchanged": desired & existing}
    summary = {key: len(value) for key, value in changes.items()} | {
        "discovered": len(desired), "unresolved": len(unresolved),
        "unresolved_item_ids": unresolved, "verified_items": len(verified),
        "partial_items": len(partial),
    }
    if dry_run:
        return summary

    now = datetime.now(timezone.utc).isoformat()
    # Every relationship, provenance, and audit mutation is atomic.
    with conn:
        ensure_table(conn)
        for item_id, collection_id in changes["removed"]:
            conn.execute("""INSERT INTO item_collection_audit
                (item_id, collection_id, action, previous_source, recorded_at)
                VALUES (?, ?, 'REMOVED_BY_ITEMIT_API', ?, ?)""",
                (item_id, collection_id, existing_rows[(item_id, collection_id)], now))
        conn.executemany("DELETE FROM item_collections WHERE item_id = ? AND collection_id = ?", changes["removed"])
        conn.executemany("""INSERT INTO item_collections
            (item_id, collection_id, source, evidence_serial, evidence_path, imported_at)
            VALUES (?, ?, 'itemit_api', '', '', ?)""",
            [(item_id, collection_id, now) for item_id, collection_id in changes["added"]])
        conn.executemany("""UPDATE item_collections SET source = 'itemit_api',
            imported_at = ? WHERE item_id = ? AND collection_id = ?""",
            [(now, item_id, collection_id) for item_id, collection_id in changes["unchanged"]])
    return summary
