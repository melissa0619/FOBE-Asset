# API reference

These are FastAPI paths. The missing external Node-RED flow is expected to forward the same paths beneath `/api`; no untracked gateway-only routes are documented here.

| Method/path | Purpose | Inputs | Result |
| --- | --- | --- | --- |
| `GET /health` | API/database health | none | status and latest sync time |
| `GET /assets` | list assets | `active_only`, `limit` 1–500, `offset` | asset array |
| `GET /assets/{asset_id}` | asset detail | itemit ID | asset or 404 |
| `GET /collections` | list collections | `active_only`, `limit`, `offset` | collection array |
| `GET /collections/{collection_id}` | collection detail | ID | collection or 404 |
| `POST /matching/candidates` | retrieve candidate inventory; never maps | IFC metadata, filters, paging | candidate page |
| `GET /mappings` | list confirmed mappings | optional `model_key`, `itemit_item_id` | mapping array |
| `GET /mappings/status` | one mapping | `model_key`, `ifc_global_id` | mapping or 404 |
| `POST /mappings` | create mapping | JSON below | 201 mapping |
| `PATCH /mappings/display-name` | update display name | model key, GlobalId, name | mapping |
| `PUT /mappings/{model_key}/{ifc_global_id}` | update inactive legacy mapping | mutable fields | mapping / 409 if confirmed |
| `DELETE /mappings/{model_key}/{ifc_global_id}` | remove relationship | path identity | 204 |
| `GET /mapped-assets`, `GET /mapped-assets.csv` | records / CSV export | none | array / CSV |

```json
{
  "model_key": "foyer",
  "ifc_global_id": "<22-character IFC GlobalId>",
  "itemit_item_id": "<existing itemit ID>",
  "mapping_method": "MANUAL",
  "notes": "Verified on site"
}
```

Writes require `FOBE_ENABLE_MAPPING_WRITES=true`. Common errors: 403 writes disabled, 404 missing record, 409 confirmed or duplicate mapping, 422 nonexistent IFC/index or itemit ID, and 503 unavailable database/index/Firestore.

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod 'http://127.0.0.1:1880/api/assets?limit=5'
Invoke-RestMethod 'http://127.0.0.1:1880/api/collections?limit=5'
Invoke-RestMethod 'http://127.0.0.1:1880/api/mappings'
```

