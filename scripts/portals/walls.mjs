import {MODULE_ID} from "../constants.mjs";
import {getPortalFlags, isPortalDoor} from "./geometry.mjs";

/**
 * Portal Walls: the Portal section of the Wall config, the pick-on-canvas tool for choosing an
 * exit, and keeping portal Walls see-through, walk-through, and linked both ways.
 */
export function registerWallPortals() {
  Hooks.on("renderWallConfig", injectPortalSection);
  Hooks.on("preCreateWall", (wall, data) => {
    const changes = {};
    preparePortalChanges(wall, data, changes);
    if ( !foundry.utils.isEmpty(changes) ) wall.updateSource(changes);
  });
  Hooks.on("preUpdateWall", (wall, changes) => preparePortalChanges(wall, changes, changes));
  Hooks.on("createWall", (wall, options, userId) => {
    if ( userId === game.user.id ) linkBack(wall);
  });
  Hooks.on("updateWall", (wall, changed, options, userId) => {
    if ( (userId === game.user.id) && (foundry.utils.hasProperty(changed, `flags.${MODULE_ID}.portal`)
      || ("door" in changed)) ) linkBack(wall);
    if ( "ds" in changed ) syncDoorState(wall, userId);
  });
}

/* ---------------------------------------- */

/**
 * Clean up portal settings in Wall data, and make portal Walls block nothing: what lies beyond a
 * portal is handled by the module, so sight and movement must pass the Wall itself. Portal windows
 * block movement, since nothing walks through them. Portal doors are the exception: closed, they
 * block like any door, and open, Foundry lets everything through.
 * @param {WallDocument} wall    The Wall being created or updated, as it was before
 * @param {object} data          The Wall data or changes to read
 * @param {object} changes       The changes to write to
 */
function preparePortalChanges(wall, data, changes) {
  const path = `flags.${MODULE_ID}.portal.exit`;
  const windowPath = `flags.${MODULE_ID}.portal.window`;
  const setsExit = foundry.utils.hasProperty(data, path);
  const setsWindow = foundry.utils.hasProperty(data, windowPath);
  if ( !setsExit && !setsWindow && !("door" in data) ) return;
  let exit = wall._source.flags[MODULE_ID]?.portal?.exit;
  if ( setsExit ) {
    exit = foundry.utils.getProperty(data, path)?.trim() || null;
    foundry.utils.setProperty(changes, path, exit);
  }
  if ( !exit ) return;
  const isWindow = setsWindow ? !!foundry.utils.getProperty(data, windowPath)
    : !!wall._source.flags[MODULE_ID]?.portal?.window;

  const types = {move: CONST.WALL_MOVEMENT_TYPES, sight: CONST.WALL_SENSE_TYPES,
    light: CONST.WALL_SENSE_TYPES, sound: CONST.WALL_SENSE_TYPES};
  if ( (data.door ?? wall._source.door) === CONST.WALL_DOOR_TYPES.NONE ) {
    for ( const [key, type] of Object.entries(types) ) {
      changes[key] = ((key === "move") && isWindow) ? type.NORMAL : type.NONE;
    }
    return;
  }

  // A portal becoming a door had everything set to pass through it, so make it block while closed
  if ( wall._source.door !== CONST.WALL_DOOR_TYPES.NONE ) return;
  for ( const [key, type] of Object.entries(types) ) {
    if ( (data[key] ?? wall._source[key]) === type.NONE ) changes[key] = type.NORMAL;
  }
}

/* ---------------------------------------- */

/**
 * Point a two-way portal's exit Wall back at it, and make it the same kind of door.
 * @param {WallDocument} wall
 */
async function linkBack(wall) {
  const flags = getPortalFlags(wall);
  if ( !flags?.twoWay ) return;
  const exit = fromUuidSync(flags.exit, {strict: false});
  if ( !(exit instanceof foundry.documents.WallDocument) || (exit === wall) ) return;
  const changes = {};
  const back = getPortalFlags(exit);
  if ( (back?.exit !== wall.uuid) || (back.window !== flags.window) ) {
    changes.flags = {[MODULE_ID]: {portal: {exit: wall.uuid, flip: flags.flip, twoWay: true, window: flags.window}}};
  }
  if ( exit.door !== wall.door ) Object.assign(changes, {door: wall.door, ds: wall.ds});
  if ( foundry.utils.isEmpty(changes) || !exit.canUserModify(game.user, "update") ) return;
  await exit.update(changes);
}

/* ---------------------------------------- */

/**
 * Open, close, or lock the other end of a two-way portal door along with this one: they are the
 * same door, seen from two places. The active GM does it, since players may not update Walls.
 * @param {WallDocument} wall
 * @param {string} userId    The user who changed the door
 */
async function syncDoorState(wall, userId) {
  const responsible = game.users.activeGM ?? game.users.get(userId);
  if ( !responsible?.isSelf || !isPortalDoor(wall) || !getPortalFlags(wall).twoWay ) return;
  const exit = fromUuidSync(getPortalFlags(wall).exit, {strict: false});
  if ( !(exit instanceof foundry.documents.WallDocument) || (exit === wall) ) return;
  if ( !isPortalDoor(exit) || (getPortalFlags(exit).exit !== wall.uuid) || (exit.ds === wall.ds) ) return;
  if ( !exit.canUserModify(game.user, "update", {ds: wall.ds}) ) return;
  await exit.update({ds: wall.ds});
}

/* ---------------------------------------- */

/**
 * Add the Portal section to the Wall config, after the restrictions.
 * @param {WallConfig} app
 * @param {HTMLElement} element
 */
function injectPortalSection(app, element) {
  const form = element.querySelector(".standard-form.scrollable") ?? element.querySelector(".standard-form");
  if ( !form || form.querySelector(".noneuclid-portal") ) return;
  const flags = app.document.flags[MODULE_ID]?.portal ?? {};
  const name = key => `flags.${MODULE_ID}.portal.${key}`;
  const id = key => `${app.id}-noneuclid-${key}`;

  const fieldset = document.createElement("fieldset");
  fieldset.className = "noneuclid-portal";
  fieldset.innerHTML = `
    <legend>${_loc("NONEUCLID.WallPortal.Legend")}</legend>
    <p class="hint">${_loc("NONEUCLID.WallPortal.Hint")}</p>
    <div class="form-group">
      <label for="${id("exit")}">${_loc("NONEUCLID.WallPortal.Exit")}</label>
      <div class="form-fields">
        <input type="text" id="${id("exit")}" name="${name("exit")}" placeholder="${_loc("NONEUCLID.WallPortal.NoExit")}">
        <button type="button" class="icon fa-solid fa-crosshairs" data-noneuclid-pick
          data-tooltip aria-label="${_loc("NONEUCLID.WallPortal.Pick")}"></button>
      </div>
      <p class="hint">${_loc("NONEUCLID.WallPortal.ExitHint")}</p>
    </div>
    <div class="form-group">
      <label for="${id("flip")}">${_loc("NONEUCLID.WallPortal.Flip")}</label>
      <div class="form-fields"><input type="checkbox" id="${id("flip")}" name="${name("flip")}"></div>
      <p class="hint">${_loc("NONEUCLID.WallPortal.FlipHint")}</p>
    </div>
    <div class="form-group">
      <label for="${id("twoWay")}">${_loc("NONEUCLID.WallPortal.TwoWay")}</label>
      <div class="form-fields"><input type="checkbox" id="${id("twoWay")}" name="${name("twoWay")}"></div>
      <p class="hint">${_loc("NONEUCLID.WallPortal.TwoWayHint")}</p>
    </div>
    <div class="form-group">
      <label for="${id("window")}">${_loc("NONEUCLID.WallPortal.Window")}</label>
      <div class="form-fields"><input type="checkbox" id="${id("window")}" name="${name("window")}"></div>
      <p class="hint">${_loc("NONEUCLID.WallPortal.WindowHint")}</p>
    </div>`;

  // Set values through the DOM so nothing user-provided is parsed as HTML
  const exitInput = fieldset.querySelector(`[name="${name("exit")}"]`);
  exitInput.value = flags.exit ?? "";
  fieldset.querySelector(`[name="${name("flip")}"]`).checked = !!flags.flip;
  fieldset.querySelector(`[name="${name("twoWay")}"]`).checked = flags.twoWay ?? true;
  fieldset.querySelector(`[name="${name("window")}"]`).checked = !!flags.window;
  fieldset.querySelector("[data-noneuclid-pick]").addEventListener("click", () => pickExitWall(app, exitInput));

  const restrictions = form.querySelector("fieldset");
  if ( restrictions ) restrictions.after(fieldset);
  else form.append(fieldset);
  app.setPosition();
}

/* ---------------------------------------- */

/**
 * Let the user click the exit Wall on the canvas. Escape or right-click cancels.
 * @param {WallConfig} app
 * @param {HTMLInputElement} input    The exit field to fill in
 */
function pickExitWall(app, input) {
  if ( !canvas.ready ) return;
  const view = canvas.app.view;
  app.minimize();
  ui.notifications.info("NONEUCLID.WallPortal.PickPrompt", {localize: true});

  const finish = wall => {
    view.removeEventListener("pointerdown", onPointerDown, {capture: true});
    window.removeEventListener("keydown", onKeyDown, {capture: true});
    if ( wall ) {
      input.value = wall.document.uuid;
      input.dispatchEvent(new Event("change", {bubbles: true}));
    }
    app.maximize();
  };

  // Intercept the click before the Walls layer starts drawing a new Wall
  const onPointerDown = event => {
    event.stopImmediatePropagation();
    event.preventDefault();
    if ( event.button !== 0 ) return finish(null);
    const point = canvas.canvasCoordinatesFromClient({x: event.clientX, y: event.clientY});
    const wall = findWallAt(point, app.document);
    if ( wall ) finish(wall);
    else ui.notifications.warn("NONEUCLID.WallPortal.PickMissed", {localize: true});
  };
  const onKeyDown = event => {
    if ( event.key !== "Escape" ) return;
    event.stopImmediatePropagation();
    finish(null);
  };
  view.addEventListener("pointerdown", onPointerDown, {capture: true});
  window.addEventListener("keydown", onKeyDown, {capture: true});
}

/* ---------------------------------------- */

/**
 * The Wall closest to a point, within a few screen pixels.
 * @param {Point} point
 * @param {WallDocument} exclude    The Wall being configured
 * @returns {Wall|null}
 */
function findWallAt(point, exclude) {
  const tolerance = 12 / canvas.stage.scale.x;
  let best = null;
  let bestDistance = tolerance;
  for ( const wall of canvas.walls.placeables ) {
    if ( wall.document === exclude ) continue;
    const [x0, y0, x1, y1] = wall.document.c;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const t = Math.clamp((((point.x - x0) * dx) + ((point.y - y0) * dy)) / ((dx * dx) + (dy * dy) || 1), 0, 1);
    const d = Math.hypot(point.x - (x0 + (t * dx)), point.y - (y0 + (t * dy)));
    if ( d <= bestDistance ) {
      best = wall;
      bestDistance = d;
    }
  }
  return best;
}
