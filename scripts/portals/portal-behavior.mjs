import {log} from "../constants.mjs";

const {fields} = foundry.data;
const {RegionBehaviorType} = foundry.data.regionBehaviors;
const {REGION_EVENTS} = CONST;

/**
 * A seamless portal. A Token that walks into this Region comes out of the linked Region,
 * keeping its relative position across the portal and optionally turning by a set angle.
 *
 * Unlike the core Teleport Token behavior there is no dialog and no randomness: a portal
 * links exactly one exit, so a pair of portal Regions pointing at each other forms a doorway.
 *
 * @property {string|null} exit          UUID of the exit Region
 * @property {boolean} preserveOffset    Keep the Token's relative position across the portal?
 * @property {number} rotation           Degrees to rotate the Token by when it exits
 * @property {boolean} snap              Snap the Token to the grid at the exit?
 */
export default class PortalRegionBehaviorType extends RegionBehaviorType {

  /** @override */
  static LOCALIZATION_PREFIXES = ["NONEUCLID.Portal", "BEHAVIOR.TYPES.base"];

  /* ---------------------------------------- */

  /** @override */
  static defineSchema() {
    return {
      exit: new fields.DocumentUUIDField({type: "Region", relative: true, relativize: true}),
      preserveOffset: new fields.BooleanField({initial: true}),
      rotation: new fields.NumberField({required: true, nullable: false, initial: 0, min: -180, max: 180, step: 15}),
      snap: new fields.BooleanField({initial: true})
    };
  }

  /* ---------------------------------------- */

  /**
   * Send a Token through the portal when it moves into the Region.
   * @param {RegionTokenMoveInEvent} event
   * @this {PortalRegionBehaviorType}
   */
  static async #onTokenMoveIn(event) {
    const {token, movement} = event.data;

    // Only the user who moved the Token handles it
    if ( !event.user.isSelf ) return;

    // Arriving through a portal is a displacement; ignoring it stops the exit portal from firing straight back
    if ( movement.passed.waypoints.at(-1).action === "displace" ) return;

    const exit = this.getExit();
    if ( !exit ) return;
    if ( (exit.parent !== token.parent) && !(game.user.can("TOKEN_CREATE") && game.user.can("TOKEN_DELETE")) ) {
      ui.notifications.warn("NONEUCLID.Portal.NoCrossScenePermission", {localize: true});
      return;
    }

    token.stopMovement();
    if ( token.rendered && token.object.movementAnimationPromise ) {
      await game.raceWithWindowHidden(token.object.movementAnimationPromise);
    }
    if ( !token.regions.has(this.region) ) return;

    // Relative position of the Token's center inside this portal, carried over to the exit
    const center = token.getCenterPoint(movement.destination);
    const bounds = this.region.bounds;
    const offset = {x: (center.x - bounds.left) / bounds.width, y: (center.y - bounds.top) / bounds.height};

    const updateData = {};
    if ( this.rotation ) updateData.rotation = (token.rotation + this.rotation) % 360;

    log("debug", `${token.name} enters portal ${this.region.name} -> ${exit.name}`);
    const exitToken = await exit.teleportToken(token, {
      placement: this.preserveOffset ? "relative" : "center",
      offset,
      snap: this.snap,
      updateData,
      pan: {duration: 0, force: true}
    });

    // Follow the Token into another Scene or Level
    if ( (exitToken.parent !== token.parent) || (exitToken._source.level !== token._source.level) ) {
      await exit.parent.view({level: exitToken._source.level, controlledTokens: [exitToken.id]});
    }
  }

  /* ---------------------------------------- */

  /** @override */
  static events = {
    [REGION_EVENTS.TOKEN_MOVE_IN]: this.#onTokenMoveIn
  };

  /* ---------------------------------------- */

  /**
   * Resolve the exit Region of this portal.
   * @returns {RegionDocument|null}
   */
  getExit() {
    if ( !this.exit ) return null;
    const exit = fromUuidSync(this.exit, {relative: this.parent});
    if ( exit instanceof foundry.documents.RegionDocument ) return exit;
    log("warn", `Portal ${this.region?.name} has a missing exit ${this.exit}`);
    return null;
  }
}
