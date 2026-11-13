import argparse
import json
import sqlite3
from pathlib import Path
from contextlib import closing

DEFAULT_DB = Path("data/asset_sync.db")
DEFAULT_OUTPUT = Path("data/collection_tree.json")


def build_structure(db_path=DEFAULT_DB, excluded_collection_ids=None, active_only=False):
    """Return a JSON-ready hierarchy preserving direct Collection memberships."""
    db_path = Path(db_path)
    if not db_path.is_file():
        raise FileNotFoundError(f"SQLite database not found: {db_path}")

    excluded = set(excluded_collection_ids or ())

    # Open read-only so the hierarchy generator cannot alter the baseline.
    uri = db_path.resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as conn, conn:
        conn.row_factory = sqlite3.Row
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        required = {"items", "collections", "item_collections"}
        missing = required - tables
        if missing:
            raise RuntimeError(
                "Required table(s) missing: " + ", ".join(sorted(missing))
                + ". Run a successful itemit synchronization first."
            )

        collection_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(collections)")
        }
        has_is_active = "is_active" in collection_columns
        collection_sql = "SELECT id, name, parent_id"
        if has_is_active:
            collection_sql += ", is_active"
        collection_sql += " FROM collections"
        collection_rows = conn.execute(collection_sql).fetchall()

        item_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(items)")
        }
        has_item_is_active = "is_active" in item_columns
        item_sql = "SELECT id, name, serial, archived"
        if has_item_is_active:
            item_sql += ", is_active"
        item_sql += " FROM items"
        item_rows = conn.execute(item_sql).fetchall()

        membership_rows = conn.execute(
            "SELECT item_id, collection_id FROM item_collections"
        ).fetchall()

    collection_by_id = {str(r["id"]): r for r in collection_rows}
    item_by_id = {}

    for r in item_rows:
        # Never display an item absent from the confirmed API snapshot.
        if has_item_is_active and not bool(r["is_active"]):
            continue

        archived = bool(r["archived"])
        if active_only and archived:
            continue

        item_by_id[str(r["id"])] = {
            "id": str(r["id"]),
            "name": r["name"] or "Unnamed item",
            "serial": r["serial"] or "",
            "archived": archived,
        }

    # Exclude explicitly ignored (deleted) Collections, inactive Collections
    # if the schema supports them, and all descendants of such Collections.
    visible_cache = {}
    checking = set()

    def visible(collection_id):
        if collection_id in visible_cache:
            return visible_cache[collection_id]

        if collection_id in checking:
            raise RuntimeError(f"Cycle in Collection hierarchy: {collection_id}")

        row = collection_by_id.get(collection_id)
        if row is None or collection_id in excluded:
            return False

        if has_is_active and not bool(row["is_active"]):
            visible_cache[collection_id] = False
            return False

        checking.add(collection_id)

        try:
            parent_id = str(row["parent_id"]) if row["parent_id"] else None
            outcome = parent_id is None or visible(parent_id)
        finally:
            checking.remove(collection_id)

        visible_cache[collection_id] = outcome
        return outcome

    nodes = {}

    for collection_id, r in collection_by_id.items():
        if visible(collection_id):
            nodes[collection_id] = {
                "id": collection_id,
                "name": r["name"] or "Unnamed Collection",
                "children": [],
                "items": [],
            }

    roots = []

    for collection_id, node in nodes.items():
        parent_id = collection_by_id[collection_id]["parent_id"]

        if parent_id:
            nodes[str(parent_id)]["children"].append(node)
        else:
            roots.append(node)

    mapped_item_ids = set()
    imported_visible_memberships = set()
    skipped_memberships = 0

    for r in membership_rows:
        item_id = str(r["item_id"])
        collection_id = str(r["collection_id"])

        if item_id not in item_by_id or collection_id not in nodes:
            skipped_memberships += 1
            continue

        key = (item_id, collection_id)

        if key in imported_visible_memberships:
            continue

        imported_visible_memberships.add(key)
        nodes[collection_id]["items"].append(item_by_id[item_id].copy())
        mapped_item_ids.add(item_id)

    def item_key(item):
        return (item["name"].casefold(), item["serial"].casefold(), item["id"])

    def sort_tree(node):
        node["items"].sort(key=item_key)
        node["children"].sort(key=lambda n: (n["name"].casefold(), n["id"]))

        for child in node["children"]:
            sort_tree(child)

    roots.sort(key=lambda n: (n["name"].casefold(), n["id"]))

    for root in roots:
        sort_tree(root)

    uncategorized = [
        item.copy()
        for item_id, item in item_by_id.items()
        if item_id not in mapped_item_ids
    ]

    uncategorized.sort(key=item_key)

    return {
        "summary": {
            "database_items": len(item_by_id),
            "collection_nodes": len(nodes),
            "hidden_collection_nodes": len(collection_by_id) - len(nodes),
            "raw_membership_rows": len(membership_rows),
            "visible_membership_rows": len(imported_visible_memberships),
            "skipped_membership_rows": skipped_memberships,
            "categorized_unique_items": len(mapped_item_ids),
            "uncategorized_items": len(uncategorized),
            "active_only": active_only,
        },
        "collections": roots,
        "uncategorized": {
            "id": "uncategorized",
            "name": "Uncategorized",
            "children": [],
            "items": uncategorized,
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)

    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB,
    )

    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
    )

    parser.add_argument(
        "--exclude-collection-id",
        action="append",
        default=[],
        help="Optionally hide a Collection UUID (repeatable).",
    )

    parser.add_argument(
        "--active-only",
        action="store_true",
        help="Exclude archived items (by default all items are shown).",
    )

    args = parser.parse_args()

    structure = build_structure(
        db_path=args.db,
        excluded_collection_ids=args.exclude_collection_id,
        active_only=args.active_only,
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)

    args.output.write_text(
        json.dumps(structure, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print("\n--- COLLECTION STRUCTURE SUMMARY ---")

    for key, value in structure["summary"].items():
        print(f"{key}: {value}")

    print(
        "Root Collections:",
        ", ".join(n["name"] for n in structure["collections"]),
    )

    print("\nUncategorized items:")

    for item in structure["uncategorized"]["items"]:
        print(f"- {item['name']} | {item['serial']}")

    print(f"\nJSON exported: {args.output}")
    print("SQLite and itemit were not modified.")


if __name__ == "__main__":
    main()
