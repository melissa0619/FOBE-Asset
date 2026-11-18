import test from 'node:test';
import assert from 'node:assert/strict';
import { mappedIfcDisplayName, mappingForIfc } from '../src/mapping-selection.js';

const mapping = (modelKey, ifcGlobalId, itemitItemId, status = 'CONFIRMED') => ({ model_key: modelKey, ifc_global_id: ifcGlobalId, itemit_item_id: itemitItemId, mapping_status: status });

test('finds a confirmed mapping only when both model key and IFC GlobalId match', () => {
  const mappings = [
    mapping('black', 'same-global-id', 'asset-black'),
    mapping('foyer', 'same-global-id', 'asset-foyer'),
  ];
  assert.equal(mappingForIfc(mappings, 'black', 'same-global-id')?.itemit_item_id, 'asset-black');
  assert.equal(mappingForIfc(mappings, 'foyer', 'same-global-id')?.itemit_item_id, 'asset-foyer');
  assert.equal(mappingForIfc(mappings, 'white', 'same-global-id'), null);
});

test('does not treat inactive mappings as a confirmed viewer selection', () => {
  assert.equal(mappingForIfc([mapping('black', 'global-id', 'asset-id', 'UNMAPPED')], 'black', 'global-id'), null);
});

test('uses the Firestore display_name before falling back to the IFC index name', () => {
  const indexedElement = { name: 'Local IFC index name', globalId: 'global-id' };
  assert.equal(mappedIfcDisplayName({ display_name: 'Combined Firebase display name' }, indexedElement), 'Combined Firebase display name');
  assert.equal(mappedIfcDisplayName({ display_name: '   ' }, indexedElement), 'Local IFC index name');
});
