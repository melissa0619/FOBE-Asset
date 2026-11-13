export const INDEX_SCHEMA_VERSION = '1.0';

function validElement(element, modelKey) {
  return element && element.identity?.modelKey === modelKey && typeof element.identity.globalId === 'string' && element.identity.globalId.length > 0;
}

const staticPath = path => `${import.meta.env.BASE_URL}${path}`;

export async function loadIfcIndexes(url = staticPath('ifc-index/manifest.json')) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`IFC index manifest is unavailable (${response.status}). Generate it from trusted IFC source files first.`);
  const manifest = await response.json();
  if (manifest.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(manifest.models)) throw new Error('IFC index manifest has an unsupported schema. Regenerate it with this application.');
  const indexes = await Promise.all(manifest.models.map(async model => {
    const indexResponse = await fetch(staticPath(`ifc-index/${model.file}`));
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
