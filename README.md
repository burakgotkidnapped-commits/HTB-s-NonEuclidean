# HTB's Non-Euclidean

A Foundry Virtual Tabletop v14 module for non-Euclidean geometry.

## Features

| Feature | Status | How |
| --- | --- | --- |
| **Portals** | Seamless walking, seeing, and camera through portals | Region behavior **Portal** |
| **Folds** | A Region cut out of space: long outside, short inside | Region behavior **Fold** |
| **Impossible spaces** | Movement cost works | Region behavior **Impossible Space** |
| **Curved space** | Scene data helpers only | `scripts/curved-space/geometry.mjs` |

### Folds: long on the outside, short on the inside

The simplest example, a hallway:

1. Draw a hallway 10 squares long with walls along both sides.
2. Draw a Region over its middle 8 squares and add the **Fold** behavior.
3. Select a Token with vision and look down the hallway: the far end is right there, 2 squares away.
   Walk in, and after 2 squares you come out at the far end.

From outside, the hallway still looks 10 squares long on the map. A fold joins its Region's two
opposite edges and removes everything between them. **Shortened Direction** picks which pair of edges;
Automatic uses the longer side.

### Portals

1. Put walls on both sides of two doorways, A and B.
2. Draw a Region strip across doorway A and add the **Portal** behavior with **Exit** set to a
   matching strip across doorway B. Set **Crossing Direction** to the way Tokens walk through. With **Two-Way** on, B gets a portal back to A automatically.

Each portal's *plane* is the line through its Region's center, across the crossing direction. Then:

- **Walking:** a move that crosses A's plane continues out of B's plane as one uninterrupted movement.
  Drag a Token to a spot you see through the portal and it walks there.
- **Seeing:** looking into A shows a live view of what lies beyond B: lighting, fog, Tokens and all.
  A Token's sight stops at A's plane and continues beyond B instead.
- **Camera:** when a controlled Token crosses, the view moves with it on the same frame, so nothing on
  screen changes.

**Flip** makes the Token come out of B heading the opposite way. If A and B face different directions
(one horizontal, one vertical), the passage turns by 90°. If B is longer or shorter than A, things are
scaled through the portal, and the camera zooms to match.

Limitations:

- The camera can't rotate. A portal that turns (flip, or mixed orientations) keeps the Token
  on screen, but the view visibly rotates.
- Exits in another Scene or on another Level teleport the Token instead of being seamless.
- Portal views only render while you have a Token selected (or vision Tokens as a player), so the
  GM sees the real map when editing.
- Only movement done through Foundry's movement system (dragging, keyboard, `TokenDocument#move`)
  is routed through portals. Direct `update({x, y})` calls skip them.

### Impossible spaces

Add the **Impossible Space** behavior to a Region and set **Inside Scale**. With a scale of 3, crossing
the Region costs three times its drawn distance, so it's bigger on the inside. A scale below 1
makes it smaller on the inside.

### Curved space

Planned: per-Scene hyperbolic or spherical geometry that changes distance measurement and line of sight.

## Layout

```
module.json
scripts/
  main.mjs                 entry point, registers everything on init
  constants.mjs            module ID, behavior type names, logging
  settings.mjs
  portals/
    portal-behavior.mjs    the Portal region behavior
    fold-behavior.mjs      the Fold region behavior
    eyes.mjs               where the viewer looks from
    geometry.mjs           portal planes and the transform between them
    pathing.mjs            routes movement through portals
    camera.mjs             moves the view with Tokens that cross
    vision.mjs             cuts sight at portals, ghost vision beyond exits
    renderer.mjs           draws the live view through each portal
  impossible-spaces/
  curved-space/
lang/en.json
styles/noneuclid.css
```

The API is available at `game.modules.get("noneuclid").api`.
