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

  game.settings.register(MODULE_ID, "portalDepth", {
    name: "NONEUCLID.Settings.portalDepth.name",
    hint: "NONEUCLID.Settings.portalDepth.hint",
    scope: "client",
    config: true,
    type: new foundry.data.fields.NumberField({required: true, nullable: false, integer: true, min: 1, max: 8,
      step: 1, initial: 4})
  });
}
