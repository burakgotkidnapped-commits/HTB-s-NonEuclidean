/**
 * @typedef PortalEye
 * A point the current user looks from.
 * @property {string} id                 A stable ID for the viewer
 * @property {number} x
 * @property {number} y
 * @property {number} [elevation]
 * @property {PIXI.Polygon|null} los     What the viewer can see past walls, or null if unlimited
 * @property {PointVisionSource} [source]  The vision source, if the viewer is one
 */

/**
 * The points the current user looks from: their vision sources, or their controlled Tokens
 * when Token vision is off. Without any, portals show nothing and the real map is visible.
 * @returns {PortalEye[]}
 */
export function getEyes() {
  if ( canvas.visibility.tokenVision ) {
    return canvas.effects.visionSources
      .filter(s => !s.isPortalGhost && s.active && !s.data.preview)
      .map(source => ({id: source.sourceId, x: source.data.x, y: source.data.y, elevation: source.data.elevation,
        los: source.los, source}));
  }
  return canvas.tokens.controlled.map(token => {
    const {x, y} = token.center;
    const elevation = token.document.elevation;
    return {id: token.sourceId, x, y, elevation, los: computeSight({x, y, elevation})};
  });
}

/**
 * The line of sight from a point, blocked by walls only.
 * @param {ElevatedPoint} origin
 * @returns {PIXI.Polygon|null}
 */
function computeSight(origin) {
  try {
    return CONFIG.Canvas.polygonBackends.sight.create(origin, {type: "sight", level: canvas.level});
  } catch(err) {
    return null;
  }
}
