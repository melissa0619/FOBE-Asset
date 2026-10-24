import os

import requests
from dotenv import load_dotenv


load_dotenv()


class ItemitClient:
    """Authenticate with itemit and retrieve workspace items."""

    def __init__(self):
        self.base_url = os.getenv(
            "ITEMIT_BASE_URL", "https://api.itemit.com/v1"
        ).rstrip("/")

        credentials = {
            "X-API-KEY": os.getenv("ITEMIT_API_KEY"),
            "X-USER-ID": os.getenv("ITEMIT_USER_ID"),
            "X-USER-TOKEN": os.getenv("ITEMIT_USER_TOKEN"),
            "X-WORKSPACE-ID": os.getenv("ITEMIT_WORKSPACE_ID"),
        }
        missing = [key for key, value in credentials.items() if not value]

        if missing:
            raise ValueError(f"Missing itemit credentials: {', '.join(missing)}")

        self.session = requests.Session()
        self.session.headers.update({**credentials, "Accept": "application/json"})

    def get_items(self, skip=0, limit=100):
        """Return one page of items from the configured workspace."""
        response = self.session.get(
            f"{self.base_url}/items",
            params={"skip": skip, "limit": limit},
            timeout=30,
        )
        response.raise_for_status()
        return response.json()
    
    def get_all_items(self):
        all_items = []
        skip = 0
        limit = 100

        while True:
            data = self.get_items(skip=skip, limit=limit)

            items = data.get("results", [])
            total = data.get("total")

            if not items:
                break

            all_items.extend(items)

            print(
                f"Fetched {len(all_items)} "
                f"of {total} items"
            )

            skip += len(items)

            if total is not None and len(all_items) >= total:
                break

            if len(items) < limit:
                break

        return all_items

    
    def get_all_collections(self):
        all_collections = []
        skip = 0
        limit = 100

        while True:
            response = self.session.get(
                f"{self.base_url}/collections",
                params={"skip": skip, "limit": limit},
                timeout=30
            )
            response.raise_for_status()

            data = response.json()
            collections = data.get("results", [])
            total = data.get("total")

            if not isinstance(collections, list):
                raise ValueError("Invalid Collections response")

            all_collections.extend(collections)

            print(
                f"Fetched {len(all_collections)} "
                f"of {total} collections"
            )

            if total is not None and len(all_collections) >= total:
                break

            if not collections:
                raise RuntimeError(
                    "Pagination stopped before all collections were fetched"
                )

            skip += len(collections)

        return all_collections

    
    def get_all_pages(self, endpoint, limit=100):
        """Fetch every page from a read-only itemit endpoint."""
        records = []
        skip = 0

        while True:
            response = self.session.get(
                f"{self.base_url}/{endpoint}",
                params={"skip": skip, "limit": limit},
                timeout=30
            )
            response.raise_for_status()

            data = response.json()
            page = data.get("results")
            total = data.get("total")

            if not isinstance(page, list):
                raise ValueError(
                    f"Invalid response from {endpoint}"
                )

            records.extend(page)

            print(
                f"{endpoint}: fetched {len(records)}"
                f" of {total} records"
            )

            if total is not None and len(records) >= total:
                break

            if not page:
                if total is not None and len(records) < total:
                    raise RuntimeError(
                        f"Incomplete response from {endpoint}"
                    )
                break

            skip += len(page)

            if total is None and len(page) < limit:
                break

        return records

    def get_all_locations(self):
        """Fetch location definitions."""
        return self.get_all_pages("locations")

    def get_all_location_usage(self):
        """Fetch item location history."""
        return self.get_all_pages("items/usage/locations")



if __name__ == "__main__":
    client = ItemitClient()

    try:
        items = client.get_all_items()

        print("\nSuccessfully connected to itemit!")
        print("Total items fetched:", len(items))

        print("\nFirst 5 items:")
        for item in items[:5]:
            print(item.get("name"), item.get("serial"))

       
        collections = client.get_all_collections()

        print("\nTotal collections fetched:", len(collections))
        print("\nRoot Collections:")

        for collection in collections:
            if not collection.get("parent"):
                print("-", collection.get("name"))


        # Fetch location definitions
        locations = client.get_all_locations()

        print("\nTotal locations:", len(locations))

        # Fetch item location history
        usage_records = client.get_all_location_usage()

        print("Total location history records:", len(usage_records))

        # Find the current location for each item
        current_locations = {}

        for record in usage_records:
            usage = record.get("usage") or {}

            if usage.get("to") is None and usage.get("location"):
                item_id = record.get("id")
                location = usage["location"]

                if item_id in current_locations:
                    if current_locations[item_id] != location:
                        print(
                            "WARNING: conflicting current locations:",
                            item_id
                        )
                else:
                    current_locations[item_id] = location

        print("\nItems with current locations:", len(current_locations))

        print("\nFirst 5 item locations:")

        for item in items[:5]:
            item_id = item.get("id")
            location = current_locations.get(
                item_id, "No current location"
            )

            print(item.get("serial"), "->", location)

        
        print("\n--- Items Without Current Locations ---")

        unlocated_items = [
            item for item in items
            if item.get("id") not in current_locations
        ]

        print("Total unlocated items:", len(unlocated_items))

        for item in unlocated_items:
            print(
                "Name:", item.get("name"),
                "| Serial:", item.get("serial")
            )

        unknown_location_ids = set(current_locations) - {
            item.get("id") for item in items
        }

        print(
            "Location assignments without matching items:",
            len(unknown_location_ids)
        )

    except requests.exceptions.RequestException as error:
        print("API request failed:", error)
