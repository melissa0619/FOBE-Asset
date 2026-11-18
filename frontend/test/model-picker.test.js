import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { geometryBoundingBox, selectedElementBox, setupModelPicker } from '../src/model-picker.js';

test('geometryBoundingBox calculates an element-only box from Fragments geometry', () => {
  const box = geometryBoundingBox([[{
    positions: new Float32Array([0, 0, 0, 2, 3, 4]),
    transform: { elements: [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      10, 20, 30, 1
    ] }
  }]]);
  assert.deepEqual(box.min.toArray(), [10, 20, 30]);
  assert.deepEqual(box.max.toArray(), [12, 23, 34]);
});

test('geometryBoundingBox rejects elements without renderable geometry', () => {
  assert.equal(geometryBoundingBox([[]]), null);
  assert.equal(geometryBoundingBox([[{ positions: new Float32Array(), transform: { elements: [] } }]]), null);
});

test('selectedElementBox uses the Fragments item box in world coordinates', async () => {
  const expected = new THREE.Box3(new THREE.Vector3(10, 20, 30), new THREE.Vector3(12, 23, 34));
  const result = await selectedElementBox({ getBoxes: async ids => { assert.deepEqual(ids, [42]); return [expected]; } }, 42);
  assert.equal(result.box, expected);
  assert.equal(result.boxSource, 'fragments-item-box');
});

test('selectedElementBox applies the model world transform only for geometry fallback', async () => {
  const result = await selectedElementBox({
    getBoxes: async () => [],
    getItemsGeometry: async () => [[{ positions: new Float32Array([0, 0, 0, 1, 1, 1]), transform: new THREE.Matrix4() }]],
    object: { matrixWorld: new THREE.Matrix4().makeTranslation(10, 20, 30) }
  }, 7);
  assert.equal(result.boxSource, 'geometry-fallback');
  assert.deepEqual(result.box.min.toArray(), [10, 20, 30]);
  assert.deepEqual(result.box.max.toArray(), [11, 21, 31]);
});

test('shared locate highlights and then frames the same local ID', async () => {
  const calls = [];
  const canvas = { addEventListener: () => {} };
  const model = {
    highlight: async ids => calls.push(['highlight', ids]),
    getBoxes: async ids => {
      calls.push(['getBoxes', ids]);
      return [new THREE.Box3(new THREE.Vector3(1, 2, 3), new THREE.Vector3(3, 5, 7))];
    }
  };
  const viewer = {
    world: { renderer: { three: { domElement: canvas } }, camera: { controls: {
      setLookAt: async (...values) => calls.push(['setLookAt', values]),
      fitToSphere: async sphere => calls.push(['fitToSphere', sphere.center.toArray(), sphere.radius])
    } } },
    fragments: { core: { update: async () => calls.push(['update']) } }
  };
  const picker = setupModelPicker({ viewer, getActiveModel: () => model });
  const result = await picker.locate(model, 42);
  assert.equal(result.localId, 42);
  assert.deepEqual(calls.find(([name]) => name === 'highlight'), ['highlight', [42]]);
  assert.deepEqual(calls.find(([name]) => name === 'getBoxes'), ['getBoxes', [42]]);
  assert.ok(calls.find(([name]) => name === 'fitToSphere'));
  assert.deepEqual(calls.find(([name]) => name === 'setLookAt')[1].slice(3, 6), [2, 3.5, 5]);
  assert.ok(calls.findIndex(([name]) => name === 'highlight') < calls.findIndex(([name]) => name === 'fitToSphere'));
});
