# FOBE Asset Mapping

Standalone Vite frontend for manual, immutable IFC-to-itemit mapping. It has no 3D viewer and never treats a Fragments/STEP local ID as persistent identity.

## Prepare trusted IFC metadata

The UI requires generated JSON indexes in `public/ifc-index/`. Generate them only from the controlled source IFC files:

```powershell
cd .\FOBE-API\frontend\asset-mapping
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

Confirmed mappings are read-only. The UI only calls `GET /assets`, `GET /assets/{id}`, `GET /collections`, `GET /mappings`, `GET /mappings/status`, and `POST /mappings`.
