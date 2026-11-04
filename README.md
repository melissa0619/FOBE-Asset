# FOBE Assets

FOBE Assets is the local data bridge between an **itemit** asset workspace and
FOBE's BIM / digital-twin tools. It is deliberately split into two small
services that share a local SQLite inventory snapshot:

```text
itemit (source of truth for assets)
             |
             v
Asset synchronizer  ----writes---->  data/asset_sync.db
                                         |       |
                                         |       +--> Collection-tree JSON export
                                         v
                               FOBE API (read-only inventory)
                                         |
                                         v
                         Firestore (source of truth for IFC mappings)
```

## What “current FOBE Assets” means

The current implementation is an **asset-inventory mirror and integration
layer**, not a replacement for itemit or a general asset-management product.

- **itemit owns assets, Collections, and location-use data.** The synchronizer
  reads these records; it never changes them in itemit.
- **SQLite is the local, operational snapshot.** It retains the prior state so
  the synchronizer can identify additions, updates, moves, removals, and
  restores. It is also what the local API serves to BIM tools.
- **Firestore owns IFC-to-itemit mappings.** A mapping links an IFC element
  (`model_key` + `ifc_global_id`) to an existing itemit asset UUID. Mapping
  writes never go back to SQLite.
- **The first sync establishes a baseline.** It stores inventory but produces
  no change events. Keep the same `data/asset_sync.db` on a continuing
  deployment; replacing it makes the next sync a new baseline.
- **PDF membership import is transitional.** It is only for Collection
  memberships that itemit does not provide completely. It is dry-run by
  default and must be explicitly applied.

The project is safe by default: inventory synchronization writes only local
SQLite, the API binds to `127.0.0.1` by default, and API mapping writes are off
unless explicitly enabled.

## Repository layout

```text
FOBE-Asset/
|- main.py                         Itemit-to-SQLite synchronization entry point
|- api/itemit_client.py            Authenticated, paginated itemit client
|- storage/                        Schema, migrations, and single-run lock
|- handlers/                       Change detection and Collection-tree export
|- importers/                      Optional PDF Collection-membership importer
|- FOBE-API/                       Local FastAPI inventory and mapping service
|- scripts/run_sync.cmd            Task Scheduler-friendly sync launcher
|- input/                          Optional source reports (for example, PDF)
|- data/                           Runtime database, JSON exports, and sync log
|- logs/                           Task Scheduler / API logs
`- tests/                          Synchronizer tests
```

`data/`, `logs/`, `.venv/`, `.env`, SQLite databases, and Firebase service
account JSON files are local runtime state and are intentionally ignored by
Git. Do not put secrets or a working database in source control.

## Set up on a new Windows computer

These instructions assume PowerShell and Python 3.10 or later. Install Python
from [python.org](https://www.python.org/downloads/windows/) and make sure the
installer's **Add Python to PATH** option is selected. Git is needed only when
cloning the repository.

### 1. Get the project and create its Python environment

Run these commands from the `FOBE-Asset` directory:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip install -r .\FOBE-API\requirements.txt
Copy-Item .env.example .env
```

If PowerShell blocks activation, use the environment's interpreter directly:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Or allow activation only for the current window:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

### 2. Configure `.env`

Open the newly created `.env` and add the itemit credentials for the intended
workspace. These four values are required for every synchronizer run:

```dotenv
ITEMIT_BASE_URL=https://api.itemit.com/v1
ITEMIT_API_KEY=replace_with_itemit_api_key
ITEMIT_USER_ID=replace_with_itemit_user_id
ITEMIT_USER_TOKEN=replace_with_itemit_user_token
ITEMIT_WORKSPACE_ID=replace_with_itemit_workspace_id
```

Optional settings, for the local API or mapping workflow, belong in the same
file:

```dotenv
# API defaults shown; leave local unless a deliberate network deployment is made.
FOBE_API_HOST=127.0.0.1
FOBE_API_PORT=8000
# FOBE_ASSET_DB=C:\path\to\asset_sync.db

# Firestore is needed only to read or write IFC mappings.
FOBE_FIREBASE_PROJECT_ID=your-firebase-project-id
FOBE_FIREBASE_CREDENTIALS=C:\secure\firebase-service-account.json
FOBE_ENABLE_MAPPING_WRITES=false
FOBE_MAPPING_ACTOR=local-unverified

# Optional: allow API-confirmed Collection memberships to be persisted on sync.
# ITEMIT_COLLECTION_SYNC_APPLY=false
```

Keep the Firebase service-account JSON outside this repository and restrict
access to the account that runs the API. For Google-managed environments, omit
`FOBE_FIREBASE_CREDENTIALS` and use Application Default Credentials instead.

### 3. Establish or transfer the inventory baseline

For a new installation, run the first sync:

```powershell
.\.venv\Scripts\python.exe main.py
```

It creates `data\asset_sync.db` and records the baseline without reporting
changes. On later runs, it reports changes against that baseline.

To move an existing deployment **without losing change history**, stop its
scheduled sync and API first, then securely copy `data\asset_sync.db` to the
same path in the new installation before running the sync. Do not copy `.env`
or Firebase credentials through Git or an untrusted channel. Back up the
database before an operating-system move or any experiment.

### 4. Verify the installation

```powershell
.\.venv\Scripts\python.exe -m pytest -q
.\.venv\Scripts\python.exe main.py
.\.venv\Scripts\python.exe .\FOBE-API\scripts\start_api.py
```

In a second PowerShell window, confirm the API after the first successful sync:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:8000/assets?limit=1
```

Stop the foreground API with `Ctrl+C`. If the database is unavailable, run the
synchronizer first or point `FOBE_ASSET_DB` at an existing copied database.

## Everyday operations

### Synchronize inventory

```powershell
.\.venv\Scripts\python.exe main.py
```

An exclusive lock prevents overlapping manual and scheduled syncs. A failed
fetch or validation check does not partially update the snapshot. Suspected
mass removals halt for review; records are soft-deleted to preserve history.

### Run synchronization on a schedule

`scripts\run_sync.cmd` is the correct launcher for Windows Task Scheduler. It
uses the project virtual environment, sets the working directory, and appends
output to `logs\task-scheduler.log`.

Create a Task Scheduler task that runs this command every 30 minutes (or the
interval your operations require):

```text
C:\path\to\FOBE-Asset\scripts\run_sync.cmd
```

Set **Start in** to `C:\path\to\FOBE-Asset`, use an account that can read
`.env` and write `data\` and `logs\`, and choose a host that stays awake if
continuous synchronization is required. Inspect `data\sync.log` and
`logs\task-scheduler.log` when a run fails.

### Run the local API automatically

After the baseline exists, install the per-user logon task:

```powershell
cd .\FOBE-API
PowerShell -ExecutionPolicy Bypass -File .\scripts\install_api_task.ps1
```

Useful checks:

```powershell
Get-ScheduledTaskInfo -TaskName 'FOBE API Server'
Get-NetTCPConnection -LocalPort 8000 -State Listen
Invoke-RestMethod http://127.0.0.1:8000/health
Get-Content .\logs\api-server.log -Tail 100
```

Remove only that API task with:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\scripts\uninstall_api_task.ps1
```

## Optional tools

Preview PDF Collection memberships (no writes):

```powershell
.\.venv\Scripts\python.exe -m importers.pdf_importer --pdf input\itemit_report.pdf --db data\asset_sync.db
```

Persist only verified PDF memberships:

```powershell
.\.venv\Scripts\python.exe -m importers.pdf_importer --pdf input\itemit_report.pdf --db data\asset_sync.db --apply
```

Export the visible Collection hierarchy for another tool:

```powershell
.\.venv\Scripts\python.exe -m handlers.structure_handler --db data\asset_sync.db --output data\collection_tree.json
```

Use `--active-only` to omit archived items. Both commands leave itemit
unchanged.

## Deployment boundary

The included scheduled tasks are suited to a trusted Windows desktop or local
development. They are not a complete network-service deployment:

- `127.0.0.1` cannot be reached by BIM Studio, Node-RED, or another computer.
- Sleep, shutdown, and logoff can make the services unavailable.
- There is currently no API authentication or authorization. Mapping writes
  must remain disabled on anything reachable over a network.

For shared or production use, deploy on an always-on host with persistent
storage, managed secrets, a service account, HTTPS, authentication and
authorization, monitoring, and an explicit firewall / network decision before
listening beyond localhost. See [FOBE-API/README.md](FOBE-API/README.md) for
the mapping API routes and Firestore migration notes.
