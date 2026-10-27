import {MODULE_ID} from "../constants.mjs";

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
 * @typedef PortalFlags
 * The portal settings stored in a Wall's flags at `flags.noneuclid.portal`.
 * @property {string|null} exit    UUID of the exit Wall
 * @property {boolean} flip        Come out of the exit heading the opposite way
 * @property {boolean} twoWay      Keep the exit Wall linked back to this one
 */

/**
 * How far, in pixels, views on either side of a portal overlap. Foundry blurs the edges of vision,
 * so if both sides stopped exactly at the portal, a thin dark seam would show along it.
 * @returns {number}
 */
export function seamOverlap() {
  return Math.max(8, canvas.dimensions.size / 8);
}

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
 * The plane of a Wall.
 * @param {WallDocument} wall
 * @returns {PortalPlane}
 */
export function wallPlane(wall) {
  const [x0, y0, x1, y1] = wall.c;
  return makePlane({x: x0, y: y0}, {x: x1, y: y1});
}

/**
 * Get a Wall's portal settings.
 * @param {WallDocument} wall
 * @returns {PortalFlags|null}    The settings, or null if the Wall is not a portal
 */
export function getPortalFlags(wall) {
  const flags = wall.flags[MODULE_ID]?.portal;
  if ( !flags?.exit ) return null;
  return {exit: flags.exit, flip: !!flags.flip, twoWay: flags.twoWay ?? true};
}

/* ---------------------------------------- */

/**
 * A one-way link from an entrance Wall to an exit Wall.
 *
 * The link is the similarity transform (rotation, uniform scale, translation) that maps the
 * entrance Wall onto the exit Wall. A viewer looking across the entrance sees the space beyond the
 * exit, and a Token walking across the entrance comes out of the exit.
 */
export class PortalLink {
  /**
   * @param {object} options
   * @param {WallDocument} options.entrance    The entrance Wall
   * @param {WallDocument} options.exit        The exit Wall, possibly in another Scene
   * @param {boolean} [options.flip=false]     Come out heading the opposite way
   */
  constructor({entrance, exit, flip=false}) {
    this.id = entrance.id;
    this.entrance = entrance;
    this.exit = exit;
    this.from = wallPlane(entrance);

    // Walls have no front, so line the exit up with the entrance as closely as possible:
    // walking straight through comes out heading the same way unless flipped
    let to = wallPlane(exit);
    const dot = (to.direction.x * this.from.direction.x) + (to.direction.y * this.from.direction.y);
    if ( dot < -1e-6 ) to = makePlane(to.b, to.a);
    this.to = to;

    /** Is the exit in another Scene? Such links teleport instead of being seamless. */
    this.crossScene = exit.parent !== entrance.parent;

    /** Rotation in radians applied by the link. */
    this.angle = Math.atan2(to.direction.y, to.direction.x) - Math.atan2(this.from.direction.y, this.from.direction.x)
      + (flip ? Math.PI : 0);

    /** Uniform scale applied by the link. */
    this.scale = to.halfLength / this.from.halfLength;

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
   * Which side of the entrance Wall's line a point is on: 1, -1, or 0 if on the line.
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
   * Where the segment from p0 to p1 crosses the entrance Wall, as a fraction of its length.
   * @param {Point} p0
   * @param {Point} p1
   * @returns {number|null}
   */
  crossing(p0, p1) {
    const s0 = this.side(p0);
    const s1 = this.side(p1);
    if ( !s0 || !s1 || (s0 === s1) ) return null;
    const hit = foundry.utils.lineSegmentIntersection(p0, p1, this.from.a, this.from.b);
    return hit ? hit.t0 : null;
  }

  /* ---------------------------------------- */

  /**
   * A point along the entrance Wall.
   * @param {number} t    0 at one end, 1 at the other
   * @returns {Point}
   */
  pointAt(t) {
    const {a, b} = this.from;
    return {x: a.x + ((b.x - a.x) * t), y: a.y + ((b.y - a.y) * t)};
  }

  /* ---------------------------------------- */

  /**
   * The stretches of the entrance Wall a viewer can actually see, unblocked by other walls.
   * @param {Point} eye
   * @param {PIXI.Polygon|null} los    The viewer's line of sight, or null to treat everything as visible
   * @returns {[number, number][]}      Visible intervals as fractions along the Wall
   */
  visibleIntervals(eye, los) {
    if ( !this.side(eye) ) return [];
    if ( !los ) return [[0, 1]];
    const steps = Math.max(2, Math.ceil((this.from.halfLength * 2) / 4));
    const intervals = [];
    let start = null;
    for ( let i = 0; i <= steps; i++ ) {
      const t = i / steps;
      const p = this.pointAt(t);

      // Test just in front of the Wall, toward the viewer
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
   * The area beyond the entrance Wall that a viewer sees through part of it.
   * @param {Point} eye
   * @param {number} [t0=0]    Start of the part of the Wall, as a fraction
   * @param {number} [t1=1]    End of the part of the Wall, as a fraction
   * @param {number} [inset=0] Start this many pixels in front of the Wall, toward the viewer;
   *                           negative to start behind it
   * @returns {PIXI.Polygon|null}
   */
  wedge(eye, t0=0, t1=1, inset=0) {
    if ( !this.side(eye) ) return null;
    const {width, height} = canvas.dimensions;
    const far = 2 * (width + height);
    const along = (p, distance) => {
      const dx = p.x - eye.x;
      const dy = p.y - eye.y;
      const d = Math.hypot(dx, dy) || 1;
      return {x: p.x + ((dx / d) * distance), y: p.y + ((dy / d) * distance)};
    };
    const a = this.pointAt(t0);
    const b = this.pointAt(t1);

    // The unit normal of the Wall pointing away from the viewer
    const {center, direction} = this.from;
    const away = this.side(eye) > 0 ? -1 : 1;
    const nx = -direction.y * away;
    const ny = direction.x * away;

    // Move the near edge straight off the Wall, never past the viewer, which would turn the wedge
    // inside out right at the portal
    const distance = Math.abs((direction.x * (eye.y - center.y)) - (direction.y * (eye.x - center.x)));
    inset = Math.min(inset, distance / 2);
    const na = {x: a.x - (nx * inset), y: a.y - (ny * inset)};
    const nb = {x: b.x - (nx * inset), y: b.y - (ny * inset)};
    const fa = along(a, far);
    const fb = along(b, far);

    // Close the far side through a point straight out from the Wall, so the wedge still covers the
    // whole far side when the viewer is right at the Wall and its edges are nearly parallel to it
    const fm = {x: center.x + (nx * far), y: center.y + (ny * far)};
    return new PIXI.Polygon(na.x, na.y, nb.x, nb.y, fb.x, fb.y, fm.x, fm.y, fa.x, fa.y);
  }

  /* ---------------------------------------- */

  /**
   * A strip along the entrance Wall, reaching a distance to either side of it.
   * @param {number} padding
   * @returns {PIXI.Polygon}
   */
  band(padding) {
    const {a, b, direction} = this.from;
    const nx = -direction.y * padding;
    const ny = direction.x * padding;
    return new PIXI.Polygon(a.x + nx, a.y + ny, b.x + nx, b.y + ny, b.x - nx, b.y - ny, a.x - nx, a.y - ny);
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
   * Does an edge lie along the exit Wall?
   * @param {Point} a
   * @param {Point} b
   * @returns {boolean}
   */
  isExitEdge(a, b) {
    const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 1;
    const {a: ea, b: eb} = this.to;
    return (near(a, ea) && near(b, eb)) || (near(a, eb) && near(b, ea));
  }

  /* ---------------------------------------- */

  /**
   * A rectangle around the entrance Wall, padded by a distance.
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
    if ( !this.crossScene && this.exit.includedInLevel(level) ) return level;
    return this.exit.levels.first() ?? this.exit.parent.initialLevel?.id ?? level;
  }

  /* ---------------------------------------- */

  /**
   * Is this link seamless on the given Level, with both ends on it?
   * @param {string} level
   * @returns {boolean}
   */
  inLevel(level) {
    return !this.crossScene && this.entrance.includedInLevel(level) && this.exit.includedInLevel(level);
  }
}

/* ---------------------------------------- */

let cache = null;

/**
 * Get the portal links whose entrances are in a Scene.
 * @param {Scene} [scene]
 * @returns {PortalLink[]}
 */
export function getPortalLinks(scene=canvas.scene) {
  if ( !scene ) return [];
  if ( cache?.scene !== scene ) cache = {scene, links: buildLinks(scene)};
  return cache.links;
}

/**
 * Get the seamless portal links on the currently viewed Level.
 * @returns {PortalLink[]}
 */
export function getViewedPortalLinks() {
  if ( !canvas.ready || !canvas.level ) return [];
  return getPortalLinks().filter(link => link.inLevel(canvas.level.id));
}

/** Forget cached links, after portal Walls change. */
export function invalidatePortalLinks() {
  cache = null;
}

/**
 * @param {Scene} scene
 * @returns {PortalLink[]}
 */
function buildLinks(scene) {
  const links = [];
  for ( const wall of scene.walls ) {
    const flags = getPortalFlags(wall);
    if ( !flags ) continue;
    const exit = fromUuidSync(flags.exit, {strict: false});
    if ( !(exit instanceof foundry.documents.WallDocument) || (exit === wall) ) continue;
    links.push(new PortalLink({entrance: wall, exit, flip: flags.flip}));
  }
  return links;
}
