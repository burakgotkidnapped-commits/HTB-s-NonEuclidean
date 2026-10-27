import {invalidatePortalLinks} from "./geometry.mjs";
import {registerPathing} from "./pathing.mjs";
import {followPortalJumps, resetCamera} from "./camera.mjs";
import {patchVisionSources, syncGhostVision, clearGhostVision} from "./vision.mjs";
import PortalWindows from "./renderer.mjs";

export {default as PortalRegionBehaviorType} from "./portal-behavior.mjs";
export {default as FoldRegionBehaviorType} from "./fold-behavior.mjs";
export {PortalLink, getPortalLinks} from "./geometry.mjs";

const windows = new PortalWindows();

/**
 * Before perception updates: move the camera with Tokens that jumped through a portal,
 * then line up ghost vision with the Tokens' real vision.
 */
function beforePerception() {
  followPortalJumps();
  syncGhostVision();
}

/** After animations, just before the frame is rendered: capture the portal windows. */
function beforeRender() {
  windows.render();
}

/** Called during the init hook. */
export function init() {
  registerPathing();

  Hooks.once("setup", patchVisionSources);

  Hooks.on("canvasReady", () => {
    const p = PIXI.UPDATE_PRIORITY;
    windows.draw();
    canvas.app.ticker.add(beforePerception, undefined, p.PERCEPTION + 0.5);
    canvas.app.ticker.add(beforeRender, undefined, p.LOW + 0.5);
  });

  Hooks.on("canvasTearDown", () => {
    canvas.app.ticker.remove(beforePerception);
    canvas.app.ticker.remove(beforeRender);
    windows.tearDown();
    clearGhostVision();
    resetCamera();
    invalidatePortalLinks();
  });

  // Rebuild links and vision whenever portals or their Regions change
  const onChange = document => {
    const scene = document instanceof foundry.documents.RegionBehavior ? document.parent?.parent : document.parent;
    if ( scene !== canvas.scene ) return;
    invalidatePortalLinks();
    if ( canvas.ready ) canvas.perception.update({initializeVision: true});
  };
  for ( const name of ["Region", "RegionBehavior"] ) {
    for ( const action of ["create", "update", "delete"] ) Hooks.on(`${action}${name}`, onChange);
  }
}
