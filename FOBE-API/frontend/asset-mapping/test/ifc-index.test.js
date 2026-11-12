import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMappingIdentity } from '../src/ifc-index.js';

const element = (modelKey, globalId) => ({ identity: { modelKey, globalId, stableKey: `${modelKey}:${globalId}` }, name: 'Desk', candidate: { classification: 'LIKELY_ASSET' } });
test('Building Overview resolves only to one room-model GlobalId', () => {
  const overview = element('building', '0abcdefghijklmnopqrstu');
  const foyer = element('foyer', overview.identity.globalId);
  assert.deepEqual(resolveMappingIdentity(overview, new Map([['building', { modelKey: 'building', elements: [overview] }], ['foyer', { modelKey: 'foyer', elements: [foyer] }]])), { ...foyer, overviewSource: overview.identity });
  assert.equal(resolveMappingIdentity(overview, new Map([['foyer', { modelKey: 'foyer', elements: [foyer] }], ['black', { modelKey: 'black', elements: [element('black', overview.identity.globalId)] }]])), null);
});
