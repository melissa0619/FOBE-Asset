import test from 'node:test';
import assert from 'node:assert/strict';
import { geometryBoundingBox } from '../src/model-picker.js';

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
