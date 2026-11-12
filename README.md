# FOBE Assets

FOBE Assets synchronizes an itemit workspace into a local SQLite inventory
snapshot and provides a local FastAPI integration service for BIM tools.

```text
itemit -> synchronizer -> data/asset_sync.db -> FOBE API -> Firestore mappings
```

## Current architecture

- itemit is the source of truth for assets, collections, and locations.
- `main.py` is the itemit-to-SQLite synchronizer and the only writer of
  inventory tables.
- `FOBE-API` reads the SQLite snapshot for `/assets` and `/collections`; it
  does not fetch itemit inventory while serving a request.
- Firestore collection `ifc_item_mappings` is authoritative for IFC-to-itemit
  mappings. Mapping writes never fall back to SQLite.
- New mappings are always `CONFIRMED` and are immutable: they cannot be
  remapped or deleted through the API.

## Repository layout

```text
FOBE-Asset/
|- main.py                    Synchronization entry point
|- api/itemit_client.py       Authenticated, paginated itemit client
|- storage/                   SQLite schema and synchronization lock
|- handlers/                  Snapshot change and membership handling
|- importers/pdf_importer.py  Optional historical PDF membership importer
|- FOBE-API/                  FastAPI inventory and Firestore mapping service
|- scripts/run_sync.cmd       Windows Task Scheduler sync launcher
`- tests/                     Synchronizer and API tests
```

Runtime state (`.env`, `.venv`, databases, logs, Firebase credentials, and
exports in `data/`) is ignored by Git. Do not commit secrets or working data.

## Setup

Use PowerShell from `FOBE-Asset` with Python 3.10 or later:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pip install -r .\FOBE-API\requirements.txt
Copy-Item .env.example .env
```

Configure itemit in `.env`:

```dotenv
ITEMIT_BASE_URL=https://api.itemit.com/v1
ITEMIT_API_KEY=replace_with_itemit_api_key
ITEMIT_USER_ID=replace_with_itemit_user_id
ITEMIT_USER_TOKEN=replace_with_itemit_user_token
ITEMIT_WORKSPACE_ID=replace_with_itemit_workspace_id
```

Optional API and mapping settings:

```dotenv
FOBE_API_HOST=127.0.0.1
FOBE_API_PORT=8000
# FOBE_ASSET_DB=C:\path\to\asset_sync.db

FOBE_FIREBASE_PROJECT_ID=your-firebase-project-id
FOBE_FIREBASE_CREDENTIALS=C:\secure\firebase-service-account.json
FOBE_ENABLE_MAPPING_WRITES=false
FOBE_MAPPING_ACTOR=local-unverified

# Persist verified item-to-collection memberships fetched during sync.
# ITEMIT_COLLECTION_SYNC_APPLY=false
```

Keep the Firebase service-account file outside the repository. Use Application
Default Credentials instead when running on Google-managed infrastructure.

## Run and verify

Create or update the inventory snapshot:

```powershell
.\.venv\Scripts\python.exe main.py
```

Start the API after a successful sync:

```powershell
.\.venv\Scripts\python.exe .\FOBE-API\scripts\start_api.py
```

Verify from a second terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:8000/assets?limit=1
Invoke-RestMethod http://127.0.0.1:8000/collections?limit=100
.\.venv\Scripts\python.exe -m pytest -q
```

Swagger is available at `http://127.0.0.1:8000/docs`. `/collections` returns
standalone collections, including collections that currently have no assets.

## Operations

`scripts/run_sync.cmd` is the Windows Task Scheduler launcher. Configure it
with working directory `FOBE-Asset`, an account that can read `.env` and write
`data` and `logs`, and the desired schedule. The synchronizer prevents
overlapping runs, validates upstream snapshots, and soft-deletes records only
after a confirmation fetch.

Install the local API startup task from `FOBE-API`:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\scripts\install_api_task.ps1
```

The default `127.0.0.1` service has no authentication or authorization. Before
using it beyond the host, add HTTPS, authentication, authorization, managed
secrets, monitoring, and an explicit firewall policy.

## Optional utilities

Preview or import historical PDF collection memberships:

```powershell
.\.venv\Scripts\python.exe -m importers.pdf_importer --pdf input\itemit_report.pdf --db data\asset_sync.db
.\.venv\Scripts\python.exe -m importers.pdf_importer --pdf input\itemit_report.pdf --db data\asset_sync.db --apply
```

Export the SQLite collection hierarchy:

```powershell
.\.venv\Scripts\python.exe -m handlers.structure_handler --db data\asset_sync.db --output data\collection_tree.json
```

See [FOBE-API/README.md](FOBE-API/README.md) for the API contract, Firestore
configuration, and the confirmed-only mapping workflow.
