import {getViewedPortalLinks} from "./geometry.mjs";
import {getEyes} from "./eyes.mjs";

/**
 * Seeing through portals.
 *
 * - A Token's own sight stops at a portal plane: the real space behind the portal is cut out
 *   of its vision polygon, so it is neither revealed nor explored.
 * - In its place the Token gets a "ghost" vision source at the matching point beyond the exit,
 *   limited to the wedge it can see through the portal. That reveals the space on the other side,
 *   which the portal window then draws.
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
    else if ( !this.data.preview ) shapes.push(...getPortalCuts(this.data));
    return config;
  };

  GhostVisionSource = class PortalGhostVisionSource extends VisionSource {
    /** Marks ghost sources so they are never treated as real Token vision. */
    isPortalGhost = true;

    /**
     * The area beyond the exit this ghost may see.
     * @type {PIXI.Polygon|null}
     */
    portalBoundary = null;
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
    if ( !link.isEntrySide(origin) ) continue;

    // Only cut where the portal is actually in view, so walls elsewhere keep working as usual
    los ??= CONFIG.Canvas.polygonBackends.sight.create({x: origin.x, y: origin.y, elevation: origin.elevation ?? 0},
      {type: "sight", level: canvas.level});
    for ( const [t0, t1] of link.visibleIntervals(origin, los) ) {
      const wedge = link.wedge(origin, t0, t1);
      if ( wedge ) cuts.push(canvasPolygon.intersectPolygon(wedge, {clipType: ClipperLib.ClipType.ctDifference}));
    }
  }
  return cuts;
}

/* ---------------------------------------- */

/**
 * Create, move, or remove ghost vision sources to match the real ones.
 * Called once per frame, before perception updates are applied.
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
          const wedge = link.wedge(eye, t0, t1);
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
          wanted.set(`${source.sourceId}.noneuclid.${link.id}.${i}`, {source, data, boundary});
        }
      }
    }
  }

  let changed = false;
  let added = false;
  for ( const [key, ghost] of ghosts ) {
    if ( wanted.has(key) ) continue;
    ghost.destroy();
    ghosts.delete(key);
    changed = added = true;
  }
  for ( const [key, {source, data, boundary}] of wanted ) {
    let ghost = ghosts.get(key);
    const signature = JSON.stringify([data.x, data.y, data.rotation, data.radius, data.lightRadius,
      data.externalRadius, data.angle, data.visionMode, data.disabled, data.level, source.blinded]);
    if ( ghost?.portalSignature === signature ) continue;
    if ( !ghost ) {
      ghost = new GhostVisionSource({sourceId: key, object: source.object});
      ghosts.set(key, ghost);
      added = true;
    }
    Object.assign(ghost.blinded, source.blinded);
    ghost.portalBoundary = boundary;
    ghost.portalSignature = signature;
    ghost.initialize(data);
    ghost.add();
    changed = true;
  }

  if ( changed ) canvas.perception.update({initializeVisionModes: added, refreshVision: true, refreshLighting: true});
}

/* ---------------------------------------- */

/** Remove all ghost vision sources. */
export function clearGhostVision() {
  for ( const ghost of ghosts.values() ) ghost.destroy();
  ghosts.clear();
}
