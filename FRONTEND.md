# FOBE Asset Mapping

Vite frontend for IFC-to-itemit mapping and model review. Its source is in
`frontend/`; the controlled build emits the GitHub Pages site at the repository
root. It never treats a Fragments/STEP local ID as persistent identity.

## Prepare trusted IFC metadata

The UI requires generated JSON indexes in `public/ifc-index/`. This path is
also consumed by the local FastAPI service, so it remains outside
`frontend/`. Generate indexes only from controlled source IFC files:

```powershell
cd .
$env:IFC_SOURCE_DIR = 'C:\path\to\IFC_Viewer_Weixuan\public\models'
npm run generate:ifc-index
```

The generator records the source file SHA-256 in each index. It emits `modelKey`, IFC GlobalId, name, IFC type, description, object type, stable key, and classification. It rejects records lacking a valid 22-character IFC GlobalId. It does not generate or persist mappings.

Building Overview remains read-only unless its GlobalId occurs in exactly one non-overview model index; the mapping is then written against that room model's identity.

## Run

```powershell
npm install
npm run dev
```

Start FastAPI separately, then start Node-RED with its `/api` routes forwarding
to FastAPI. Vite proxies `/api` to Node-RED at `http://127.0.0.1:1880` by
default; override that gateway address with `FOBE_NODE_RED_TARGET`. For a
separately hosted build, set `VITE_API_BASE_URL` to the public Node-RED gateway
URL, including `/api`, and configure the gateway/API CORS policy before deployment.

Run `npm run build` to generate root `index.html`, `model-view.html`, `assets/`,
`fragments/`, `ifc-index/`, `wasm/`, and `worker.mjs` for GitHub Pages.

## GitHub Pages

In GitHub **Settings → Pages**, set the source to **Deploy from a branch**,
choose `main`, and select `/(root)`. Commit the generated root frontend
files after each build. The site is served below `/FOBE-Asset/`: Asset
Mapping is `/FOBE-Asset/` and Model View is `/FOBE-Asset/model-view.html`.

GitHub Pages cannot reach the local Node-RED gateway. For a production mapping
interface, set `VITE_API_BASE_URL` to the public HTTPS Node-RED gateway URL,
including `/api`, before building, and allow the Pages origin in the gateway's
CORS configuration. Local `npm run dev` continues to proxy `/api` to
`FOBE_NODE_RED_TARGET` (or `http://127.0.0.1:1880`).

Confirmed mappings are read-only. The UI only calls `GET /assets`, `GET /assets/{id}`, `GET /collections`, `GET /mappings`, `GET /mappings/status`, and `POST /mappings`.

## Runtime API configuration

Production bundles load `config/backend.json` at runtime beneath Vite's base
path (`/FOBE-Asset/config/backend.json` on GitHub Pages). Its `apiBaseUrl` must
be an absolute HTTPS URL ending in `/api`. The file is deliberately outside the
generated paths, so `npm run build` validates but does not overwrite it.

Run `npm run watch:tunnel` on the Cloudflare/Node-RED host after setting local
ignored `GITHUB_TOKEN`, `REPO_OWNER`, and `REPO_NAME` variables. The watcher
extracts the latest Quick Tunnel URL from `TUNNEL_LOG_PATH` (default
`logs/tunnel.log`), validates `/api/health`, and updates the public JSON through
GitHub's Contents API. The browser refreshes configuration after its short
cache period or a connection failure. A tunnel outage produces a visible API
connection/configuration error; GitHub Pages updates can take time to propagate.

`VITE_API_BASE_URL` remains a migration fallback only. Local `npm run dev`
continues to use its `/api` proxy and `FOBE_NODE_RED_TARGET` configuration.
