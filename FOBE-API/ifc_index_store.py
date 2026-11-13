"""Validated, read-only access to generated IFC element indexes."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any


INDEX_SCHEMA_VERSION = "1.0"
_INDEX_FILE = re.compile(r"^[A-Za-z0-9_-]+\.index\.json$")
_DEFAULT_DIRECTORY = Path(__file__).resolve().parent.parent / "public" / "ifc-index"


class IfcIndexError(RuntimeError):
    """Raised when the generated IFC index bundle is unavailable or invalid."""


class IfcIndexStore:
    """Load and cache trusted IFC indexes; never writes index data or mappings."""

    def __init__(self, directory: str | Path | None = None):
        self.directory = Path(directory or os.getenv("FOBE_IFC_INDEX_DIR", _DEFAULT_DIRECTORY)).resolve()
        self._records: list[dict[str, Any]] | None = None
        self._by_identity: dict[tuple[str, str], dict[str, Any]] | None = None

    @staticmethod
    def _normalise(element: dict[str, Any]) -> dict[str, Any]:
        identity = element["identity"]
        candidate = element.get("candidate") or {}
        return {
            "model_key": identity["modelKey"],
            "ifc_global_id": identity["globalId"],
            "ifc_stable_key": identity.get("stableKey") or f'{identity["modelKey"]}:{identity["globalId"]}',
            "ifc_name": element.get("name"),
            "ifc_type": element.get("ifcType"),
            "ifc_description": element.get("description"),
            "ifc_object_type": element.get("objectType"),
            "ifc_tag": element.get("tag"),
            "ifc_classification": candidate.get("classification"),
        }

    def _read_json(self, path: Path) -> dict[str, Any]:
        try:
            with path.open(encoding="utf-8") as source:
                value = json.load(source)
        except (OSError, json.JSONDecodeError) as error:
            raise IfcIndexError(f"Unable to read IFC index file: {path.name}") from error
        if not isinstance(value, dict):
            raise IfcIndexError(f"IFC index file is not an object: {path.name}")
        return value

    def _load(self) -> None:
        if self._records is not None:
            return
        manifest_path = self.directory / "manifest.json"
        manifest = self._read_json(manifest_path)
        models = manifest.get("models")
        if manifest.get("schemaVersion") != INDEX_SCHEMA_VERSION or not isinstance(models, list):
            raise IfcIndexError("IFC index manifest has an unsupported schema")

        records: list[dict[str, Any]] = []
        identities: set[tuple[str, str]] = set()
        model_keys: set[str] = set()
        for model in models:
            if not isinstance(model, dict) or not isinstance(model.get("key"), str):
                raise IfcIndexError("IFC index manifest contains an invalid model")
            key, filename = model["key"], model.get("file")
            if key in model_keys or not isinstance(filename, str) or not _INDEX_FILE.fullmatch(filename):
                raise IfcIndexError("IFC index manifest contains duplicate models or invalid file references")
            model_keys.add(key)
            index_path = (self.directory / filename).resolve()
            if index_path.parent != self.directory or not index_path.is_file():
                raise IfcIndexError(f"IFC index file is unavailable: {filename}")
            index = self._read_json(index_path)
            elements = index.get("elements")
            if (index.get("schemaVersion") != INDEX_SCHEMA_VERSION or index.get("modelKey") != key
                    or not isinstance(elements, list)):
                raise IfcIndexError(f"IFC index has an unsupported schema: {filename}")
            for element in elements:
                identity = element.get("identity") if isinstance(element, dict) else None
                if (not isinstance(identity, dict) or identity.get("modelKey") != key
                        or not isinstance(identity.get("globalId"), str) or not identity["globalId"]):
                    raise IfcIndexError(f"IFC index contains an invalid identity: {filename}")
                pair = (key, identity["globalId"])
                if pair in identities:
                    raise IfcIndexError(f"IFC index contains duplicate identity: {key}:{identity['globalId']}")
                identities.add(pair)
                records.append(self._normalise(element))
        self._records = records
        self._by_identity = {(row["model_key"], row["ifc_global_id"]): row for row in records}

    def records(self) -> list[dict[str, Any]]:
        self._load()
        return [row.copy() for row in self._records or []]

    def get(self, model_key: str, ifc_global_id: str) -> dict[str, Any] | None:
        self._load()
        row = (self._by_identity or {}).get((model_key, ifc_global_id))
        return row.copy() if row else None

    def resolve_mapping_identity(self, model_key: str, ifc_global_id: str) -> tuple[str, str] | None:
        """Mirror frontend overview handling without creating or changing a mapping."""
        self._load()
        if model_key != "building":
            return (model_key, ifc_global_id) if self.get(model_key, ifc_global_id) else None
        matches = [row for row in self._records or [] if row["model_key"] != "building" and row["ifc_global_id"] == ifc_global_id]
        return (matches[0]["model_key"], ifc_global_id) if len(matches) == 1 else None
