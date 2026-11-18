# Configuration

`.env` is ignored; `.env.example` has safe placeholders. Only `VITE_` values enter browser code, so they must never be secrets.

| Variable | Component | Required | Sensitive | Notes |
| --- | --- | --- | --- | --- |
| `ITEMIT_BASE_URL` | synchronizer | No | No | Defaults `https://api.itemit.com/v1`. |
| `ITEMIT_API_KEY`, `ITEMIT_USER_ID`, `ITEMIT_USER_TOKEN`, `ITEMIT_WORKSPACE_ID` | synchronizer | Yes for sync | Yes | itemit credentials. |
| `ITEMIT_REQUESTS_PER_MINUTE` | synchronizer | No | No | Default `70`. |
| `ITEMIT_ITEM_CACHE_TTL_SECONDS`, `ITEMIT_COLLECTION_CACHE_TTL_SECONDS`, `ITEMIT_LOCATION_CACHE_TTL_SECONDS` | synchronizer | No | No | Defaults 1800, 1800, 3600. |
| `ITEMIT_COLLECTION_SYNC_APPLY` | synchronizer | No | No | Default false/dry run for membership changes. |
| `FOBE_ASSET_DB` | API | No | Usually no | Default `data/asset_sync.db`. |
| `FOBE_IFC_INDEX_DIR` | API | No | No | Default `public/ifc-index`. |
| `FOBE_API_HOST`, `FOBE_API_PORT` | API launcher | No | No | Defaults `127.0.0.1:8000`. |
| `FOBE_FIREBASE_PROJECT_ID` | API | Usually | No | Firebase project. |
| `FOBE_FIREBASE_CREDENTIALS` | API | Yes outside managed Google auth | Yes | Service-account JSON path. |
| `FIRESTORE_EMULATOR_HOST` | Firebase SDK | No | No | Emulator only. |
| `FOBE_ENABLE_MAPPING_WRITES` | API | No | No | Defaults false; trusted local use only. |
| `FOBE_MAPPING_ACTOR` | API | No | Potentially | Audit label, not authentication. |
| `FOBE_NODE_RED_TARGET` | Vite | No | No | Default `http://127.0.0.1:1880`. |
| `VITE_API_BASE_URL` | Vite | No | Public | Compiled fallback; runtime configuration is preferred. |
| `IFC_SOURCE_DIR` | IFC generator | Yes to regenerate | No | Folder containing the five source IFC files. |
| `GITHUB_TOKEN` | watcher | Yes to publish | Yes | Fine-grained Contents read/write token. |
| `REPO_OWNER`, `REPO_NAME`, `GITHUB_BRANCH` | watcher | owner/name yes | No | Branch default is `main`. |
| `TUNNEL_LOG_PATH`, `GITHUB_PAGES_ORIGIN` | watcher | No | No | Log defaults `logs/tunnel.log`; origin is optional validation. |

`config/backend.json` is public runtime data: schema version, public HTTPS `/api` URL, timestamp. It must never contain credentials. Node-RED configuration is external to this repository and should use Node-RED's credential system.

