import {MODULE_ID} from "../constants.mjs";

/**
 * Curved space: per-Scene geometry where distance and line of sight follow a curved model.
 *
 * Planned approach:
 *  - Store the Scene's geometry and curvature in Scene flags, edited from the Scene config.
 *  - Measure paths in that geometry by wrapping the grid's `_measurePath`
 *    (hyperbolic: Poincaré disk distance; spherical: great-circle distance).
 *  - Later: bend rulers and vision polygons to match.
 *
 * For now only the data helpers exist; measurement is still Euclidean.
 */

/** The supported geometries. */
export const GEOMETRIES = Object.freeze({
  euclidean: "NONEUCLID.CurvedSpace.Geometries.euclidean",
  hyperbolic: "NONEUCLID.CurvedSpace.Geometries.hyperbolic",
  spherical: "NONEUCLID.CurvedSpace.Geometries.spherical"
});

/**
 * Get the geometry configured for a Scene.
 * @param {Scene} scene
 * @returns {{type: keyof GEOMETRIES, curvature: number}}
 */
export function getSceneGeometry(scene) {
  const data = scene?.getFlag(MODULE_ID, "geometry") ?? {};
  const type = data.type in GEOMETRIES ? data.type : "euclidean";
  return {type, curvature: Number.isFinite(data.curvature) ? data.curvature : 1};
}

/**
 * Set the geometry of a Scene.
 * @param {Scene} scene
 * @param {{type: keyof GEOMETRIES, curvature?: number}} geometry
 * @returns {Promise<Scene>}
 */
export function setSceneGeometry(scene, {type, curvature=1}) {
  if ( !(type in GEOMETRIES) ) throw new Error(`Unknown geometry "${type}"`);
  return scene.setFlag(MODULE_ID, "geometry", {type, curvature});
}

/** Called during the init hook. */
export function init() {}
