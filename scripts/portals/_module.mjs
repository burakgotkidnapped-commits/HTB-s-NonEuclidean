import {invalidatePortalLinks} from "./geometry.mjs";
import {registerPathing} from "./pathing.mjs";
import {registerTeleports} from "./teleport.mjs";
import {registerWallPortals} from "./walls.mjs";
import {followPortalJumps, resetCamera} from "./camera.mjs";
import {patchVisionSources, syncGhostVision, clearGhostVision} from "./vision.mjs";
import {patchLightSources, syncGhostLights, clearGhostLights} from "./lighting.mjs";
import PortalWindows from "./renderer.mjs";
import {registerAnnexes} from "./annex.mjs";
import {log} from "../constants.mjs";

export {PortalLink, getPortalLinks, getPortalFlags, isPortalDoor, isPortalOpen} from "./geometry.mjs";

const windows = new PortalWindows();

/** Per-frame steps that failed and were switched off, so they can't stall the canvas every frame. */
const failed = new Set();

/**
 * Run a per-frame step. An error thrown inside a ticker callback stops the rest of that frame,
 * including Foundry's own perception and rendering, so a failing step is reported once and disabled.
 * @param {string} name
 * @param {Function} step
 */
function runStep(name, step) {
  if ( failed.has(name) ) return;
  try {
    step();
  } catch(err) {
    failed.add(name);
    log("error", `Portal step "${name}" failed and was turned off until the canvas is redrawn`, err);
    ui.notifications.error(`Non-Euclidean: portal ${name} failed and was turned off. See the console (F12) for details.`);
    if ( name === "vision" ) clearGhostVision();
    if ( name === "lights" ) clearGhostLights();
    if ( name === "windows" ) windows.tearDown();
  }
}

/**
 * Before perception updates: move the camera with Tokens that jumped through a portal, and carry
 * lights through portals, so this frame's lighting and vision take them in.
 */
function beforePerception() {
  runStep("camera", followPortalJumps);
  runStep("lights", syncGhostLights);
}

/**
 * After animations and perception, just before the frame is rendered: find what each viewer sees
 * through portals, line up ghost vision with it, and capture the portal windows.
 */
function beforeRender() {
  runStep("vision", syncGhostVision);
  runStep("windows", () => windows.render());
}

/** Called during the init hook. */
export function init() {
  registerPathing();
  registerTeleports();
  registerWallPortals();
  registerAnnexes();

  Hooks.once("setup", () => {
    patchVisionSources();
    patchLightSources();
  });
  Hooks.on("canvasReady", () => {
    const p = PIXI.UPDATE_PRIORITY;
    failed.clear();
    windows.draw();
    canvas.app.ticker.add(beforePerception, undefined, p.PERCEPTION + 0.5);
    canvas.app.ticker.add(beforeRender, undefined, p.LOW + 0.5);
  });

  Hooks.on("canvasTearDown", () => {
    canvas.app.ticker.remove(beforePerception);
    canvas.app.ticker.remove(beforeRender);
    windows.tearDown();
    clearGhostVision();
    clearGhostLights();
    resetCamera();
    invalidatePortalLinks();
  });

  // Rebuild links, vision, and lighting whenever Walls change: a portal, or the exit of one, may have
  // moved. Exits can be in other Scenes, so changes anywhere count.
  const onChange = () => {
    invalidatePortalLinks();
    if ( canvas.ready ) canvas.perception.update({initializeVision: true, initializeLighting: true});
  };
  for ( const action of ["create", "update", "delete"] ) Hooks.on(`${action}Wall`, onChange);
}
