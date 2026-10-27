import {BEHAVIOR_TYPES} from "../constants.mjs";

/**
 * @typedef PortalPlane
 * A line segment that Tokens cross to pass through a portal.
 * @property {Point} a             One end
 * @property {Point} b             The other end
 * @property {Point} center        The midpoint
 * @property {Point} direction     Unit vector from a to b
 * @property {number} halfLength   Half the length of the segment
 */

/**
 * Build a plane from its two ends.
 * @param {Point} a
 * @param {Point} b
 * @returns {PortalPlane}
 */
export function makePlane(a, b) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return {
    a, b,
    center: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2},
    direction: {x: (b.x - a.x) / length, y: (b.y - a.y) / length},
    halfLength: length / 2
  };
}

/**
 * The plane through the center of a rectangle.
 * @param {PIXI.Rectangle} bounds
 * @param {"auto"|"horizontal"|"vertical"} orientation    Which way the plane runs. "auto" runs it along
 *                                                        the longer side, for strips drawn across doorways.
 * @returns {PortalPlane}
 */
export function centerPlane(bounds, orientation="auto") {
  const horizontal = orientation === "auto" ? bounds.width >= bounds.height : orientation === "horizontal";
  const cx = bounds.x + (bounds.width / 2);
  const cy = bounds.y + (bounds.height / 2);
  return horizontal
    ? makePlane({x: bounds.left, y: cy}, {x: bounds.right, y: cy})
    : makePlane({x: cx, y: bounds.top}, {x: cx, y: bounds.bottom});
}

/* ---------------------------------------- */

/**
 * A one-way link from an entrance plane to an exit plane in the same Scene.
 *
 * The link is the similarity transform (rotation, uniform scale, translation) that maps the
 * entrance plane onto the exit plane. A viewer looking across the entrance plane sees the space
 * beyond the exit plane, and a Token walking across it comes out of the exit plane.
 */
export class PortalLink {
  /**
   * @param {object} options
   * @param {string} options.id                    A unique ID for the link
   * @param {RegionBehavior} options.behavior      The behavior that defines it
   * @param {RegionDocument} options.entrance      The Region the entrance belongs to
   * @param {RegionDocument} options.exit          The Region the exit belongs to
   * @param {PortalPlane} options.from             The entrance plane
   * @param {PortalPlane} options.to               The exit plane
   * @param {boolean} [options.flip=false]         Come out heading the opposite way
   * @param {number} [options.entrySide=0]         If nonzero, the link only works from this side of
   *                                               the entrance plane (see {@link PortalLink#side})
   */
  constructor({id, behavior, entrance, exit, from, to, flip=false, entrySide=0}) {
    this.id = id;
    this.behavior = behavior;
    this.entrance = entrance;
    this.exit = exit;
    this.from = from;
    this.to = to;
    this.entrySide = entrySide;

    /** Rotation in radians applied by the link. */
    this.angle = Math.atan2(to.direction.y, to.direction.x) - Math.atan2(from.direction.y, from.direction.x)
      + (flip ? Math.PI : 0);

    /** Uniform scale applied by the link. */
    this.scale = to.halfLength / from.halfLength;

    this.#cos = Math.cos(this.angle) * this.scale;
    this.#sin = Math.sin(this.angle) * this.scale;
  }

  #cos;
  #sin;

  /* ---------------------------------------- */

  /**
   * Map a point from the entrance side to the exit side.
   * @param {Point} point
   * @returns {Point}
   */
  apply({x, y}) {
    const dx = x - this.from.center.x;
    const dy = y - this.from.center.y;
    return {
      x: this.to.center.x + (this.#cos * dx) - (this.#sin * dy),
      y: this.to.center.y + (this.#sin * dx) + (this.#cos * dy)
    };
  }

  /* ---------------------------------------- */

  /**
   * Which side of the entrance plane's line a point is on: 1, -1, or 0 if on the line.
   * @param {Point} point
   * @returns {number}
   */
  side({x, y}) {
    const {center, direction} = this.from;
    const cross = (direction.x * (y - center.y)) - (direction.y * (x - center.x));
    return Math.abs(cross) < 1e-6 ? 0 : Math.sign(cross);
  }

  /* ---------------------------------------- */

  /**
   * Can a viewer or Token at this point use the link?
   * @param {Point} point
   * @returns {boolean}
   */
  isEntrySide(point) {
    const side = this.side(point);
    return !!side && (!this.entrySide || (side === this.entrySide));
  }

  /* ---------------------------------------- */

  /**
   * Where the segment from p0 to p1 enters through the entrance plane, as a fraction of its length.
   * @param {Point} p0
   * @param {Point} p1
   * @returns {number|null}
   */
  crossing(p0, p1) {
    if ( !this.isEntrySide(p0) ) return null;
    const s1 = this.side(p1);
    if ( !s1 || (s1 === this.side(p0)) ) return null;
    const hit = foundry.utils.lineSegmentIntersection(p0, p1, this.from.a, this.from.b);
    return hit ? hit.t0 : null;
  }

  /* ---------------------------------------- */

  /**
   * A point along the entrance plane.
   * @param {number} t    0 at a, 1 at b
   * @returns {Point}
   */
  pointAt(t) {
    const {a, b} = this.from;
    return {x: a.x + ((b.x - a.x) * t), y: a.y + ((b.y - a.y) * t)};
  }

  /* ---------------------------------------- */

  /**
   * The stretches of the entrance plane a viewer can actually see, unblocked by walls.
   * @param {Point} eye
   * @param {PIXI.Polygon|null} los    The viewer's line of sight, or null to treat everything as visible
   * @returns {[number, number][]}      Visible intervals as fractions along the plane
   */
  visibleIntervals(eye, los) {
    if ( !this.isEntrySide(eye) ) return [];
    if ( !los ) return [[0, 1]];
    const steps = Math.max(2, Math.ceil((this.from.halfLength * 2) / 4));
    const intervals = [];
    let start = null;
    for ( let i = 0; i <= steps; i++ ) {
      const t = i / steps;
      const p = this.pointAt(t);

      // Test just in front of the plane, toward the viewer
      const dx = eye.x - p.x;
      const dy = eye.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      const visible = los.contains(p.x + ((dx / d) * 2), p.y + ((dy / d) * 2));
      if ( visible && (start === null) ) start = t;
      if ( !visible && (start !== null) ) {
        intervals.push([Math.max(0, start - (0.5 / steps)), Math.min(1, t - (0.5 / steps))]);
        start = null;
      }
    }
    if ( start !== null ) intervals.push([Math.max(0, start - (0.5 / steps)), 1]);
    return intervals;
  }

  /* ---------------------------------------- */

  /**
   * The area beyond the entrance plane that a viewer sees through part of it.
   * @param {Point} eye
   * @param {number} [t0=0]    Start of the part of the plane, as a fraction
   * @param {number} [t1=1]    End of the part of the plane, as a fraction
   * @returns {PIXI.Polygon|null}
   */
  wedge(eye, t0=0, t1=1) {
    if ( !this.side(eye) ) return null;
    const {width, height} = canvas.dimensions;
    const far = 2 * (width + height);
    const a = this.pointAt(t0);
    const b = this.pointAt(t1);
    const extend = p => {
      const dx = p.x - eye.x;
      const dy = p.y - eye.y;
      const d = Math.hypot(dx, dy) || 1;
      return {x: p.x + ((dx / d) * far), y: p.y + ((dy / d) * far)};
    };
    const fa = extend(a);
    const fb = extend(b);
    return new PIXI.Polygon(a.x, a.y, b.x, b.y, fb.x, fb.y, fa.x, fa.y);
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
   * A rectangle around the entrance plane, padded by a distance.
   * @param {number} padding
   * @returns {PIXI.Rectangle}
   */
  planeBounds(padding) {
    const {a, b} = this.from;
    const x = Math.min(a.x, b.x) - padding;
    const y = Math.min(a.y, b.y) - padding;
    return new PIXI.Rectangle(x, y, Math.abs(b.x - a.x) + (2 * padding), Math.abs(b.y - a.y) + (2 * padding));
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
    if ( !region.bounds.width || !region.bounds.height ) continue;
    for ( const behavior of region.behaviors ) {
      if ( behavior.disabled ) continue;
      const system = behavior.system;
      if ( typeof system?.getPortalLinks !== "function" ) continue;
      if ( (behavior.type !== BEHAVIOR_TYPES.portal) && (behavior.type !== BEHAVIOR_TYPES.fold) ) continue;
      links.push(...system.getPortalLinks());
    }
  }
  return links;
}
