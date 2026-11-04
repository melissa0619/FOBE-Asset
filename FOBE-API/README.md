# FOBE API

FOBE-API reads the synchronized SQLite inventory snapshot. IFC-to-itemit mappings are stored authoritatively in Firebase Cloud Firestore; itemit synchronization remains the only writer of inventory tables.
The API entry point is `main:app`; it uses the parent project's virtual
environment: `..\.venv\Scripts\python.exe`. Its local default is
`http://127.0.0.1:8000`, and it exposes `/health`, `/assets`,
`/assets/{asset_id}`, and `/mappings`.

## Automatic Windows startup

`scripts\start_api.py` validates the SQLite path, prevents a second listener
on the configured port, and runs Uvicorn without reload or extra workers.
It writes launcher and runtime output to `logs\api-server.log`; no secrets are
written there. Install the current-user logon task with:

```powershell
cd C:\Users\Melissa\FOBE-Assets\FOBE-Asset\FOBE-API
PowerShell -ExecutionPolicy Bypass -File .\scripts\install_api_task.ps1
```

The `FOBE API Server` task starts at the current user's next Windows logon,
allows only one task instance, has no execution time limit, works across AC /
battery changes, and retries up to three unexpected failures one minute apart.
It is independent of the `FOBE Asset Synchronization` task, which continues to
run inventory synchronization every 30 minutes.

Useful commands:

```powershell
# Start / stop / restart now
Start-ScheduledTask -TaskName 'FOBE API Server'
Stop-ScheduledTask -TaskName 'FOBE API Server'
Stop-ScheduledTask -TaskName 'FOBE API Server'; Start-ScheduledTask -TaskName 'FOBE API Server'

# Inspect task, listener, health and logs
Get-ScheduledTaskInfo -TaskName 'FOBE API Server'
Get-NetTCPConnection -LocalPort 8000 -State Listen
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:8000/assets?limit=1
Get-Content .\logs\api-server.log -Tail 100

# Remove only the API startup task
PowerShell -ExecutionPolicy Bypass -File .\scripts\uninstall_api_task.ps1
```

If port 8000 is occupied, inspect the owner with
`Get-NetTCPConnection -LocalPort 8000 -State Listen | Select-Object OwningProcess`
and stop the old API task before restarting it. `FOBE_ASSET_DB` may point at an
absolute alternate database path; it must be readable by the logged-in user.

This is local-development configuration: `127.0.0.1` is not reachable by BIM
Studio or Node-RED running on a different machine. Windows sleep, shutdown, or
being logged out prevents availability. For production, use an always-on host,
a supervised service account, persistent data, HTTPS and authentication before
binding to a network interface. Do not open firewall ports without an explicit
deployment decision.

## Firestore mapping persistence

Install the API dependencies, including Firebase Admin:

```powershell
..\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Set these environment variables in an uncommitted `.env` or in the server's secret manager:

```text
FOBE_FIREBASE_PROJECT_ID=your-firebase-project-id
FOBE_FIREBASE_CREDENTIALS=C:\secure\firebase-service-account.json
FOBE_ENABLE_MAPPING_WRITES=true
FOBE_MAPPING_ACTOR=local-unverified
```

`FOBE_FIREBASE_CREDENTIALS` is a Firebase service-account JSON path and is ignored by Git. On Google-managed infrastructure, omit it and use Application Default Credentials. For emulator testing, set `FIRESTORE_EMULATOR_HOST` plus `FOBE_FIREBASE_PROJECT_ID` before starting the API.

Mappings live only in the Firestore `ifc_item_mappings` collection. Their document ID is a versioned SHA-256 digest of the complete JSON-encoded `[model_key, ifc_global_id]` pair. The fields retain both original values, so identity is queryable and collision-safe in practice. Every document includes `itemit_item_id`, status, method, notes, `authenticated_user`, and Firestore server timestamps.

SQLite is not used as a runtime mapping fallback and no mapping request dual-writes to SQLite. Existing legacy SQLite rows can be copied once, after backup and review:

```powershell
# inspect first; no writes
..\.venv\Scripts\python.exe .\scripts\migrate_sqlite_mappings_to_firestore.py --sqlite ..\data\asset_sync.db

# copy only missing Firestore records; conflicts are reported and never overwritten
..\.venv\Scripts\python.exe .\scripts\migrate_sqlite_mappings_to_firestore.py --sqlite ..\data\asset_sync.db --apply
```

## IFC-to-itemit mapping API

Mapping writes validate the synchronized inventory UUID column, `items.id`, before calling Firestore. The deterministic document ID enforces one mapping per `(model_key, ifc_global_id)`. The same itemit UUID is allowed in mappings for different models.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/mappings` | Create a mapping |
| GET | `/mappings` | List mappings; optional `model_key`, `itemit_item_id` |
| GET | `/mappings/status?model_key=...&ifc_global_id=...` | Retrieve one IFC element's mapping |
| PUT | `/mappings/{model_key}/{ifc_global_id}` | Update notes/status/method or remap the asset |
| DELETE | `/mappings/{model_key}/{ifc_global_id}` | Remove a mapping |

Example create request:

```json
{
  "model_key": "foyer",
  "ifc_global_id": "2aBcD3",
  "itemit_item_id": "36b066a7-8610-4dc5-8022-8ae1dd6c947c",
  "mapping_status": "PROVISIONAL",
  "mapping_method": "MANUAL",
  "notes": "Verified on site"
}
```

Responses include `created_at` and `updated_at` Firestore server timestamps (serialized as ISO-8601 UTC). Invalid local item UUIDs return `422`; duplicate model/GlobalId pairs return `409`; Firestore failures return `503`.

```json
{
  "model_key": "foyer",
  "ifc_global_id": "2aBcD3",
  "itemit_item_id": "36b066a7-8610-4dc5-8022-8ae1dd6c947c",
  "mapping_status": "PROVISIONAL",
  "mapping_method": "MANUAL",
  "notes": "Verified on site",
  "created_at": "2026-10-28T11:30:00+00:00",
  "updated_at": "2026-10-28T11:30:00+00:00"
}
```

There is currently no authentication or authorization mechanism in this project. Mapping writes are disabled by default and require `FOBE_ENABLE_MAPPING_WRITES=true`, which is suitable only for trusted local development bound to `127.0.0.1`. `authenticated_user` is currently recorded as the configured `FOBE_MAPPING_ACTOR` value, not a verified user identity. Add real authentication and authorization before network deployment; do not bind write routes publicly in the current state.
