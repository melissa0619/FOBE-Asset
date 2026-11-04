"""Firestore-backed authoritative storage for IFC-to-itemit mappings."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any


COLLECTION_NAME = "ifc_item_mappings"


class MappingStoreUnavailable(RuntimeError):
    """Raised when Firebase credentials or Firestore are unavailable."""


class MappingAlreadyExists(RuntimeError):
    """Raised when a mapping already exists for a stable IFC identity."""


class MappingNotFound(RuntimeError):
    """Raised when no mapping exists for a stable IFC identity."""


def mapping_document_id(model_key: str, ifc_global_id: str) -> str:
    """Return a deterministic Firestore-safe ID for the complete identity pair."""
    encoded = json.dumps([model_key, ifc_global_id], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return f"v1_{hashlib.sha256(encoded).hexdigest()}"


def _as_json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return value


class FirestoreMappingStore:
    """The sole runtime mapping store. It never falls back to SQLite writes."""

    def __init__(self, client=None):
        self._client = client

    @property
    def client(self):
        if self._client is not None:
            return self._client
        try:
            import firebase_admin
            from firebase_admin import credentials, firestore

            if not firebase_admin._apps:
                options = {}
                project_id = os.getenv("FOBE_FIREBASE_PROJECT_ID")
                if project_id:
                    options["projectId"] = project_id
                credential_path = os.getenv("FOBE_FIREBASE_CREDENTIALS")
                credential = credentials.Certificate(credential_path) if credential_path else None
                firebase_admin.initialize_app(credential, options or None)
            self._client = firestore.client()
            return self._client
        except Exception as error:  # credentials and connectivity are deployment concerns
            raise MappingStoreUnavailable("Firestore is unavailable; check Firebase configuration") from error

    def _doc(self, model_key: str, ifc_global_id: str):
        return self.client.collection(COLLECTION_NAME).document(mapping_document_id(model_key, ifc_global_id))

    @staticmethod
    def _serialize(snapshot) -> dict[str, Any]:
        if not snapshot.exists:
            raise MappingNotFound()
        data = {key: _as_json_value(value) for key, value in snapshot.to_dict().items()}
        data.pop("document_id", None)
        return data

    @staticmethod
    def _timestamps():
        from firebase_admin import firestore
        return firestore.SERVER_TIMESTAMP

    def create(self, mapping: dict[str, Any]) -> dict[str, Any]:
        ref = self._doc(mapping["model_key"], mapping["ifc_global_id"])
        data = {**mapping, "document_id": ref.id, "created_at": self._timestamps(), "updated_at": self._timestamps()}
        try:
            ref.create(data)
        except Exception as error:
            code = getattr(error, "code", None)
            code_value = code() if callable(code) else code
            if code_value and "ALREADY_EXISTS" in str(code_value).upper():
                raise MappingAlreadyExists() from error
            if "AlreadyExists" in type(error).__name__:
                raise MappingAlreadyExists() from error
            raise MappingStoreUnavailable("Firestore could not create the mapping") from error
        return self.get(mapping["model_key"], mapping["ifc_global_id"])

    def get(self, model_key: str, ifc_global_id: str) -> dict[str, Any]:
        try:
            return self._serialize(self._doc(model_key, ifc_global_id).get())
        except MappingNotFound:
            raise
        except Exception as error:
            raise MappingStoreUnavailable("Firestore could not retrieve the mapping") from error

    def list(self, model_key: str | None = None, itemit_item_id: str | None = None) -> list[dict[str, Any]]:
        try:
            query = self.client.collection(COLLECTION_NAME)
            if model_key:
                query = query.where("model_key", "==", model_key)
            if itemit_item_id:
                query = query.where("itemit_item_id", "==", itemit_item_id)
            rows = [self._serialize(snapshot) for snapshot in query.stream()]
            return sorted(rows, key=lambda row: (row["model_key"], row["ifc_global_id"]))
        except Exception as error:
            raise MappingStoreUnavailable("Firestore could not list mappings") from error

    def update(self, model_key: str, ifc_global_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        ref = self._doc(model_key, ifc_global_id)
        try:
            if not ref.get().exists:
                raise MappingNotFound()
            ref.update({**changes, "updated_at": self._timestamps()})
            return self.get(model_key, ifc_global_id)
        except MappingNotFound:
            raise
        except Exception as error:
            raise MappingStoreUnavailable("Firestore could not update the mapping") from error

    def delete(self, model_key: str, ifc_global_id: str) -> None:
        ref = self._doc(model_key, ifc_global_id)
        try:
            if not ref.get().exists:
                raise MappingNotFound()
            ref.delete()
        except MappingNotFound:
            raise
        except Exception as error:
            raise MappingStoreUnavailable("Firestore could not delete the mapping") from error
