# HTB's Non-Euclidean

A Foundry Virtual Tabletop v14 module for non-Euclidean geometry.

## Features

| Feature | Status | How |
| --- | --- | --- |
| **Portals** | Walls you can see and walk through to somewhere else, seamlessly | Wall config, **Portal** section |
| **Impossible spaces** | Movement cost works | Region behavior **Impossible Space** |
| **Curved space** | Scene data helpers only | `scripts/curved-space/geometry.mjs` |

### Portals

Any wall can be a portal. Open the wall's config, and in the **Portal** section set the **Exit Wall**:
click the crosshair button, then click the exit wall on the map. With **Two-Way** on, the exit wall
becomes a portal leading back. Portal walls never block sight or movement themselves.

- **Walking:** a move that crosses the portal wall continues out of the exit wall as one uninterrupted
  movement. Drag a Token to a spot you see through the portal and it walks there.
- **Seeing:** looking at the portal shows a live view of what lies beyond the exit: lighting, fog,
  Tokens and all. A Token's sight stops at the portal and continues beyond the exit instead.
  Portals seen through a portal show their own view too, so a room whose walls lead back into
  itself repeats, with your Token in every copy. **Portal View Depth** in the module settings sets
  how many portals deep the scene is drawn in full (default 4); each level draws the scene again.
  Past that, loops carry on to the edge of the screen with copies of the levels already drawn,
  which cost almost nothing.
- **Camera:** when a controlled Token crosses, the view moves with it on the same frame, so nothing on
  screen changes.

Walking straight through comes out heading the same way; **Flip** reverses that. If the exit wall
runs at an angle to the portal, the passage turns to match. If it is longer or shorter, things are
scaled through the portal, and the camera zooms to match.

#### Example: a hallway that is long outside, short inside

1. Draw a hallway 10 squares long with walls along both sides.
2. Draw a wall across the hallway 1 square in, and another 1 square from the far end.
3. Make the first a portal with the second as its exit (Two-Way on).
4. Select a Token with vision and look down the hallway: the far end is right there, 2 squares away.
   Walk in, and after 2 squares you come out at the far end.

From outside, the hallway still looks 10 squares long on the map.

#### Another Scene

Paste the UUID of a wall in another Scene as the exit (for example from
`canvas.walls.controlled[0].document.uuid` in the console there). The Token walks up to the portal, then moves to the other Scene with the view kept on it. This one
is a teleport, not seamless.

#### Limitations

- The camera can't rotate. A portal that turns (flip, or walls at an angle) keeps the Token
  on screen, but the view visibly rotates.
- At most 16 portal views are drawn in full and 64 copied at once. Past that, and past the view
  depth outside loops, portals show nothing beyond them.
- Copies past the view depth show what the deepest drawn level sees. A Token's sight range is not
  counted again for each copy, so a limited sight range doesn't fade out the far copies.
- Exits on another Level of the same Scene move the Token there, but views through them aren't drawn.
- Portal views only render while you have a Token selected (or vision Tokens as a player), so the
  GM sees the real map when editing.
- All movement is routed through portals, including direct `update({x, y})` calls, which Foundry
  treats as movement. To place a Token without passing through portals, move it with the
  `displace` action: `token.move([{x, y, action: "displace"}])`.

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
    walls.mjs              Portal section of the wall config, exit picking, two-way links
    teleport.mjs           portals into other Scenes
    eyes.mjs               where the viewer looks from
    geometry.mjs           portal walls and the transform between them
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
