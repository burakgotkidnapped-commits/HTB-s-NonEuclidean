/** The module ID, matching module.json and the module folder name. */
export const MODULE_ID = "noneuclid";

/**
 * Fully qualified RegionBehavior sub-type names.
 * Foundry prefixes module-provided sub-types with the module ID.
 */
export const BEHAVIOR_TYPES = Object.freeze({
  portal: `${MODULE_ID}.portal`,
  impossibleSpace: `${MODULE_ID}.impossibleSpace`
});

/** Font Awesome icons shown for each behavior type in the Region config. */
export const BEHAVIOR_ICONS = Object.freeze({
  [BEHAVIOR_TYPES.portal]: "fa-solid fa-dungeon",
  [BEHAVIOR_TYPES.impossibleSpace]: "fa-solid fa-cube"
});

/**
 * Log a message to the console, prefixed with the module ID.
 * Debug messages are only shown when the debug setting is enabled.
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {...any} args
 */
export function log(level, ...args) {
  if ( (level === "debug") && !game.settings?.get(MODULE_ID, "debug") ) return;
  console[level === "debug" ? "log" : level](`${MODULE_ID} |`, ...args);
}
