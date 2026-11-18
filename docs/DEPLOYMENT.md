# Deployment and tunnel watcher

Start FastAPI, verify `/health`, start Node-RED and verify `/api/health`, then create a tunnel to Node-RED:

```powershell
New-Item -ItemType Directory -Force .\logs | Out-Null
cloudflared tunnel --url http://127.0.0.1:1880 --logfile .\logs\tunnel.log
npm run watch:tunnel
```

The watcher finds the latest `https://*.trycloudflare.com` address, validates `<url>/api/health`, updates local `VITE_API_BASE_URL`, writes `config/backend.json`, and publishes it using the GitHub Contents API. It requires `REPO_OWNER`, `REPO_NAME`, and `GITHUB_TOKEN` with Contents read/write access; branch defaults to `main`. A 403 indicates incorrect token scope, owner/repository, or branch permission.

GitHub Pages publishes `config/backend.json`; the viewer fetches it at runtime. Pages propagation can take time. Only one machine should watch/publish a repository branch at once: competing watchers can flip the public URL to an offline machine. Stop the old watcher before moving hosts or use separate branches/repositories.

`npm run build` writes the Pages artifacts to root. No GitHub Actions Pages workflow or Node-RED flow export is tracked, so their setup remains an owner-managed external dependency.

