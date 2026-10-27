import {getViewedPortalLinks} from "./geometry.mjs";

/** The rendered center of each controlled Token on the previous frame. */
const previousCenters = new Map();

/**
 * Keep the camera locked to Tokens that pass through a portal.
 * Called once per frame, after Token animation and before rendering. When a controlled Token's
 * rendered position jumps from a portal to the matching point at its exit, the view is moved by
 * the same transform on the same frame, so nothing on screen changes.
 */
export function followPortalJumps() {
  const links = getViewedPortalLinks();
  const tolerance = canvas.grid.size / 2;
  const seen = new Set();
  let panned = false;

  for ( const token of canvas.tokens.controlled ) {
    seen.add(token.id);
    const center = token.center;
    const previous = previousCenters.get(token.id);
    previousCenters.set(token.id, center);
    if ( !previous || panned || !links.length ) continue;
    if ( Math.hypot(center.x - previous.x, center.y - previous.y) < tolerance ) continue;

    for ( const link of links ) {
      const expected = link.apply(previous);
      if ( Math.hypot(center.x - expected.x, center.y - expected.y) > tolerance ) continue;

      // Move the view by exactly the portal's transform, so the scene stays put on screen. The Token's
      // own step this frame, and its hop across the portal, show as ordinary movement
      const pivot = link.apply(canvas.stage.pivot);
      canvas.pan({x: pivot.x, y: pivot.y, scale: canvas.stage.scale.x / link.scale});
      panned = true;
      break;
    }
  }

  for ( const id of previousCenters.keys() ) if ( !seen.has(id) ) previousCenters.delete(id);
}

/** Forget tracked positions, when the canvas is torn down. */
export function resetCamera() {
  previousCenters.clear();
}
