import {getViewedPortalLinks} from "./geometry.mjs";
import {getEyes} from "./eyes.mjs";

/**
 * Portal windows: a live picture of the far side of each portal, drawn over the space beyond it.
 *
 * Each frame, for each visible portal, the whole canvas is rendered a second time with the camera
 * moved through the portal (pivot, zoom, and rotation mapped by the link) into a screen-sized
 * texture. That texture is then shown in screen space, masked to the wedge the viewer sees through
 * the portal. Rendering the full pipeline with the moved camera keeps Foundry's screen-space
 * lighting, vision, and fog buffers consistent with what is drawn.
 *
 * Windows sit above the scene and its fog but below the interface (borders, rulers, HUD).
 */
export default class PortalWindows {

  /** @type {PIXI.Container} */
  container;

  /** @type {Map<string, {sprite: PIXI.Sprite, mask: PIXI.Graphics, texture: PIXI.RenderTexture}>} */
  windows = new Map();

  /* ---------------------------------------- */

  /** Add the window layer to the canvas. */
  draw() {
    this.container = new PIXI.Container();
    this.container.eventMode = "none";
    canvas.rendered.addChildAt(this.container, canvas.rendered.getChildIndex(canvas.interface));
  }

  /* ---------------------------------------- */

  /** Remove the window layer and free its textures. */
  tearDown() {
    for ( const w of this.windows.values() ) w.texture.destroy(true);
    this.windows.clear();
    this.container?.destroy({children: true});
    this.container = null;
  }

  /* ---------------------------------------- */

  /**
   * Update and capture every window. Called once per frame, after animations and before rendering.
   */
  render() {
    if ( !this.container ) return;
    const links = getViewedPortalLinks();
    const eyes = getEyes();
    const active = new Set();

    for ( const link of links ) {

      // Only the parts of the portal each viewer can see past walls
      const wedges = [];
      for ( const eye of eyes ) {
        for ( const [t0, t1] of link.visibleIntervals(eye, eye.los) ) {
          const wedge = link.wedge(eye, t0, t1);
          if ( wedge ) wedges.push(wedge);
        }
      }
      if ( !wedges.length ) continue;
      active.add(link.id);
      const w = this.#getWindow(link.id);
      w.mask.clear().beginFill(0xFFFFFF);
      for ( const wedge of wedges ) w.mask.drawShape(wedge);
      w.mask.endFill();
    }

    for ( const [id, w] of this.windows ) {
      if ( active.has(id) ) continue;
      w.texture.destroy(true);
      w.sprite.destroy();
      w.mask.destroy();
      this.windows.delete(id);
    }
    if ( !active.size ) return;

    // Place the window sprites in screen space
    const stage = canvas.stage;
    stage.transform.updateLocalTransform();
    const screenToWorld = stage.transform.localTransform.clone().invert();
    for ( const w of this.windows.values() ) w.sprite.transform.setFromMatrix(screenToWorld);

    for ( const link of links ) {
      const w = this.windows.get(link.id);
      if ( w ) this.#capture(link, w.texture);
    }
  }

  /* ---------------------------------------- */

  /**
   * Get or create the window for a link, with a texture matching the screen.
   * @param {string} id
   */
  #getWindow(id) {
    const renderer = canvas.app.renderer;
    const {width, height} = renderer.screen;
    let w = this.windows.get(id);
    if ( !w ) {
      const texture = PIXI.RenderTexture.create({width, height, resolution: renderer.resolution});
      const sprite = new PIXI.Sprite(texture);
      const mask = new PIXI.Graphics();
      sprite.mask = mask;
      this.container.addChild(sprite, mask);
      w = {sprite, mask, texture};
      this.windows.set(id, w);
    }
    if ( w.texture.baseTexture.resolution !== renderer.resolution ) {
      const old = w.texture;
      w.texture = w.sprite.texture = PIXI.RenderTexture.create({width, height, resolution: renderer.resolution});
      old.destroy(true);
    }
    else if ( (w.texture.width !== width) || (w.texture.height !== height) ) w.texture.resize(width, height, true);
    return w;
  }

  /* ---------------------------------------- */

  /**
   * Render the canvas as seen through a portal into a texture.
   * @param {PortalLink} link
   * @param {PIXI.RenderTexture} texture
   */
  #capture(link, texture) {
    const stage = canvas.stage;
    const pivot = {x: stage.pivot.x, y: stage.pivot.y};
    const scale = stage.scale.x;
    const rotation = stage.rotation;
    const hidden = [canvas.interface, canvas.overlay, this.container].filter(c => c.renderable);
    const moved = this.#moveTokensThrough(link);

    try {
      const exitPivot = link.apply(pivot);
      stage.pivot.set(exitPivot.x, exitPivot.y);
      stage.scale.set(scale / link.scale);
      stage.rotation = rotation - link.angle;
      for ( const c of hidden ) c.renderable = false;
      PortalWindows.#invalidateScreenBuffers();
      canvas.app.renderer.render(stage, {renderTexture: texture, clear: true});
    } finally {
      stage.pivot.set(pivot.x, pivot.y);
      stage.scale.set(scale);
      stage.rotation = rotation;
      for ( const c of hidden ) c.renderable = true;
      for ( const [mesh, state] of moved ) Object.assign(mesh, state);
      PortalWindows.#invalidateScreenBuffers();
    }
  }

  /* ---------------------------------------- */

  /**
   * Temporarily move the meshes of Tokens touching the entrance to the matching point at the exit,
   * so the part of a Token that has stepped through the portal shows up on the far side.
   * @param {PortalLink} link
   * @returns {Map<PIXI.DisplayObject, object>}    The original transforms to restore
   */
  #moveTokensThrough(link) {
    const moved = new Map();
    const area = link.planeBounds(canvas.grid.size * 2);
    for ( const token of canvas.tokens.placeables ) {
      const mesh = token.mesh;
      if ( !mesh || !token.visible || !token.bounds.intersects(area) ) continue;
      moved.set(mesh, {
        position: mesh.position.clone(),
        rotation: mesh.rotation,
        scale: mesh.scale.clone()
      });
      const p = link.apply(mesh.position);
      mesh.position = new PIXI.Point(p.x, p.y);
      mesh.rotation += link.angle;
      mesh.scale = new PIXI.Point(mesh.scale.x * link.scale, mesh.scale.y * link.scale);
    }
    return moved;
  }

  /* ---------------------------------------- */

  /** Mark Foundry's screen-space buffers that only re-render on demand as dirty. */
  static #invalidateScreenBuffers() {
    canvas.hidden.invalidateMasks();
    canvas.masks.vision.renderDirty = true;
    canvas.masks.occlusion.renderDirty = true;
    canvas.effects.illumination.invalidateDarknessLevelContainer(true);
  }
}
