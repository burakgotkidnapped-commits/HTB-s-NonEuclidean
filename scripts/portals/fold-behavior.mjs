import {PortalLink, makePlane} from "./geometry.mjs";

const {fields} = foundry.data;
const {RegionBehaviorType} = foundry.data.regionBehaviors;

/**
 * A fold: the Region is cut out of space, and its two opposite edges are joined.
 * A hallway drawn 10 squares long with a fold over its middle 8 squares looks 10 squares long
 * from outside but takes 2 squares to walk, and looking down it shows the far end up close.
 *
 * Built from two one-way portal links: the near edge leads out past the far edge, and the far
 * edge leads out past the near edge.
 *
 * @property {"auto"|"northSouth"|"eastWest"} direction    The direction of travel that is shortened
 */
export default class FoldRegionBehaviorType extends RegionBehaviorType {

  /** @override */
  static LOCALIZATION_PREFIXES = ["NONEUCLID.Fold", "BEHAVIOR.TYPES.base"];

  /* ---------------------------------------- */

  /** @override */
  static defineSchema() {
    return {
      direction: new fields.StringField({required: true, initial: "auto", choices: {
        auto: "NONEUCLID.Crossing.auto",
        northSouth: "NONEUCLID.Crossing.northSouth",
        eastWest: "NONEUCLID.Crossing.eastWest"
      }})
    };
  }

  /* ---------------------------------------- */

  /**
   * The two links that join the Region's opposite edges.
   * @returns {PortalLink[]}
   */
  getPortalLinks() {
    const {left, right, top, bottom, width, height} = this.region.bounds;
    const eastWest = this.direction === "auto" ? width >= height : this.direction === "eastWest";

    // Edges run across the direction of travel, both pointing the same way so nothing rotates
    const near = eastWest ? makePlane({x: left, y: top}, {x: left, y: bottom})
      : makePlane({x: left, y: top}, {x: right, y: top});
    const far = eastWest ? makePlane({x: right, y: top}, {x: right, y: bottom})
      : makePlane({x: left, y: bottom}, {x: right, y: bottom});
    const outside = (plane, other) => ({x: (2 * plane.center.x) - other.center.x, y: (2 * plane.center.y) - other.center.y});

    const common = {behavior: this.behavior, entrance: this.region, exit: this.region};
    const forward = new PortalLink({...common, id: `${this.behavior.id}.forward`, from: near, to: far});
    forward.entrySide = forward.side(outside(near, far));
    const backward = new PortalLink({...common, id: `${this.behavior.id}.backward`, from: far, to: near});
    backward.entrySide = backward.side(outside(far, near));
    return [forward, backward];
  }
}
