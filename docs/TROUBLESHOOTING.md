# Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `ECONNREFUSED` | Start FastAPI and Node-RED; check direct `:8000/health`, then gateway `:1880/api/health`. |
| 502 gateway error | Node-RED cannot reach FastAPI. Align its target with `FOBE_API_PORT` and deploy the flow. |
| 8000 versus 8001 | The code defaults 8000. Set `FOBE_API_PORT=8001` only if Node-RED forwards to 8001 too. |
| Stale tunnel URL | Tunnel restarted or watcher stopped. Check the log, restart watcher, validate public `/api/health`, wait for Pages. |
| GitHub 403 | Use a fine-grained Contents read/write token and check owner, repo, branch. |
| Missing `dotenv`, FastAPI, Firebase | Install both requirements files into `.venv`. |
| Firestore 503 | Check Firebase project, credential path, service-account access; never commit credentials. |
| SQLite 503 | Run synchronizer and check `FOBE_ASSET_DB`. |
| Mapping 403 | Writes are disabled by default; enable only on a trusted local host. |
| Asset detail fails through gateway | Ensure Node-RED preserves `/api/assets/{id}` correctly when forwarding. |
| Node tests fail with `spawn EPERM` | Restricted runners can block Node child processes; run tests in normal local PowerShell. |

```powershell
npm test
.\.venv\Scripts\python.exe -m unittest discover -s .\tests
Push-Location .\FOBE-API
..\.venv\Scripts\python.exe -m unittest discover -s .\tests
Pop-Location
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:1880/api/health
```

