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

Start FOBE-API separately on `127.0.0.1:8000`. Vite proxies `/api` locally. For a separately hosted build, set `VITE_FOBE_API_BASE_URL` and configure FastAPI CORS before deployment.

Run `npm run build` to generate root `index.html`, `model-view.html`, `js/`,
`css/`, `fragments/`, `ifc-index/`, `wasm/`, and `worker.mjs` for GitHub Pages.

Confirmed mappings are read-only. The UI only calls `GET /assets`, `GET /assets/{id}`, `GET /collections`, `GET /mappings`, `GET /mappings/status`, and `POST /mappings`.
