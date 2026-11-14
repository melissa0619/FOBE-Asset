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
separately hosted build, set `VITE_FOBE_API_BASE_URL` to the Node-RED gateway
URL and configure the gateway/API CORS policy before deployment.

Run `npm run build` to generate root `index.html`, `model-view.html`, `assets/`,
`fragments/`, `ifc-index/`, `wasm/`, and `worker.mjs` for GitHub Pages.

## GitHub Pages

In GitHub **Settings → Pages**, set the source to **Deploy from a branch**,
choose `main`, and select `/(root)`. Commit the generated root frontend
files after each build. The site is served below `/FOBE-Asset/`: Asset
Mapping is `/FOBE-Asset/` and Model View is `/FOBE-Asset/model-view.html`.

GitHub Pages cannot reach the local FastAPI proxy. For a production mapping
interface, set `VITE_FOBE_API_BASE_URL` to the public HTTPS URL of the
separately hosted FOBE API before building, and allow the Pages origin in that
API's CORS configuration. Local `npm run dev` continues to proxy `/api` to
`FOBE_API_TARGET` (or `http://127.0.0.1:8000`).

Confirmed mappings are read-only. The UI only calls `GET /assets`, `GET /assets/{id}`, `GET /collections`, `GET /mappings`, `GET /mappings/status`, and `POST /mappings`.
