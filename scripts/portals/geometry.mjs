import {BEHAVIOR_TYPES} from "../constants.mjs";

/**
 * A one-way link from a portal Region (the entrance) to its exit Region in the same Scene.
 *
 * Each Region is reduced to a "plane": the segment through its center along its longer side.
 * The link is the similarity transform (rotation, uniform scale, translation) that maps the
 * entrance plane onto the exit plane. Everything beyond the entrance plane, as seen from a
 * viewer, is replaced by the matching space beyond the exit plane.
 */
export class PortalLink {
  constructor(behavior, entrance, exit) {
    this.behavior = behavior;
    this.id = behavior.id;
    this.entrance = entrance;
    this.exit = exit;

    const from = PortalLink.#plane(entrance.bounds);
    const to = PortalLink.#plane(exit.bounds);
    this.center = from.center;
    this.direction = from.direction;
    this.a = from.a;
    this.b = from.b;
    this.exitCenter = to.center;

    /** Rotation in radians applied by the link. */
    this.angle = Math.atan2(to.direction.y, to.direction.x) - Math.atan2(from.direction.y, from.direction.x)
      + (behavior.system.flip ? Math.PI : 0);

    /** Uniform scale applied by the link. */
    this.scale = to.halfLength / from.halfLength;

    this.#cos = Math.cos(this.angle) * this.scale;
    this.#sin = Math.sin(this.angle) * this.scale;
  }

  #cos;
  #sin;

  /* ---------------------------------------- */

  /**
   * Reduce a bounding rectangle to its plane segment.
   * @param {PIXI.Rectangle} bounds
   */
  static #plane(bounds) {
    const center = {x: bounds.x + (bounds.width / 2), y: bounds.y + (bounds.height / 2)};
    const horizontal = bounds.width >= bounds.height;
    const direction = horizontal ? {x: 1, y: 0} : {x: 0, y: 1};
    const halfLength = (horizontal ? bounds.width : bounds.height) / 2;
    return {
      center, direction, halfLength,
      a: {x: center.x - (direction.x * halfLength), y: center.y - (direction.y * halfLength)},
      b: {x: center.x + (direction.x * halfLength), y: center.y + (direction.y * halfLength)}
    };
  }

  /* ---------------------------------------- */

  /**
   * Map a point from the entrance side to the exit side.
   * @param {Point} point
   * @returns {Point}
   */
  apply({x, y}) {
    const dx = x - this.center.x;
    const dy = y - this.center.y;
    return {
      x: this.exitCenter.x + (this.#cos * dx) - (this.#sin * dy),
      y: this.exitCenter.y + (this.#sin * dx) + (this.#cos * dy)
    };
  }

  /* ---------------------------------------- */

  /**
   * Which side of the entrance plane a point is on: 1, -1, or 0 if it lies on the plane's line.
   * @param {Point} point
   * @returns {number}
   */
  side({x, y}) {
    const cross = (this.direction.x * (y - this.center.y)) - (this.direction.y * (x - this.center.x));
    return Math.abs(cross) < 1e-6 ? 0 : Math.sign(cross);
  }

  /* ---------------------------------------- */

  /**
   * Where the segment from p0 to p1 crosses the entrance plane, as a fraction of its length.
   * @param {Point} p0
   * @param {Point} p1
   * @returns {number|null}
   */
  crossing(p0, p1) {
    const s0 = this.side(p0);
    const s1 = this.side(p1);
    if ( !s0 || !s1 || (s0 === s1) ) return null;
    const hit = foundry.utils.lineSegmentIntersection(p0, p1, this.a, this.b);
    return hit ? hit.t0 : null;
  }

  /* ---------------------------------------- */

  /**
   * The area beyond the entrance plane that a viewer at the eye sees through the portal.
   * @param {Point} eye
   * @returns {PIXI.Polygon|null}
   */
  wedge(eye) {
    if ( !this.side(eye) ) return null;
    const {width, height} = canvas.dimensions;
    const far = 2 * (width + height);
    const extend = p => {
      const dx = p.x - eye.x;
      const dy = p.y - eye.y;
      const d = Math.hypot(dx, dy) || 1;
      return {x: p.x + ((dx / d) * far), y: p.y + ((dy / d) * far)};
    };
    const fa = extend(this.a);
    const fb = extend(this.b);
    return new PIXI.Polygon(this.a.x, this.a.y, this.b.x, this.b.y, fb.x, fb.y, fa.x, fa.y);
  }

  /* ---------------------------------------- */

  /**
   * Map a polygon from the entrance side to the exit side.
   * @param {PIXI.Polygon} polygon
   * @returns {PIXI.Polygon}
   */
  applyPolygon(polygon) {
    const points = [];
    for ( let i = 0; i < polygon.points.length; i += 2 ) {
      const p = this.apply({x: polygon.points[i], y: polygon.points[i + 1]});
      points.push(p.x, p.y);
    }
    return new PIXI.Polygon(points);
  }

  /* ---------------------------------------- */

  /**
   * The Level a Token lands on when it exits, given the Level it entered from.
   * @param {string} level
   * @returns {string}
   */
  exitLevel(level) {
    if ( this.exit.includedInLevel(level) ) return level;
    return this.exit.levels.first() ?? level;
  }

  /* ---------------------------------------- */

  /**
   * Is this link usable on the given Level, with both ends on it?
   * @param {string} level
   * @returns {boolean}
   */
  inLevel(level) {
    return this.entrance.includedInLevel(level) && this.exit.includedInLevel(level);
  }
}

/* ---------------------------------------- */

let cache = null;

/**
 * Get the portal links of a Scene whose exits are in the same Scene.
 * @param {Scene} [scene]
 * @returns {PortalLink[]}
 */
export function getPortalLinks(scene=canvas.scene) {
  if ( !scene ) return [];
  if ( cache?.scene !== scene ) cache = {scene, links: buildLinks(scene)};
  return cache.links;
}

/**
 * Get the portal links usable on the currently viewed Level.
 * @returns {PortalLink[]}
 */
export function getViewedPortalLinks() {
  if ( !canvas.ready || !canvas.level ) return [];
  return getPortalLinks().filter(link => link.inLevel(canvas.level.id));
}

/** Forget cached links, after portals or their Regions change. */
export function invalidatePortalLinks() {
  cache = null;
}

/**
 * @param {Scene} scene
 * @returns {PortalLink[]}
 */
function buildLinks(scene) {
  const links = [];
  for ( const region of scene.regions ) {
    for ( const behavior of region.behaviors ) {
      if ( (behavior.type !== BEHAVIOR_TYPES.portal) || behavior.disabled ) continue;
      const exit = behavior.system.getExit();
      if ( !exit || (exit === region) || (exit.parent !== scene) ) continue;
      if ( !region.bounds.width || !exit.bounds.width ) continue;
      links.push(new PortalLink(behavior, region, exit));
    }
  }
  return links;
}
