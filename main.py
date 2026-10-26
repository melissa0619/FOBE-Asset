from api.itemit_client import ItemitClient
from storage.database import save_initial_baseline
from handlers.change_handler import (
    build_index,
    get_pending_removals,
    sync_snapshot,
)


def main():
    client = ItemitClient()
    print("Fetching itemit data...")

    items = client.get_all_items()
    collections = client.get_all_collections()
    usage_records = client.get_all_location_usage()

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

    initialized = save_initial_baseline(
        items=items,
        collections=collections,
        current_locations=current_locations,
    )
    if initialized:
        print("\nFirst baseline saved. No change events generated.")
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
    )

    print("\n--- CHANGE DETECTION RESULTS ---")
    print("Total changes detected:", len(events))
    for event in events:
        print(f"[{event['event_type']}] {event['entity_id']}")
        print("  Before:", event["previous_value"])
        print("  After: ", event["new_value"])


if __name__ == "__main__":
    main()
