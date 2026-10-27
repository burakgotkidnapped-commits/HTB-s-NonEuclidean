/**
 * Seeing through portals.
 *
 * Planned approach:
 *  1. For each viewed portal Region with an exit in the same Scene and Level, find the part of
 *     the exit's surroundings that a Token looking into the portal should see.
 *  2. Render that area (from the exit side) into a texture, masked to the portal's shape and
 *     clipped to the Token's line of sight to the portal.
 *  3. Extend the Token's vision polygon through the portal so fog of war and token
 *     visibility on the far side follow suit.
 *
 * Nothing is rendered yet; this file only reserves the entry point.
 */

/** Called during the init hook. */
export function init() {}
