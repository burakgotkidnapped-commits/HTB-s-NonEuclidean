# HTB's Non-Euclidean

A Foundry Virtual Tabletop v14 module for non-Euclidean geometry.

## Features

| Feature | Status | How |
| --- | --- | --- |
| **Portals** | Traversal works; seeing through portals is planned | Region behavior **Portal** |
| **Impossible spaces** | Movement cost works | Region behavior **Impossible Space** |
| **Curved space** | Scene data helpers only | `scripts/curved-space/geometry.mjs` |

### Portals

1. Draw a Region where the portal entrance should be and add the **Portal** behavior.
2. Set **Exit** to another Region, in this Scene or another one.
3. For a two-way doorway, give the exit Region its own Portal behavior pointing back.

A Token that walks in comes out of the exit at the same relative position (turn off
**Preserve Offset** to come out at the center), turned by **Rotation** degrees. Arriving through
a portal never triggers the exit portal, so paired portals don't bounce Tokens back and forth.

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
  portals/                 portal traversal (portal-behavior.mjs) and portal vision (vision.mjs)
  impossible-spaces/
  curved-space/
lang/en.json
styles/noneuclid.css
```

The API is available at `game.modules.get("noneuclid").api`.
