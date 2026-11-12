from api.itemit_client import ItemitClient
import logging
import os
import sqlite3
import sys
from datetime import datetime, timezone

from storage.database import DB_PATH, save_initial_baseline
from handlers.collection_membership_sync import reconcile
from storage.run_lock import SyncAlreadyRunning, SyncRunLock
from handlers.change_handler import (
    build_index,
    get_pending_removals,
    sync_snapshot,
)


LOG_PATH = "data/sync.log"
LOCK_PATH = "data/asset_sync.lock"


def configure_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8"), logging.StreamHandler()],
    )


def main():
    configure_logging()
    started_at = datetime.now(timezone.utc).isoformat()
    with SyncRunLock(LOCK_PATH):
        return run_sync(started_at)


def run_sync(started_at):
    client = ItemitClient()
    logging.info("Synchronization started")

    items = client.get_all_items()
    collections = client.get_all_collections()
    usage_records = client.get_all_location_usage()
    # Collection membership is an optional, conservative enrichment. itemit
    # exposes it through collection-profiles, not the normal item response.
    # If this endpoint is unavailable or incomplete, preserve current links.
    try:
        collection_profiles = client.get_all_collection_profiles()
        membership_records = client.resolve_collection_profile_memberships(
            items, collections, collection_profiles
        )
    except Exception as error:  # Enrichment must never block inventory sync.
        logging.warning("Collection-profile membership sync unavailable: %s", error)
        membership_records = client.resolve_item_collection_memberships(items)
    logging.info("itemit request metrics: %s", client.request_metrics())

    current_locations = {}
    for record in usage_records:
        usage = record.get("usage") or {}
        if usage.get("to") is not None:
            continue

        item_id = record.get("id")
        location = usage.get("location")
        if not item_id or not location:
            continue

        previous = current_locations.get(item_id)
        if previous and previous != location:
            raise ValueError(f"Conflicting active locations for item {item_id}")
        current_locations[item_id] = location

    print("\n--- API DATA SUMMARY ---")
    print("Items:", len(items))
    print("Collections:", len(collections))
    print("Location usage records:", len(usage_records))
    print_collection_status(membership_records)

    initialized = save_initial_baseline(
        items=items,
        collections=collections,
        current_locations=current_locations,
        run_started_at=started_at,
    )
    if initialized:
        with sqlite3.connect(DB_PATH) as conn:
            summary = reconcile(conn, membership_records, dry_run=True)
        print_collection_result(summary, "DRY_RUN")
        logging.info("Initial baseline saved; successful run recorded")
        return

    # Before soft-deleting a missing UUID, fetch a second independent full
    # snapshot of that resource. A transient disappearance stops the sync.
    pending_items, pending_collections = get_pending_removals(
        items, collections
    )
    if pending_items:
        print(f"Rechecking {len(pending_items)} missing item(s)...")
        confirmation_items = build_index(
            client.get_all_items(), "Confirmation items"
        )
        if pending_items & set(confirmation_items):
            raise RuntimeError(
                "An item reappeared during confirmation. "
                "Synchronization cancelled; retry with a fresh snapshot."
            )
    if pending_collections:
        print(f"Rechecking {len(pending_collections)} missing Collection(s)...")
        confirmation_collections = build_index(
            client.get_all_collections(), "Confirmation Collections"
        )
        if pending_collections & set(confirmation_collections):
            raise RuntimeError(
                "A Collection reappeared during confirmation. "
                "Synchronization cancelled; retry with a fresh snapshot."
            )

    events = sync_snapshot(
        items=items,
        collections=collections,
        current_locations=current_locations,
        confirmed_removed_item_ids=pending_items,
        confirmed_removed_collection_ids=pending_collections,
        run_started_at=started_at,
    )

    print("\n--- CHANGE DETECTION RESULTS ---")
    print("Total changes detected:", len(events))
    for event in events:
        print(f"[{event['event_type']}] {event['entity_id']}")
        print("  Before:", event["previous_value"])
        print("  After: ", event["new_value"])
    logging.info("Synchronization completed successfully with %s change(s)", len(events))

    # Safe default for the scheduled task: report only until an administrator
    # has reviewed a complete snapshot and explicitly enables application.
    apply_memberships = os.getenv("ITEMIT_COLLECTION_SYNC_APPLY", "false").lower() in {"1", "true", "yes"}
    with sqlite3.connect(DB_PATH) as conn:
        summary = reconcile(conn, membership_records, dry_run=not apply_memberships)
    print_collection_result(summary, "APPLY" if apply_memberships else "DRY_RUN")


def print_collection_status(records):
    counts = {state: sum(row.get("status") == state for row in records)
              for state in ("COMPLETE", "EMPTY", "PARTIAL", "INCOMPLETE", "UNKNOWN")}
    relationships = sum(len(row.get("memberships", [])) for row in records
                        if row.get("status") in {"COMPLETE", "EMPTY", "PARTIAL"})
    print("\n--- COLLECTION MEMBERSHIP STATUS ---")
    print("Total item records fetched:", len(records))
    print("Items with complete Collection information:", counts["COMPLETE"])
    print("Items explicitly having zero Collections:", counts["EMPTY"])
    print("Items with partially observed Collection information:", counts["PARTIAL"])
    print("Items with incomplete information:", counts["INCOMPLETE"])
    print("Items with missing information:", counts["UNKNOWN"])
    print("Total validated Collection relationships:", relationships)


def print_collection_result(summary, mode):
    print("Collection reconciliation mode:", mode)
    print("Proposed additions:", summary["added"])
    print("Proposed removals:", summary["removed"])
    print("Unchanged relationships:", summary["unchanged"])
    print("Partially observed item UUIDs:", summary["partial_items"])
    print("Unresolved item UUIDs:", ", ".join(summary["unresolved_item_ids"]) or "none")
    print("PDF-derived relationships remain:", "yes" if summary["pdf_derived_remain"] else "no")
    if summary["unresolved"]:
        print("Collection reconciliation remains partial; unresolved memberships were preserved.")
    else:
        print("Collection reconciliation completed for all fetched items.")


if __name__ == "__main__":
    try:
        main()
    except SyncAlreadyRunning as error:
        logging.basicConfig(level=logging.INFO)
        logging.warning("Synchronization skipped: %s", error)
        sys.exit(0)
    except Exception:
        logging.exception("Synchronization failed; SQLite snapshot was not changed")
        sys.exit(1)
