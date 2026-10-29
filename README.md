# HTB's Non-Euclidean

A Foundry Virtual Tabletop v14 module for non-Euclidean geometry.

## Installation

In Foundry's **Add-on Modules** tab, click **Install Module** and paste this manifest URL:

```
https://github.com/burakgotkidnapped-commits/HTB-s-NonEuclidean/releases/latest/download/module.json
```

## Features

| Feature | Status | How |
| --- | --- | --- |
| **Portals** | Walls you can see and walk through to somewhere else, seamlessly | Wall config, **Portal** section |
| **Impossible spaces** | Movement cost works | Region behavior **Impossible Space** |
| **Curved space** | Not yet: planned for a later version | |

### Portals

Any wall can be a portal. Open the wall's config, and in the **Portal** section set the **Exit Wall**:
click the crosshair button, then click the exit wall on the map. With **Two-Way** on, the exit wall
becomes a portal leading back. Portal walls never block sight or movement themselves, except windows and doors (below).

**Portal doors:** set the wall's **Door** type (Door or Secret Door) as well, and the portal acts like
a regular door. Closed or locked, it blocks sight, light, sound, and movement like any door, and
nothing shows through it. Open, it is a portal. The two ends of a two-way portal door are one door:
they share their door type, and opening, closing, or locking either end does the same to the other.

**Portal windows:** turn on **Window** and the portal can be seen and lit through but not walked
through: the wall blocks movement, and a move that reaches it stops in front of it, even a move
carried through another portal first. Like Foundry's window walls, it lets sight and light through
only up close: a viewer or light within the wall's proximity threshold (2 grid spaces by default, set
in the wall's sight and light restrictions) sees or shines through the portal, and from farther away
the window blocks like a wall. Two-way windows are windows at both ends. A window can also be
a door, like shutters: closed it blocks everything, open it is a window.

- **Walking:** a move that crosses the portal wall continues out of the exit wall as one uninterrupted
  movement. Drag a Token to a spot you see through the portal and it walks there.
- **Seeing:** looking at the portal shows a live view of what lies beyond the exit: lighting, fog,
  Tokens and all. A Token's sight stops at the portal and continues beyond the exit instead.
  Portals seen through a portal show their own view too, so a room whose walls lead back into
  itself repeats, with your Token in every copy. **Portal View Depth** in the module settings sets
  how many portals deep the scene is drawn in full (default 4); each level draws the scene again.
  Past that, loops carry on to the edge of the screen with copies of the levels already drawn,
  which cost almost nothing.
- **Light:** lights shine through portals too. A light near a portal stops at it and lights the
  space beyond the exit instead, on the real map as well as in portal views, so a torch on the far
  side lights up what you see through the portal, and Tokens there can be seen by it. Torches carried
  by Tokens follow them as they move, and light carries on through portals it reaches beyond an exit,
  up to the **Portal View Depth**. Animated lights flicker in step on both sides.
- **Camera:** when a controlled Token crosses, the view moves with it on the same frame, so nothing on
  screen changes.

Walking straight through comes out heading the same way; **Flip** reverses that. If the exit wall
runs at an angle to the portal, the passage turns to match. If it is longer or shorter, the space beyond
is scaled through the portal, and the camera zooms to match. Tokens never change size going through a
portal: they keep their size in grid spaces.

#### Example: a hallway that is long outside, short inside

1. Draw a hallway 10 squares long with walls along both sides.
2. Draw a wall across the hallway 1 square in, and another 1 square from the far end.
3. Make the first a portal with the second as its exit (Two-Way on).
4. Select a Token with vision and look down the hallway: the far end is right there, 2 squares away.
   Walk in, and after 2 squares you come out at the far end.

From outside, the hallway still looks 10 squares long on the map.

#### Another Scene

Portals to other scenes DO work but are not recommended.

Paste the UUID of a wall in another Scene as the exit (for example from
`canvas.walls.controlled[0].document.uuid` in the console there). The Token walks up to the portal, then moves to the other Scene. This one
is a teleport, not seamless. Everyone who had the Token selected goes to the other Scene with it,
the view kept on it and the Token still selected.
Looking at the portal shows the other Scene: the exit Level's background and foreground, its Tiles,
and its Tokens, as far as the viewer sees past that Scene's walls. Tokens move there live as they are
moved in that Scene. Its lights aren't drawn yet: the whole view is darkened by that Scene's darkness
level instead, unless its global illumination lights it. Portals in the other Scene show nothing beyond
them, and hidden Tokens there show only to the GM.

#### Another Level

Portals to other levels technically work but are not recommended.

A portal whose exit wall is on another Level of the same Scene works the same way as one into another
Scene. Viewing the entrance's Level, you can pick the exit by clicking only if it shows on that Level;
otherwise paste its UUID (view the exit's Level, select the wall, and copy
`canvas.walls.controlled[0].document.uuid` from the console). Looking at the portal shows the exit Level:
its background and foreground, Tiles, and Tokens, past its walls, darkened as described above. The Token
walks up to the portal, then moves onto the exit Level at the matching point. It stays as high above that
Level's base as it was above the base of the Level it left. Everyone who had the Token selected switches
to the exit Level with it, the view kept on it. A portal is seamless only when both of its walls are on the
Level being viewed.

#### Limitations

- The module is completely imcompatible with Fog of War, you have to disable it from the scene settings if you wish to use it.
- The camera can't rotate. A portal that turns (flip, or walls at an angle) keeps the Token
  on screen, but the view visibly rotates.
- At most 16 portal views are drawn in full and 64 copied at once. Past that, and past the view
  depth outside loops, portals show nothing beyond them.
- Copies past the view depth show what the deepest drawn level sees. A Token's sight range is not
  counted again for each copy, so a limited sight range doesn't fade out the far copies.
- Views into another Scene or Level show everything in line of sight, however dark: sight range, vision
  modes, and lights there aren't taken into account yet, so Tokens standing in the dark are seen too.
- Switching Levels redraws the canvas, so crossing into another Level isn't seamless: the
  screen reloads for a moment.
- Darkness sources, and lights set not to be constrained by walls, don't pass through portals.
  Lights only pass through portals on the Level being viewed. At most 64 lights are carried
  through portals at once.
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
LICENSE
scripts/
  main.mjs                 entry point, registers everything on init
  constants.mjs            module ID, behavior type names, logging
  settings.mjs
  portals/
    walls.mjs              Portal section of the wall config, exit picking, two-way links
    teleport.mjs           portals into other Scenes and Levels
    annex.mjs              draws other Scenes and Levels for portal views of them
    eyes.mjs               where the viewer looks from
    geometry.mjs           portal walls and the transform between them
    pathing.mjs            routes movement through portals
    camera.mjs             moves the view with Tokens that cross
    vision.mjs             cuts sight at portals, ghost vision beyond exits
    lighting.mjs           cuts light at portals, ghost lights beyond exits
    renderer.mjs           draws the live view through each portal
  impossible-spaces/
  curved-space/
lang/en.json
styles/noneuclid.css
```

The API is available at `game.modules.get("htb-noneuclidean").api`.

## License

[MIT](LICENSE)
