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
  const stored = typeof mapping?.display_name === 'string' ? mapping.display_name.trim() : '';
  return stored || indexedElement?.name || indexedElement?.globalId || mapping?.ifc_global_id || 'Unnamed IFC element';
}
