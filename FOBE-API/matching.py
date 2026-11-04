"""Read-only normalization and candidate-pool helpers for Phase 4A."""

from __future__ import annotations

import re
import unicodedata
from typing import Any


LOCATION_ALIASES = {
    "white-box": ("white box", "whitebox", "d108g"),
    "black-box": ("black box", "blackbox", "d108c"),
    "research-room": ("research room", "research", "d108b"),
    "foyer": ("foyer",),
}
GENERIC_NAME_TOKENS = {"element", "model", "object", "family", "type"}


def normalize_text(value: Any) -> str:
    """Stable comparison text; source values are never changed."""
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"\s+", " ", re.sub(r"[^\w]+", " ", text.casefold())).strip()


def normalize_asset_name(value: Any) -> str:
    return normalize_text(value)


def normalize_ifc_type(value: Any) -> str:
    text = normalize_text(value).replace(" ", "")
    return text[3:] if text.startswith("ifc") else text


def normalize_category(value: Any) -> str | None:
    text = normalize_text(value)
    if not text:
        return None
    if any(token in text for token in ("chair", "seating", "stool", "sofa")):
        return "seating"
    if any(token in text for token in ("table", "desk", "worktop")):
        return "table"
    if any(token in text for token in ("screen", "display", "projector", "audio visual")):
        return "audiovisual"
    if any(token in text for token in ("light", "luminaire", "lamp")):
        return "lighting"
    return None


def normalize_location(value: Any) -> str | None:
    text = normalize_text(value)
    if not text:
        return None
    for canonical, aliases in LOCATION_ALIASES.items():
        if any(normalize_text(alias) in text for alias in aliases):
            return canonical
    return text


def comparison_tokens(value: Any) -> list[str]:
    """Keep only meaningful export-name tokens for comparison, not identity."""
    return [token for token in normalize_text(value).split()
            if token not in GENERIC_NAME_TOKENS and not token.isdigit()]


def normalize_ifc_element(element: dict[str, Any]) -> dict[str, Any]:
    room = element.get("room") or {}
    name = element.get("name")
    ifc_type = element.get("ifc_type") or element.get("ifcType")
    explicit_room = normalize_location(room.get("name") if isinstance(room, dict) else room)
    name_room = normalize_location(name)
    return {
        "model_key": element.get("model_key") or element.get("modelKey"),
        "global_id": element.get("global_id") or element.get("globalId") or (element.get("identity") or {}).get("globalId"),
        "name": normalize_asset_name(name), "name_tokens": comparison_tokens(name),
        "ifc_type": normalize_ifc_type(ifc_type),
        "category": normalize_category(name) or normalize_category(ifc_type),
        "room": explicit_room or name_room,
        "room_source": "IFC_SPACE" if explicit_room else "NAME_INFERENCE" if name_room else "UNKNOWN",
    }


def normalize_asset(asset: dict[str, Any]) -> dict[str, Any]:
    memberships = asset.get("collection_memberships") or []
    return {
        "name": normalize_asset_name(asset.get("name")),
        "name_tokens": comparison_tokens(asset.get("name")),
        "serial": normalize_text(asset.get("serial")),
        "location": normalize_location(asset.get("current_location")),
        "categories": sorted({category for value in [asset.get("name"), *(m.get("name") for m in memberships)] if (category := normalize_category(value))}),
        "collections": [normalize_text(m.get("name")) for m in memberships if m.get("name")],
    }


def filter_candidates(assets: list[dict[str, Any]], filters: dict[str, Any]) -> list[dict[str, Any]]:
    """Apply only explicit admin filters; this deliberately does not score or map."""
    name = normalize_asset_name(filters.get("name"))
    serial = normalize_text(filters.get("serial"))
    location = normalize_location(filters.get("location"))
    collection = normalize_text(filters.get("collection"))
    result = []
    for asset in assets:
        normalized = asset["normalized"]
        if name and name not in normalized["name"]:
            continue
        if serial and serial not in normalized["serial"]:
            continue
        if location and normalized["location"] != location:
            continue
        if collection and collection not in normalized["collections"]:
            continue
        result.append(asset)
    return result
