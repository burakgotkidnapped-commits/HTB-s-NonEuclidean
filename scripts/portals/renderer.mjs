import {planeSide} from "./geometry.mjs";
import {getPortalViews, showGhostVision, hideGhostVision, drawLitSeams} from "./vision.mjs";
import SceneAnnex from "./annex.mjs";

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
 *
 * Views through portals into another Scene, or onto another Level of this one, can't render the canvas,
 * which only holds the viewed Level. They render an annex of the exit Level instead (see annex.mjs), with
 * the camera moved the same way.
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

  /**
   * The annexes of other Scenes and Levels seen through portals, by Level UUID.
   * @type {Map<string, SceneAnnex>}
   */
  annexes = new Map();

  /* ---------------------------------------- */

  /** Remove the window layer and free its textures. */
  tearDown() {
    for ( const w of this.windows.values() ) w.texture?.destroy(true);
    this.windows.clear();
    for ( const annex of this.annexes.values() ) annex.destroy();
    this.annexes.clear();
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
    const level = canvas.level.id;
    const annexed = new Set();
    for ( const view of views ) {
      if ( view.link.leadsAway(level) ) annexed.add(view.link.exitLevelDocument(level)?.uuid);
    }
    for ( const [uuid, annex] of this.annexes ) {
      if ( annexed.has(uuid) ) continue;
      annex.destroy();
      this.annexes.delete(uuid);
    }
    if ( !active.size ) {
      drawLitSeams(null);
      return;
    }

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
      if ( view.source ) continue;
      const texture = this.windows.get(view.id).texture;
      if ( view.link.leadsAway(level) ) this.#captureAnnex(view, texture);
      else this.#capture(view, texture);
    }
    drawLitSeams(null);
  }

  /* ---------------------------------------- */

  /**
   * Render the other Scene or Level seen through a portal into a texture.
   * @param {PortalView} view
   * @param {PIXI.RenderTexture} texture
   */
  #captureAnnex(view, texture) {
    const level = view.link.exitLevelDocument(canvas.level.id);
    if ( !level ) return;
    let annex = this.annexes.get(level.uuid);
    if ( !annex ) this.annexes.set(level.uuid, annex = new SceneAnnex(level));
    const stage = canvas.stage;
    const {transform} = view;
    annex.render(canvas.app.renderer, texture, {
      position: stage.position,
      pivot: transform.apply(stage.pivot),
      scale: stage.scale.x / transform.scale,
      rotation: stage.rotation - transform.angle
    }, view.seen);
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
    const ghosts = showGhostVision(view);
    drawLitSeams(view);
    const doubled = this.#drawTokensThrough(view, ghosts);
    const shown = this.#showTokensSeen(ghosts, doubled);

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
      for ( const mesh of doubled ) delete mesh.render;
      for ( const [mesh, visible] of shown ) mesh.visible = visible;
      hideGhostVision();
      PortalWindows.#invalidateScreenBuffers();
    }
  }

  /* ---------------------------------------- */

  /**
   * Temporarily draw Tokens stepping through the portal a second time, at the matching point at the
   * exit, so the part of a Token that has gone through shows up on the far side. A Token is stepping
   * through when it touches the entrance from the side the view is seen from. It is still drawn where
   * it really is too, if the view sees that spot, such as in a room that leads back into itself, where
   * the viewer sees their own Token from behind.
   * @param {PortalView} view
   * @param {PointVisionSource[]|null} ghosts    The ghost vision seen through the portal, or null if
   *                                             Token vision is off and every Token shows
   * @returns {Set<PIXI.DisplayObject>}          The meshes drawn twice, whose own render to remove
   */
  #drawTokensThrough(view, ghosts) {
    const doubled = new Set();
    const link = view.link;
    const area = link.planeBounds(canvas.grid.size * 2);
    const near = Math.sign(planeSide(link.to, view.eye));
    for ( const token of canvas.tokens.placeables ) {
      const mesh = token.mesh;
      if ( !mesh || !mesh.visible || !token.visible || !token.bounds.intersects(area) ) continue;

      // Compare beyond the exit, where the view's eye is: the Token's center, carried through, must
      // be on the eye's side of the exit, as it is on the viewer's side of the entrance
      const p = link.apply(mesh.position);
      if ( planeSide(link.to, p) * near <= 0 ) continue;
      // Tokens keep their size through portals, so the copy does too
      const through = {
        position: new PIXI.Point(p.x, p.y),
        rotation: mesh.rotation + link.angle,
        scale: mesh.scale.clone()
      };
      const real = !ghosts || PortalWindows.#isSeen(token, ghosts);

      // Batched sprites are read when the batch is flushed, so flush each copy before moving the mesh
      const render = mesh.render;
      mesh.render = function(renderer) {
        if ( real ) {
          render.call(this, renderer);
          renderer.batch.flush();
        }
        const state = {position: this.position.clone(), rotation: this.rotation, scale: this.scale.clone()};
        Object.assign(this, through);
        this.updateTransform();
        render.call(this, renderer);
        renderer.batch.flush();
        Object.assign(this, state);
        this.updateTransform();
      };
      doubled.add(mesh);
    }
    return doubled;
  }

  /* ---------------------------------------- */

  /**
   * Temporarily show exactly the Tokens the viewer sees through the portal: hidden ones the ghost
   * vision reaches appear, and ones the viewer only sees directly, from across the map, disappear.
   * @param {PointVisionSource[]|null} ghosts    The ghost vision seen through the portal, or null if
   *                                             Token vision is off and every Token shows
   * @param {Set<PIXI.DisplayObject>} doubled    Meshes drawn through the portal, which decide for themselves
   * @returns {Map<PIXI.DisplayObject, boolean>} The meshes changed, with their visibility to restore
   */
  #showTokensSeen(ghosts, doubled) {
    const changed = new Map();
    if ( !ghosts ) return changed;
    for ( const token of canvas.tokens.placeables ) {
      const mesh = token.mesh;
      if ( !mesh || doubled.has(mesh) ) continue;
      const seen = PortalWindows.#isSeen(token, ghosts);
      if ( seen === mesh.visible ) continue;
      changed.set(mesh, mesh.visible);
      mesh.visible = seen;
    }
    return changed;
  }

  /* ---------------------------------------- */

  /**
   * Does ghost vision see a Token where it really is? As in Foundry, a Token counts as seen within
   * sight range, or anywhere in line of sight that is lit.
   * @param {Token} token
   * @param {PointVisionSource[]} ghosts
   * @returns {boolean}
   */
  static #isSeen(token, ghosts) {
    const {x, y} = token.center;
    return (!token.document.hidden || game.user.isGM) && token.document.includedInLevel(canvas.level)
      && ghosts.some(g => g.shape.contains(x, y) || (g.light?.contains(x, y)
        && canvas.effects.testInsideLight({x, y, elevation: token.document.elevation})));
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
