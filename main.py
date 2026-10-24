from api.itemit_client import ItemitClient
from storage.database import save_initial_baseline
from handlers.change_handler import sync_snapshot


def main():
    client = ItemitClient()

    print("Fetching itemit data...")

    items = client.get_all_items()
    collections = client.get_all_collections()
    usage_records = client.get_all_location_usage()

    # Build the current item-location mapping.
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
            raise ValueError(
                f"Conflicting active locations for item {item_id}"
            )

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
    else:
        events = sync_snapshot(
            items=items,
            collections=collections,
            current_locations=current_locations,
            ignored_missing_collection_ids={
                "1b3fb33e-e5d1-466a-a949-9fbd041c4e15"
            },
        )

        print("\n--- CHANGE DETECTION RESULTS ---")
        print("Total changes detected:", len(events))

        for event in events:
            print(
                f"[{event['event_type']}] "
                f"{event['entity_id']}"
            )
            print("  Before:", event["previous_value"])
            print("  After: ", event["new_value"])



if __name__ == "__main__":
    main()
