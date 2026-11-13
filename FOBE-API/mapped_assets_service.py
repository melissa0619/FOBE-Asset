"""Read-only Pandas projection of confirmed IFC-to-itemit mappings."""

from __future__ import annotations

from io import StringIO
from typing import Any, Callable

import pandas as pd

from display_name import resolved_display_name
from firestore_mapping_store import is_active_mapping, mapping_document_id


COLUMNS = [
    "mapping_id", "model_key", "ifc_global_id", "itemit_item_id", "is_mapped", "mapping_status",
    "mapping_method", "mapping_notes", "display_name", "mapping_created_at", "mapping_updated_at",
    "ifc_stable_key", "ifc_name", "ifc_type", "ifc_description", "ifc_object_type",
    "ifc_tag", "ifc_classification", "ifc_found", "itemit_found", "itemit_is_active",
    "itemit_name", "itemit_serial", "itemit_archived", "current_location",
    "collection_memberships", "collections",
]


def _frame(rows: list[dict[str, Any]], columns: list[str]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=columns) if rows else pd.DataFrame(columns=columns)


def _stringify(value: Any) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


class MappedAssetsService:
    def __init__(self, mapping_store, ifc_index_store, inventory_loader: Callable[..., list[dict[str, Any]]]):
        self.mapping_store = mapping_store
        self.ifc_index_store = ifc_index_store
        self.inventory_loader = inventory_loader

    def dataframe(self) -> pd.DataFrame:
        mappings = [row for row in self.mapping_store.list() if is_active_mapping(row)]
        mapping_rows = [{
            "mapping_id": row.get("mapping_id") or mapping_document_id(row["model_key"], row["ifc_global_id"]),
            "model_key": row.get("model_key"), "ifc_global_id": row.get("ifc_global_id"),
            "itemit_item_id": row.get("itemit_item_id"), "is_mapped": is_active_mapping(row),
            "mapping_status": row.get("mapping_status"),
            "mapping_method": row.get("mapping_method"), "mapping_notes": row.get("notes"),
            "display_name": row.get("display_name"),
            "display_name_source": row.get("display_name_source"),
            "mapping_created_at": _stringify(row.get("created_at")),
            "mapping_updated_at": _stringify(row.get("updated_at")),
        } for row in mappings]
        # Keep provenance only while resolving the presentation label.  It is
        # deliberately excluded from the public mapped-asset schema below.
        mapping_columns = [*COLUMNS[:11], "display_name_source"]
        mapping_df = _frame(mapping_rows, mapping_columns)
        if mapping_df.empty:
            return _frame([], COLUMNS)
        if mapping_df.duplicated(["model_key", "ifc_global_id"]).any():
            raise ValueError("Duplicate confirmed IFC mapping identities")

        ifc_columns = COLUMNS[11:18]
        ifc_rows = self.ifc_index_store.records()
        ifc_df = _frame(ifc_rows, ["model_key", "ifc_global_id", *ifc_columns])
        if ifc_df.duplicated(["model_key", "ifc_global_id"]).any():
            raise ValueError("Duplicate IFC index identities")

        assets = self.inventory_loader(active_only=False, limit=None)
        asset_rows = [{
            "itemit_item_id": asset.get("id"), "itemit_is_active": asset.get("is_active"),
            "itemit_name": asset.get("name"), "itemit_serial": asset.get("serial"),
            "itemit_archived": asset.get("archived"), "current_location": asset.get("current_location"),
            "collection_memberships": asset.get("collection_memberships") or [],
            "collections": asset.get("collections") or [],
        } for asset in assets]
        asset_columns = ["itemit_item_id", *COLUMNS[20:]]
        asset_df = _frame(asset_rows, asset_columns)
        if asset_df.duplicated(["itemit_item_id"]).any():
            raise ValueError("Duplicate itemit asset identities")

        result = mapping_df.merge(ifc_df, on=["model_key", "ifc_global_id"], how="left", validate="one_to_one", indicator="_ifc")
        result = result.merge(asset_df, on="itemit_item_id", how="left", validate="one_to_one", indicator="_itemit")
        result["ifc_found"] = result.pop("_ifc").eq("both")
        result["itemit_found"] = result.pop("_itemit").eq("both")
        result["itemit_is_active"] = result["itemit_is_active"].where(result["itemit_found"], None)
        result["display_name"] = result.apply(
            lambda row: resolved_display_name(row, row["ifc_name"], row["itemit_name"]), axis=1,
        )
        return result.reindex(columns=COLUMNS)

    def records(self) -> list[dict[str, Any]]:
        frame = self.dataframe()
        # Convert first so nullable numeric/object columns emit JSON null, not NaN.
        return frame.astype(object).where(pd.notna(frame), None).to_dict(orient="records")

    def csv(self) -> str:
        frame = self.dataframe().copy()
        for column in ("collection_memberships", "collections"):
            frame[column] = frame[column].map(lambda value: __import__("json").dumps(value, ensure_ascii=False) if isinstance(value, list) else "")
        return frame.to_csv(index=False, lineterminator="\n")
