export function isConfirmedMapping(mapping) {
  return mapping?.is_mapped === true || mapping?.mapping_status === 'CONFIRMED';
}

export function mappingForIfc(mappings, modelKey, ifcGlobalId) {
  return (mappings || []).find(mapping => (
    isConfirmedMapping(mapping)
    && mapping.model_key === modelKey
    && mapping.ifc_global_id === ifcGlobalId
  )) || null;
}

export function mappedIfcDisplayName(mapping, indexedElement) {
  const ifcName = indexedElement?.name;
  const stored = typeof mapping?.display_name === 'string' ? mapping.display_name : '';
  // Automatic display-name selection compares normalized values. If it selected
  // the IFC source, display the original indexed name without rewriting it.
  if (ifcName && mapping?.display_name_source === 'AUTO' && stored.trim() === ifcName.trim()) return ifcName;
  return stored.trim() ? stored : ifcName || indexedElement?.globalId || mapping?.ifc_global_id || 'Unnamed IFC element';
}
