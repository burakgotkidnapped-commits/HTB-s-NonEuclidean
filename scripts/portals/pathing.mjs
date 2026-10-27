import {getPortalLinks} from "./geometry.mjs";
import {log} from "../constants.mjs";

/**
 * How far before and after the portal plane, in pixels, the Token jumps.
 * Keeping both ends off the plane means the viewer is always clearly on one side of it.
 */
const JUMP_MARGIN = 2;

/** The most portals a single movement may pass through. */
const MAX_CROSSINGS = 8;

/**
 * Rewrite Token movement so that a path through a portal becomes one continuous movement:
 * walk up to the portal plane, displace to the matching point at the exit, and carry on along
 * the rest of the path as seen through the portal. Because it is a single movement there is no
 * pause at the portal, and the jump happens on exactly one animation frame.
 */
export function registerPathing() {
  const TokenDocument = foundry.documents.TokenDocument;
  const original = TokenDocument.prototype._preUpdate;
  TokenDocument.prototype._preUpdate = async function(changed, options, user) {
    try {
      rewriteMovement(this, options);
    } catch(err) {
      log("error", "Failed to route movement through portals", err);
    }
    return original.call(this, changed, options, user);
  };
}

/* ---------------------------------------- */

/**
 * @param {TokenDocument} token
 * @param {object} options    The update options
 */
function rewriteMovement(token, options) {
  if ( options.isUndo || options.isPaste || options.planned ) return;
  const movement = options.movement?.[token.id];
  if ( !movement?.waypoints?.length || movement.planned ) return;
  const links = getPortalLinks(token.parent);
  if ( !links.length ) return;

  const pivotOf = w => token.getCenterPoint({x: 0, y: 0, elevation: 0, width: w.width, height: w.height,
    shape: w.shape});
  const centerOf = w => {
    const pivot = pivotOf(w);
    return {x: w.x + pivot.x, y: w.y + pivot.y};
  };
  const place = (w, center) => {
    const pivot = pivotOf(w);
    return {...w, x: Math.round(center.x - pivot.x), y: Math.round(center.y - pivot.y)};
  };
  const traverse = (link, w) => {
    const scaled = {...w, level: link.exitLevel(w.level)};
    if ( link.scale !== 1 ) {
      scaled.width = w.width * link.scale;
      scaled.height = w.height * link.scale;
    }
    return place(scaled, link.apply(centerOf(w)));
  };

  const {x, y, elevation, width, height, shape, level} = token._source;
  let previous = {x, y, elevation, width, height, shape, level};
  let original = previous;
  const passedThrough = [];
  const waypoints = [];
  let crossings = 0;

  for ( const raw of movement.waypoints ) {

    // Fill in missing fields the way core does, from the previous waypoint as the user drew it
    original = {...original};
    for ( const [k, v] of Object.entries(raw) ) if ( v !== undefined ) original[k] = v;

    // Carry it through the portals already passed
    let current = passedThrough.reduce((w, link) => traverse(link, w), original);

    if ( current.action !== "displace" ) {
      while ( crossings < MAX_CROSSINGS ) {
        const p0 = centerOf(previous);
        const p1 = centerOf(current);
        const length = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        if ( length < 1 ) break;

        // Find the first portal plane crossed by this segment on this Level
        let hit = null;
        for ( const link of links ) {
          if ( !link.entrance.includedInLevel(previous.level) ) continue;
          const t = link.crossing(p0, p1);
          if ( (t === null) || ((t * length) < JUMP_MARGIN) ) continue;
          if ( !hit || (t < hit.t) ) hit = {link, t};
        }
        if ( !hit ) break;

        const {link, t} = hit;
        const along = d => ({
          x: p0.x + ((p1.x - p0.x) * (t + (d / length))),
          y: p0.y + ((p1.y - p0.y) * (t + (d / length)))
        });
        const before = place({...previous, action: current.action, snapped: false, explicit: false,
          checkpoint: false}, along(-JUMP_MARGIN));
        const after = traverse(link, place({...previous}, along(JUMP_MARGIN)));
        waypoints.push(before, {...after, action: "displace", snapped: false, explicit: false, checkpoint: false});
        log("debug", `${token.name} passes through portal ${link.entrance.name} -> ${link.exit.name}`);

        passedThrough.push(link);
        current = traverse(link, current);
        previous = after;
        crossings++;
      }
    }

    waypoints.push(current);
    previous = current;
  }

  if ( !crossings ) return;
  options.movement[token.id] = {...movement, waypoints};
}
