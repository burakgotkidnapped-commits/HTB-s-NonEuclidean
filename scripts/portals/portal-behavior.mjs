import {BEHAVIOR_TYPES, log} from "../constants.mjs";

const {fields} = foundry.data;
const {RegionBehaviorType} = foundry.data.regionBehaviors;
const {REGION_EVENTS} = CONST;

/**
 * A portal. The Region acts as a doorway whose far side is the space beyond its exit Region.
 *
 * Each Region's "plane" is the line through its center along its longer side. Walking across
 * the plane continues the walk out of the exit's plane, and looking through the portal shows the
 * space beyond the exit. Draw portal Regions as thin strips across doorways, with walls on
 * either side, so the portal is the only way to see or walk past that line.
 *
 * Within one Scene, movement is routed through the portal before it starts (see pathing.mjs),
 * so it never stops at the portal. An exit in another Scene teleports the Token on entry.
 *
 * @property {string|null} exit    UUID of the exit Region
 * @property {boolean} flip        Come out of the exit facing the opposite way
 * @property {boolean} twoWay      Keep a matching portal on the exit that leads back here
 */
export default class PortalRegionBehaviorType extends RegionBehaviorType {

  /** @override */
  static LOCALIZATION_PREFIXES = ["NONEUCLID.Portal", "BEHAVIOR.TYPES.base"];

  /* ---------------------------------------- */

  /** @override */
  static defineSchema() {
    return {
      exit: new fields.DocumentUUIDField({type: "Region", relative: true, relativize: true}),
      flip: new fields.BooleanField(),
      twoWay: new fields.BooleanField({initial: true})
    };
  }

  /* ---------------------------------------- */

  /** @inheritDoc */
  prepareBaseData() {
    super.prepareBaseData();

    // Only exits in other Scenes need the Region event; same-Scene portals never interrupt movement
    this.events = new Set();
    if ( this.exit && !this.exit.startsWith(".") ) this.events.add(REGION_EVENTS.TOKEN_MOVE_IN);
  }

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

  /* ---------------------------------------- */

  /**
   * Teleport a Token that enters a portal whose exit is in another Scene.
   * @param {RegionEvent} event
   * @override
   */
  async _handleRegionEvent(event) {
    if ( event.name !== REGION_EVENTS.TOKEN_MOVE_IN ) return;
    const {token, movement} = event.data;
    if ( !event.user.isSelf ) return;
    if ( movement.passed.waypoints.at(-1).action === "displace" ) return;

    const exit = this.getExit();
    if ( !exit || (exit.parent === token.parent) ) return;
    if ( !(game.user.can("TOKEN_CREATE") && game.user.can("TOKEN_DELETE")) ) {
      ui.notifications.warn("NONEUCLID.Portal.NoCrossScenePermission", {localize: true});
      return;
    }

    token.stopMovement();
    if ( token.rendered && token.object.movementAnimationPromise ) {
      await game.raceWithWindowHidden(token.object.movementAnimationPromise);
    }
    if ( !token.regions.has(this.region) ) return;

    const center = token.getCenterPoint(movement.destination);
    const bounds = this.region.bounds;
    const offset = {x: (center.x - bounds.left) / bounds.width, y: (center.y - bounds.top) / bounds.height};
    const exitToken = await exit.teleportToken(token, {placement: "relative", offset, snap: false,
      pan: {duration: 0, force: true}});
    await exit.parent.view({level: exitToken._source.level, controlledTokens: [exitToken.id]});
  }

  /* ---------------------------------------- */

  /** @inheritDoc */
  _onCreate(data, options, userId) {
    super._onCreate(data, options, userId);
    if ( userId === game.user.id ) this.#ensureReturnPortal();
  }

  /* ---------------------------------------- */

  /** @inheritDoc */
  _onUpdate(changed, options, userId) {
    super._onUpdate(changed, options, userId);
    if ( (userId === game.user.id) && ("system" in changed) ) this.#ensureReturnPortal();
  }

  /* ---------------------------------------- */

  /** Give the exit Region a portal back to this one, if two-way and it has none. */
  async #ensureReturnPortal() {
    if ( !this.twoWay ) return;
    const exit = this.getExit();
    if ( !exit || (exit === this.region) ) return;
    const hasReturn = exit.behaviors.some(b => (b.type === BEHAVIOR_TYPES.portal) && (b.system.getExit() === this.region));
    if ( hasReturn ) return;
    await exit.createEmbeddedDocuments("RegionBehavior", [{
      type: BEHAVIOR_TYPES.portal,
      name: this.behavior.name,
      system: {exit: this.region.uuid, flip: this.flip, twoWay: true}
    }]);
  }
}
