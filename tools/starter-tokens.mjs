#!/usr/bin/env node
// starter-tokens.mjs — the two things a BRAND-BLIND starter page needs before
// anybody has ruled that brand's roles.
//
// A pack's outputs.web.palette names colours the way the brand names them:
// `wine`, `cream`, `periDeep`. A scaffolded page cannot mention any of those,
// because the moment it does it has a brand fact in code and the whole point
// of the engine is gone. So the starter needs two things it can rely on for
// EVERY pack:
//
//   1. one CSS custom property per palette colour, named from the pack's own
//      key (`--bbe-wine`, `--bbe-cream`), so a page can reach any of them
//      without the generator knowing what they are called;
//   2. two role aliases, `--bbe-starter-ground` and `--bbe-starter-ink`, so the
//      starter page has a background and a text colour on day one.
//
// The aliases are NOT called `--bbe-ground` / `--bbe-ink`. They were, for about
// ten minutes, and gabriella's pack has a palette key literally named `ink`, so
// the block emitted `--bbe-ink:var(--bbe-ink)`. A custom property that references
// itself is invalid at computed-value time: the browser drops it, `color` falls
// back to the initial value, and nothing complains. Not the build, not the gate,
// not a byte-identity check. Same shape of silent defect as the radius string
// that shipped a square corner on gab-site. So the aliases live in their own
// namespace, and a collision with a pack key throws instead of rendering wrong.
//
// The two aliases are MEASURED, not chosen: the lightest colour in the pack
// becomes the ground and the darkest becomes the ink, by relative luminance.
// That is a placeholder and it is documented as one in every README this
// scaffold writes. The moment the brand rules its real roles, the page points
// at those custom properties instead. Nothing here invents a value; every
// number comes out of the pack.
//
// Zero dependencies, Node stdlib only, no filesystem access.

// camelCase (or a flattened camel key like `surfaceDarkTop`) -> kebab.
export function kebab(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

export function cssVarName(name, prefix = '--bbe-') {
  return `${prefix}${kebab(name)}`;
}

// #rgb / #rrggbb -> {r,g,b}, else null. Anything that is not a plain hex
// (a gradient, a colour function, a prose note) returns null and takes no part
// in the role measurement.
export function parseHex(value) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value).trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

// WCAG relative luminance. Returns null for anything that is not a hex.
export function luminance(value) {
  const rgb = parseHex(value);
  if (!rgb) return null;
  const chan = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(rgb.r) + 0.7152 * chan(rgb.g) + 0.0722 * chan(rgb.b);
}

// Pick the two placeholder roles out of a flat {name: value} palette map.
// Ties break on the key name so the answer is deterministic for a given pack.
export function pickRoles(flat) {
  const rows = [];
  for (const [name, value] of Object.entries(flat)) {
    const lum = luminance(value);
    if (lum === null) continue;
    rows.push({ name, value, lum });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => (a.lum - b.lum) || (a.name < b.name ? -1 : 1));
  const ink = rows[0];
  const ground = rows[rows.length - 1];
  return {
    ground: ground.name,
    groundValue: ground.value,
    ink: ink.name,
    inkValue: ink.value,
    measured: rows.length
  };
}

// The `:root{}` block: one custom property per palette colour, then the two
// measured role aliases pointing at two of them. Keys are emitted in the pack's
// own order so a diff of this block reads like a diff of the pack.
export const STARTER_GROUND = 'starter-ground';
export const STARTER_INK = 'starter-ink';

export function rootCss(flat, { prefix = '--bbe-', indent = '  ' } = {}) {
  const emitted = new Set();
  const lines = [];
  for (const [name, value] of Object.entries(flat)) {
    const prop = cssVarName(name, prefix);
    emitted.add(prop);
    lines.push(`${indent}${prop}:${value};`);
  }
  const roles = pickRoles(flat);
  if (roles) {
    const groundProp = `${prefix}${STARTER_GROUND}`;
    const inkProp = `${prefix}${STARTER_INK}`;
    // A pack key that kebabs to one of the alias names would make the alias
    // reference itself, which browsers drop silently. Fail loudly instead.
    for (const prop of [groundProp, inkProp]) {
      if (emitted.has(prop)) {
        throw new Error(
          `brand pack: a palette key resolves to ${prop}, which is the starter role alias. ` +
          `Rename that palette key, or pass a different prefix to rootCss(); an alias that ` +
          `references itself is invalid CSS the browser drops without an error.`
        );
      }
    }
    lines.push(`${indent}/* placeholder roles, measured by relative luminance, not ruled */`);
    lines.push(`${indent}${groundProp}:var(${cssVarName(roles.ground, prefix)});`);
    lines.push(`${indent}${inkProp}:var(${cssVarName(roles.ink, prefix)});`);
  }
  return `:root{\n${lines.join('\n')}\n}\n`;
}
