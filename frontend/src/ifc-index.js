export const INDEX_SCHEMA_VERSION = '1.0';

// These IFC entities describe definitions, model hierarchy, or reference data.
// They are kept in the index for inspection and legacy mappings, but cannot be
// selected as new itemit mapping targets.
const EXCLUDED_IFC_ENTITY_TYPES = new Set([
  'IFCPROJECT',
  'IFCSITE',
  'IFCBUILDING',
  'IFCBUILDINGSTOREY',
  'IFCSPACE',
  'IFCGROUP',
  'IFCGRID',
  'IFCMATERIAL',
  'IFCSURFACESTYLE',
  'IFCOPENINGELEMENT',
  'IFCDISTRIBUTIONPORT',
]);

export function normaliseIfcType(ifcType) {
  return String(ifcType || '').trim().toUpperCase();
}

export function isExcludedIfcEntity(ifcType) {
  const type = normaliseIfcType(ifcType);
  return Boolean(type) && (type.endsWith('TYPE') || EXCLUDED_IFC_ENTITY_TYPES.has(type));
}

// Legacy confirmed mappings remain visible for inspection and unmapping, even
// when the IFC entity is no longer allowed as a new mapping target.
export function shouldDisplayIfcInMappingList(element, { hasConfirmedMapping = false } = {}) {
  return hasConfirmedMapping || !isExcludedIfcEntity(element?.ifcType);
}

// IFC type definitions (for example IFCFURNITURETYPE) describe a family, not
// a placed instance. They do not have element geometry to select or focus.
export function isNonGeometricIfcDefinition(element) {
  return normaliseIfcType(element?.ifcType).endsWith('TYPE');
}

function validElement(element, modelKey) {
  return element && element.identity?.modelKey === modelKey && typeof element.identity.globalId === 'string' && element.identity.globalId.length > 0;
}

const staticPath = path => `${import.meta.env.BASE_URL}${path}`;

export async function loadIfcIndexes(url = staticPath('ifc-index/manifest.json'), { forceRefresh = false } = {}) {
  const requestOptions = forceRefresh ? { cache: 'no-store' } : undefined;
  const response = await fetch(url, requestOptions);
  if (!response.ok) throw new Error(`IFC index manifest is unavailable (${response.status}). Generate it from trusted IFC source files first.`);
  const manifest = await response.json();
  if (manifest.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(manifest.models)) throw new Error('IFC index manifest has an unsupported schema. Regenerate it with this application.');
  const indexes = await Promise.all(manifest.models.map(async model => {
    const indexResponse = await fetch(staticPath(`ifc-index/${model.file}`), requestOptions);
    if (!indexResponse.ok) throw new Error(`IFC index for ${model.key} is unavailable.`);
    const index = await indexResponse.json();
    if (index.schemaVersion !== INDEX_SCHEMA_VERSION || index.modelKey !== model.key || !Array.isArray(index.elements) || !index.elements.every(element => validElement(element, model.key))) throw new Error(`IFC index for ${model.key} is invalid or contains non-stable identities.`);
    return index;
  }));
  return { manifest, indexes: new Map(indexes.map(index => [index.modelKey, index])) };
}

export function resolveMappingIdentity(element, indexes) {
  if (element.identity.modelKey !== 'building') return element;
  const matches = [...indexes.values()]
    .filter(index => index.modelKey !== 'building')
    .flatMap(index => index.elements.filter(candidate => candidate.identity.globalId === element.identity.globalId));
  return matches.length === 1 ? { ...matches[0], overviewSource: element.identity } : null;
}
