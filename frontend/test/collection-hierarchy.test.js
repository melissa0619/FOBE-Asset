import test from 'node:test';
import assert from 'node:assert/strict';
import { assetHasKnownCollection, assetMatchesCollectionNode, createCollectionHierarchy } from '../src/collection-hierarchy.js';

const hierarchy = createCollectionHierarchy([
  { id: 'electrical', name: 'Electrical', parent_id: null },
  { id: 'system', name: 'Electrical System', parent_id: 'electrical' },
  { id: 'light', name: 'Light', parent_id: 'system' },
  { id: 'security', name: 'Security', parent_id: null },
  { id: 'camera', name: 'Camera', parent_id: 'security' },
  { id: 'black-room', name: 'Black Room', parent_id: 'camera' },
  { id: 'front-camera', name: 'Front Camera', parent_id: 'black-room' },
  { id: 'environmental', name: 'Environmental', parent_id: null },
  { id: 'temperature', name: 'Temperature', parent_id: 'environmental' },
  { id: 'electronic', name: 'Electronic', parent_id: null },
  { id: 'desktop', name: 'Desktop Computer', parent_id: 'electronic' },
  { id: 'processor', name: 'AMD Ryzen 3900X Processor', parent_id: 'desktop' },
  { id: 'furniture', name: 'Furniture', parent_id: null },
  { id: 'chair', name: 'Chair', parent_id: 'furniture' },
  { id: 'meeting-chair', name: 'Meeting Chair', parent_id: 'chair' },
]);

test('matches a category and any irregular-depth descendant from collection membership IDs', () => {
  const camera = { collection_memberships: [{ id: 'front-camera', name: 'Front Camera' }] };
  assert.equal(assetMatchesCollectionNode(camera, hierarchy, 'security'), true);
  assert.equal(assetMatchesCollectionNode(camera, hierarchy, 'camera'), true);
  assert.equal(assetMatchesCollectionNode(camera, hierarchy, 'black-room'), true);
  assert.equal(assetMatchesCollectionNode(camera, hierarchy, 'front-camera'), true);
  assert.equal(assetMatchesCollectionNode(camera, hierarchy, 'electrical'), false);
});

test('supports Electrical, Electronic, Environmental, and Furniture category membership without name matching', () => {
  assert.equal(assetMatchesCollectionNode({ collection_memberships: [{ id: 'light' }] }, hierarchy, 'electrical'), true);
  assert.equal(assetMatchesCollectionNode({ collection_memberships: [{ id: 'processor' }] }, hierarchy, 'electronic'), true);
  assert.equal(assetMatchesCollectionNode({ collection_memberships: [{ id: 'temperature' }] }, hierarchy, 'environmental'), true);
  assert.equal(assetMatchesCollectionNode({ collection_memberships: [{ id: 'meeting-chair' }] }, hierarchy, 'furniture'), true);
  assert.equal(assetHasKnownCollection({ collection_memberships: [{ id: 'missing' }] }, hierarchy), false);
});

test('retains orphaned and cyclic collection records without looping while calculating descendants', () => {
  const malformed = createCollectionHierarchy([
    { id: 'orphan', name: 'Orphaned Value', parent_id: 'missing-parent' },
    { id: 'cycle-a', name: 'Cycle A', parent_id: 'cycle-b' },
    { id: 'cycle-b', name: 'Cycle B', parent_id: 'cycle-a' },
  ]);
  assert.equal(malformed.roots.includes('orphan'), true);
  assert.equal(malformed.roots.includes('cycle-a') || malformed.roots.includes('cycle-b'), true);
  assert.equal(assetMatchesCollectionNode({ collection_memberships: [{ id: 'cycle-b' }] }, malformed, 'cycle-a'), true);
});
