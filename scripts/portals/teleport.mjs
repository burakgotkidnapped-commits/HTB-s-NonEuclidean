import {MODULE_ID, log} from "../constants.mjs";
import {PortalLink, getPortalFlags, isPortalOpen} from "./geometry.mjs";

/**
 * Portals whose exit is in another Scene. Path routing (see pathing.mjs) stops the Token just
 * before the portal Wall and marks the update; once it arrives, the Token is moved to the matching
 * point beyond the exit in the other Scene, and the view follows it there.
 */
export function registerTeleports() {
  Hooks.on("updateToken", (token, changed, options, userId) => {
    const teleport = options[MODULE_ID]?.teleport;
    if ( teleport && (userId === game.user.id) ) teleportThroughPortal(token, teleport);
  });
}

/* ---------------------------------------- */

/**
 * @param {TokenDocument} token
 * @param {{wall: string, point: Point, snap: boolean}} teleport    The entrance Wall, the point just past it,
 *                                                                  and whether to come out on the grid
 */
async function teleportThroughPortal(token, {wall: uuid, point, snap}) {
  const entrance = fromUuidSync(uuid, {strict: false});
  const flags = entrance && isPortalOpen(entrance) && getPortalFlags(entrance);
  const exit = flags && fromUuidSync(flags.exit, {strict: false});
  if ( !(exit instanceof foundry.documents.WallDocument) ) return;
  if ( !(game.user.can("TOKEN_CREATE") && game.user.can("TOKEN_DELETE")) ) {
    ui.notifications.warn("NONEUCLID.WallPortal.NoCrossScenePermission", {localize: true});
    return;
  }
  const link = new PortalLink({entrance, exit, flip: flags.flip});

  // Let the Token finish walking up to the portal
  if ( token.rendered && token.object.movementAnimationPromise ) {
    await game.raceWithWindowHidden(token.object.movementAnimationPromise);
  }

  // Place a copy of the Token beyond the exit, then remove the original
  const data = token.toObject();
  const width = data.width * link.scale;
  const height = data.height * link.scale;
  const pivot = token.getCenterPoint({x: 0, y: 0, elevation: 0, width, height, shape: data.shape});
  const center = link.apply(point);
  const position = snap ? snapBeyondExit(link, center, {...data, width, height}, pivot)
    : {x: center.x - pivot.x, y: center.y - pivot.y};
  const level = link.exitLevel(data.level);
  Object.assign(data, {
    x: Math.round(position.x),
    y: Math.round(position.y),
    width, height, level,
    rotation: (data.rotation + Math.toDegrees(link.angle)) % 360
  });
  delete data._id;
  delete data._movementHistory;
  const view = canvas.scene === token.parent ? {...link.apply(canvas.stage.pivot), scale: canvas.stage.scale.x / link.scale} : null;
  log("debug", `${token.name} passes through portal to ${exit.parent.name}`);
  const [created] = await exit.parent.createEmbeddedDocuments("Token", [data]);
  await token.delete();
  if ( !created || !view ) return;

  // Keep the Token where it was on screen
  await exit.parent.view({level, controlledTokens: [created.id]});
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
  const getSnappedPosition = foundry.documents.BaseToken.prototype.getSnappedPosition;
  for ( const step of [0, 0.5, 1, 1.5] ) {
    const d = step * scene.grid.size;
    const {x, y} = getSnappedPosition.call({parent: scene}, {x: center.x + (normal.x * d) - pivot.x,
      y: center.y + (normal.y * d) - pivot.y, elevation: 0, width, height, shape});
    if ( !side || (sideOf({x: x + pivot.x, y: y + pivot.y}) === side) ) return {x, y};
  }
  return {x: center.x - pivot.x, y: center.y - pivot.y};
}
