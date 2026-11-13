"""Firestore-backed authoritative storage for IFC-to-itemit mappings."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any


COLLECTION_NAME = "ifc_item_mappings"
LOGGER = logging.getLogger(__name__)


class MappingStoreUnavailable(RuntimeError):
    """Raised when Firebase credentials or Firestore are unavailable."""


class MappingAlreadyExists(RuntimeError):
    """Raised when a mapping already exists for a stable IFC identity."""


class MappingConfirmed(RuntimeError):
    """Raised when an immutable confirmed mapping is targeted for a write."""


class MappingNotFound(RuntimeError):
    """Raised when no mapping exists for a stable IFC identity."""


class MappingAssetAssigned(RuntimeError):
    """Raised when an itemit asset is already actively mapped in a model."""


def mapping_document_id(model_key: str, ifc_global_id: str) -> str:
    """Return a deterministic Firestore-safe ID for the complete identity pair."""
    encoded = json.dumps([model_key, ifc_global_id], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return f"v1_{hashlib.sha256(encoded).hexdigest()}"


def _as_json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return value


def is_active_mapping(mapping: dict[str, Any]) -> bool:
    """Use is_mapped as the authority, with safe support for legacy rows."""
    if "is_mapped" in mapping:
        return mapping["is_mapped"] is True
    return mapping.get("mapping_status") == "CONFIRMED"


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
            LOGGER.exception("Firestore client initialization failed: %s: %s", type(error).__name__, error)
            raise MappingStoreUnavailable("Firestore is unavailable; check Firebase configuration") from error

    def _doc(self, model_key: str, ifc_global_id: str):
        return self.client.collection(COLLECTION_NAME).document(mapping_document_id(model_key, ifc_global_id))

    def _asset_mappings(self, model_key: str, itemit_item_id: str):
        return (self.client.collection(COLLECTION_NAME)
                .where("model_key", "==", model_key)
                .where("itemit_item_id", "==", itemit_item_id))

    @staticmethod
    def _transaction_snapshot(transaction, ref):
        """Return one document snapshot across supported Firestore SDK versions.

        google-cloud-firestore currently returns a generator from
        ``Transaction.get(DocumentReference)``; older test doubles returned a
        snapshot directly.
        """
        result = transaction.get(ref)
        return result if hasattr(result, "exists") else next(result, None)

    @staticmethod
    def _transaction_snapshots(transaction, query):
        """Return query snapshots across supported Firestore SDK versions."""
        result = transaction.get(query)
        return list(result) if not isinstance(result, list) else result

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
        """Create the sole confirmed mapping for an IFC identity atomically."""
        from firebase_admin import firestore

        ref = self._doc(mapping["model_key"], mapping["ifc_global_id"])
        data = {
            **mapping,
            "mapping_id": ref.id,
            # Retained for existing API consumers while mapping_id is the
            # canonical schema field.
            "document_id": ref.id,
            "is_mapped": True,
            "mapping_status": "CONFIRMED",
            "created_at": self._timestamps(),
            "updated_at": self._timestamps(),
        }

        @firestore.transactional
        def create_if_absent(transaction):
            snapshot = self._transaction_snapshot(transaction, ref)
            if snapshot and snapshot.exists:
                existing = snapshot.to_dict() or {}
                if is_active_mapping(existing):
                    raise MappingConfirmed()
                raise MappingAlreadyExists()
            for assigned in self._transaction_snapshots(
                transaction, self._asset_mappings(mapping["model_key"], mapping["itemit_item_id"])
            ):
                assigned_data = assigned.to_dict() or {}
                if is_active_mapping(assigned_data):
                    raise MappingAssetAssigned()
            transaction.create(ref, data)

        try:
            create_if_absent(self.client.transaction())
        except (MappingAlreadyExists, MappingConfirmed, MappingAssetAssigned):
            raise
        except Exception as error:
            code = getattr(error, "code", None)
            code_value = code() if callable(code) else code
            if code_value and "ALREADY_EXISTS" in str(code_value).upper():
                raise MappingAlreadyExists() from error
            if "AlreadyExists" in type(error).__name__:
                raise MappingAlreadyExists() from error
            LOGGER.exception(
                "Firestore mapping create failed: type=%s code=%s message=%s",
                type(error).__name__, code_value, error,
            )
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
            rows = [row for row in rows if is_active_mapping(row)]
            return sorted(rows, key=lambda row: (row["model_key"], row["ifc_global_id"]))
        except Exception as error:
            raise MappingStoreUnavailable("Firestore could not list mappings") from error

    def update(self, model_key: str, ifc_global_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        """Update legacy inactive records without racing a confirmation."""
        from firebase_admin import firestore

        ref = self._doc(model_key, ifc_global_id)

        @firestore.transactional
        def update_if_mutable(transaction):
            snapshot = self._transaction_snapshot(transaction, ref)
            if not snapshot or not snapshot.exists:
                raise MappingNotFound()
            if is_active_mapping(snapshot.to_dict() or {}):
                raise MappingConfirmed()
            transaction.update(ref, {**changes, "updated_at": self._timestamps()})

        try:
            update_if_mutable(self.client.transaction())
            return self.get(model_key, ifc_global_id)
        except (MappingNotFound, MappingConfirmed):
            raise
        except Exception as error:
            raise MappingStoreUnavailable("Firestore could not update the mapping") from error

    def update_display_name(self, model_key: str, ifc_global_id: str, display_name: str) -> dict[str, Any]:
        """Update presentation metadata only; confirmed identities remain immutable."""
        from firebase_admin import firestore
        ref = self._doc(model_key, ifc_global_id)

        @firestore.transactional
        def update_name(transaction):
            snapshot = self._transaction_snapshot(transaction, ref)
            if not snapshot or not snapshot.exists:
                raise MappingNotFound()
            if not is_active_mapping(snapshot.to_dict() or {}):
                raise MappingAlreadyExists("Only confirmed mappings support display names")
            transaction.update(ref, {"display_name": display_name, "display_name_source": "CUSTOM", "updated_at": self._timestamps()})

        try:
            update_name(self.client.transaction())
            return self.get(model_key, ifc_global_id)
        except (MappingNotFound, MappingAlreadyExists):
            raise
        except Exception as error:
            raise MappingStoreUnavailable("Firestore could not update the display name") from error

    def delete(self, model_key: str, ifc_global_id: str) -> None:
        """Hard-delete an active mapping so its IFC element can be remapped."""
        from firebase_admin import firestore

        ref = self._doc(model_key, ifc_global_id)

        @firestore.transactional
        def delete_if_mutable(transaction):
            snapshot = self._transaction_snapshot(transaction, ref)
            if not snapshot or not snapshot.exists:
                raise MappingNotFound()
            transaction.delete(ref)

        try:
            delete_if_mutable(self.client.transaction())
        except MappingNotFound:
            raise
        except Exception as error:
            raise MappingStoreUnavailable("Firestore could not delete the mapping") from error
