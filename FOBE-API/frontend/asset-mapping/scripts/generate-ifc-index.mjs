/* Generate trusted, read-only mapping indexes from IFC STEP source files.
 * This deliberately never emits Fragments local IDs and never writes mappings. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const schemaVersion = '1.0';
const outputDirectory = resolve(process.cwd(), 'public', 'ifc-index');
const defaultSource = process.env.IFC_SOURCE_DIR;
const defaultModels = [
  ['building', 'Building Overview', 'building.ifc'], ['foyer', 'Foyer', 'foyer.ifc'],
  ['black', 'Black Room', 'black-room.ifc'], ['white', 'White Room', 'white-room.ifc'],
  ['research', 'Research Room', 'research-room.ifc']
];

function splitArgs(text) {
  const values = []; let start = 0; let depth = 0; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") { if (quoted && text[index + 1] === "'") { index += 1; continue; } quoted = !quoted; }
    else if (!quoted && char === '(') depth += 1;
    else if (!quoted && char === ')') depth -= 1;
    else if (!quoted && depth === 0 && char === ',') { values.push(text.slice(start, index)); start = index + 1; }
  }
  values.push(text.slice(start)); return values;
}
function stepString(value) { const match = /^'([\s\S]*)'$/.exec(String(value ?? '').trim()); return match ? match[1].replace(/''/g, "'") : null; }
function classify(ifcType, name, description, objectType) {
  const source = [name, description, objectType].filter(Boolean).join(' ');
  if (/^IFC(BEAM|BUILDING|BUILDINGSTOREY|COLUMN|COVERING|CURTAINWALL|DOOR|FOOTING|GRID|MEMBER|OPENINGELEMENT|PLATE|RAILING|RAMP|ROOF|SITE|SLAB|STAIR|WALL|WALLSTANDARDCASE|WINDOW)$/i.test(ifcType) || /\b(partition|wall|floor|ceiling|slab|beam|column|curtain\s*wall|room\s*boundary|opening)\b/i.test(source)) return { classification: 'BUILDING_COMPONENT', reason: 'ifc-type-or-name' };
  if (/^IFC(AIRTERMINAL|AUDIOVISUALAPPLIANCE|BOILER|CHILLER|CONTROLLER|DISTRIBUTIONBOARD|ELECTRICAPPLIANCE|ELECTRICMOTOR|FAN|FILTER|FLOWMETER|PUMP|SENSOR|SWITCHINGDEVICE|TRANSFORMER|UNITARYEQUIPMENT|VALVE|LIGHTFIXTURE|FURNISHINGELEMENT)$/i.test(ifcType) || /\b(computer|monitor|table|chair|desk|cabinet|storage|projector|display|screen|printer|scanner|server|switch|router|pump|fan|sensor|controller|boiler|chiller|transformer|valve|panel|equipment|device|appliance|unit)\b/i.test(source)) return { classification: 'LIKELY_ASSET', reason: 'ifc-type-or-name' };
  return { classification: 'NEEDS_REVIEW', reason: 'insufficient-asset-evidence' };
}
function indexIfc(source, modelKey) {
  const elements = []; const expression = /#\d+\s*=\s*(IFC[A-Z0-9_]+)\s*\(([\s\S]*?)\);/g;
  for (const match of source.matchAll(expression)) {
    const ifcType = match[1];
    if (ifcType.startsWith('IFCREL') || ifcType.startsWith('IFCPROPERTY') || /^(IFCMATERIAL|IFCPROFILE|IFCSTYLE|IFCSHAPE|IFCGEOMETRIC|IFCCOLOUR|IFCCARTESIAN|IFCDIRECTION|IFCAXIS|IFCLOCALPLACEMENT|IFCMAPCONVERSION|IFCUNIT|IFCMEASURE|IFCOWNERHISTORY|IFCPERSON|IFCORGANIZATION|IFCAPPLICATION|IFCADDRESS|IFCCOST|IFCSCHEDULE|IFCTIME|IFCWORK|IFCPROJECT|IFCLIBRARY|IFCDOCUMENT|IFCCLASSIFICATION)/.test(ifcType)) continue;
    const args = splitArgs(match[2]); const globalId = stepString(args[0]);
    // IFC GlobalIds are 22 characters; never substitute a STEP/Fragments local ID.
    if (!globalId || globalId.length !== 22) continue;
    const name = stepString(args[2]); const description = stepString(args[3]); const objectType = stepString(args[4]);
    // IFC product tags are conventionally the final scalar attribute. Keep
    // it only when it is an actual STEP string, never a local numeric ID.
    const tag = stepString(args.at(-1));
    elements.push({ identity: { modelKey, globalId, stableKey: `${modelKey}:${globalId}` }, name, ifcType, description, objectType, tag, room: null, roomSource: 'NOT_INDEXED', identifyingProperties: {}, candidate: classify(ifcType, name, description, objectType) });
  }
  const unique = new Map(elements.map(element => [element.identity.globalId, element]));
  return [...unique.values()].sort((left, right) => (left.name || '').localeCompare(right.name || '') || left.identity.globalId.localeCompare(right.identity.globalId));
}
async function main() {
  if (!defaultSource) throw new Error('Set IFC_SOURCE_DIR to the trusted directory containing the five source IFC files. No index was generated.');
  await mkdir(outputDirectory, { recursive: true }); const manifestModels = [];
  for (const [key, name, sourceFile] of defaultModels) {
    const sourcePath = resolve(defaultSource, sourceFile); const source = await readFile(sourcePath, 'utf8'); const elements = indexIfc(source, key);
    if (!elements.length) throw new Error(`${sourcePath} produced no stable IFC GlobalIds; it was not accepted.`);
    const file = `${key}.index.json`; const index = { schemaVersion, generatedAt: new Date().toISOString(), generator: 'fobe-ifc-step-indexer-v1', modelKey: key, sourceFile: basename(sourcePath), sourceSha256: createHash('sha256').update(source).digest('hex'), elementCount: elements.length, stableIdentityCount: elements.length, elements };
    await writeFile(resolve(outputDirectory, file), JSON.stringify(index), 'utf8'); manifestModels.push({ key, name, file, sourceSha256: index.sourceSha256, elementCount: elements.length });
    console.log(`${key}: ${elements.length} stable IFC identities`);
  }
  const manifest = { schemaVersion, generatedAt: new Date().toISOString(), generator: 'fobe-ifc-step-indexer-v1', models: manifestModels };
  await writeFile(resolve(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8'); console.log(`Wrote ${resolve(outputDirectory, 'manifest.json')}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
