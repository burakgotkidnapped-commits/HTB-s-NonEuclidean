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
 * The portal settings stored in a Wall's flags at `flags["htb-noneuclidean"].portal`.
 * @property {string|null} exit    UUID of the exit Wall
 * @property {boolean} flip        Come out of the exit heading the opposite way
 * @property {boolean} twoWay      Keep the exit Wall linked back to this one
 * @property {boolean} window      Only see and shine through the portal: nothing can pass it
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
  return {exit: flags.exit, flip: !!flags.flip, twoWay: flags.twoWay ?? true, window: !!flags.window};
}

/**
 * Is a portal Wall a door? A portal door is an ordinary door while closed, and a portal while open.
 * @param {WallDocument} wall
 * @returns {boolean}
 */
export function isPortalDoor(wall) {
  return !!getPortalFlags(wall) && (wall.door !== CONST.WALL_DOOR_TYPES.NONE);
}

/**
 * Does a portal Wall lead through right now? Portal doors only do while open.
 * @param {WallDocument} wall
 * @returns {boolean}
 */
export function isPortalOpen(wall) {
  return (wall.door === CONST.WALL_DOOR_TYPES.NONE) || (wall.ds === CONST.WALL_DOOR_STATES.OPEN);
}

/**
 * Which side of a plane's line a point is on, as a signed distance.
 * @param {PortalPlane} plane
 * @param {Point} point
 * @returns {number}
 */
export function planeSide({center, direction}, {x, y}) {
  return (direction.x * (y - center.y)) - (direction.y * (x - center.x));
}

/* ---------------------------------------- */

/**
 * A similarity transform: rotation, uniform scale, and translation. Treating points as complex
 * numbers, it maps z to m·z + t, where m = cos + i·sin with the scale folded in.
 */
export class Similarity {
  constructor(cos=1, sin=0, x=0, y=0) {
    this.cos = cos;
    this.sin = sin;
    this.x = x;
    this.y = y;
  }

  /** The transform that leaves everything in place. */
  static IDENTITY = new Similarity();

  /** Uniform scale applied. */
  get scale() {
    return Math.hypot(this.cos, this.sin);
  }

  /** Rotation in radians applied. */
  get angle() {
    return Math.atan2(this.sin, this.cos);
  }

  /**
   * @param {Point} point
   * @returns {Point}
   */
  apply({x, y}) {
    return {x: this.x + (this.cos * x) - (this.sin * y), y: this.y + (this.sin * x) + (this.cos * y)};
  }

  /**
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

  /**
   * This transform followed by another.
   * @param {Similarity} other
   * @returns {Similarity}
   */
  then(other) {
    const t = other.apply(this);
    return new Similarity((other.cos * this.cos) - (other.sin * this.sin),
      (other.sin * this.cos) + (other.cos * this.sin), t.x, t.y);
  }

  /** @returns {Similarity} */
  invert() {
    const d = (this.cos * this.cos) + (this.sin * this.sin);
    const cos = this.cos / d;
    const sin = -this.sin / d;
    return new Similarity(cos, sin, -((cos * this.x) - (sin * this.y)), -((sin * this.x) + (cos * this.y)));
  }
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
   * @param {boolean} [options.window=false]   Only look through it: Tokens can't pass
   */
  constructor({entrance, exit, flip=false, window=false}) {
    this.id = entrance.id;
    this.entrance = entrance;
    this.exit = exit;

    /** Is this a portal window? Sight and light pass through it, but Tokens don't. */
    this.window = window;
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

    /** The transform from the entrance side to the exit side. */
    const cos = Math.cos(this.angle) * this.scale;
    const sin = Math.sin(this.angle) * this.scale;
    const {x, y} = this.from.center;
    this.transform = new Similarity(cos, sin, to.center.x - ((cos * x) - (sin * y)),
      to.center.y - ((sin * x) + (cos * y)));
  }

  /* ---------------------------------------- */

  /**
   * Map a point from the entrance side to the exit side.
   * @param {Point} point
   * @returns {Point}
   */
  apply(point) {
    return this.transform.apply(point);
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
   * How far a point is from the nearest point of the entrance Wall.
   * @param {Point} point
   * @returns {number}
   */
  distance({x, y}) {
    const {a, direction, halfLength} = this.from;
    const t = Math.clamp(((x - a.x) * direction.x) + ((y - a.y) * direction.y), 0, halfLength * 2);
    return Math.hypot(x - (a.x + (direction.x * t)), y - (a.y + (direction.y * t)));
  }

  /* ---------------------------------------- */

  /**
   * Is a viewer or light close enough to see or shine through the portal? A portal window works like
   * a window Wall: sight and light only pass it within its proximity threshold. Other portals, and
   * windows without a threshold, let everything through.
   * @param {Point} point
   * @param {"sight"|"light"} type
   * @param {number} [externalRadius=0]    The source's own radius, which counts toward the threshold
   * @returns {boolean}
   */
  reaches(point, type, externalRadius=0) {
    const threshold = this.window ? this.entrance.threshold?.[type] : 0;
    if ( !threshold ) return true;
    const limit = threshold * this.entrance.parent.dimensions.distancePixels;
    return Math.max(this.distance(point) - externalRadius, 0) < limit;
  }

  /* ---------------------------------------- */

  /**
   * How far from a viewer or light it sees or shines through a portal window. Foundry attenuates sight
   * and light through window Walls: right at the window they reach as far as ever, and the farther from
   * it, the less they reach beyond it, until at the threshold they stop at the window.
   * @param {Point} point
   * @param {"sight"|"light"} type
   * @param {number} radius                How far the source reaches without the window
   * @param {number} [externalRadius=0]    The source's own radius, which counts toward the threshold
   * @returns {number}    The distance from the point, or Infinity if the window doesn't attenuate
   */
  attenuatedRadius(point, type, radius, externalRadius=0) {
    const threshold = this.window ? this.entrance.threshold?.[type] : 0;
    if ( !threshold || !this.entrance.threshold.attenuation ) return Infinity;
    const limit = threshold * this.entrance.parent.dimensions.distancePixels;
    const inside = this.distance(point);
    const outside = radius - inside;
    if ( outside <= 0 ) return Infinity; // Doesn't reach past the window anyway
    const p = 1 - (Math.max(inside - externalRadius, 0) / limit);
    if ( p <= 0 ) return inside;
    const a = (p / (2 * (1 - p))) * CONFIG.Wall.thresholdAttenuationMultiplier;
    return inside + Math.min(a * limit, outside);
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
    const {a, b, center, direction} = this.from;
    const length = this.from.halfLength * 2;

    // Work along a line just in front of the Wall, on the viewer's side: the line of sight may stop
    // exactly at the Wall itself, since a Token's sight is cut at portals
    const toward = this.side(eye);
    const distance = Math.abs((direction.x * (eye.y - center.y)) - (direction.y * (eye.x - center.x)));
    const offset = Math.min(2, distance / 2);
    const ox = -direction.y * toward * offset;
    const oy = direction.x * toward * offset;
    const pa = {x: a.x + ox, y: a.y + oy};
    const pb = {x: b.x + ox, y: b.y + oy};

    // Find exactly where that line enters and leaves the line of sight
    const cuts = [0, 1];
    const points = los.points;
    for ( let i = 0; i < points.length; i += 2 ) {
      const j = (i + 2) % points.length;
      const hit = foundry.utils.lineSegmentIntersection(pa, pb,
        {x: points[i], y: points[i + 1]}, {x: points[j], y: points[j + 1]});
      if ( hit ) cuts.push(hit.t0);
    }
    cuts.sort((x, y) => x - y);

    // Keep the stretches between cuts whose middle is in sight. A stretch at the very end of the
    // Wall narrower than a pixel is where it meets other walls, not a real view
    const intervals = [];
    for ( let i = 0; i < cuts.length - 1; i++ ) {
      const [t0, t1] = [cuts[i], cuts[i + 1]];
      if ( (t1 - t0) * length < 1 ) continue;
      const m = (t0 + t1) / 2;
      if ( !los.contains(pa.x + ((pb.x - pa.x) * m), pa.y + ((pb.y - pa.y) * m)) ) continue;
      const last = intervals.at(-1);
      if ( last && ((t0 - last[1]) * length < 1) ) last[1] = t1;
      else intervals.push([t0, t1]);
    }

    // Project the stretches from the line in front of the Wall onto the Wall, as seen from the viewer
    const k = distance / (distance - offset);
    const project = t => {
      const qx = pa.x + ((pb.x - pa.x) * t);
      const qy = pa.y + ((pb.y - pa.y) * t);
      const px = eye.x + ((qx - eye.x) * k);
      const py = eye.y + ((qy - eye.y) * k);
      return Math.clamp((((px - a.x) * direction.x) + ((py - a.y) * direction.y)) / length, 0, 1);
    };
    return intervals.map(([t0, t1]) => [project(t0), project(t1)]);
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
    const {width, height} = this.entrance.parent.dimensions;
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

    // Close the far side through a point along the middle of the two edges, so the wedge still covers
    // the whole far side when the viewer is right at the Wall and its edges are nearly opposite.
    // The middle direction always lies between the edges, wherever the viewer stands.
    const unit = p => {
      const d = Math.hypot(p.x - eye.x, p.y - eye.y) || 1;
      return {x: (p.x - eye.x) / d, y: (p.y - eye.y) / d};
    };
    const ua = unit(a);
    const ub = unit(b);
    let mx = ua.x + ub.x;
    let my = ua.y + ub.y;
    const ml = Math.hypot(mx, my);
    if ( ml < 1e-6 ) [mx, my] = [nx, ny];
    else [mx, my] = [mx / ml, my / ml];
    const fm = {x: eye.x + (mx * far * 2), y: eye.y + (my * far * 2)};
    return new PIXI.Polygon(na.x, na.y, nb.x, nb.y, fb.x, fb.y, fm.x, fm.y, fa.x, fa.y);
  }

  /* ---------------------------------------- */

  /**
   * A strip along part of the entrance Wall, reaching a distance toward a viewer. It stays on the
   * viewer's side: beyond the Wall it would light what lies outside the viewer's wedge.
   * @param {Point} eye
   * @param {number} t0          Start of the part of the Wall, as a fraction
   * @param {number} t1          End of the part of the Wall, as a fraction
   * @param {number} padding
   * @returns {PIXI.Polygon}
   */
  band(eye, t0, t1, padding) {
    const {direction} = this.from;
    const toward = this.side(eye);
    const nx = -direction.y * toward * padding;
    const ny = direction.x * toward * padding;
    const a = this.pointAt(t0);
    const b = this.pointAt(t1);
    return new PIXI.Polygon(a.x, a.y, b.x, b.y, b.x + nx, b.y + ny, a.x + nx, a.y + ny);
  }

  /* ---------------------------------------- */

  /**
   * Map a polygon from the entrance side to the exit side.
   * @param {PIXI.Polygon} polygon
   * @returns {PIXI.Polygon}
   */
  applyPolygon(polygon) {
    return this.transform.applyPolygon(polygon);
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
    if ( !this.leadsAway(level) ) return level;
    return this.exit.levels.first() ?? this.exit.parent.initialLevel?.id ?? level;
  }

  /* ---------------------------------------- */

  /**
   * The elevation a Token comes out at, given the Level it entered from: as high above the exit Level's
   * base as it was above the entrance Level's.
   * @param {string} level
   * @param {number} elevation
   * @returns {number}
   */
  exitElevation(level, elevation) {
    const from = this.entrance.parent.levels.get(level)?.elevation.base ?? 0;
    const to = this.exitLevelDocument(level)?.elevation.base ?? from;
    return to + (elevation - from);
  }

  /* ---------------------------------------- */

  /**
   * Does the exit lead away from the given Level: into another Scene, or onto another Level of this
   * one? Such links aren't seamless. Their views show a picture of the exit Level drawn apart from the
   * canvas, and Tokens move there once they reach the portal.
   * @param {string} level
   * @returns {boolean}
   */
  leadsAway(level) {
    return this.crossScene || !this.exit.includedInLevel(level);
  }

  /* ---------------------------------------- */

  /**
   * The Level of the exit Scene seen through the portal from the given Level.
   * @param {string} level
   * @returns {Level|undefined}
   */
  exitLevelDocument(level) {
    return this.exit.parent.levels.get(this.exitLevel(level));
  }

  /* ---------------------------------------- */

  /**
   * Is this link seamless on the given Level, with both ends on it?
   * @param {string} level
   * @returns {boolean}
   */
  inLevel(level) {
    return this.entrance.includedInLevel(level) && !this.leadsAway(level);
  }
}

/* ---------------------------------------- */

/** @type {Map<Scene, PortalLink[]>} */
const cache = new Map();

/**
 * Get the portal links whose entrances are in a Scene.
 * @param {Scene} [scene]
 * @returns {PortalLink[]}
 */
export function getPortalLinks(scene=canvas.scene) {
  if ( !scene ) return [];
  let links = cache.get(scene);
  if ( !links ) cache.set(scene, links = buildLinks(scene));
  return links;
}

/**
 * Get the seamless portal links on the currently viewed Level.
 * @returns {PortalLink[]}
 */
export function getViewedPortalLinks() {
  if ( !canvas.ready || !canvas.level ) return [];
  return getPortalLinks().filter(link => link.inLevel(canvas.level.id));
}

/**
 * Get the portal links seen through on the currently viewed Level: the seamless ones, and those whose
 * exit is in another Scene or on another Level, which show it but move Tokens there instead of being
 * walked through.
 * @returns {PortalLink[]}
 */
export function getSeenPortalLinks() {
  if ( !canvas.ready || !canvas.level ) return [];
  const level = canvas.level.id;
  return getPortalLinks().filter(link => link.inLevel(level)
    || (link.leadsAway(level) && link.entrance.includedInLevel(level) && !!link.exitLevelDocument(level)));
}

/** Forget cached links, after portal Walls change. */
export function invalidatePortalLinks() {
  cache.clear();
}

/**
 * @param {Scene} scene
 * @returns {PortalLink[]}
 */
function buildLinks(scene) {
  const links = [];
  for ( const wall of scene.walls ) {
    const flags = getPortalFlags(wall);
    if ( !flags || !isPortalOpen(wall) ) continue;
    const exit = fromUuidSync(flags.exit, {strict: false});
    if ( !(exit instanceof foundry.documents.WallDocument) || (exit === wall) ) continue;
    links.push(new PortalLink({entrance: wall, exit, flip: flags.flip, window: flags.window}));
  }
  return links;
}
