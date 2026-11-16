import * as THREE from 'three';

function focusError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function matrixFromGeometry(transform) {
  if (transform?.isMatrix4) return transform;
  const elements = transform?.elements ?? transform;
  if (!elements || typeof elements.length !== 'number' || elements.length !== 16) return null;
  return new THREE.Matrix4().fromArray(elements);
}

// The checked-in Fragments worker does not expose getMergedBox().  Reading
// geometry here remains accurate even when the element's render tile has not
// been instantiated yet (the condition that makes getPositions() return []).
export function geometryBoundingBox(groups) {
  const box = new THREE.Box3();
  let hasVertex = false;
  for (const group of groups || []) {
    for (const geometry of group || []) {
      const transform = matrixFromGeometry(geometry?.transform);
      const positions = geometry?.positions;
      if (!transform || !positions || positions.length < 3) continue;
      for (let index = 0; index + 2 < positions.length; index += 3) {
        const x = positions[index]; const y = positions[index + 1]; const z = positions[index + 2];
        if (![x, y, z].every(Number.isFinite)) continue;
        box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(transform));
        hasVertex = true;
      }
    }
  }
  return hasVertex && !box.isEmpty() ? box : null;
}

export function setupModelPicker({ viewer, getActiveModel, onSelected }) {
  const canvas = viewer.world.renderer.three.domElement;
  let selected = null;
  // This object is sent to the Fragments worker, so keep its colour
  // serializable instead of passing a THREE.Color instance across the worker
  // boundary.  preserveOriginalMaterial lets resetHighlight restore the IFC
  // element's normal material when another element is selected.
  const material = {
    color: { r: 0.475, g: 0.843, b: 0.769 },
    renderedFaces: 1,
    opacity: .82,
    transparent: true,
    preserveOriginalMaterial: true,
    _explicitProps: ['color', 'renderedFaces', 'opacity', 'transparent']
  };
  async function select(model, localId) {
    if (!model || localId == null) return;
    if (selected) await selected.model.resetHighlight([selected.localId]);
    selected = { model, localId };
    await model.highlight([localId], material);
    await viewer.fragments.core.update(true);
    onSelected?.(model, localId);
  }
  async function focus(model, localId) {
    if (!model || localId == null) return;
    let box;
    try {
      // Ensure the loaded model has completed its current Fragments update
      // before asking the worker for this element's geometry.
      await viewer.fragments.core.update(true);
      box = geometryBoundingBox(await model.getItemsGeometry([localId]));
    } catch (error) {
      throw focusError('GEOMETRY_UNAVAILABLE', 'The IFC element geometry could not be read.', error);
    }
    if (!box) throw focusError('GEOMETRY_UNAVAILABLE', 'The IFC element has no renderable geometry.');
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    sphere.radius = Math.max(sphere.radius * 1.45, 0.5);
    try {
      await viewer.world.camera.controls.fitToSphere(sphere, true);
      await viewer.fragments.core.update(true);
    } catch (error) {
      throw focusError('CAMERA_FAILURE', 'The camera controls could not focus the IFC element.', error);
    }
  }
  async function pick(event) {
    const model = getActiveModel();
    if (!model) return;
    const hit = await model.raycast({ camera: viewer.world.camera.three, mouse: new THREE.Vector2(event.clientX, event.clientY), dom: canvas });
    if (hit) await select(model, hit.localId);
  }
  canvas.addEventListener('click', event => void pick(event));
  return { select, focus };
}
