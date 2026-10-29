import {log} from "../constants.mjs";

/**
 * Another Level, of another Scene or of this one, drawn inside the current canvas for portal views of it.
 *
 * Foundry only draws the viewed Level, so a portal whose exit is elsewhere has nothing on the canvas
 * to look at. An annex is a light copy of the exit Level: its background, Tiles, Tokens, and
 * foreground, as plain sprites in its Scene's own coordinates, kept off the stage. Portal views of
 * the Level render it with the camera moved through the portal, masked to what the viewers see there.
 *
 * Lighting isn't carried over: the annex is darkened by the Scene's darkness level as a whole.
 */
export default class SceneAnnex {
  /**
   * @param {Level} level    The Level to draw
   */
  constructor(level) {
    this.level = level;
    this.scene = level.parent;
    this.container = new PIXI.Container();
    this.container.eventMode = "none";
    live.add(this);
  }

  /** @type {Level} */
  level;

  /** @type {Scene} */
  scene;

  /** @type {PIXI.Container} */
  container;

  /** Does the annex need to be built again before it is next drawn? */
  dirty = true;

  /** What the viewers see, drawn as the mask of the content. */
  #sight = null;

  /* ---------------------------------------- */

  /**
   * The annexes of a Scene.
   * @param {Scene} scene
   * @returns {SceneAnnex[]}
   */
  static of(scene) {
    return [...live].filter(annex => annex.scene === scene);
  }

  /* ---------------------------------------- */

  /**
   * Draw the annex, as seen from a camera.
   * @param {PIXI.Renderer} renderer
   * @param {PIXI.RenderTexture} texture
   * @param {object} camera
   * @param {Point} camera.position       Where the camera's pivot shows on screen
   * @param {Point} camera.pivot          What the camera looks at, in the Scene's coordinates
   * @param {number} camera.scale
   * @param {number} camera.rotation
   * @param {PIXI.Polygon[]} seen         What the viewers see, in the Scene's coordinates
   */
  render(renderer, texture, {position, pivot, scale, rotation}, seen) {
    if ( this.dirty ) this.#build();
    const sight = this.#sight;
    sight.clear().beginFill(0xFFFFFF);
    for ( const polygon of seen ) sight.drawShape(polygon);
    sight.endFill();
    const c = this.container;
    c.position.set(position.x, position.y);
    c.pivot.set(pivot.x, pivot.y);
    c.scale.set(scale);
    c.rotation = rotation;
    renderer.render(c, {renderTexture: texture, clear: true});
  }

  /* ---------------------------------------- */

  /** Remove the annex and its sprites. Textures stay in Foundry's cache. */
  destroy() {
    live.delete(this);
    this.container.destroy({children: true});
  }

  /* ---------------------------------------- */

  /** Build the sprites from the Scene's documents. */
  #build() {
    this.dirty = false;
    const c = this.container;
    for ( const child of c.removeChildren() ) child.destroy({children: true});
    const {rect, sceneRect, maxR} = this.scene.dimensions;
    const level = this.level;

    // What the viewers don't see is dark, as unexplored fog is
    const backdrop = c.addChild(new PIXI.Graphics());
    backdrop.beginFill(0x000000).drawRect(rect.x - (4 * maxR), rect.y - (4 * maxR), rect.width + (8 * maxR),
      rect.height + (8 * maxR)).endFill();

    const content = c.addChild(new PIXI.Container());
    this.#sight = c.addChild(new PIXI.Graphics());
    content.mask = this.#sight;

    // The Level's background, under everything else
    const color = Number(level.background.color ?? this.scene.backgroundColor ?? 0x999999);
    content.addChild(new PIXI.Graphics()).beginFill(color).drawShape(sceneRect).endFill();
    const background = this.#levelSprite(level.background);
    if ( background ) content.addChild(background);

    // Tiles and Tokens, by elevation, then Tiles under Tokens, then by sort
    const placeables = [];
    for ( const tile of this.scene.tiles ) {
      if ( tile.hidden || !tile.texture.src || !tile.includedInLevel(level.id) ) continue;
      placeables.push({elevation: tile.elevation, kind: 0, sort: tile.sort, draw: () => this.#tileSprite(tile)});
    }
    for ( const token of this.scene.tokens ) {
      if ( (token.hidden && !game.user.isGM) || !token.texture.src || !token.includedInLevel(level.id) ) continue;
      placeables.push({elevation: token.elevation, kind: 1, sort: token.sort, draw: () => this.#tokenSprite(token)});
    }
    placeables.sort((a, b) => (a.elevation - b.elevation) || (a.kind - b.kind) || (a.sort - b.sort));
    for ( const {draw} of placeables ) {
      const sprite = draw();
      if ( sprite ) content.addChild(sprite);
    }

    const foreground = this.#levelSprite(level.foreground);
    if ( foreground ) content.addChild(foreground);

    // No lights are drawn: the whole Scene is as dark as its darkness level, unless globally lit
    const darkness = this.#darkness();
    if ( darkness > 0 ) {
      const shade = content.addChild(new PIXI.Graphics());
      shade.beginFill(CONFIG.Canvas.darknessColor, darkness).drawShape(sceneRect).endFill();
    }
  }

  /* ---------------------------------------- */

  /**
   * How much the Scene is darkened, from 0 to 1.
   * @returns {number}
   */
  #darkness() {
    const {darknessLevel, globalLight} = this.scene.environment;
    const {min=0, max=1} = globalLight.darkness ?? {};
    if ( globalLight.enabled && (darknessLevel >= min) && (darknessLevel <= max) ) return 0;
    return darknessLevel * 0.8;
  }

  /* ---------------------------------------- */

  /**
   * A sprite covering the Scene with a Level's background or foreground image.
   * @param {{src: string|null, tint: Color}} data
   * @returns {PIXI.Sprite|null}
   */
  #levelSprite({src, tint}) {
    const texture = this.#getTexture(src);
    if ( !texture ) return null;
    const {sceneRect} = this.scene.dimensions;
    const sprite = new PIXI.Sprite(texture);
    sprite.position.set(sceneRect.x, sceneRect.y);
    sprite.width = sceneRect.width;
    sprite.height = sceneRect.height;
    sprite.tint = Number(tint ?? 0xFFFFFF);
    return sprite;
  }

  /* ---------------------------------------- */

  /**
   * @param {TileDocument} tile
   * @returns {PIXI.Sprite|null}
   */
  #tileSprite(tile) {
    const {x, y, width, height, rotation, alpha} = tile;
    return this.#fittedSprite(tile.texture, {x: x + (width / 2), y: y + (height / 2)}, width, height, rotation, alpha);
  }

  /* ---------------------------------------- */

  /**
   * @param {TokenDocument} token
   * @returns {PIXI.Sprite|null}
   */
  #tokenSprite(token) {
    const {width, height} = token.getSize();
    const rotation = token.lockRotation ? 0 : token.rotation;
    const alpha = token.alpha * (token.hidden ? 0.5 : 1);
    return this.#fittedSprite(token.texture, token.getCenterPoint(), width, height, rotation, alpha);
  }

  /* ---------------------------------------- */

  /**
   * A sprite fitted into a box as Foundry fits Tile and Token textures.
   * @param {TextureData} data
   * @param {Point} center
   * @param {number} width
   * @param {number} height
   * @param {number} rotation    In degrees
   * @param {number} alpha
   * @returns {PIXI.Sprite|null}
   */
  #fittedSprite(data, center, width, height, rotation, alpha) {
    const texture = this.#getTexture(data.src);
    if ( !texture ) return null;
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(data.anchorX ?? 0.5, data.anchorY ?? 0.5);
    const tw = texture.width || 1;
    const th = texture.height || 1;
    let sx = width / tw;
    let sy = height / th;
    switch ( data.fit ) {
      case "contain": sx = sy = Math.min(sx, sy); break;
      case "cover": sx = sy = Math.max(sx, sy); break;
      case "width": sy = sx; break;
      case "height": sx = sy; break;
    }
    sprite.scale.set(sx * (data.scaleX ?? 1), sy * (data.scaleY ?? 1));
    sprite.position.set(center.x + (data.offsetX ?? 0), center.y + (data.offsetY ?? 0));
    sprite.angle = rotation + (data.rotation ?? 0);
    sprite.alpha = alpha;
    sprite.tint = Number(data.tint ?? 0xFFFFFF);
    return sprite;
  }

  /* ---------------------------------------- */

  /**
   * Get a loaded texture, or start loading it and build the annex again once it has.
   * @param {string|null} src
   * @returns {PIXI.Texture|null}
   */
  #getTexture(src) {
    if ( !src ) return null;
    const texture = foundry.canvas.getTexture(src);
    if ( texture ) return texture instanceof PIXI.Spritesheet ? null : texture;
    if ( !loading.has(src) ) {
      loading.add(src);
      foundry.canvas.loadTexture(src).then(() => {
        for ( const annex of live ) annex.dirty = true;
      }, err => log("warn", `Failed to load ${src} for a portal view`, err));
    }
    return null;
  }
}

/* ---------------------------------------- */

/** @type {Set<SceneAnnex>} */
const live = new Set();

/** Textures asked to load, so each is only asked once. */
const loading = new Set();

/**
 * Build annexes again whenever what they show changes. Called during the init hook.
 */
export function registerAnnexes() {
  const markScene = scene => {
    for ( const annex of SceneAnnex.of(scene) ) annex.dirty = true;
  };
  for ( const type of ["Token", "Tile", "Level"] ) {
    for ( const action of ["create", "update", "delete"] ) Hooks.on(`${action}${type}`, doc => markScene(doc.parent));
  }
  Hooks.on("updateScene", markScene);
}
