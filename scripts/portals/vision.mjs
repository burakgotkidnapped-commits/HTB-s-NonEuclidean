import {getPortalLinks, getViewedPortalLinks, planeSide, seamOverlap, Similarity} from "./geometry.mjs";
import {getEyes} from "./eyes.mjs";
import {MODULE_ID, log} from "../constants.mjs";

/**
 * Seeing through portals.
 *
 * - A Token's own sight stops at a portal plane: the real space behind the portal is cut out
 *   of its vision polygon, so it is neither revealed nor explored.
 * - In its place the Token gets a "ghost" vision source at the matching point beyond the exit,
 *   limited to the wedge it can see through the portal. Ghosts only count while that portal's
 *   window is being drawn, so the space beyond the exit shows inside the portal and nowhere else.
 * - Ghost sight stops at portals in turn, and portals a ghost sees get ghosts of their own, a few
 *   levels deep, so a room that leads back into itself shows repeating copies of itself.
 */

/** @type {Map<string, PointVisionSource>} */
const ghosts = new Map();

/** @type {typeof PointVisionSource} */
let GhostVisionSource;

/** @type {typeof ClockwiseSweepPolygon} */
let GhostSweep;

/**
 * Patch the configured vision source class. Called on setup, after systems and modules
 * have had a chance to replace it.
 */
export function patchVisionSources() {
  const VisionSource = CONFIG.Canvas.visionSourceClass;
  const original = VisionSource.prototype._getPolygonConfiguration;
  VisionSource.prototype._getPolygonConfiguration = function() {
    const config = original.call(this);
    const shapes = config.boundaryShapes = [...(config.boundaryShapes ?? [])];
    if ( this.portalBoundaries ) shapes.push(...this.portalBoundaries);
    else if ( !this.data.preview ) {
      try {
        shapes.push(...getPortalCuts(this.data));
      } catch(err) {
        log("error", "Failed to cut vision at portals", err);
      }
    }
    return config;
  };

  GhostSweep = createGhostSweep(CONFIG.Canvas.polygonBackends.sight);

  GhostVisionSource = class PortalGhostVisionSource extends VisionSource {
    /** Marks ghost sources so they are never treated as real Token vision. */
    isPortalGhost = true;

    /**
     * The area beyond the exit this ghost may see, as shapes it must stay inside.
     * @type {PIXI.Polygon[]|null}
     */
    portalBoundaries = null;

    /**
     * The exit Wall's plane. Walls between the ghost and it are not in the way: the Token is
     * really looking through the entrance, so only what lies beyond the exit counts.
     * @type {PortalPlane|null}
     */
    portalClip = null;

    /**
     * Ghosts are never attached to the active vision sources, but their vision mode, such as
     * darkvision, is drawn in portal views, and Foundry only draws that for active sources.
     * @override
     */
    get active() {
      return !this.data.disabled && !this.suppressed;
    }

    /** @override */
    _getPolygonBackend() {
      return GhostSweep;
    }

    /** @inheritDoc */
    _getPolygonConfiguration() {
      return Object.assign(super._getPolygonConfiguration(), {portalClip: this.portalClip});
    }
  };
}

/* ---------------------------------------- */

/**
 * A polygon backend for ghost vision or light that only takes walls beyond the exit plane into account.
 * Walls on the ghost's side of the exit are dropped, and walls crossing it are trimmed to the far side.
 * @param {typeof ClockwiseSweepPolygon} Sweep    The configured sight or light backend
 * @returns {typeof ClockwiseSweepPolygon}
 */
export function createGhostSweep(Sweep) {
  return class PortalGhostSweep extends Sweep {
    /**
     * The canvas, grown to take in the origin. Ghosts often look from the scene's edge or beyond it,
     * where the scene's own bounds would cut through or miss the origin and break the sweep.
     * @returns {PIXI.Rectangle}
     */
    #getBounds() {
      const {x, y, width, height} = this.scene.dimensions.rect;
      const pad = canvas.dimensions.size;
      const x0 = Math.min(x, this.origin.x) - pad;
      const y0 = Math.min(y, this.origin.y) - pad;
      return new PIXI.Rectangle(x0, y0, Math.max(x + width, this.origin.x) + pad - x0,
        Math.max(y + height, this.origin.y) + pad - y0);
    }

    /**
     * Foundry gives up on origins off the canvas, but a ghost deep in a chain of portals often
     * looks from there. Its bounds take in the origin, so the sweep works all the same.
     * @override
     */
    compute() {
      const {x, y} = this.origin;
      const {width, height} = this.scene.dimensions;
      const {angle, radius, externalRadius} = this.config;
      const degenerate = (radius === 0) || ((angle === 0) && (externalRadius === 0));
      if ( degenerate || ((x >= 0) && (x <= width) && (y >= 0) && (y <= height)) ) return super.compute();
      this.bounds = undefined;
      this._compute();
      this.bounds = this.getBounds();
      return this;
    }

    /** @override */
    _defineBoundingBox() {
      let b = this.#getBounds();
      for ( const shape of this.config.boundaryShapes ) b = b.intersection(shape.getBounds());
      const {x, y} = this.origin;
      const x0 = Math.min(b.x, x);
      const y0 = Math.min(b.y, y);
      b = new PIXI.Rectangle(x0, y0, Math.max(b.right, x) - x0, Math.max(b.bottom, y) - y0);
      return b.normalize().ceil().pad(1);
    }

    /** @override */
    _identifyEdges() {
      super._identifyEdges();
      for ( const edge of [...this.edges] ) if ( edge.type.endsWith("Bounds") ) this.edges.delete(edge);

      // The scene's edge blocks sight like a wall, as it does for Tokens inside the scene, and is cut
      // at the exit like one. Bounds around the origin close off the polygon.
      for ( const side of ["top", "right", "bottom", "left"] ) {
        const edge = this.level.edges.get(`innerBounds.${side}`);
        if ( edge ) this.edges.add(edge.clone());
      }
      const r = this.#getBounds();
      const corners = [{x: r.x, y: r.y}, {x: r.right, y: r.y}, {x: r.right, y: r.bottom}, {x: r.x, y: r.bottom}];
      for ( const [i, a] of corners.entries() ) {
        this.edges.add(new foundry.canvas.geometry.edges.Edge(a, corners[(i + 1) % 4],
          {id: `noneuclid.bounds.${i}`, type: "outerBounds"}));
      }

      const plane = this.config.portalClip;
      if ( !plane ) return;
      const {center, direction} = plane;
      const sideOf = p => (direction.x * (p.y - center.y)) - (direction.y * (p.x - center.x));
      const keep = -Math.sign(sideOf(this.origin)) || 1;
      const beyond = p => (sideOf(p) * keep) > -0.5;

      for ( const edge of [...this.edges] ) {
        if ( edge.type === "outerBounds" ) continue; // These close off the polygon
        const inA = beyond(edge.a);
        const inB = beyond(edge.b);
        if ( inA && inB ) continue;
        this.edges.delete(edge);
        if ( !inA && !inB ) continue;

        // Trim the edge where it crosses the exit plane's line
        const sa = sideOf(edge.a);
        const sb = sideOf(edge.b);
        const t = sa / (sa - sb);
        const cut = {x: edge.a.x + ((edge.b.x - edge.a.x) * t), y: edge.a.y + ((edge.b.y - edge.a.y) * t)};
        const trimmed = new edge.constructor(inA ? edge.a : cut, inB ? edge.b : cut, edge);
        trimmed.intersections = Object.fromEntries(Object.entries(edge.intersections).map(([level, list]) => {
          return [level, list.filter(({intersection: i}) => beyond(i))];
        }));
        this.edges.add(trimmed);
      }
    }
  };
}

/* ---------------------------------------- */

/**
 * The parts of the canvas a real vision or light source at this origin may still reach:
 * everything except what lies beyond each portal plane it looks through.
 * @param {{x: number, y: number, elevation?: number}} origin
 * @param {object} [options]
 * @param {"sight"|"light"} [options.type="sight"]    Which walls block the source
 * @param {number} [options.radius=Infinity]          How far the source reaches: portals past it are left alone
 * @param {number} [options.overlap]                  How far past each portal the source still reaches
 * @returns {PIXI.Polygon[]}
 */
export function getPortalCuts(origin, {type="sight", radius=Infinity, overlap=seamOverlap()}={}) {
  const links = getViewedPortalLinks();
  if ( !links.length ) return [];
  const {x, y, width, height} = canvas.dimensions.rect;
  const canvasPolygon = new PIXI.Polygon(x, y, x + width, y, x + width, y + height, x, y + height);
  const cuts = [];
  let los;
  for ( const link of links ) {
    if ( !link.side(origin) || (link.distance(origin) >= radius) ) continue;

    // Only cut where the portal is actually in view, so walls elsewhere keep working as usual
    los ??= CONFIG.Canvas.polygonBackends[type].create({x: origin.x, y: origin.y, elevation: origin.elevation ?? 0},
      {type, level: canvas.level});
    for ( const [t0, t1] of link.visibleIntervals(origin, los) ) {
      const wedge = link.wedge(origin, t0, t1, -overlap); // Let real sight reach a little past the portal
      if ( wedge ) cuts.push(asBoundary(subtract(canvasPolygon, wedge, origin)));
    }
  }
  return cuts;
}

/**
 * Make a polygon safe to use as a boundary shape of a source. Foundry intersects the source's shape
 * with each boundary shape and keeps only the first piece that comes out. Where a portal's edges and
 * the shadows of walls at its ends miss each other by a fraction of a pixel, slivers come out too, and
 * if one comes first the whole source shrinks to it. So keep the largest piece instead.
 * @param {PIXI.Polygon} polygon
 * @returns {PIXI.Polygon}    The same polygon
 */
export function asBoundary(polygon) {
  polygon.intersectPolygon = function(other, {scalingFactor=CONST.CLIPPER_SCALING_FACTOR}={}) {
    const solution = this.intersectClipper(other.toClipperPoints({scalingFactor}), {scalingFactor});
    let largest = [];
    let area = 0;
    for ( const path of solution ) {
      const a = Math.abs(ClipperLib.Clipper.Area(path));
      if ( a <= area ) continue;
      largest = path;
      area = a;
    }
    return PIXI.Polygon.fromClipperPoints(largest, {scalingFactor});
  };
  return polygon;
}

/**
 * Join two overlapping polygons into one.
 * @param {PIXI.Polygon|null} polygon
 * @param {PIXI.Polygon} other
 * @returns {PIXI.Polygon|null}
 */
export function union(polygon, other) {
  if ( !polygon ) return null;
  const scalingFactor = CONST.CLIPPER_SCALING_FACTOR;
  const [points] = polygon.intersectClipper(other.toClipperPoints({scalingFactor}),
    {clipType: ClipperLib.ClipType.ctUnion, scalingFactor});
  return points ? PIXI.Polygon.fromClipperPoints(points, {scalingFactor}) : polygon;
}

/**
 * Cut a wedge out of a polygon, keeping the piece that contains a point.
 * @param {PIXI.Polygon} polygon
 * @param {PIXI.Polygon} wedge
 * @param {Point} keep
 * @returns {PIXI.Polygon}
 */
function subtract(polygon, wedge, keep) {
  const scalingFactor = CONST.CLIPPER_SCALING_FACTOR;
  const pieces = polygon.intersectClipper(wedge.toClipperPoints({scalingFactor}),
    {clipType: ClipperLib.ClipType.ctDifference, scalingFactor})
    .map(points => PIXI.Polygon.fromClipperPoints(points, {scalingFactor}));
  return pieces.find(p => p.contains(keep.x, keep.y)) ?? pieces[0] ?? new PIXI.Polygon();
}

/* ---------------------------------------- */

/**
 * Is a portal past the exit of another, as seen from a point beyond that exit? Portals between the
 * point and the exit, or the exit Wall itself, are behind the view and can't be looked through.
 * @param {PortalLink} through    The portal being looked through
 * @param {PortalLink} link       Another portal
 * @param {Point} origin          Where the view is seen from, mapped through the first portal
 * @returns {boolean}
 */
export function isPast(through, link, origin) {
  if ( link.entrance === through.exit ) return false;
  const near = Math.sign(planeSide(through.to, origin));
  return (planeSide(through.to, link.from.a) * near < 0.5) && (planeSide(through.to, link.from.b) * near < 0.5);
}

/**
 * What a ghost may see of a view: everything except what lies beyond the portals in it. Nested
 * views show those, and past the deepest view nothing does.
 * @param {Point} origin            Where the ghost looks from
 * @param {PortalLink[]} links
 * @param {PortalLink} through      The portal the ghost looks out of
 * @param {number} [overlap]        How far past each portal the ghost still reaches
 * @returns {PIXI.Polygon[]}
 */
export function getGhostCuts(origin, links, through, overlap=seamOverlap()) {
  // The canvas, grown to take in the origin, which may lie beyond its edge
  const {x, y, width, height} = canvas.dimensions.rect;
  const pad = canvas.dimensions.size;
  const x0 = Math.min(x, origin.x) - pad;
  const y0 = Math.min(y, origin.y) - pad;
  const x1 = Math.max(x + width, origin.x) + pad;
  const y1 = Math.max(y + height, origin.y) + pad;
  const canvasPolygon = new PIXI.Polygon(x0, y0, x1, y0, x1, y1, x0, y1);
  const cuts = [];
  for ( const link of links ) {
    if ( !isPast(through, link, origin) ) continue;
    const wedge = link.wedge(origin, 0, 1, -overlap);
    if ( wedge ) cuts.push(asBoundary(subtract(canvasPolygon, wedge, origin)));
  }
  return cuts;
}

/* ---------------------------------------- */

/**
 * @typedef PortalView
 * What the current user sees through a chain of portals: through one, then through another seen
 * inside it, and so on, as in a room whose walls lead back into itself. Each is drawn as its own window.
 * @property {string} id               The links looked through, as their IDs joined by ">"
 * @property {PortalLink} link         The last portal looked through
 * @property {number} depth            How many portals are looked through
 * @property {Similarity} transform    Maps the real canvas onto what the view shows
 * @property {Point} eye               Where a viewer looks from, mapped by the transform
 * @property {PIXI.Polygon[]} masks    Where the view shows, on the real canvas
 * @property {number} order            Views with a higher order are drawn over those with a lower one
 * @property {PortalView} [source]     For a copy in a loop, the rendered view it shows a shifted copy of
 * @property {Similarity} [shift]      For a copy, maps the real canvas onto where the source shows the same
 */

/**
 * Where a chain of portals goes on repeating: its shortest repeating run of links, given that the
 * run has started over at least once.
 * @param {PortalLink[]} links
 * @returns {{run: Similarity, length: number, next: PortalLink}|null}
 *   The run's transform and length, and the link that continues the chain
 */
function findLoop(links) {
  for ( let p = 1; p < links.length; p++ ) {
    if ( !links.every((link, i) => (i + p >= links.length) || (links[i + p] === link)) ) continue;
    const run = links.slice(0, p).reduce((t, link) => t.then(link.transform), Similarity.IDENTITY);
    return {run, length: p, next: links.at(-p)};
  }
  return null;
}

/**
 * Does a picture shifted by a transform only take what is on screen? A view's texture only holds
 * what is on screen, so a copy can't show what its source would show off screen.
 * @param {PIXI.Polygon[]} masks     Where the copy shows, on the real canvas
 * @param {Similarity} shift         Maps the copy's points to where its source shows the same
 * @param {ClipperPoint[]} screen    The part of the canvas on screen
 * @returns {boolean}
 */
function isOnScreen(masks, shift, screen) {
  const scalingFactor = CONST.CLIPPER_SCALING_FACTOR;
  const minArea = 4 * scalingFactor * scalingFactor; // A few pixels left over are rounding
  for ( const mask of masks ) {
    for ( const points of mask.intersectClipper(screen, {scalingFactor}) ) {
      const shifted = shift.applyPolygon(PIXI.Polygon.fromClipperPoints(points, {scalingFactor}));
      const outside = shifted.intersectClipper(screen, {clipType: ClipperLib.ClipType.ctDifference, scalingFactor});
      if ( outside.some(path => Math.abs(ClipperLib.Clipper.Area(path)) > minArea) ) return false;
    }
  }
  return true;
}

/**
 * Carry loops on past the deepest views, such as a room whose walls lead back into itself, with
 * copies of rendered views instead of more renders.
 *
 * A chain whose links repeat with a run of transform P shows the same picture as the chain without
 * its first run, shifted: what it shows at a point w is what that one shows at P(w). So each next
 * view along the loop is a copy of one already drawn, masked to the wedge beyond the next copy of the
 * portal. Copies match rendered views exactly, except that the vision in them is that of the view
 * they copy, which sees from nearer by.
 * @param {PortalView[]} rendered    The views drawn in full
 * @param {number} maxDepth
 * @param {ClipperPoint[]} screen    The part of the canvas on screen
 * @returns {PortalView[]}
 */
function repeatLoops(rendered, maxDepth, screen) {
  const scalingFactor = CONST.CLIPPER_SCALING_FACTOR;
  const known = new Map(rendered.map(view => [view.id, view]));
  const copies = [];
  const queue = rendered.filter(view => view.depth >= maxDepth);
  while ( queue.length && (copies.length < MAX_COPIES) ) {
    const parent = queue.shift();
    const loop = findLoop(parent.links);
    if ( !loop ) continue;
    const links = [...parent.links, loop.next];
    const id = links.map(link => link.id).join(">");
    if ( known.has(id) ) continue; // Rendered in full, where a copy couldn't show it
    const source = known.get(links.slice(loop.length).map(link => link.id).join(">"));
    if ( !source ) continue;

    // The wedge beyond the next portal, as seen in the parent view, mapped back to the real canvas
    const fromParent = parent.transform.invert();
    const masks = [];
    for ( const eye of parent.eyes ) {
      const wedge = loop.next.wedge(parent.transform.apply(eye), 0, 1);
      if ( !wedge ) continue;
      const clip = fromParent.applyPolygon(wedge).toClipperPoints({scalingFactor});
      for ( const mask of parent.masks ) {
        for ( const points of mask.intersectClipper(clip, {scalingFactor}) ) {
          const piece = PIXI.Polygon.fromClipperPoints(points, {scalingFactor});
          if ( piece.intersectClipper(screen, {scalingFactor}).length ) masks.push(piece);
        }
      }
    }
    if ( !masks.length ) continue;
    const shift = source.source ? loop.run.then(source.shift) : loop.run;
    if ( !isOnScreen(masks, shift, screen) ) continue;
    const transform = parent.transform.then(loop.next.transform);
    const copy = {id, link: loop.next, links, depth: parent.depth + 1, transform, eye: transform.apply(parent.eyes[0]),
      eyes: parent.eyes, masks, order: parent.order + (1 / (MAX_COPIES + 2)), source: source.source ?? source, shift};
    known.set(id, copy);
    copies.push(copy);
    queue.push(copy);
  }
  return copies;
}

/**
 * The most views drawn at once, however many portals are in sight. Each one renders the whole canvas.
 */
const MAX_VIEWS = 16;

/** The most copies of views drawn past the deepest level of a loop. They are cheap: no rendering. */
const MAX_COPIES = 64;

/** @type {PortalView[]} */
let views = [];

/**
 * Lines of sight beyond portals while Token vision is off, when there are no ghosts to provide them.
 * @type {Map<string, {signature: string, los: PIXI.Polygon}>}
 */
const sights = new Map();

/**
 * The views through portals the current user sees this frame, as found by {@link syncGhostVision}.
 * @returns {PortalView[]}
 */
export function getPortalViews() {
  return views;
}

/**
 * Find what the current user sees through portals, including portals seen through other portals,
 * and create, move, or remove ghost vision sources to match. Called once per frame, just before
 * the portal views are drawn. Ghosts only compute their shapes here; see {@link showGhostVision}.
 */
export function syncGhostVision() {
  const links = getViewedPortalLinks();
  const eyes = links.length ? getEyes() : [];
  const maxDepth = game.settings.get(MODULE_ID, "portalDepth");
  const scalingFactor = CONST.CLIPPER_SCALING_FACTOR;
  const screen = screenPolygon().toClipperPoints({scalingFactor});
  const found = new Map();
  const wanted = new Set();

  // Breadth first, so with too many portals in sight the nearest few levels are drawn
  const roots = eyes.map(eye => ({key: `${eye.id}.noneuclid`, eye, depth: 0, transform: Similarity.IDENTITY,
    inverse: Similarity.IDENTITY, from: eye, los: eye.los, children: []}));
  const queue = [...roots];
  while ( queue.length ) {
    const parent = queue.shift();

    // Past the depth setting, loops go on with copies of views already drawn (see repeatLoops).
    // Only where a copy would need what is off screen is the next view along the loop drawn in full.
    let loop = null;
    if ( parent.depth >= maxDepth ) {
      loop = parent.view && findLoop(parent.view.links);
      if ( !loop ) continue;
    }
    for ( const link of links ) {
      if ( loop && (link !== loop.next) ) continue;
      if ( parent.link && !isPast(parent.link, link, parent.from) ) continue;

      // One ghost per stretch of the portal the viewer can actually see past walls
      for ( const [i, [t0, t1]] of link.visibleIntervals(parent.from, parent.los).entries() ) {
        // Start the window exactly at the portal: light stops exactly there, and nothing hides under the window
        const wedge = link.wedge(parent.from, t0, t1);
        if ( !wedge ) continue;
        const mask = parent.inverse.applyPolygon(wedge);
        if ( !mask.intersectClipper(screen, {scalingFactor}).length ) continue; // Off screen
        if ( loop && isOnScreen([mask], loop.run, screen) ) continue;
        const id = parent.view ? `${parent.view.id}>${link.id}` : link.id;
        let view = found.get(id);
        if ( !view ) {
          if ( found.size >= MAX_VIEWS ) continue;
          const transform = parent.transform.then(link.transform);
          view = {id, link, links: [...(parent.view?.links ?? []), link], depth: parent.depth + 1, transform,
            eye: transform.apply(parent.eye), eyes: [], masks: [], order: 0};
          found.set(id, view);
        }
        view.masks.push(mask);
        if ( !view.eyes.includes(parent.eye) ) view.eyes.push(parent.eye);
        const node = {key: `${parent.key}.${link.id}.${i}`, eye: parent.eye, view, link, depth: view.depth,
          transform: view.transform, inverse: view.transform.invert(), from: link.apply(parent.from), children: [],
          distance: Math.hypot(parent.from.x - link.from.center.x, parent.from.y - link.from.center.y)};
        node.los = sightBeyond(node, parent.from, t0, t1, links);
        wanted.add(node.key);
        parent.children.push(node);
        queue.push(node);
      }
    }
  }

  // Draw each view over the one it is seen in, and nearer portals over farther ones
  let order = 0;
  const visit = node => {
    for ( const child of node.children.sort((a, b) => b.distance - a.distance) ) {
      child.view.order = Math.max(child.view.order, ++order);
      visit(child);
    }
  };
  roots.forEach(visit);
  views = [...found.values()];
  views.push(...repeatLoops(views, maxDepth, screen));

  for ( const [key, ghost] of ghosts ) {
    if ( wanted.has(key) ) continue;
    ghost.destroy();
    ghosts.delete(key);
  }
  for ( const key of sights.keys() ) if ( !wanted.has(key) ) sights.delete(key);
}

/**
 * Create or update what a viewer sees through the last portal of a view: a ghost vision source when
 * the viewer is one, or else just the line of sight.
 * @param {object} node            The view as seen by one viewer, through one stretch of the portal
 * @param {Point} from             Where the viewer looks at the portal from
 * @param {number} t0              The stretch of the portal seen
 * @param {number} t1
 * @param {PortalLink[]} links     All portals in view
 * @returns {PIXI.Polygon|null}    The line of sight beyond the portal
 */
function sightBeyond(node, from, t0, t1, links) {
  const {key, link, eye, transform} = node;
  const boundaries = () => {
    // Let ghost sight start a little before the exit, so its soft edge doesn't show at the portal
    const boundary = asBoundary(link.applyPolygon(union(link.wedge(from, t0, t1),
      link.band(from, t0, t1, seamOverlap()))));
    boundary._includeEdge = (a, b) => !link.isExitEdge(a, b); // See past the exit Wall even if it blocks
    return [boundary, ...getGhostCuts(node.from, links, link)];
  };
  const allLinks = getPortalLinks();

  const source = eye.source;
  if ( !source ) {
    const signature = JSON.stringify([node.from.x, node.from.y, eye.elevation, t0, t1]);
    let sight = sights.get(key);
    if ( (sight?.signature !== signature) || (sight.links !== allLinks) ) {
      let los = null;
      try {
        los = GhostSweep.create({...node.from, elevation: eye.elevation ?? 0}, {type: "sight", level: canvas.level,
          boundaryShapes: boundaries(), portalClip: link.to});
      } catch(err) {
        log("error", "Failed to compute sight through a portal", err);
      }
      sight = {signature, links: allLinks, los};
      sights.set(key, sight);
    }
    return sight.los;
  }

  const scale = transform.scale;
  const data = {
    ...source.data,
    x: node.from.x,
    y: node.from.y,
    rotation: source.data.rotation + Math.toDegrees(transform.angle),
    radius: source.data.radius * scale,
    lightRadius: source.data.lightRadius * scale,
    externalRadius: source.data.externalRadius * scale
  };
  const signature = JSON.stringify([data.x, data.y, data.rotation, data.radius, data.lightRadius,
    data.externalRadius, data.angle, data.visionMode, data.disabled, data.level, source.blinded, t0, t1]);
  let ghost = ghosts.get(key);
  if ( (ghost?.portalSignature !== signature) || (ghost.portalLinks !== allLinks) ) {
    ghost?.destroy();
    ghost = new GhostVisionSource({sourceId: key, object: source.object});
    ghosts.set(key, ghost);
    Object.assign(ghost.blinded, source.blinded);
    ghost.portalBoundaries = boundaries();
    ghost.portalClip = link.to;
    ghost.portalSignature = signature;
    ghost.portalLinks = allLinks;
    ghost.initialize(data);
    try {
      ghost._configure({}); // Set up the meshes its vision mode is drawn with, as attaching it would
    } catch(err) {
      log("error", "Failed to set up vision mode through a portal", err);
    }
  }
  ghost.portalViewId = node.view.id;
  return ghost.los;
}

/**
 * The part of the canvas on screen.
 * @returns {PIXI.Polygon}
 */
function screenPolygon() {
  const {width, height} = canvas.app.renderer.screen;
  const stage = canvas.stage;
  stage.transform.updateLocalTransform();
  const m = stage.transform.localTransform;
  const points = [];
  for ( const [x, y] of [[0, 0], [width, 0], [width, height], [0, height]] ) {
    const p = m.applyInverse({x, y});
    points.push(p.x, p.y);
  }
  return new PIXI.Polygon(points);
}

/* ---------------------------------------- */

/**
 * Graphics that stand in for Foundry's vision mask while a portal view is captured.
 * Ghosts are never added to the active vision sources, so the real map stays exactly as the
 * Token sees it, walls and all.
 */
const overlays = {sight: null, light: null, realLightMask: null, seams: null};

/* ---------------------------------------- */

/**
 * Carry the lit area across the portals in a picture, the real map or a portal view. Light stops
 * exactly at portals, and Foundry blurs the edge of what is visible, so without this a faint shadow
 * would show along each portal. Beyond each portal, under the window that covers it, the lit area
 * just beyond its exit is drawn, and in a portal view, the lit area just before its entrance is drawn
 * before the exit, where the window leaves it out. Neither shows itself: only its blur reaches over.
 * @param {PortalView|null} view    The view being drawn, or null for the real map
 */
export function drawLitSeams(view) {
  const vision = canvas.visibility.vision;
  if ( !vision?.light ) return;
  if ( overlays.seams?.parent !== vision.light ) {
    overlays.seams?.destroy();
    overlays.seams = vision.light.addChild(new PIXI.LegacyGraphics());
    overlays.seams.blendMode = PIXI.BLEND_MODES.MAX_COLOR;
  }
  const graphics = overlays.seams;
  if ( graphics.geometry.graphicsData.length ) {
    graphics.clear();
    canvas.masks.vision.renderDirty = true;
  }
  if ( !canvas.visibility.tokenVision || !views.length ) return;
  canvas.masks.vision.renderDirty = true;
  const scalingFactor = CONST.CLIPPER_SCALING_FACTOR;
  const width = seamOverlap();
  const transform = view?.transform ?? Similarity.IDENTITY;
  graphics.beginFill(0xFF0000);

  // Beyond the portals seen in this picture, clipped to their windows
  const depth = (view?.depth ?? 0) + 1;
  for ( const child of views ) {
    if ( (child.depth !== depth) || (view && !child.id.startsWith(`${view.id}>`)) ) continue;
    const link = child.link;
    const back = link.transform.invert();
    const windows = child.masks.map(mask => transform.applyPolygon(mask).toClipperPoints({scalingFactor}));
    const beyond = -Math.sign(planeSide(link.to, child.eye)) || 1;
    for ( const lit of litStrip(link.to, beyond, width) ) {
      const mapped = back.applyPolygon(lit);
      for ( const clip of windows ) {
        for ( const points of mapped.intersectClipper(clip, {scalingFactor}) ) {
          graphics.drawShape(PIXI.Polygon.fromClipperPoints(points, {scalingFactor}));
        }
      }
    }
  }

  // Before the exit of this view, on the side it is seen from
  if ( view ) {
    const link = view.link;
    const eye = link.transform.invert().apply(view.eye);
    const near = Math.sign(planeSide(link.from, eye)) || 1;
    for ( const lit of litStrip(link.from, near, width / link.scale) ) graphics.drawShape(link.applyPolygon(lit));
  }
  graphics.endFill();
}

/**
 * The lit area in a strip along one side of a portal plane.
 * @param {PortalPlane} plane
 * @param {number} side        1 or -1, the side of the plane, as {@link planeSide} gives it
 * @param {number} width
 * @returns {PIXI.Polygon[]}
 */
function litStrip({a, b, direction}, side, width) {
  const scalingFactor = CONST.CLIPPER_SCALING_FACTOR;
  const nx = -direction.y * side * width;
  const ny = direction.x * side * width;
  const strip = new PIXI.Polygon(a.x, a.y, b.x, b.y, b.x + nx, b.y + ny, a.x + nx, a.y + ny);
  const bounds = strip.getBounds();
  const clip = strip.toClipperPoints({scalingFactor});
  const lit = [];
  for ( const light of canvas.effects.lightSources ) {
    if ( !light.hasActiveLayer || light.isPreview || !light.shape ) continue;
    if ( light instanceof foundry.canvas.sources.GlobalLightSource ) continue;
    if ( !(light.shape.bounds ?? light.shape.getBounds()).intersects(bounds) ) continue;
    for ( const points of light.shape.intersectClipper(clip, {scalingFactor}) ) {
      lit.push(PIXI.Polygon.fromClipperPoints(points, {scalingFactor}));
    }
  }
  return lit;
}

/**
 * Vision mode meshes swapped while a portal view is captured: the ghosts' meshes added, the Tokens'
 * own meshes hidden, and the containers whose visibility was changed, to restore.
 */
const visionEffects = {added: [], hidden: [], containers: []};

/**
 * Show only the ghost vision seen in one portal view. The Tokens' own sight is hidden meanwhile:
 * where it also covers the space beyond the exit, seen directly from across the map, it would
 * otherwise show through the portal too.
 * @param {PortalView} view
 * @returns {PointVisionSource[]|null}    The ghosts drawn, or null if Token vision is off
 */
export function showGhostVision(view) {
  const vision = canvas.visibility.vision;
  if ( !vision || !canvas.visibility.tokenVision ) return null;
  if ( overlays.sight?.parent !== vision ) {
    overlays.sight?.destroy();
    overlays.sight = vision.addChildAt(new PIXI.LegacyGraphics(), vision.getChildIndex(vision.darkness));
    overlays.sight.blendMode = PIXI.BLEND_MODES.MAX_COLOR;
  }
  if ( overlays.light?.parent !== vision.light ) {
    overlays.light?.destroy();
    overlays.light = vision.light.addChild(new PIXI.LegacyGraphics());
  }
  const shown = [];
  overlays.sight.clear().beginFill(0xFF0000);
  overlays.light.clear().beginFill(0xFF0000);

  // Lights that grant vision are seen wherever they shine, portal or not
  for ( const light of canvas.effects.lightSources ) {
    if ( !light.hasActiveLayer || !light.data.vision || light.isPreview ) continue;
    if ( light instanceof foundry.canvas.sources.GlobalLightSource ) continue;
    overlays.light.drawShape(light.shape);
  }
  for ( const ghost of ghosts.values() ) {
    if ( (ghost.portalViewId !== view.id) || !ghost.shape || ghost.isBlinded ) continue;
    if ( ghost.radius > 0 ) overlays.sight.drawShape(ghost.shape);
    if ( ghost.lightRadius > 0 ) overlays.light.drawShape(ghost.light);
    shown.push(ghost);
  }
  overlays.sight.endFill();
  overlays.light.endFill();

  overlays.sight.renderable = true;
  vision.sight.renderable = false;
  const realLightMask = overlays.realLightMask = vision.light.mask;
  vision.light.mask = overlays.light;
  realLightMask.renderable = false; // No longer a mask, so it would draw as a plain shape

  // Foundry reaches these through the mask while rendering
  for ( const key of ["preview", "shared", "surfaceExposure"] ) overlays.light[key] = realLightMask[key];
  canvas.masks.vision.renderDirty = true;
  showVisionEffects(shown);
  return shown;
}

/**
 * Draw the vision modes of the ghosts seen in a portal view, such as darkvision brightening what it
 * sees, in place of the Tokens' own. Otherwise the view would show the space beyond the exit as if
 * seen with plain sight, and look darker than the space before the portal.
 * @param {PointVisionSource[]} shown    The ghosts drawn
 */
function showVisionEffects(shown) {
  const {background, illumination, coloration} = canvas.effects;
  for ( const source of canvas.effects.visionSources ) {
    for ( const layer of Object.values(source.layers) ) {
      const mesh = layer.mesh;
      if ( !mesh?.parent || !mesh.renderable ) continue;
      mesh.renderable = false;
      visionEffects.hidden.push(mesh);
    }
  }

  // As Foundry does for active vision sources when lighting is refreshed
  const add = (container, mesh) => {
    if ( !mesh ) return;
    container.addChild(mesh);
    visionEffects.added.push(mesh);
  };
  for ( const ghost of shown ) {
    if ( (ghost.radius <= 0) || !ghost._geometry ) continue; // Without meshes if setting them up failed
    ghost.refresh();
    const meshes = ghost.drawMeshes();
    add(ghost.preferred ? background.visionPreferred : background.vision, meshes.background);
    add(illumination.lights, meshes.illumination);
    add(coloration, meshes.coloration);
  }

  // Foundry hides the background vision containers, and turns off their filters, when they hold nothing
  for ( const container of [background.vision, background.visionPreferred] ) {
    visionEffects.containers.push([container, container.visible, container.filter.enabled]);
    container.visible = container.filter.enabled = container.children.some(c => c.renderable && c.visible);
  }
  visionEffects.containers.push([coloration, coloration.visible, null]);
  if ( visionEffects.added.some(mesh => mesh.parent === coloration) ) coloration.visible = true;
}

/** Put the Tokens' own vision modes back, after a portal view is captured. */
function hideVisionEffects() {
  for ( const mesh of visionEffects.added ) if ( !mesh.destroyed ) mesh.parent?.removeChild(mesh);
  for ( const mesh of visionEffects.hidden ) if ( !mesh.destroyed ) mesh.renderable = true;
  for ( const [container, visible, filtered] of visionEffects.containers ) {
    if ( container.destroyed ) continue;
    container.visible = visible;
    if ( filtered !== null ) container.filter.enabled = filtered;
  }
  visionEffects.added.length = visionEffects.hidden.length = visionEffects.containers.length = 0;
}

/** Put the Tokens' own vision back, after a portal view is captured. */
export function hideGhostVision() {
  hideVisionEffects();
  const vision = canvas.visibility.vision;
  if ( overlays.realLightMask ) {
    if ( vision?.light && !vision.light.destroyed ) vision.light.mask = overlays.realLightMask;
    overlays.realLightMask = null;
  }
  if ( vision?.sight && !vision.sight.destroyed ) vision.sight.renderable = true;
  if ( overlays.sight ) overlays.sight.renderable = false;
  if ( overlays.light ) overlays.light.renderable = false;
  canvas.masks.vision.renderDirty = true;
}

/* ---------------------------------------- */

/** Remove all ghost vision sources. */
export function clearGhostVision() {
  for ( const ghost of ghosts.values() ) ghost.destroy();
  ghosts.clear();
  sights.clear();
  views = [];
  for ( const key of ["sight", "light", "seams"] ) {
    overlays[key]?.destroy();
    overlays[key] = null;
  }
}

/* ---------------------------------------- */

/**
 * The current ghost vision sources, for inspection.
 * @returns {PointVisionSource[]}
 */
export function getGhostVision() {
  return [...ghosts.values()];
}
