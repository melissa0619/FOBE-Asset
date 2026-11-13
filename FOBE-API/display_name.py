"""Deterministic presentation names for confirmed IFC-to-itemit mappings."""

FALLBACK_DISPLAY_NAME = "Unnamed mapped asset"


def _trim(value) -> str:
    return str(value or "").strip()


def ifc_comparison_name(value) -> str:
    """Use the human IFC label before Revit-style colon-qualified details."""
    text = _trim(value)
    return text.split(":", 1)[0].strip() or text


def default_display_name(ifc_name, itemit_name) -> str:
    """Choose the shortest trimmed source name; ties intentionally prefer IFC."""
    ifc = ifc_comparison_name(ifc_name)
    itemit = _trim(itemit_name)
    if ifc and itemit:
        return ifc if len(ifc) <= len(itemit) else itemit
    return ifc or itemit or FALLBACK_DISPLAY_NAME


def _previous_default_display_name(ifc_name, itemit_name) -> str:
    """Pre-Phase-2.1 behavior, retained solely to identify legacy AUTO rows."""
    ifc, itemit = _trim(ifc_name), _trim(itemit_name)
    if ifc and itemit:
        return ifc if len(ifc) <= len(itemit) else itemit
    return ifc or itemit or FALLBACK_DISPLAY_NAME


def resolved_display_name(mapping, ifc_name, itemit_name) -> str:
    """Use CUSTOM labels verbatim; safely refresh known automatic defaults."""
    stored = _trim(mapping.get("display_name"))
    source = mapping.get("display_name_source")
    if source == "CUSTOM":
        return stored or default_display_name(ifc_name, itemit_name)
    if source == "AUTO" or not stored:
        return default_display_name(ifc_name, itemit_name)
    # Legacy documents predate provenance. Only recognize a value as automatic
    # when it exactly matches the old algorithm and has never been updated.
    if (stored == _previous_default_display_name(ifc_name, itemit_name)
            and mapping.get("created_at") == mapping.get("updated_at")):
        return default_display_name(ifc_name, itemit_name)
    return stored
