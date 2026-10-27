import {MODULE_ID, log} from "../constants.mjs";
import {PortalLink, getPortalFlags} from "./geometry.mjs";

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
 * @param {{wall: string, point: Point}} teleport    The entrance Wall and the point just past it
 */
async function teleportThroughPortal(token, {wall: uuid, point}) {
  const entrance = fromUuidSync(uuid, {strict: false});
  const flags = entrance && getPortalFlags(entrance);
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
  const level = link.exitLevel(data.level);
  Object.assign(data, {
    x: Math.round(center.x - pivot.x),
    y: Math.round(center.y - pivot.y),
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
