# FOBE API

FOBE API reads the synchronized itemit inventory from local SQLite and stores
authoritative IFC-to-itemit mappings in Firebase Cloud Firestore. It does not
call itemit while serving API requests.

## Data ownership

- itemit is the source of truth for assets, collections, and locations.
- The synchronizer writes `../data/asset_sync.db`.
- FastAPI reads that SQLite snapshot for inventory and collection routes.
- Firestore collection `ifc_item_mappings` is the source of truth for mappings.
  Mapping writes never fall back to or dual-write SQLite.

## Run locally

From `FOBE-Asset`, after configuring `.env` and running an inventory sync:

```powershell
.\.venv\Scripts\python.exe .\FOBE-API\scripts\start_api.py
```

The default address is `http://127.0.0.1:8000`; Swagger is available at
`http://127.0.0.1:8000/docs`. The launcher loads `FOBE-Asset/.env`, verifies
the configured SQLite database, and logs to `FOBE-API/logs/api-server.log`.

## API routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | API status and last successful local sync |
| GET | `/assets` | Paginated active assets from SQLite |
| GET | `/assets/{asset_id}` | One synchronized asset |
| GET | `/collections` | Paginated collections, including empty collections |
| GET | `/collections/{collection_id}` | One synchronized collection |
| POST | `/matching/candidates` | Read-only candidate retrieval for an IFC element |
| POST | `/mappings` | Create the one confirmed mapping for an IFC element |
| GET | `/mappings` | List mappings; optional `model_key`, `itemit_item_id` |
| GET | `/mappings/status` | Get the current mapping for an IFC element |
| PUT | `/mappings/{model_key}/{ifc_global_id}` | Legacy-record update; confirmed mappings are rejected |
| DELETE | `/mappings/{model_key}/{ifc_global_id}` | Hard-delete a mapping, making the IFC element and asset available again |

`GET /collections` queries the collection table directly, so an empty
collection appears after synchronization. Use `active_only=false` to include
soft-deleted collections.

## Confirmed mapping workflow

Mapping writes require `FOBE_ENABLE_MAPPING_WRITES=true` and are appropriate
only for trusted local development. A create request validates the itemit UUID
against the SQLite inventory snapshot and always creates:

```json
{"mapping_status": "CONFIRMED"}
```

Each mapping document is identified by the complete `model_key` and
`ifc_global_id` pair, encoded into a versioned SHA-256 document ID. Creation
uses a Firestore transaction: it reads that document and creates it only when
absent. Concurrent requests cannot overwrite a confirmed mapping.

Confirmed mappings cannot be overwritten or remapped in place. A duplicate
create or identity-changing update returns HTTP `409` with this detail:

```text
This IFC element is already mapped and confirmed.
```

Use `DELETE /mappings/{model_key}/{ifc_global_id}` to unmap. It hard-deletes
only the Firestore relationship; it does not change the IFC index or itemit
inventory. A new confirmed mapping can then be created for the same IFC
identity. Mapping reads return the stored `itemit_item_id` and `mapping_status`.

Example create request:

```json
{
  "model_key": "foyer",
  "ifc_global_id": "2aBcD3",
  "itemit_item_id": "36b066a7-8610-4dc5-8022-8ae1dd6c947c",
  "mapping_method": "MANUAL",
  "notes": "Verified on site"
}
```

## Firestore configuration

Install dependencies from `FOBE-Asset`:

```powershell
.\.venv\Scripts\python.exe -m pip install -r .\FOBE-API\requirements.txt
```

Configure the following in `FOBE-Asset/.env` or a secret manager:

```dotenv
FOBE_FIREBASE_PROJECT_ID=your-firebase-project-id
FOBE_FIREBASE_CREDENTIALS=C:\secure\firebase-service-account.json
FOBE_ENABLE_MAPPING_WRITES=false
FOBE_MAPPING_ACTOR=local-unverified
```

Keep service-account JSON outside the repository. On Google-managed
infrastructure, use Application Default Credentials. For an emulator, set
`FIRESTORE_EMULATOR_HOST` and `FOBE_FIREBASE_PROJECT_ID` before starting API.

To migrate legacy SQLite rows once, inspect then apply explicitly:

```powershell
.\.venv\Scripts\python.exe .\FOBE-API\scripts\migrate_sqlite_mappings_to_firestore.py --sqlite .\data\asset_sync.db
.\.venv\Scripts\python.exe .\FOBE-API\scripts\migrate_sqlite_mappings_to_firestore.py --sqlite .\data\asset_sync.db --apply
```

The migration never overwrites Firestore records and creates migrated rows as
confirmed mappings.

## Windows startup task

From `FOBE-API`, install the per-user task:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\scripts\install_api_task.ps1
```

```powershell
Start-ScheduledTask -TaskName 'FOBE API Server'
Stop-ScheduledTask -TaskName 'FOBE API Server'
Get-ScheduledTaskInfo -TaskName 'FOBE API Server'
Get-Content .\logs\api-server.log -Tail 100
```

The service binds to localhost by default and has no authentication or
authorization. Do not expose mapping writes to a network without HTTPS, real
authentication and authorization, managed secrets, and a production host.
