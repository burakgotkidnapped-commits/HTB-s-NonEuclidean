import {getViewedPortalLinks} from "./geometry.mjs";

/** The rendered center of each controlled Token on the previous frame. */
const previousCenters = new Map();

/**
 * Keep the camera locked to Tokens that pass through a portal.
 * Called once per frame, after Token animation and before rendering. When a controlled Token's
 * rendered position jumps from a portal to the matching point at its exit, the view is moved by
 * the same transform on the same frame, so the Token stays put on screen.
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
      const driftX = center.x - expected.x;
      const driftY = center.y - expected.y;
      if ( Math.hypot(driftX, driftY) > tolerance ) continue;
      const pivot = link.apply(canvas.stage.pivot);
      canvas.pan({x: pivot.x + driftX, y: pivot.y + driftY, scale: canvas.stage.scale.x / link.scale});
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
