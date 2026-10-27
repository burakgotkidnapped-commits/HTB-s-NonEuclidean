import {MODULE_ID} from "./constants.mjs";

/** Register the module's settings. Called during the init hook. */
export function registerSettings() {
  game.settings.register(MODULE_ID, "debug", {
    name: "NONEUCLID.Settings.debug.name",
    hint: "NONEUCLID.Settings.debug.hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
}
