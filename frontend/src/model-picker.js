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

export async function selectedElementBox(model, localId) {
  let box = null;
  try {
    box = (await model.getBoxes([localId])).find(candidate => candidate && !candidate.isEmpty()) || null;
    if (box) return { box, boxSource: 'fragments-item-box' };
  } catch {
    // Use geometry only when the supported item-box query is unavailable.
  }
  box = geometryBoundingBox(await model.getItemsGeometry([localId]));
  if (box) box.applyMatrix4(model.object.matrixWorld);
  return { box, boxSource: box ? 'geometry-fallback' : null };
}

export function setupModelPicker({ viewer, getActiveModel, onSelected }) {
  const canvas = viewer.world.renderer.three.domElement;
  let selected = null;
  // Keep click-pipeline diagnostics available in the local Vite viewer without
  // adding routine pointer logging to deployed builds.
  const debug = typeof import.meta.env === 'object' && import.meta.env?.DEV;
  const trace = (event, detail = {}) => { if (debug) console.info('[FOBE picker]', { event, ...detail }); };
  trace('listener-registered', {
    canvasConnected: canvas.isConnected,
    canvasSize: { width: canvas.clientWidth, height: canvas.clientHeight }
  });
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
    return { localId };
  }
  async function focus(model, localId) {
    if (!model || localId == null) return;
    let box, boxSource;
    try {
      // Fragments' supported box API returns the box for this local ID in
      // world coordinates, including model.object.matrixWorld. That is the
      // same coordinate space used by the active camera controls.
      await viewer.fragments.core.update(true);
      ({ box, boxSource } = await selectedElementBox(model, localId));
    } catch (error) {
      throw focusError('GEOMETRY_UNAVAILABLE', 'The IFC element geometry could not be read.', error);
    }
    if (!box) throw focusError('GEOMETRY_UNAVAILABLE', 'The IFC element has no renderable geometry.');
    const size = box.getSize(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    sphere.radius = Math.max(sphere.radius * 1.35, 0.12);
    try {
      // Use the same Y-up convention as the viewer's Top button before
      // fitting. fitToSphere adjusts only the framing distance, preserving
      // this predictable top-down orientation for every located element.
      const topDistance = Math.max(sphere.radius * 3, 1);
      await viewer.world.camera.controls.setLookAt(
        sphere.center.x, sphere.center.y + topDistance, sphere.center.z,
        sphere.center.x, sphere.center.y, sphere.center.z,
        true
      );
      await viewer.world.camera.controls.fitToSphere(sphere, true);
      await viewer.fragments.core.update(true);
      return { localId, boxSource, box, dimensions: { x: size.x, y: size.y, z: size.z }, radius: sphere.radius, view: 'top' };
    } catch (error) {
      throw focusError('CAMERA_FAILURE', 'The camera controls could not focus the IFC element.', error);
    }
  }
  // Keep interactive picks and programmatic Mapping Results location on the
  // exact same selection path: apply the element material, flush Fragments,
  // then frame that element's world-space box.
  async function locate(model, localId) {
    const selection = await select(model, localId);
    const focusResult = await focus(model, localId);
    return { ...focusResult, selection };
  }
  async function pick(event) {
    const model = getActiveModel();
    trace('click-received', {
      pointer: { x: event.clientX, y: event.clientY },
      activeModelId: model?.modelId ?? null,
      canvasTarget: event.target === canvas
    });
    if (!model) return trace('raycast-skipped', { reason: 'no-active-model' });
    try {
      const hit = await model.raycast({ camera: viewer.world.camera.three, mouse: new THREE.Vector2(event.clientX, event.clientY), dom: canvas });
      trace('raycast-result', { activeModelId: model.modelId, hit: Boolean(hit), localId: hit?.localId ?? null });
      if (!hit || hit.localId == null) return;
      const result = await locate(model, hit.localId);
      trace('locate-success', { activeModelId: model.modelId, localId: hit.localId, boxSource: result.boxSource, dimensions: result.dimensions });
    } catch (error) {
      console.error('[FOBE picker]', {
        event: 'manual-selection-failed',
        activeModelId: model.modelId,
        error: error?.message || String(error)
      });
    }
  }
  canvas.addEventListener('pointerdown', event => trace('pointerdown-received', {
    pointer: { x: event.clientX, y: event.clientY },
    canvasTarget: event.target === canvas
  }));
  canvas.addEventListener('click', event => void pick(event));
  return { select, focus, locate };
}
