const {fields} = foundry.data;
const {RegionBehaviorType} = foundry.data.regionBehaviors;
const {REGION_EVENTS} = CONST;

/**
 * An impossible space: a Region that is bigger (or smaller) on the inside.
 * Movement through the Region costs `scale` times its drawn distance, so a 2-square
 * corridor with a scale of 5 takes as long to cross as a 10-square one.
 *
 * @property {number} scale    How many times longer distances are inside the Region
 */
export default class ImpossibleSpaceRegionBehaviorType extends RegionBehaviorType {

  /** @override */
  static LOCALIZATION_PREFIXES = ["NONEUCLID.ImpossibleSpace", "BEHAVIOR.TYPES.base"];

  /* ---------------------------------------- */

  /** @override */
  static defineSchema() {
    return {
      scale: new fields.NumberField({required: true, nullable: false, initial: 2, min: 0.1, max: 20, step: 0.1})
    };
  }

  /* ---------------------------------------- */

  /**
   * Recalculate planned movement paths when this behavior's influence changes.
   * @this {ImpossibleSpaceRegionBehaviorType}
   */
  static async #recalculatePaths() {
    if ( this.behavior.viewed ) canvas.tokens.recalculatePlannedMovementPaths();
  }

  /* ---------------------------------------- */

  /** @override */
  static events = {
    [REGION_EVENTS.BEHAVIOR_VIEWED]: () => canvas.tokens.recalculatePlannedMovementPaths(),
    [REGION_EVENTS.BEHAVIOR_UNVIEWED]: () => canvas.tokens.recalculatePlannedMovementPaths(),
    [REGION_EVENTS.REGION_BOUNDARY]: this.#recalculatePaths
  };

  /* ---------------------------------------- */

  /** @inheritDoc */
  _onUpdate(changed, options, userId) {
    super._onUpdate(changed, options, userId);
    if ( ("system" in changed) && this.behavior.viewed ) canvas.tokens.recalculatePlannedMovementPaths();
  }

  /* ---------------------------------------- */

  /** @override */
  _getTerrainEffects(token, segment, options) {
    if ( this.scale === 1 ) return [];
    return [{name: "difficulty", difficulty: this.scale}];
  }
}
