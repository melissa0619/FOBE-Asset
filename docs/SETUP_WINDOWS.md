# Windows setup

Install Git, Node.js with npm, Python 3.11 (or compatible Python 3), Node-RED, and `cloudflared`. You need itemit credentials, Firebase project access and a service-account JSON file, and GitHub Contents permission if using the tunnel watcher. The Node-RED flow is not contained in this repository.

```powershell
git clone <repository-url> FOBE-Assets
Set-Location .\FOBE-Assets
npm ci
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r .\requirements.txt
.\.venv\Scripts\python.exe -m pip install -r .\FOBE-API\requirements.txt
Copy-Item .\.env.example .\.env
```

Edit `.env` locally. Put Firebase service-account JSON outside the checkout and set `FOBE_FIREBASE_CREDENTIALS` to its absolute path. Supply itemit values and leave `FOBE_ENABLE_MAPPING_WRITES=false` initially.

The initial sync creates ignored `data\asset_sync.db`:

```powershell
.\.venv\Scripts\python.exe .\main.py
.\.venv\Scripts\python.exe .\FOBE-API\scripts\start_api.py
Invoke-RestMethod http://127.0.0.1:8000/health
```

The API defaults to port 8000. To use 8001, add `FOBE_API_PORT=8001` to `.env`, restart FastAPI, and update Node-RED's upstream URL to `http://127.0.0.1:8001`.

Import the separately supplied Node-RED flow. It must expose `/api` and forward, for example, `/api/health` to FastAPI `/health`, preserving JSON responses and allowing the GitHub Pages origin through CORS. Verify it:

```powershell
Invoke-RestMethod http://127.0.0.1:1880/api/health
npm run dev
New-Item -ItemType Directory -Force .\logs | Out-Null
cloudflared tunnel --url http://127.0.0.1:1880 --logfile .\logs\tunnel.log
npm run watch:tunnel
```

Open the Vite URL printed by `npm run dev`. The Pages URL is `https://<owner>.github.io/FOBE-Asset/` when Pages is configured. No Pages workflow is tracked, so retain or configure the repository's Pages source separately.

Optional API Task Scheduler setup:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\FOBE-API\scripts\install_api_task.ps1
Start-ScheduledTask -TaskName 'FOBE API Server'
```

## Migration checklist

- Install Git, Node.js/npm, Python, Node-RED, and cloudflared on the new computer.
- Clone the repository; install npm and both Python dependency sets in `.venv`.
- Create a new local `.env`; transfer credentials through a secure channel, never Git.
- Obtain the Firebase service-account access and set the new absolute credential path.
- Create a new SQLite baseline by running the synchronizer (or transfer data only with appropriate approval).
- Import the Node-RED flow and set its FastAPI target to the selected port.
- Start the API, Node-RED, tunnel, and exactly one repository tunnel watcher.
- Recreate the Task Scheduler task if automatic API startup is needed.
- Verify direct API, gateway, public tunnel, runtime `config/backend.json`, and an end-to-end mapping read before enabling mapping writes.

