import {planeSide} from "./geometry.mjs";
import {getPortalViews, showGhostVision, hideGhostVision} from "./vision.mjs";

/**
 * Portal windows: a live picture of the far side of each portal, drawn over the space beyond it.
 *
 * Each frame, for each portal view, the whole canvas is rendered a second time with the camera
 * moved through the portals (pivot, zoom, and rotation mapped by the links) into a screen-sized
 * texture. That texture is then shown in screen space, masked to the wedge the viewer sees through
 * the portal. Rendering the full pipeline with the moved camera keeps Foundry's screen-space
 * lighting, vision, and fog buffers consistent with what is drawn. Views of portals seen through
 * other portals are drawn the same way, over the view they appear in.
 *
 * Windows sit above the scene and its fog but below the interface (borders, rulers, HUD).
 */
export default class PortalWindows {

  /** @type {PIXI.Container} */
  container;

  /** @type {Map<string, {sprite: PIXI.Sprite, mask: PIXI.Graphics, texture: PIXI.RenderTexture|null}>} */
  windows = new Map();

  /* ---------------------------------------- */

  /** Add the window layer to the canvas. */
  draw() {
    this.container = new PIXI.Container();
    this.container.eventMode = "none";
    this.container.sortableChildren = true;
    canvas.rendered.addChildAt(this.container, canvas.rendered.getChildIndex(canvas.interface));

    // The outline of the scene's edge belongs to the scene, not the interface: portal views cover it
    const outline = this.#outline = PortalWindows.#findOutline();
    if ( outline ) {
      outline.zIndex = -Infinity;
      this.container.addChild(outline);
    }
  }

  /** @type {PIXI.Graphics|undefined} */
  #outline;

  /* ---------------------------------------- */

  /**
   * Find the outline Foundry draws around the scene and canvas, in the interface group.
   * @returns {PIXI.Graphics|undefined}
   */
  static #findOutline() {
    const {rect, sceneRect} = canvas.dimensions;
    const isRect = (shape, r) => (shape instanceof PIXI.Rectangle) && (shape.x === r.x) && (shape.y === r.y)
      && (shape.width === r.width) && (shape.height === r.height);
    return canvas.interface.children.find(c => (c.constructor === PIXI.Graphics) && c.geometry.graphicsData.length
      && c.geometry.graphicsData.every(d => isRect(d.shape, sceneRect) || isRect(d.shape, rect)));
  }

  /* ---------------------------------------- */

  /** Remove the window layer and free its textures. */
  tearDown() {
    for ( const w of this.windows.values() ) w.texture?.destroy(true);
    this.windows.clear();
    const outline = this.#outline;
    if ( outline && !outline.destroyed && !canvas.interface.destroyed ) canvas.interface.addChildAt(outline, 0);
    this.#outline = undefined;
    this.container?.destroy({children: true});
    this.container = null;
  }

  /* ---------------------------------------- */

  /**
   * Update and capture every window. Called once per frame, after animations and before rendering.
   */
  render() {
    if ( !this.container ) return;
    const views = getPortalViews();
    const active = new Set();

    for ( const view of views ) {
      active.add(view.id);
      const w = this.#getWindow(view.id, !view.source);
      w.sprite.zIndex = w.mask.zIndex = view.order;
      w.mask.clear().beginFill(0xFFFFFF);
      for ( const mask of view.masks ) w.mask.drawShape(mask);
      w.mask.endFill();
    }

    for ( const [id, w] of this.windows ) {
      if ( active.has(id) ) continue;
      w.texture?.destroy(true);
      w.sprite.destroy();
      w.mask.destroy();
      this.windows.delete(id);
    }
    if ( !active.size ) return;

    // Place the window sprites in screen space. A copy in a loop shows its source's picture, shifted
    // so that what the source shows at P(w) appears at w
    const stage = canvas.stage;
    stage.transform.updateLocalTransform();
    const screenToWorld = stage.transform.localTransform.clone().invert();
    for ( const view of views ) {
      const sprite = this.windows.get(view.id).sprite;
      if ( !view.source ) {
        sprite.transform.setFromMatrix(screenToWorld);
        continue;
      }
      sprite.texture = this.windows.get(view.source.id).texture;
      const {cos, sin, x, y} = view.shift.invert();
      sprite.transform.setFromMatrix(new PIXI.Matrix(cos, sin, -sin, cos, x, y).append(screenToWorld));
    }

    for ( const view of views ) {
      if ( !view.source ) this.#capture(view, this.windows.get(view.id).texture);
    }
  }

  /* ---------------------------------------- */

  /**
   * Get or create the window for a view.
   * @param {string} id
   * @param {boolean} rendered    Does the view render into its own texture, matching the screen?
   *                              Copies in a loop show another view's texture instead.
   */
  #getWindow(id, rendered) {
    const renderer = canvas.app.renderer;
    const {width, height} = renderer.screen;
    let w = this.windows.get(id);
    if ( !w ) {
      const texture = rendered ? PIXI.RenderTexture.create({width, height, resolution: renderer.resolution}) : null;
      const sprite = new PIXI.Sprite(texture ?? PIXI.Texture.EMPTY);
      const mask = new PIXI.Graphics();
      sprite.mask = mask;
      this.container.addChild(sprite, mask);
      w = {sprite, mask, texture};
      this.windows.set(id, w);
    }
    if ( !w.texture ) return w;
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
   * Render the canvas as seen through portals into a texture.
   * @param {PortalView} view
   * @param {PIXI.RenderTexture} texture
   */
  #capture(view, texture) {
    const stage = canvas.stage;
    const pivot = {x: stage.pivot.x, y: stage.pivot.y};
    const scale = stage.scale.x;
    const rotation = stage.rotation;
    const hidden = [canvas.interface, canvas.overlay, this.container].filter(c => c.renderable);
    const moved = this.#moveTokensThrough(view);
    const shown = this.#showTokensSeen(showGhostVision(view), moved);

    try {
      const {transform} = view;
      const exitPivot = transform.apply(pivot);
      stage.pivot.set(exitPivot.x, exitPivot.y);
      stage.scale.set(scale / transform.scale);
      stage.rotation = rotation - transform.angle;
      for ( const c of hidden ) c.renderable = false;
      PortalWindows.#invalidateScreenBuffers();
      canvas.app.renderer.render(stage, {renderTexture: texture, clear: true});
    } finally {
      stage.pivot.set(pivot.x, pivot.y);
      stage.scale.set(scale);
      stage.rotation = rotation;
      for ( const c of hidden ) c.renderable = true;
      for ( const [mesh, state] of moved ) Object.assign(mesh, state);
      for ( const [mesh, visible] of shown ) mesh.visible = visible;
      hideGhostVision();
      PortalWindows.#invalidateScreenBuffers();
    }
  }

  /* ---------------------------------------- */

  /**
   * Temporarily move the meshes of Tokens touching the entrance to the matching point at the exit,
   * so the part of a Token that has stepped through the portal shows up on the far side. Tokens the
   * view shows where they really are stay put, such as in a room that leads back into itself,
   * where the viewer sees their own Token from behind.
   * @param {PortalView} view
   * @returns {Map<PIXI.DisplayObject, object>}    The original transforms to restore
   */
  #moveTokensThrough(view) {
    const moved = new Map();
    const link = view.link;
    const area = link.planeBounds(canvas.grid.size * 2);
    const near = Math.sign(planeSide(link.to, view.eye));
    for ( const token of canvas.tokens.placeables ) {
      const mesh = token.mesh;
      if ( !mesh || !token.visible || !token.bounds.intersects(area) ) continue;
      if ( planeSide(link.to, mesh.position) * near < 0 ) continue;
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

  /**
   * Temporarily show exactly the Tokens the viewer sees through the portal: hidden ones the ghost
   * vision reaches appear, and ones the viewer only sees directly, from across the map, disappear.
   * As in Foundry, a Token counts as seen within sight range, or anywhere in line of sight that is lit.
   * @param {PointVisionSource[]|null} ghosts    The ghost vision seen through the portal, or null if
   *                                             Token vision is off and every Token shows
   * @param {Map<PIXI.DisplayObject, object>} moved    Meshes moved through the portal, which stay shown
   * @returns {Map<PIXI.DisplayObject, boolean>}       The meshes changed, with their visibility to restore
   */
  #showTokensSeen(ghosts, moved) {
    const changed = new Map();
    if ( !ghosts ) return changed;
    for ( const token of canvas.tokens.placeables ) {
      const mesh = token.mesh;
      if ( !mesh || moved.has(mesh) ) continue;
      const {x, y} = token.center;
      const seen = (!token.document.hidden || game.user.isGM) && token.document.includedInLevel(canvas.level)
        && ghosts.some(g => g.shape.contains(x, y) || (g.light?.contains(x, y)
          && canvas.effects.testInsideLight({x, y, elevation: token.document.elevation})));
      if ( seen === mesh.visible ) continue;
      changed.set(mesh, mesh.visible);
      mesh.visible = seen;
    }
    return changed;
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
