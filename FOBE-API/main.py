"""HTTP access to synchronized FOBE assets and persistent IFC mappings."""

import json
import os
import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Response, status
from pydantic import BaseModel, Field

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from firestore_mapping_store import (
    FirestoreMappingStore,
    MappingAlreadyExists,
    MappingConfirmed,
    MappingNotFound,
    MappingStoreUnavailable,
)
from matching import filter_candidates, normalize_asset, normalize_ifc_element

DATABASE_PATH = Path(
    os.getenv(
        "FOBE_ASSET_DB",
        Path(__file__).resolve().parent.parent / "data" / "asset_sync.db",
    )
)
app = FastAPI(title="FOBE API", version="0.1.0")
MAPPING_STORE_FACTORY = FirestoreMappingStore


class MappingCreate(BaseModel):
    model_key: str = Field(min_length=1, max_length=120)
    ifc_global_id: str = Field(min_length=1, max_length=255)
    itemit_item_id: str = Field(min_length=1, max_length=255)
    mapping_status: Literal["CONFIRMED"] = "CONFIRMED"
    mapping_method: str = Field(default="MANUAL", min_length=1, max_length=40)
    notes: str | None = Field(default=None, max_length=4000)


class MappingUpdate(BaseModel):
    itemit_item_id: str | None = Field(default=None, min_length=1, max_length=255)
    mapping_method: str | None = Field(default=None, min_length=1, max_length=40)
    notes: str | None = Field(default=None, max_length=4000)


class CandidateFilters(BaseModel):
    name: str | None = Field(default=None, max_length=500)
    serial: str | None = Field(default=None, max_length=500)
    location: str | None = Field(default=None, max_length=500)
    collection: str | None = Field(default=None, max_length=500)


class CandidateRequest(BaseModel):
    """Raw IFC metadata from BIM Studio; it is not a mapping request."""
    model_key: str | None = Field(default=None, max_length=120)
    global_id: str | None = Field(default=None, max_length=255)
    name: str | None = Field(default=None, max_length=1000)
    ifc_type: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    room: dict | str | None = None
    identifying_properties: dict | None = None
    classification: str | None = Field(default=None, max_length=80)
    filters: CandidateFilters = Field(default_factory=CandidateFilters)
    active_only: bool = True
    limit: int = Field(default=100, ge=1, le=500)
    offset: int = Field(default=0, ge=0)


@contextmanager
def database():
    if not DATABASE_PATH.is_file():
        raise HTTPException(status_code=503, detail="Asset database is unavailable")
    conn = sqlite3.connect(f"file:{DATABASE_PATH.resolve()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def require_itemit_item(itemit_item_id):
    # The existing synchronized inventory key is items.id, verified from schema.
    with database() as conn:
        exists = conn.execute("SELECT 1 FROM items WHERE id = ?", (itemit_item_id,)).fetchone()
    if not exists:
        raise HTTPException(status_code=422, detail="itemit_item_id does not exist in local inventory")


def require_item_available_in_model(model_key, ifc_global_id, itemit_item_id):
    """Revalidate same-model assignment immediately before every mapping write."""
    try:
        conflicts = [row for row in mapping_store().list(model_key=model_key)
                     if row.get("itemit_item_id") == itemit_item_id
                     and row.get("ifc_global_id") != ifc_global_id]
    except MappingStoreUnavailable as error:
        mapping_error(error)
    if conflicts:
        raise HTTPException(
            status_code=409,
            detail="itemit_item_id is already mapped to another IFC GlobalId in this model",
        )


def mapping_store():
    return MAPPING_STORE_FACTORY()


def require_mapping_writes_enabled():
    """Fail closed: unauthenticated writes must be opted into for local use."""
    if os.getenv("FOBE_ENABLE_MAPPING_WRITES", "false").lower() not in {"1", "true", "yes"}:
        raise HTTPException(
            status_code=403,
            detail="Mapping writes are disabled. Set FOBE_ENABLE_MAPPING_WRITES=true only for trusted local development.",
        )


def mapping_actor() -> str:
    # There is no request authentication yet. Do not imply this is an identity
    # asserted by a user; deployment must add auth before exposing writes.
    return os.getenv("FOBE_MAPPING_ACTOR", "local-unverified")


def mapping_error(error):
    if isinstance(error, MappingConfirmed):
        raise HTTPException(
            status_code=409,
            detail="This IFC element is already mapped and confirmed.",
        ) from error
    if isinstance(error, MappingNotFound):
        raise HTTPException(status_code=404, detail="IFC mapping not found") from error
    if isinstance(error, MappingAlreadyExists):
        raise HTTPException(status_code=409, detail="A mapping already exists for this model_key and ifc_global_id") from error
    if isinstance(error, MappingStoreUnavailable):
        raise HTTPException(status_code=503, detail=str(error)) from error
    raise error


def serialize_asset(row):
    asset = json.loads(row["raw_json"])
    asset["is_active"] = bool(row["is_active"])
    asset["current_location"] = row["location"]
    asset["collection_memberships"] = json.loads(row["collection_memberships_json"] or "[]")
    # Kept for the existing BIM Studio collection filter.
    asset["collections"] = [membership["name"] for membership in asset["collection_memberships"]]
    return asset


def serialize_collection(row):
    """Expose a collection even when it has no item memberships."""
    collection = json.loads(row["raw_json"] or "{}")
    collection["id"] = row["id"]
    collection["name"] = row["name"]
    collection["parent_id"] = row["parent_id"]
    collection["is_active"] = bool(row["is_active"])
    return collection


ASSET_SELECT = """
    SELECT i.raw_json, i.is_active, l.location,
           COALESCE((
             SELECT json_group_array(json_object('id', c.id, 'name', c.name, 'source', ic.source))
               FROM item_collections ic
               JOIN collections c ON c.id = ic.collection_id
              WHERE ic.item_id = i.id
           ), '[]') AS collection_memberships_json
      FROM items i
 LEFT JOIN item_locations l ON l.item_id = i.id
"""


def inventory_assets(active_only=True, limit=None, offset=0):
    with database() as conn:
        query, params = ASSET_SELECT, []
        if active_only:
            query += " WHERE i.is_active = 1"
        query += " ORDER BY i.name, i.id"
        if limit is not None:
            query += " LIMIT ? OFFSET ?"
            params.extend([limit, offset])
        return [serialize_asset(row) for row in conn.execute(query, params)]


@app.get("/health")
def health():
    with database() as conn:
        try:
            latest = conn.execute(
                "SELECT completed_at FROM sync_runs WHERE status = 'SUCCESS' "
                "ORDER BY id DESC LIMIT 1"
            ).fetchone()
        except sqlite3.OperationalError:
            # Databases created before run logging are still readable.
            latest = None
    return {"status": "ok", "last_successful_sync": latest["completed_at"] if latest else None}


@app.get("/assets")
def list_assets(active_only: bool = True, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
    return inventory_assets(active_only=active_only, limit=limit, offset=offset)


@app.get("/assets/{asset_id}")
def get_asset(asset_id: str):
    with database() as conn:
        row = conn.execute(ASSET_SELECT + " WHERE i.id = ?", (asset_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Asset not found")
    return serialize_asset(row)


@app.get("/collections")
def list_collections(
    active_only: bool = True,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """List synchronized collections, including collections without assets."""
    with database() as conn:
        query = "SELECT id, name, parent_id, raw_json, is_active FROM collections"
        params = []
        if active_only:
            query += " WHERE is_active = 1"
        query += " ORDER BY name, id LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        rows = conn.execute(query, params).fetchall()
    return [serialize_collection(row) for row in rows]


@app.get("/collections/{collection_id}")
def get_collection(collection_id: str):
    with database() as conn:
        row = conn.execute(
            "SELECT id, name, parent_id, raw_json, is_active FROM collections WHERE id = ?",
            (collection_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Collection not found")
    return serialize_collection(row)


@app.post("/matching/candidates")
def retrieve_candidates(payload: CandidateRequest):
    """Return a paged, read-only inventory pool for a selected IFC element.

    Metadata is normalized only for transparent filtering and future analysis.
    No name, type, collection, or room match creates or changes a mapping.
    """
    assets = inventory_assets(active_only=payload.active_only, limit=None)
    prepared = [{**asset, "normalized": normalize_asset(asset)} for asset in assets]
    filtered = filter_candidates(prepared, payload.filters.model_dump())
    page = filtered[payload.offset:payload.offset + payload.limit]
    return {
        "ifc": {"raw": payload.model_dump(exclude={"filters", "limit", "offset", "active_only"}), "normalized": normalize_ifc_element(payload.model_dump())},
        "filters_applied": payload.filters.model_dump(),
        "total": len(filtered),
        "offset": payload.offset,
        "limit": payload.limit,
        "candidates": page,
        "notice": "Candidates are retrieval results only; no physical identity or mapping is inferred.",
    }


@app.post("/mappings", status_code=status.HTTP_201_CREATED)
def create_mapping(payload: MappingCreate):
    require_mapping_writes_enabled()
    require_itemit_item(payload.itemit_item_id)
    require_item_available_in_model(
        payload.model_key, payload.ifc_global_id, payload.itemit_item_id
    )
    try:
        return mapping_store().create({
            **payload.model_dump(exclude={"mapping_status"}),
            "mapping_status": "CONFIRMED",
            "authenticated_user": mapping_actor(),
        })
    except (MappingAlreadyExists, MappingConfirmed, MappingStoreUnavailable) as error:
        mapping_error(error)


@app.get("/mappings")
def list_mappings(model_key: str | None = None, itemit_item_id: str | None = None):
    try:
        return mapping_store().list(model_key=model_key, itemit_item_id=itemit_item_id)
    except MappingStoreUnavailable as error:
        mapping_error(error)


@app.get("/mappings/status")
def get_mapping_status(model_key: str, ifc_global_id: str):
    try:
        return mapping_store().get(model_key, ifc_global_id)
    except (MappingNotFound, MappingStoreUnavailable) as error:
        mapping_error(error)


@app.put("/mappings/{model_key}/{ifc_global_id}")
def update_mapping(model_key: str, ifc_global_id: str, payload: MappingUpdate):
    require_mapping_writes_enabled()
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=422, detail="At least one mapping field is required")
    if "itemit_item_id" in changes:
        require_itemit_item(changes["itemit_item_id"])
        require_item_available_in_model(model_key, ifc_global_id, changes["itemit_item_id"])
    changes["authenticated_user"] = mapping_actor()
    try:
        return mapping_store().update(model_key, ifc_global_id, changes)
    except (MappingNotFound, MappingConfirmed, MappingStoreUnavailable) as error:
        mapping_error(error)


@app.delete("/mappings/{model_key}/{ifc_global_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_mapping(model_key: str, ifc_global_id: str):
    require_mapping_writes_enabled()
    try:
        mapping_store().delete(model_key, ifc_global_id)
    except (MappingNotFound, MappingConfirmed, MappingStoreUnavailable) as error:
        mapping_error(error)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
