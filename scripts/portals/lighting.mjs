import {getPortalLinks, getViewedPortalLinks, planeSide} from "./geometry.mjs";
import {asBoundary, createGhostSweep, getGhostCuts, getPortalCuts, isPast} from "./vision.mjs";
import {MODULE_ID, log} from "../constants.mjs";

/**
 * Light through portals.
 *
 * - A light stops at a portal plane, as a Token's sight does: the real space behind the portal is
 *   cut out of its shape, so it isn't lit from the wrong side.
 * - In its place the light gets a "ghost" light source at the matching point beyond the exit, limited
 *   to the wedge it shines into through the portal. Unlike ghost vision, ghost lights are real light
 *   sources: the space beyond the exit really is lit, whether it is seen directly or through the portal.
 * - Ghost light stops at portals in turn and carries on through them, a few levels deep.
 * - Ghosts follow their light every frame, so a torch a Token carries lights the far side as it moves.
 *
 * Unlike sight, light can't overlap past a portal to hide the soft edge Foundry draws along it: being
 * real, the overlap would show from the portal's other side as a thin line of light. So light stops
 * exactly at portals, and its soft edge is left out along them instead (see {@link hardenPortalSeams}).
 */

/** @type {Map<string, PointLightSource>} */
const ghosts = new Map();

/** @type {typeof PointLightSource} */
let GhostLightSource;

/**
 * Ghost lights that failed to be computed, so each failure is only reported once.
 * @type {Set<string>}
 */
const failures = new Set();

/** The most ghost lights at once, however many lights and portals there are. */
const MAX_GHOSTS = 64;

/** Uniforms that light animations change every frame, which ghosts take from the light they carry on. */
const ANIMATED_UNIFORMS = ["time", "brightnessPulse", "ratio"];

/**
 * Patch the configured light source class. Called on setup, after systems and modules
 * have had a chance to replace it.
 */
export function patchLightSources() {
  const LightSource = CONFIG.Canvas.lightSourceClass;
  const original = LightSource.prototype._getPolygonConfiguration;
  LightSource.prototype._getPolygonConfiguration = function() {
    const config = original.call(this);
    const shapes = config.boundaryShapes = [...(config.boundaryShapes ?? [])];
    if ( this.portalBoundaries ) shapes.push(...this.portalBoundaries);
    else if ( this.data.walls && (config.radius > 0) ) {
      try {
        shapes.push(...getPortalCuts(this.data, {type: this.constructor.sourceType, radius: config.radius,
          overlap: 0}));
      } catch(err) {
        log("error", "Failed to cut light at portals", err);
      }
    }
    return config;
  };

  const updateGeometry = LightSource.prototype._updateGeometry;
  LightSource.prototype._updateGeometry = function() {
    updateGeometry.call(this);
    try {
      hardenPortalSeams(this);
    } catch(err) {
      log("error", "Failed to smooth light at portals", err);
    }
  };

  const GhostSweep = createGhostSweep(CONFIG.Canvas.polygonBackends.light);

  GhostLightSource = class PortalGhostLightSource extends LightSource {
    /** Marks ghost sources so they are never carried through portals as lights of their own. */
    isPortalGhost = true;

    /**
     * The area beyond the exit this ghost may light, as shapes it must stay inside.
     * @type {PIXI.Polygon[]|null}
     */
    portalBoundaries = null;

    /**
     * The exit Wall's plane. Walls between the ghost and it are not in the way: the light really
     * shines through the entrance, so only what lies beyond the exit counts.
     * @type {PortalPlane|null}
     */
    portalClip = null;

    /**
     * The real light this ghost carries on, whose animation it follows.
     * @type {PointLightSource|null}
     */
    portalRoot = null;

    /**
     * Ghosts never shape darkness: the light they carry on does that where it really is.
     * @override
     */
    get requiresEdges() {
      return false;
    }

    /** @override */
    _getPolygonBackend() {
      return GhostSweep;
    }

    /** @inheritDoc */
    _getPolygonConfiguration() {
      return Object.assign(super._getPolygonConfiguration(), {portalClip: this.portalClip});
    }

    /**
     * Flicker in step with the real light. Time-based animations already match, since the ghost has the
     * same seed, but flickering draws from random noise of its own, so take the animated values instead.
     * @inheritDoc
     */
    animate(dt) {
      super.animate(dt);
      const root = this.portalRoot;
      if ( !root?.active ) return;
      for ( const [id, layer] of Object.entries(this.layers) ) {
        const from = root.layers[id]?.shader?.uniforms;
        const to = layer.shader?.uniforms;
        if ( !from || !to ) continue;
        for ( const key of ANIMATED_UNIFORMS ) if ( key in from ) to[key] = from[key];
      }
    }
  };
}

/* ---------------------------------------- */

/**
 * Leave the soft edge out of a light's mesh where it runs along a portal, entrance or exit. Foundry
 * fades light out over a few pixels inside the edge of its shape; at a portal that would show as a
 * dark seam between the light on either side. The fade comes from a depth value per vertex, from 0 on
 * the edge to 1 inside, so vertices along a portal are set to 1.
 * @param {PointLightSource} source
 */
function hardenPortalSeams(source) {
  if ( !source._flags.renderSoftEdges || !source.shape ) return;
  const depth = source._geometry?.getBuffer("aDepthValue");
  if ( !depth ) return;
  const {x, y} = source.shape.origin;
  const radius = source.shape.config.radius;
  const width = (Math.abs(source.constructor.EDGE_OFFSET) * (canvas.scene._source.grid.size / 100)) + 1;
  const planes = getViewedPortalLinks().flatMap(link => [link.from, link.to])
    .filter(({center, halfLength}) => Math.hypot(center.x - x, center.y - y) < radius + halfLength + width);
  if ( !planes.length ) return;
  const near = (plane, p) => {
    if ( Math.abs(planeSide(plane, p)) > width ) return false;
    const along = ((p.x - plane.a.x) * plane.direction.x) + ((p.y - plane.a.y) * plane.direction.y);
    return (along >= -1) && (along <= (plane.halfLength * 2) + 1);
  };

  // Vertices are stored relative to the origin, in units of the radius
  const position = source._geometry.getBuffer("aVertexPosition").data;
  let changed = false;
  for ( let i = 0; i < depth.data.length; i++ ) {
    if ( depth.data[i] >= 1 ) continue;
    const p = {x: x + (position[i * 2] * radius), y: y + (position[(i * 2) + 1] * radius)};
    if ( !planes.some(plane => near(plane, p)) ) continue;
    depth.data[i] = 1;
    changed = true;
  }
  if ( changed ) depth.update();
}

/* ---------------------------------------- */

/**
 * Should a light be carried through portals?
 * @param {PointLightSource} source
 * @returns {boolean}
 */
function isCarried(source) {
  return !source.isPortalGhost && source.active && !source.isPreview && source.data.walls && (source.radius > 0)
    && !!source.shape && !(source instanceof foundry.canvas.sources.GlobalLightSource)
    && (source.data.level === canvas.level.id);
}

/**
 * Find where lights shine through portals, including portals lit through other portals, and create,
 * move, or remove ghost lights to match. Called once per frame, before perception is updated, so
 * lighting and vision take in this frame's ghosts.
 */
export function syncGhostLights() {
  const links = getViewedPortalLinks();
  const allLinks = getPortalLinks();
  const maxDepth = game.settings.get(MODULE_ID, "portalDepth");
  const wanted = new Set();
  let changed = false;

  // Breadth first, so with too many in reach the light through the nearest portals is kept
  const queue = [];
  if ( links.length ) {
    for ( const source of canvas.effects.lightSources ) {
      if ( isCarried(source) ) queue.push({key: `${source.sourceId}.noneuclid`, root: source, source,
        from: source.origin, link: null, depth: 0});
    }
  }
  while ( queue.length && (wanted.size < MAX_GHOSTS) ) {
    const parent = queue.shift();
    if ( parent.depth >= maxDepth ) continue;
    const {source, from} = parent;
    for ( const link of links ) {
      if ( parent.link && !isPast(parent.link, link, from) ) continue;
      if ( link.distance(from) >= source.radius ) continue;

      // One ghost per stretch of the portal the light actually reaches past walls
      for ( const [i, [t0, t1]] of link.visibleIntervals(from, source.shape).entries() ) {
        if ( wanted.size >= MAX_GHOSTS ) break;
        // Foundry rounds a source's position to the pixel, so place the ghost there from the start
        const node = {key: `${parent.key}.${link.id}.${i}`, root: parent.root, link, depth: parent.depth + 1,
          from: roundOffPlane(link.apply(from), link.to)};
        const ghost = updateGhost(node, source, from, t0, t1, links, allLinks);
        if ( !ghost ) {
          changed = true; // It may have been dropped
          continue;
        }
        changed ||= ghost.portalChanged;
        wanted.add(node.key);
        if ( ghost.active && ghost.shape ) queue.push({...node, source: ghost});
      }
    }
  }

  for ( const [key, ghost] of ghosts ) {
    if ( wanted.has(key) ) continue;
    ghost.destroy();
    ghosts.delete(key);
    changed = true;
  }
  if ( changed ) canvas.perception.update({refreshLighting: true, refreshVision: true});
}

/**
 * Round a point to the pixel, as Foundry does with a source's position, without letting it reach or
 * cross a plane. A ghost must stay on the side of the exit it shines from: a light carried up to a
 * portal comes within a pixel of it, and through a portal that scales, plain rounding would put the
 * ghost on the exit, or past it, where it lights the wrong side or nothing.
 * @param {Point} point
 * @param {PortalPlane} plane
 * @returns {Point}
 */
function roundOffPlane(point, plane) {
  const side = Math.sign(planeSide(plane, point));
  let best = null;
  let distance = Infinity;
  for ( const x of [Math.floor(point.x), Math.ceil(point.x)] ) {
    for ( const y of [Math.floor(point.y), Math.ceil(point.y)] ) {
      const p = {x, y};
      if ( side && (Math.sign(planeSide(plane, p)) !== side) ) continue;
      const d = Math.hypot(x - point.x, y - point.y);
      if ( d >= distance ) continue;
      best = p;
      distance = d;
    }
  }
  return best ?? {x: Math.round(point.x), y: Math.round(point.y)};
}

/**
 * Create or update the ghost of a light beyond one stretch of a portal.
 * @param {object} node                   The ghost's place in the chain of portals
 * @param {PointLightSource} parent       The light shining into the portal, real or a ghost
 * @param {Point} from                    Where the parent shines from
 * @param {number} t0                     The stretch of the portal lit
 * @param {number} t1
 * @param {PortalLink[]} links            All portals in view
 * @param {PortalLink[]} allLinks         All portals in the Scene, to notice when they change
 * @returns {PointLightSource|null}
 */
function updateGhost({key, root, link, from: origin}, parent, from, t0, t1, links, allLinks) {
  // Fan the wedge out from exactly where the ghost is, so its edges meet the shadows the ghost casts.
  // With a portal that scales, the ghost's rounded position doesn't map back onto the parent's
  const wedge = link.wedge(link.transform.invert().apply(origin), t0, t1);
  if ( !wedge ) return null;
  const {animation={}, ...rest} = parent.data;
  const scale = link.scale;
  const data = Object.assign(foundry.utils.deepClone(rest), {
    x: origin.x,
    y: origin.y,
    rotation: rest.rotation + Math.toDegrees(link.angle),
    dim: rest.dim * scale,
    bright: rest.bright * scale,
    externalRadius: rest.externalRadius * scale,
    preview: false,
    seed: parent.animation.seed,
    animation: {type: animation.type, speed: animation.speed, intensity: animation.intensity, reverse: animation.reverse}
  });
  const signature = JSON.stringify([data, t0, t1]);
  let ghost = ghosts.get(key);
  if ( (ghost?.portalSignature === signature) && (ghost.portalLinks === allLinks) ) {
    ghost.portalChanged = false;
    return ghost;
  }
  if ( !ghost ) {
    ghost = new GhostLightSource({sourceId: key, object: root.object});
    ghosts.set(key, ghost);
  }

  // Ghost light starts exactly at the exit: anything before it would show from the exit's other side
  const boundary = asBoundary(link.applyPolygon(wedge));
  boundary._includeEdge = (a, b) => !link.isExitEdge(a, b); // Shine past the exit Wall even if it blocks
  ghost.portalBoundaries = [boundary, ...getGhostCuts(origin, links, link, 0)];
  ghost.portalClip = link.to;
  ghost.portalRoot = root;
  ghost.portalSignature = signature;
  ghost.portalLinks = allLinks;
  ghost.portalChanged = true;
  // Foundry only logs a failure to compute the shape, and takes the source out of the active lights.
  // Drop the ghost then, so it is tried again next frame rather than taken as up to date
  const updateId = ghost.updateId;
  try {
    ghost.initialize(data);
    if ( ghost.updateId === updateId ) throw new Error(`The shape of ghost light ${key} could not be computed`);
    ghost.add();
  } catch(err) {
    if ( !failures.has(key) ) log("error", "Failed to carry light through a portal", err);
    failures.add(key); // Tried again every frame, but reported once
    ghost.destroy();
    ghosts.delete(key);
    return null;
  }
  return ghost;
}

/* ---------------------------------------- */

/** Remove all ghost lights. */
export function clearGhostLights() {
  const had = ghosts.size > 0;
  for ( const ghost of ghosts.values() ) ghost.destroy();
  ghosts.clear();
  failures.clear();
  if ( had ) canvas.perception.update({refreshLighting: true, refreshVision: true});
}

/* ---------------------------------------- */

/**
 * The current ghost light sources, for inspection.
 * @returns {PointLightSource[]}
 */
export function getGhostLights() {
  return [...ghosts.values()];
}
