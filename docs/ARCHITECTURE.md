# Architecture and data design

`main.py` reads itemit items, collections, location usage, and collection profiles. It establishes an SQLite baseline then performs transactional snapshot comparison. Missing IDs are independently re-fetched before they are marked inactive. FastAPI opens SQLite read-only and validates IFC mapping identities using generated index JSON.

Firestore collection `ifc_item_mappings` is the authoritative runtime mapping store. Its document ID is deterministically derived from `[model_key, ifc_global_id]`. A normal created record has `mapping_status: CONFIRMED` and `is_mapped: true`. Transactions prevent an itemit asset from being actively mapped to two IFC elements within the same model. Confirmed mappings cannot have their identity or asset updated; a display name can be changed, and DELETE removes the relationship so a new mapping can be made.

An IFC GlobalId is the 22-character stable element identity. `model_key` identifies a generated model (`building`, `foyer`, `black`, `white`, `research`); together they form the stable mapping identity.

| SQLite table | Responsibility |
| --- | --- |
| `items` | itemit ID, name, serial, archived value, raw JSON, active flag. |
| `collections` | collection ID, name, parent, raw JSON, active flag. |
| `item_locations` | active location by item ID. |
| `item_collections` | reconciled membership links and source data. |
| `sync_metadata` | baseline marker. |
| `change_events` | detected changes. |
| `sync_runs` | successful sync time and counts. |

Check freshness with `/health`; `last_successful_sync` is read from `sync_runs`. The viewer fetches `config/backend.json` at runtime and caches it for 30 seconds. Editing local `.env` does not change an already-built Vite frontend; update runtime configuration or rebuild.

