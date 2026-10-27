import {MODULE_ID, BEHAVIOR_TYPES, BEHAVIOR_ICONS, log} from "./constants.mjs";
import {registerSettings} from "./settings.mjs";
import * as portals from "./portals/_module.mjs";
import ImpossibleSpaceRegionBehaviorType from "./impossible-spaces/impossible-space-behavior.mjs";
import * as curvedSpace from "./curved-space/geometry.mjs";

Hooks.once("init", () => {
  log("info", "Initializing");
  registerSettings();

  // Region behaviors
  Object.assign(CONFIG.RegionBehavior.dataModels, {
    [BEHAVIOR_TYPES.portal]: portals.PortalRegionBehaviorType,
    [BEHAVIOR_TYPES.fold]: portals.FoldRegionBehaviorType,
    [BEHAVIOR_TYPES.impossibleSpace]: ImpossibleSpaceRegionBehaviorType
  });
  Object.assign(CONFIG.RegionBehavior.typeIcons, BEHAVIOR_ICONS);

  portals.init();
  curvedSpace.init();

  // Public API
  game.modules.get(MODULE_ID).api = {
    BEHAVIOR_TYPES,
    portals,
    ImpossibleSpaceRegionBehaviorType,
    curvedSpace
  };
});

Hooks.once("ready", () => log("info", "Ready"));
