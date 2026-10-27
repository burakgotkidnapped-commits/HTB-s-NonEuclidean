import {getViewedPortalLinks} from "./geometry.mjs";
import {getPortalViews} from "./vision.mjs";
import {log} from "../constants.mjs";

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

    const followed = links.find(link => {
      const expected = link.apply(previous);
      return Math.hypot(center.x - expected.x, center.y - expected.y) <= tolerance;
    });
    const panning = foundry.canvas.animation.CanvasAnimation.getAnimation("canvas.animatePan");
    log("debug", `${token.name} jumped from (${Math.round(previous.x)}, ${Math.round(previous.y)}) to `
      + `(${Math.round(center.x)}, ${Math.round(center.y)})`, followed ? `through portal ${followed.id}` : "not through a portal",
      panning ? "while the camera was panning" : "");
    if ( !followed ) continue;

    // Move the view by exactly the portal's transform, so the scene stays put on screen. The Token's
    // own step this frame, and its hop across the portal, show as ordinary movement
    const pivot = followed.apply(canvas.stage.pivot);
    carryPanThrough(followed);
    canvas.pan({x: pivot.x, y: pivot.y, scale: canvas.stage.scale.x / followed.scale});
    panned = true;
  }

  for ( const id of previousCenters.keys() ) if ( !seen.has(id) ) previousCenters.delete(id);
}

/**
 * Move a camera pan that is under way through a portal along with the view. Core pans set the view
 * on every frame, later in the frame than the camera follows a Token, so left alone a pan started
 * before the Token crossed, such as scrolling at the screen's edge, would drag the view back.
 * A portal maps straight lines to straight lines, so mapping where the pan starts and ends keeps
 * it on the same course, seen through the portal.
 * @param {PortalLink} link
 */
function carryPanThrough(link) {
  const animation = foundry.canvas.animation.CanvasAnimation.getAnimation("canvas.animatePan");
  if ( !animation ) return;
  const attributes = Object.fromEntries(animation.attributes.map(a => [a.attribute, a]));
  const {x, y, scale} = attributes;
  if ( !x || !y ) return;
  for ( const end of ["from", "to"] ) {
    const p = link.apply({x: x[end], y: y[end]});
    x[end] = p.x;
    y[end] = p.y;
    if ( scale ) scale[end] /= link.scale;
  }
  for ( const a of [x, y, scale] ) if ( a ) a.delta = a.to - a.from;
}

/**
 * Is a point off screen, but shown on screen through a portal? Core pans to a moving Token whose
 * destination is off screen. After walking around a loop, though, the Token is often seen through
 * a portal rather than where it really is, and that pan would sweep the view across the map.
 * @param {Point} point
 * @returns {boolean}
 */
export function isOnlySeenThroughPortals(point) {
  if ( !canvas.ready ) return false;

  // The same screen rectangle core keeps Tokens inside
  const pad = 50;
  const sidebarPad = (document.getElementById("sidebar")?.clientWidth ?? 0) + pad;
  const rect = new PIXI.Rectangle(pad, pad, window.innerWidth - sidebarPad, window.innerHeight - pad);
  const onScreen = p => {
    const {x, y} = canvas.stage.transform.worldTransform.apply(p);
    return rect.contains(x, y);
  };
  if ( onScreen(point) ) return false;
  return getPortalViews().some(view => {
    const seen = view.transform.invert().apply(point);
    return onScreen(seen) && view.masks.some(mask => mask.contains(seen.x, seen.y));
  });
}

/** Forget tracked positions, when the canvas is torn down. */
export function resetCamera() {
  previousCenters.clear();
}
