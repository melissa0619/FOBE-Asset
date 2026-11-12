import * as OBC from '@thatopen/components';

export async function createIfcViewer(container) {
  const components = new OBC.Components();
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();
  world.scene = new OBC.SimpleScene(components);
  world.scene.setup();
  world.scene.three.background = null;
  world.renderer = new OBC.SimpleRenderer(components, container);
  world.renderer.showLogo = false;
  world.camera = new OBC.OrthoPerspectiveCamera(components);
  components.init();
  const fragments = components.get(OBC.FragmentsManager);
  fragments.init(`${import.meta.env.BASE_URL}worker.mjs`);
  world.camera.controls.addEventListener('update', () => fragments.core.update());
  fragments.list.onItemSet.add(({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    fragments.core.update(true);
  });
  await world.camera.controls.setLookAt(25, 25, 25, 0, 0, 0);
  return { components, world, fragments };
}
