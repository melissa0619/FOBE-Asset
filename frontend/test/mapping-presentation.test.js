import test from 'node:test';
import assert from 'node:assert/strict';
import { fullIfcDisplayName, mappingDisplayName } from '../src/mapping-presentation.js';

test('keeps the full indexed IFC name separate from a short stored mapping label', () => {
  const mapping = { display_name: 'Computer', ifc_name: null };
  const indexedElement = { name: 'Computer:Computer:601234' };
  assert.equal(fullIfcDisplayName(mapping, indexedElement), 'Computer:Computer:601234');
  assert.equal(mappingDisplayName(mapping, { name: 'AMD Ryzen 3900X Processor' }, indexedElement), 'Computer');
});

test('uses a verified asset and IFC pair when a stored display name is missing or repeats the asset', () => {
  const asset = { name: 'AMD Ryzen 3900X Processor' };
  const indexedElement = { name: 'Computer:Computer:601234' };
  assert.equal(mappingDisplayName({}, asset, indexedElement), 'AMD Ryzen 3900X Processor ↔ Computer:Computer:601234');
  assert.equal(mappingDisplayName({ display_name: asset.name }, asset, indexedElement), 'AMD Ryzen 3900X Processor ↔ Computer:Computer:601234');
});
