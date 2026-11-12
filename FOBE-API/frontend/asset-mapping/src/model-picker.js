import * as THREE from 'three';

export function setupModelPicker({ viewer, getActiveModel, onSelected }) {
  const canvas = viewer.world.renderer.three.domElement;
  let selected = null;
  const material = { color: new THREE.Color('#79d7c4'), renderedFaces: 1, opacity: .82, transparent: true };
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
    const box = await model.getMergedBox([localId]);
    if (!box || box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    sphere.radius = Math.min(Math.max(sphere.radius * 1.45, .5), 250);
    await viewer.world.camera.controls.fitToSphere(sphere, true);
    await viewer.fragments.core.update(true);
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
