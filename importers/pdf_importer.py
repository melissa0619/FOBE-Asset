import argparse
import json
import re
import sqlite3
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import fitz  # PyMuPDF


FIELD_RE = re.compile(
    r"^(Name|Serial|Description|Last Seen Date|Last Seen Location|"
    r"Last Seen By|Location|Availability|Collection\s+\d+|"
    r"Created Date|Created By|Archived|Tags|Parent Name|Parent Serial|"
    r"Child Items|Inventory: items)\s{2,}(.+?)\s*$"
)

RECORD_START = re.compile(r"(?m)^Name\s{2,}")


def normal_serial(value):
    return " ".join((value or "").split()).casefold()


def normal_part(value):
    value = unicodedata.normalize("NFKC", value).casefold()
    value = value.translate(
        str.maketrans({"–": "-", "—": "-", "−": "-"})
    )
    value = re.sub(r"\s*-\s*", "-", value)
    value = re.sub(r"['\"‘’“”′″`´]", "", value)
    return " ".join(value.split())


def normal_path(value):
    return tuple(
        normal_part(part)
        for part in value.split(">")
    )


def parse_pdf(pdf_path):
    """Extract serial numbers and Collection paths from the PDF."""

    with fitz.open(pdf_path) as document:
        content = "\n".join(
            page.get_text(sort=True)
            for page in document
        )

    boundaries = list(RECORD_START.finditer(content))

    if not boundaries:
        raise ValueError(
            "No itemit asset records found in the PDF"
        )

    records = []

    for pos, start in enumerate(boundaries):
        stop = (
            boundaries[pos + 1].start()
            if pos + 1 < len(boundaries)
            else len(content)
        )

        segment = content[start.start():stop]

        record = {
            "name": None,
            "serial": None,
            "paths": [],
        }

        active_collection = None

        for line in segment.splitlines():
            if line.lstrip().startswith("Text:"):
                active_collection = None
                continue

            field = FIELD_RE.match(line)

            if field:
                key, value = field.groups()
                active_collection = None

                if key == "Name":
                    record["name"] = value.strip()

                elif key == "Serial":
                    record["serial"] = value.strip()

                elif key.startswith("Collection "):
                    record["paths"].append(value.strip())
                    active_collection = len(record["paths"]) - 1

                continue

            # Collection paths may continue onto another line.
            if active_collection is not None and line.strip():
                if line.lstrip().startswith(
                    ("Itemit ", "Asset Register Report")
                ):
                    active_collection = None
                else:
                    record["paths"][active_collection] += (
                        " " + line.strip()
                    )

        if not record["serial"] or not record["paths"]:
            raise ValueError(
                f"PDF record {pos + 1} is missing a serial "
                "or Collection information"
            )

        records.append(record)

    return records


def load_database(conn):
    """Load items, historical serials and Collection hierarchy."""

    conn.row_factory = sqlite3.Row

    items = list(
        conn.execute(
            "SELECT id, serial FROM items"
        )
    )

    collections = list(
        conn.execute(
            "SELECT id, name, parent_id FROM collections"
        )
    )

    item_ids = {
        row["id"]
        for row in items
    }

    # Match PDF serials against current item serials.
    serial_to_ids = defaultdict(set)

    for row in items:
        serial_to_ids[
            normal_serial(row["serial"])
        ].add(row["id"])

    # Recover old serials from the Change Handler's event history.
    historical_serials = defaultdict(set)

    for row in conn.execute(
        "SELECT item_id, previous_value FROM change_events "
        "WHERE event_type = 'ITEM_UPDATED'"
    ):
        if row["item_id"] not in item_ids:
            continue

        try:
            previous = json.loads(row["previous_value"])
        except (ValueError, TypeError):
            continue

        if isinstance(previous, dict) and previous.get("serial"):
            historical_serials[
                normal_serial(previous["serial"])
            ].add(row["item_id"])

    # Reconstruct each Collection's full parent-child path.
    coll_by_id = {
        row["id"]: row
        for row in collections
    }

    path_cache = {}

    def path_for(collection_id, ancestry=frozenset()):
        if collection_id in path_cache:
            return path_cache[collection_id]

        if collection_id in ancestry:
            raise ValueError(
                "Cycle found in Collection parent hierarchy"
            )

        row = coll_by_id[collection_id]
        parent_id = row["parent_id"]

        if parent_id:
            if parent_id not in coll_by_id:
                raise ValueError(
                    f"Missing parent Collection: {parent_id}"
                )

            path = path_for(
                parent_id,
                ancestry | {collection_id}
            ) + [row["name"]]

        else:
            path = [row["name"]]

        path_cache[collection_id] = path
        return path

    path_to_ids = defaultdict(set)

    for collection_id in coll_by_id:
        full_path = " > ".join(
            path_for(collection_id)
        )

        path_to_ids[
            normal_path(full_path)
        ].add(collection_id)

    return (
        item_ids,
        serial_to_ids,
        historical_serials,
        path_to_ids,
    )


def match_memberships(records, indexes):
    """Match PDF assets and paths to itemit UUIDs."""

    item_ids, by_serial, by_old_serial, by_path = indexes

    memberships = {}
    matched_item_ids = set()
    history_matched = set()
    issues = []

    for record in records:
        serial = record["serial"]
        serial_key = normal_serial(serial)

        candidates = by_serial.get(
            serial_key, set()
        )

        source = "current_serial"

        if not candidates:
            candidates = by_old_serial.get(
                serial_key, set()
            )
            source = "serial_change_history"

        if len(candidates) != 1:
            issues.append({
                "serial": serial,
                "problem": (
                    "item_not_found"
                    if not candidates
                    else "ambiguous_item"
                ),
                "candidate_count": len(candidates),
            })
            continue

        item_id = next(iter(candidates))
        matched_item_ids.add(item_id)

        if source == "serial_change_history":
            history_matched.add(item_id)

        for path in record["paths"]:
            coll_candidates = by_path.get(
                normal_path(path), set()
            )

            if len(coll_candidates) != 1:
                issues.append({
                    "serial": serial,
                    "path": path,
                    "problem": (
                        "collection_path_not_found"
                        if not coll_candidates
                        else "ambiguous_collection_path"
                    ),
                })
                continue

            collection_id = next(iter(coll_candidates))

            memberships[
                (item_id, collection_id)
            ] = (serial, path)

    return (
        memberships,
        matched_item_ids,
        history_matched,
        issues,
    )


def apply_memberships(conn, memberships):
    """Store verified relationships in SQLite."""

    conn.execute("PRAGMA foreign_keys = ON")

    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS item_collections (
                item_id TEXT NOT NULL REFERENCES items(id),
                collection_id TEXT NOT NULL
                    REFERENCES collections(id),
                source TEXT NOT NULL,
                evidence_serial TEXT NOT NULL,
                evidence_path TEXT NOT NULL,
                imported_at TEXT NOT NULL,
                PRIMARY KEY (item_id, collection_id)
            )
        """)

        before = conn.total_changes
        now = datetime.now(timezone.utc).isoformat()

        conn.executemany("""
            INSERT OR IGNORE INTO item_collections
                (item_id, collection_id, source,
                 evidence_serial, evidence_path, imported_at)
            VALUES (?, ?, 'itemit_pdf_2026-10-18', ?, ?, ?)
        """, [
            (item_id, collection_id, serial, path, now)
            for (item_id, collection_id), (serial, path)
            in memberships.items()
        ])

        return conn.total_changes - before


def main():
    parser = argparse.ArgumentParser(
        description=__doc__
    )

    parser.add_argument(
        "--pdf",
        type=Path,
        default=Path("input/itemit_report.pdf")
    )

    parser.add_argument(
        "--db",
        type=Path,
        default=Path("data/asset_sync.db")
    )

    parser.add_argument(
        "--apply",
        action="store_true",
        help="Import verified memberships into SQLite"
    )

    args = parser.parse_args()

    if not args.pdf.is_file() or not args.db.is_file():
        parser.error(
            "PDF or SQLite database not found. "
            "Check --pdf and --db"
        )

    records = parse_pdf(args.pdf)

    database_url = (
        str(args.db.resolve())
        if args.apply
        else f"file:{args.db.resolve().as_posix()}?mode=ro"
    )

    with sqlite3.connect(
        database_url,
        uri=not args.apply
    ) as conn:

        indexes = load_database(conn)

        memberships, matched, from_history, issues = (
            match_memberships(records, indexes)
        )

        print("\n--- PDF MEMBERSHIP IMPORT PREVIEW ---")
        print("PDF asset records:", len(records))
        print(
            "PDF Collection assignments:",
            sum(len(r["paths"]) for r in records)
        )

        print(
            "Current database items:",
            len(indexes[0])
        )

        print(
            "Unique item UUIDs matched:",
            len(matched)
        )

        print(
            "Matched via serial-change history:",
            len(from_history)
        )

        print(
            "Resolved membership relationships:",
            len(memberships)
        )

        print(
            "Database items absent from PDF:",
            len(indexes[0] - matched)
        )

        print(
            "Unresolved PDF matches:",
            len(issues)
        )

        for issue in issues[:15]:
            print(
                "REVIEW:",
                json.dumps(issue, ensure_ascii=False)
            )

        if len(issues) > 15:
            print(
                f"... and {len(issues) - 15} more issues"
            )

        if args.apply:
            added = apply_memberships(
                conn, memberships
            )

            print(
                f"\nApplied {added} NEW "
                "relationships to SQLite"
            )

        else:
            print(
                "\nDRY RUN: Nothing was written to SQLite"
            )
            print(
                "Review unresolved matches "
                "before using --apply"
            )


if __name__ == "__main__":
    main()
