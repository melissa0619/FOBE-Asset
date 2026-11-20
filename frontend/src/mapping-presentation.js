function present(value) { return typeof value === 'string' && value.trim() ? value : ''; }

export function fullIfcDisplayName(mapping, indexedElement) {
  return present(mapping?.ifc_name) || present(indexedElement?.name) || '';
}

export function mappingDisplayName(mapping, asset, indexedElement) {
  const stored = present(mapping?.display_name);
  const assetName = present(asset?.name);
  // A stored label that merely repeats the asset adds no mapping context.
  if (stored && stored !== assetName) return stored;
  const ifcName = fullIfcDisplayName(mapping, indexedElement);
  const parts = [assetName, ifcName].filter(Boolean);
  return parts.length ? parts.join(' ↔ ') : 'Mapping display name unavailable';
}
