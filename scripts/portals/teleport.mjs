import {CLIENT_ID, MODULE_ID, log} from "../constants.mjs";
import {PortalLink, getPortalFlags, isPortalOpen} from "./geometry.mjs";

/**
 * Portals whose exit is in another Scene. Path routing (see pathing.mjs) stops the Token just before the
 * portal Wall and marks the update; once it arrives, a copy of the Token is placed at the matching point
 * beyond the exit. Every client controlling the Token follows it there.
 */
export function registerTeleports() {
  Hooks.on("updateToken", (token, changed, options, userId) => {
    const passage = options[MODULE_ID]?.passage;
    if ( passage && followers.delete(passage.from) ) followThroughPortal(token, passage);
    const teleport = options[MODULE_ID]?.teleport;
    if ( !teleport ) return;

    // Note now whether to follow the Token: by the time its copy appears beyond the exit, the original
    // may be gone already
    if ( (canvas.scene === token.parent) && token.object?.controlled ) followers.add(token.uuid);

    // The same user may be logged in more than once: only the client that moved the Token teleports it
    if ( (userId === game.user.id) && (teleport.client === CLIENT_ID) ) teleportThroughPortal(token, teleport);
  });
  Hooks.on("createToken", (token, options) => {
    const passage = options[MODULE_ID]?.passage;
    if ( passage && followers.delete(passage.from) ) followThroughPortal(token, passage);
  });
}

/**
 * Tokens on their way through a portal into another Scene that this client controls, by UUID.
 * @type {Set<string>}
 */
const followers = new Set();

/* ---------------------------------------- */

/**
 * Get the link of a portal, if it still leads to a Wall.
 * @param {string} uuid    The entrance Wall
 * @returns {PortalLink|null}
 */
function getLink(uuid) {
  const entrance = fromUuidSync(uuid, {strict: false});
  const flags = entrance && isPortalOpen(entrance) && getPortalFlags(entrance);
  const exit = flags && fromUuidSync(flags.exit, {strict: false});
  if ( !(exit instanceof foundry.documents.WallDocument) ) return null;
  return new PortalLink({entrance, exit, flip: flags.flip});
}

/* ---------------------------------------- */

/**
 * @param {TokenDocument} token
 * @param {{wall: string, point: Point, snap: boolean}} teleport    The entrance Wall, the point just past it,
 *                                                                  and whether to come out on the grid
 */
async function teleportThroughPortal(token, {wall: uuid, point, snap}) {
  const link = getLink(uuid);
  if ( !link?.crossScene ) return;
  if ( !(game.user.can("TOKEN_CREATE") && game.user.can("TOKEN_DELETE")) ) {
    ui.notifications.warn("NONEUCLID.WallPortal.NoCrossScenePermission", {localize: true});
    return;
  }

  // Let the Token finish walking up to the portal
  const animation = token.rendered ? token.object.movementAnimationPromise : null;
  if ( animation ) await (game.raceWithWindowHidden?.(animation) ?? animation);

  // The Token keeps its size in grid spaces, measured on the exit Scene's grid, which it isn't in yet
  const data = token.toObject();
  const {width, height} = data;
  const {getCenterPoint, getSize} = foundry.documents.TokenDocument.prototype;
  const pivot = getCenterPoint.call({parent: link.exit.parent, getSize}, {x: 0, y: 0, elevation: 0, width, height,
    shape: data.shape});
  const center = link.apply(point);
  const position = snap ? snapBeyondExit(link, center, {...data, width, height}, pivot)
    : {x: center.x - pivot.x, y: center.y - pivot.y};
  const exit = {
    x: Math.round(position.x),
    y: Math.round(position.y),
    rotation: (data.rotation + Math.toDegrees(link.angle)) % 360
  };
  const passage = {from: token.uuid, wall: uuid};

  // Place a copy of the Token beyond the exit, then remove the original
  Object.assign(data, exit);
  delete data._id;
  delete data._movementHistory;
  log("debug", `${token.name} passes through portal to ${link.exit.parent.name}`);
  await link.exit.parent.createEmbeddedDocuments("Token", [data], {[MODULE_ID]: {passage}});
  await token.delete();
}

/* ---------------------------------------- */

/**
 * Follow a Token this client controlled through a portal into another Scene. The view moves with it,
 * so it stays where it was on screen.
 * @param {TokenDocument} token                     The Token beyond the exit
 * @param {{from: string, wall: string}} passage    The Token it replaces, or itself, and the entrance Wall
 */
async function followThroughPortal(token, {wall}) {
  const link = getLink(wall);
  if ( !link || (link.exit.parent !== token.parent) || (canvas.scene !== link.entrance.parent) ) return;
  const view = {...link.apply(canvas.stage.pivot), scale: canvas.stage.scale.x / link.scale};
  try {
    if ( canvas.loading ) await new Promise(resolve => Hooks.once("canvasReady", resolve));
    await token.parent.view();
  } catch(err) {
    log("warn", `Failed to follow ${token.name} into ${token.parent.name}`, err);
    return;
  }
  if ( canvas.scene !== token.parent ) return;
  token.object?.control({releaseOthers: true});
  canvas.pan(view);
}

/* ---------------------------------------- */

/**
 * The nearest grid position beyond the exit. The point just past the exit has the Token straddling
 * the exit Wall, so step away from it until the snapped Token is clear of the Wall's line.
 * @param {PortalLink} link
 * @param {Point} center         The Token's center just past the exit
 * @param {object} dimensions    The Token's width, height, and shape at the exit
 * @param {Point} pivot          The Token's center relative to its position
 * @returns {Point}              The Token's position
 */
function snapBeyondExit(link, center, {width, height, shape}, pivot) {
  const scene = link.exit.parent;
  const {center: origin, direction} = link.to;
  const sideOf = p => Math.sign((direction.x * (p.y - origin.y)) - (direction.y * (p.x - origin.x)));
  const side = sideOf(center);
  const length = Math.hypot(direction.x, direction.y);
  const normal = {x: (-direction.y * side) / length, y: (direction.x * side) / length};

  // Snap on the exit Scene's grid, which the Token isn't in yet
  const getSnappedPosition = foundry.documents.TokenDocument.prototype.getSnappedPosition;
  for ( const step of [0, 0.5, 1, 1.5] ) {
    const d = step * scene.grid.size;
    const {x, y} = getSnappedPosition.call({parent: scene}, {x: center.x + (normal.x * d) - pivot.x,
      y: center.y + (normal.y * d) - pivot.y, elevation: 0, width, height, shape});
    if ( !side || (sideOf({x: x + pivot.x, y: y + pivot.y}) === side) ) return {x, y};
  }
  return {x: center.x - pivot.x, y: center.y - pivot.y};
}
