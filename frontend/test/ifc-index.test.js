import test from 'node:test';
import assert from 'node:assert/strict';
import { isExcludedIfcEntity, isNonGeometricIfcDefinition, resolveMappingIdentity, shouldDisplayIfcInMappingList } from '../src/ifc-index.js';

const element = (modelKey, globalId) => ({ identity: { modelKey, globalId, stableKey: `${modelKey}:${globalId}` }, name: 'Desk', candidate: { classification: 'LIKELY_ASSET' } });
test('Building Overview resolves only to one room-model GlobalId', () => {
  const overview = element('building', '0abcdefghijklmnopqrstu');
  const foyer = element('foyer', overview.identity.globalId);
  assert.deepEqual(resolveMappingIdentity(overview, new Map([['building', { modelKey: 'building', elements: [overview] }], ['foyer', { modelKey: 'foyer', elements: [foyer] }]])), { ...foyer, overviewSource: overview.identity });
  assert.equal(resolveMappingIdentity(overview, new Map([['foyer', { modelKey: 'foyer', elements: [foyer] }], ['black', { modelKey: 'black', elements: [element('black', overview.identity.globalId)] }]])), null);
});

test('IFC type definitions are not treated as renderable mapping targets', () => {
  assert.equal(isNonGeometricIfcDefinition({ ifcType: 'IFCFURNITURETYPE' }), true);
  assert.equal(isNonGeometricIfcDefinition({ ifcType: 'IFCFURNISHINGELEMENT' }), false);
});

test('excludes IFC definitions, spatial hierarchy, and reference entities case-insensitively', () => {
  for (const type of ['IFCFURNITURETYPE', 'ifcBuildingElementProxyType', 'IFCSPACE', 'IFCBUILDINGSTOREY', 'IFCPROJECT', 'IFCGRID', 'IFCMATERIAL', 'IFCSURFACESTYLE', 'IFCOPENINGELEMENT', 'IFCDISTRIBUTIONPORT']) {
    assert.equal(isExcludedIfcEntity(type), true, `${type} should be excluded`);
  }
});

test('keeps physical IFC instances selectable regardless of similarly named definitions', () => {
  for (const type of ['IFCBUILDINGELEMENTPROXY', 'IFCFURNISHINGELEMENT', 'IFCWALLSTANDARDCASE', 'IFCDOOR', 'IFCWINDOW', 'IFCCOLUMN', 'IFCMEMBER', 'IFCPLATE', 'IFCSLAB', 'IFCCURTAINWALL', 'IFCFLOWTERMINAL']) {
    assert.equal(isExcludedIfcEntity(type), false, `${type} should remain selectable`);
  }
});

test('identically named physical instances retain separate GlobalIds', () => {
  const instances = [
    { ...element('black', '0abcdefghijklmnopqrstu'), ifcType: 'IFCFURNISHINGELEMENT' },
    { ...element('black', '1abcdefghijklmnopqrstu'), ifcType: 'IFCFURNISHINGELEMENT' },
  ];
  const selectable = instances.filter(instance => !isExcludedIfcEntity(instance.ifcType));
  assert.equal(selectable.length, 2);
  assert.notEqual(selectable[0].identity.globalId, selectable[1].identity.globalId);
});

test('keeps existing confirmed mappings visible without making excluded entities new targets', () => {
  const legacyType = { ...element('black', '2abcdefghijklmnopqrstu'), ifcType: 'IFCFURNITURETYPE' };
  assert.equal(shouldDisplayIfcInMappingList(legacyType), false);
  assert.equal(shouldDisplayIfcInMappingList(legacyType, { hasConfirmedMapping: true }), true);
});
