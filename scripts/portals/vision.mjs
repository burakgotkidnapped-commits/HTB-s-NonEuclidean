import {getViewedPortalLinks, seamOverlap} from "./geometry.mjs";
import {getEyes} from "./eyes.mjs";
import {log} from "../constants.mjs";

/**
 * Seeing through portals.
 *
 * - A Token's own sight stops at a portal plane: the real space behind the portal is cut out
 *   of its vision polygon, so it is neither revealed nor explored.
 * - In its place the Token gets a "ghost" vision source at the matching point beyond the exit,
 *   limited to the wedge it can see through the portal. Ghosts only count while that portal's
 *   window is being drawn, so the space beyond the exit shows inside the portal and nowhere else.
 */

/** @type {Map<string, PointVisionSource>} */
const ghosts = new Map();

/** @type {typeof PointVisionSource} */
let GhostVisionSource;

/**
 * Patch the configured vision source class. Called on setup, after systems and modules
 * have had a chance to replace it.
 */
export function patchVisionSources() {
  const VisionSource = CONFIG.Canvas.visionSourceClass;
  const original = VisionSource.prototype._getPolygonConfiguration;
  VisionSource.prototype._getPolygonConfiguration = function() {
    const config = original.call(this);
    const shapes = config.boundaryShapes = [...(config.boundaryShapes ?? [])];
    if ( this.portalBoundary ) shapes.push(this.portalBoundary);
    else if ( !this.data.preview ) {
      try {
        shapes.push(...getPortalCuts(this.data));
      } catch(err) {
        log("error", "Failed to cut vision at portals", err);
      }
    }
    return config;
  };

  const GhostSweep = createGhostSweep(CONFIG.Canvas.polygonBackends.sight);

  GhostVisionSource = class PortalGhostVisionSource extends VisionSource {
    /** Marks ghost sources so they are never treated as real Token vision. */
    isPortalGhost = true;

    /**
     * The area beyond the exit this ghost may see.
     * @type {PIXI.Polygon|null}
     */
    portalBoundary = null;

    /**
     * The exit Wall's plane. Walls between the ghost and it are not in the way: the Token is
     * really looking through the entrance, so only what lies beyond the exit counts.
     * @type {PortalPlane|null}
     */
    portalClip = null;

    /** @override */
    _getPolygonBackend() {
      return GhostSweep;
    }

    /** @inheritDoc */
    _getPolygonConfiguration() {
      return Object.assign(super._getPolygonConfiguration(), {portalClip: this.portalClip});
    }
  };
}

/* ---------------------------------------- */

/**
 * A polygon backend for ghost vision that only takes walls beyond the exit plane into account.
 * Walls on the ghost's side of the exit are dropped, and walls crossing it are trimmed to the far side.
 * @param {typeof ClockwiseSweepPolygon} Sweep    The configured sight backend
 * @returns {typeof ClockwiseSweepPolygon}
 */
function createGhostSweep(Sweep) {
  return class PortalGhostSweep extends Sweep {
    /** @override */
    _identifyEdges() {
      super._identifyEdges();
      const plane = this.config.portalClip;
      if ( !plane ) return;
      const {center, direction} = plane;
      const sideOf = p => (direction.x * (p.y - center.y)) - (direction.y * (p.x - center.x));
      const keep = -Math.sign(sideOf(this.origin)) || 1;
      const beyond = p => (sideOf(p) * keep) > -0.5;

      for ( const edge of [...this.edges] ) {
        if ( edge.type.endsWith("Bounds") ) continue; // The scene's bounds close off the polygon
        const inA = beyond(edge.a);
        const inB = beyond(edge.b);
        if ( inA && inB ) continue;
        this.edges.delete(edge);
        if ( !inA && !inB ) continue;

        // Trim the edge where it crosses the exit plane's line
        const sa = sideOf(edge.a);
        const sb = sideOf(edge.b);
        const t = sa / (sa - sb);
        const cut = {x: edge.a.x + ((edge.b.x - edge.a.x) * t), y: edge.a.y + ((edge.b.y - edge.a.y) * t)};
        const trimmed = new edge.constructor(inA ? edge.a : cut, inB ? edge.b : cut, edge);
        trimmed.intersections = Object.fromEntries(Object.entries(edge.intersections).map(([level, list]) => {
          return [level, list.filter(({intersection: i}) => beyond(i))];
        }));
        this.edges.add(trimmed);
      }
    }
  };
}

/* ---------------------------------------- */

/**
 * The parts of the canvas a real vision source at this origin may still see:
 * everything except what lies beyond each portal plane it looks through.
 * @param {{x: number, y: number}} origin
 * @returns {PIXI.Polygon[]}
 */
function getPortalCuts(origin) {
  const links = getViewedPortalLinks();
  if ( !links.length ) return [];
  const {x, y, width, height} = canvas.dimensions.rect;
  const canvasPolygon = new PIXI.Polygon(x, y, x + width, y, x + width, y + height, x, y + height);
  const cuts = [];
  let los;
  for ( const link of links ) {
    if ( !link.side(origin) ) continue;

    // Only cut where the portal is actually in view, so walls elsewhere keep working as usual
    los ??= CONFIG.Canvas.polygonBackends.sight.create({x: origin.x, y: origin.y, elevation: origin.elevation ?? 0},
      {type: "sight", level: canvas.level});
    for ( const [t0, t1] of link.visibleIntervals(origin, los) ) {
      const wedge = link.wedge(origin, t0, t1, -seamOverlap()); // Let real sight reach a little past the portal
      if ( wedge ) cuts.push(subtract(canvasPolygon, wedge, origin));
    }
  }
  return cuts;
}

/**
 * Join two overlapping polygons into one.
 * @param {PIXI.Polygon|null} polygon
 * @param {PIXI.Polygon} other
 * @returns {PIXI.Polygon|null}
 */
function union(polygon, other) {
  if ( !polygon ) return null;
  const scalingFactor = CONST.CLIPPER_SCALING_FACTOR;
  const [points] = polygon.intersectClipper(other.toClipperPoints({scalingFactor}),
    {clipType: ClipperLib.ClipType.ctUnion, scalingFactor});
  return points ? PIXI.Polygon.fromClipperPoints(points, {scalingFactor}) : polygon;
}

/**
 * Cut a wedge out of a polygon, keeping the piece that contains a point.
 * @param {PIXI.Polygon} polygon
 * @param {PIXI.Polygon} wedge
 * @param {Point} keep
 * @returns {PIXI.Polygon}
 */
function subtract(polygon, wedge, keep) {
  const scalingFactor = CONST.CLIPPER_SCALING_FACTOR;
  const pieces = polygon.intersectClipper(wedge.toClipperPoints({scalingFactor}),
    {clipType: ClipperLib.ClipType.ctDifference, scalingFactor})
    .map(points => PIXI.Polygon.fromClipperPoints(points, {scalingFactor}));
  return pieces.find(p => p.contains(keep.x, keep.y)) ?? pieces[0] ?? new PIXI.Polygon();
}

/* ---------------------------------------- */

/**
 * Create, move, or remove ghost vision sources to match the real ones.
 * Called once per frame. Ghosts only compute their shapes here; see {@link showGhostVision}.
 */
export function syncGhostVision() {
  const wanted = new Map();
  if ( canvas.visibility.tokenVision ) {
    const links = getViewedPortalLinks();
    for ( const eye of getEyes() ) {
      const source = eye.source;
      for ( const link of links ) {

        // One ghost per stretch of the portal the Token can actually see past walls
        const intervals = link.visibleIntervals(eye, eye.los);
        for ( const [i, [t0, t1]] of intervals.entries() ) {
          // Let ghost sight start a little before the exit, so its soft edge doesn't show at the portal
          const wedge = union(link.wedge(eye, t0, t1), link.band(eye, t0, t1, seamOverlap()));
          if ( !wedge ) continue;
          const exitEye = link.apply(eye);
          const data = {
            ...source.data,
            x: exitEye.x,
            y: exitEye.y,
            rotation: source.data.rotation + Math.toDegrees(link.angle),
            radius: source.data.radius * link.scale,
            lightRadius: source.data.lightRadius * link.scale,
            externalRadius: source.data.externalRadius * link.scale
          };
          const boundary = link.applyPolygon(wedge);
          boundary._includeEdge = (a, b) => !link.isExitEdge(a, b); // See past the exit Wall even if it blocks
          const signature = JSON.stringify([data.x, data.y, data.rotation, data.radius, data.lightRadius,
            data.externalRadius, data.angle, data.visionMode, data.disabled, data.level, source.blinded, t0, t1]);
          wanted.set(`${source.sourceId}.noneuclid.${link.id}.${i}`, {source, link, data, boundary, signature});
        }
      }
    }
  }

  for ( const [key, ghost] of ghosts ) {
    if ( wanted.has(key) ) continue;
    ghost.destroy();
    ghosts.delete(key);
  }
  for ( const [key, {source, link, data, boundary, signature}] of wanted ) {
    let ghost = ghosts.get(key);
    if ( ghost?.portalSignature === signature ) continue;
    ghost?.destroy();
    ghost = new GhostVisionSource({sourceId: key, object: source.object});
    ghosts.set(key, ghost);
    Object.assign(ghost.blinded, source.blinded);
    ghost.portalLinkId = link.id;
    ghost.portalBoundary = boundary;
    ghost.portalClip = link.to;
    ghost.portalSignature = signature;
    ghost.initialize(data);
  }
}

/* ---------------------------------------- */

/**
 * Graphics that stand in for Foundry's vision mask while a portal view is captured.
 * Ghosts are never added to the active vision sources, so the real map stays exactly as the
 * Token sees it, walls and all.
 */
const overlays = {sight: null, light: null, realLightMask: null};

/**
 * Show only the ghost vision seen through one portal. The Tokens' own sight is hidden meanwhile:
 * where it also covers the space beyond the exit, seen directly from across the map, it would
 * otherwise show through the portal too.
 * @param {PortalLink} link
 * @returns {PointVisionSource[]|null}    The ghosts drawn, or null if Token vision is off
 */
export function showGhostVision(link) {
  const vision = canvas.visibility.vision;
  if ( !vision || !canvas.visibility.tokenVision ) return null;
  if ( overlays.sight?.parent !== vision ) {
    overlays.sight?.destroy();
    overlays.sight = vision.addChildAt(new PIXI.LegacyGraphics(), vision.getChildIndex(vision.darkness));
    overlays.sight.blendMode = PIXI.BLEND_MODES.MAX_COLOR;
  }
  if ( overlays.light?.parent !== vision.light ) {
    overlays.light?.destroy();
    overlays.light = vision.light.addChild(new PIXI.LegacyGraphics());
  }
  const shown = [];
  overlays.sight.clear().beginFill(0xFF0000);
  overlays.light.clear().beginFill(0xFF0000);

  // Lights that grant vision are seen wherever they shine, portal or not
  for ( const light of canvas.effects.lightSources ) {
    if ( !light.hasActiveLayer || !light.data.vision || light.isPreview ) continue;
    if ( light instanceof foundry.canvas.sources.GlobalLightSource ) continue;
    overlays.light.drawShape(light.shape);
  }
  for ( const ghost of ghosts.values() ) {
    if ( (ghost.portalLinkId !== link.id) || !ghost.shape || ghost.isBlinded ) continue;
    if ( ghost.radius > 0 ) overlays.sight.drawShape(ghost.shape);
    if ( ghost.lightRadius > 0 ) overlays.light.drawShape(ghost.light);
    shown.push(ghost);
  }
  overlays.sight.endFill();
  overlays.light.endFill();

  overlays.sight.renderable = true;
  vision.sight.renderable = false;
  const realLightMask = overlays.realLightMask = vision.light.mask;
  vision.light.mask = overlays.light;
  realLightMask.renderable = false; // No longer a mask, so it would draw as a plain shape

  // Foundry reaches these through the mask while rendering
  for ( const key of ["preview", "shared", "surfaceExposure"] ) overlays.light[key] = realLightMask[key];
  canvas.masks.vision.renderDirty = true;
  return shown;
}

/** Put the Tokens' own vision back, after a portal view is captured. */
export function hideGhostVision() {
  const vision = canvas.visibility.vision;
  if ( overlays.realLightMask ) {
    if ( vision?.light && !vision.light.destroyed ) vision.light.mask = overlays.realLightMask;
    overlays.realLightMask = null;
  }
  if ( vision?.sight && !vision.sight.destroyed ) vision.sight.renderable = true;
  if ( overlays.sight ) overlays.sight.renderable = false;
  if ( overlays.light ) overlays.light.renderable = false;
  canvas.masks.vision.renderDirty = true;
}

/* ---------------------------------------- */

/** Remove all ghost vision sources. */
export function clearGhostVision() {
  for ( const ghost of ghosts.values() ) ghost.destroy();
  ghosts.clear();
  for ( const key of ["sight", "light"] ) {
    overlays[key]?.destroy();
    overlays[key] = null;
  }
}

/* ---------------------------------------- */

/**
 * The current ghost vision sources, for inspection.
 * @returns {PointVisionSource[]}
 */
export function getGhostVision() {
  return [...ghosts.values()];
}
