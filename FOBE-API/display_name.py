"""Deterministic presentation names for confirmed IFC-to-itemit mappings."""

FALLBACK_DISPLAY_NAME = "Unnamed mapped asset"


def _trim(value) -> str:
    return str(value or "").strip()


def _source_name(value) -> str:
    """Return a source label without altering its contents."""
    return value if isinstance(value, str) else str(value or "")


def default_display_name(ifc_name, itemit_name) -> str:
    """Choose the shortest original source name; ties prefer IFC."""
    # Source labels are persisted as supplied. We only inspect whitespace to
    # reject blank values; no trimming or colon-based filtering is applied.
    ifc = _source_name(ifc_name)
    itemit = _source_name(itemit_name)
    if ifc.strip() and itemit.strip():
        return ifc if len(ifc) <= len(itemit) else itemit
    return ifc if ifc.strip() else itemit if itemit.strip() else FALLBACK_DISPLAY_NAME


def _previous_default_display_name(ifc_name, itemit_name) -> str:
    """Pre-Phase-2.1 behavior, retained solely to identify legacy AUTO rows."""
    ifc, itemit = _trim(ifc_name), _trim(itemit_name)
    if ifc and itemit:
        return ifc if len(ifc) <= len(itemit) else itemit
    return ifc or itemit or FALLBACK_DISPLAY_NAME


def resolved_display_name(mapping, ifc_name, itemit_name) -> str:
    """Use CUSTOM labels verbatim; safely refresh known automatic defaults."""
    stored = _source_name(mapping.get("display_name"))
    source = mapping.get("display_name_source")
    if source == "CUSTOM":
        return stored if stored.strip() else default_display_name(ifc_name, itemit_name)
    if source == "AUTO" or not stored.strip():
        return default_display_name(ifc_name, itemit_name)
    # Legacy documents predate provenance. Only recognize a value as automatic
    # when it exactly matches the old algorithm and has never been updated.
    if (stored == _previous_default_display_name(ifc_name, itemit_name)
            and mapping.get("created_at") == mapping.get("updated_at")):
        return default_display_name(ifc_name, itemit_name)
    return stored
