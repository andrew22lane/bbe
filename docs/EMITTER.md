# THE EMITTER — `bbe kit`

`bbe kit <brand>` turns a brand pack into that brand's stylesheet. Same code for
every brand. Change the pack, re-emit, every surface that links the kit follows.

```
bbe kit design-hacker --out dist/kit
bbe kit design-hacker --verify /tmp/dh-kit-target.css       # both proof levels
bbe kit design-hacker --verify /tmp/dh-kit-target.css --selftest
bbe kit ./path/to/some.brandpack.json --vault ~/dh-work/dh-hub/vault
```

**The kit is emitter output; hand-editing it breaks the wire.** (Ruling 63.) A
hand edit survives until the next emit, then vanishes, and any surface that
inherited it drifts with no diff to point at.

## What the pack owns vs what the emitter owns

Same split as `tools/build-tokens.mjs`, which this file follows.

| The PACK holds the VALUES | The EMITTER holds the SHAPE |
|---|---|
| every colour, and the role each one plays | which selectors exist at all |
| families, weights, sizes, tracking, line-heights | which module emits which rules |
| radius scale, easing, durations, keyframes | module order, section comments, indentation |
| the button spec, state by state | the line grouping inside `:root` |
| the dark ladder and the on-ink text alphas | the reset (`box-sizing`, `margin:0`, the plumbing) |
| the font-loading URL and the families it carries | that `@import` is emitted FIRST |
| the container rule and the breakpoint list | which family role a label component uses |

The emitter contains **no brand name, no hex, no font name, no slug**. It reads
roles — `pageGround`, `accentPrimary`, `metaText` — and asks the pack what they
resolve to. That is what lets one emitter serve every brand.

Values the emitter wants and the pack does not carry become structural defaults
**and get printed**. Every run ends with a `PACK GAPS` table naming the exact key
to add. Add the key, the pack owns the value, the default stops being used. The
gap list is generated from the reads themselves, so it cannot go stale.

## Adding a component module

1. Add its name to `outputs.web.components.order` in the pack, in kit order.
2. Add `MODULES.<name> = (m) => ({ css, tail?, tailInto? })` in `tools/build-kit.mjs`.
   - `css` — the module's rules.
   - `tail` — responsive CSS that must ship at the end of the file.
   - `tailInto: { 560: '...' }` — CSS that merges into one shared `@media` block
     with every other module's contribution at that breakpoint.
3. Reach values through the model, never as literals:
   `m.R('role')` a semantic colour · `m.L('rung')` the dark ladder ·
   `m.OI('body'|'meta'|'hair')` on-ink text · `m.F('sans'|'display')` a family ·
   `m.S('mega')` a size · `m.W('headline')` a weight · `m.RAD('lg')` a radius ·
   `m.E('eo')` an easing · `m.D('cardLift')` a duration · `m.SP('cardPad', …)` a
   spacing step · `m.bp(760)` a breakpoint.
4. For anything the pack does not carry yet, use
   `m.opt('components.<module>.<field>', <default>, '<what it is>')`. It emits the
   default today and adds the key to the gap report.
5. Add the module's markup to `BLOCKS` in `tools/kit-verify-computed.mjs`, or
   level 2 will never look at it.
6. Add a section title to `SECTION_TITLE`.

## Running the verify

Two levels. Both are the acceptance test; `--verify` runs both.

**Level 1 — normalized text diff.** Both files go through the same normalizer:
comments stripped, whitespace collapsed, split into rules, declarations sorted
inside each block, selector lists sorted, `@media` rules keyed by their query so
blocks written in different places merge. Two passes are reported:

- **RAW** compares declarations as written.
- **RESOLVED** first substitutes every `var(--x)` for its `:root` value,
  recursively, in both files. Only a RESOLVED difference can change a pixel.

**Level 2 — computed styles in headless Chrome.** A local harness page
instantiates every module in `components.order`, at rest and on hover, on light
and on ink. It loads twice — reference CSS, then emitted CSS — and compares
`getComputedStyle` across ~53 properties per element.

Three things level 2 does deliberately, each paid for once already:

- **It proves the brand face actually loaded**, on both pages, by three
  independent signals: the family is in `document.fonts` with status `loaded`,
  `document.fonts.check` passes, and the same string measures a different width
  than it does in a forced fallback. If `@import` is emitted anywhere but first,
  the browser drops it silently, both pages fall back to the same system face,
  and every computed value then agrees perfectly on the wrong font. A green run
  would be worthless, so the run FAILS when the proof does not hold. Tested with
  a negative control: only the `document.fonts` signal catches it once Chrome has
  the face cached from a previous page, which is why all three are required.
- **It pins every animation to time zero** before measuring. The marquee runs 48s
  and never stops, so `transform` is otherwise a moving target and two loads a
  second apart disagree about nothing.
- **It sets the viewport with `page.setViewport`, never a `--window-size` flag.**
  Headless Chrome refuses to lay out narrower than about 500px that way, so a
  flag-set width silently measures a layout nobody asked for.

`--selftest` plants a defect in the pack in memory — a palette hex, the headline
weight, the button padding, the font URL, a motion duration — emits, and requires
the verifier to go red on each, in the right place, having first confirmed it is
green on the clean pack. A verifier that has only ever returned green has not
been tested.

## The three emitted files

| file | what it is |
|---|---|
| `<slug>-kit.css` | the whole stylesheet: `@import`, `:root`, base, every component module |
| `fonts.html` | the `<head>` snippet that loads the brand's fonts, from `outputs.web.fontLoad` |
| `tokens.generated.css` | the `:root{}` block alone, for a consumer that wants tokens without components |
