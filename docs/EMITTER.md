# THE EMITTER — `bbe kit`

`bbe kit <brand>` turns a brand pack into that brand's stylesheet. Same code for
every brand. Change the pack, re-emit, every surface that links the kit follows.

```
bbe kit design-hacker --out dist/kit
bbe kit design-hacker --verify /tmp/dh-kit-target.css       # both proof levels
bbe kit design-hacker --verify /tmp/dh-kit-target.css --selftest
bbe kit design-hacker --scheme light  --verify /tmp/dh-kit-target.css   # half 1 alone
bbe kit design-hacker --scheme system --verify /tmp/dh-kit-target.css   # half 1 + half 2
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
| the colour scheme and the dark remap | the three block shapes a scheme emits |

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

## The colour scheme (ruling 66)

Andrew, 2026-09-09: *"yes set to 'system' for dark/light. but good to have option
for all sites to be 1 of three by default: light/dark/system"*. So the scheme is a
brand-blind pack value, `outputs.web.dark.defaultScheme`, with exactly three legal
settings. `--scheme <light|dark|system>` overrides it for one run. An illegal value
in the pack stops the run whether or not this run uses it.

| setting | what comes out |
|---|---|
| `light` | the `:root` light block alone. No `@media`, no `[data-theme]` block. Byte for byte what this emitter shipped before ruling 66. |
| `dark` | the dark values IN `:root`, with `:root[data-theme="light"]` restoring light. |
| `system` | three blocks in order: `:root` light; `@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){…} }`; `:root[data-theme="dark"]{…}` so an explicit choice wins in both directions. |

**The block shape is copied from `tools/build-tokens.mjs`**, which already emits
exactly this for embody-society, down to the two comment lines. Reusing a
structure that ships beats inventing a second one that has to be argued about.

The dark values come from `outputs.web.dark.remap`, which invents no colours:
every entry names the token its dark value came `from`, and the emitter proves
that value against the light `:root` it just emitted, both directions. A wrong
number refuses the run rather than shipping a colour nobody ruled on.

`:root` is built once as structured lines, so a dark block reuses the light line
grouping instead of inventing a second one — which is also why the delta below
can only ever be an insertion.

## The split (ruling 69) and the disc/arrow law

Andrew, 2026-09-09: **split `--paper`**. The page-ground token was doing two jobs
— the page ground AND the foreground on every dark surface — so flipping it for
dark inverted every foreground declaration at once. The dark Level 2 measured the
damage before it shipped: 34 of 86 pairs failing WCAG AA, all one cause.

`outputs.web.dark.split` names the second token. `--paper` keeps the ground job
and flips; `--on-dark` takes the foreground job and does **not** flip, so it is
`#FBF7F9` in both schemes.

The emitter decides which declaration does which job by **reading its own output**,
not from a list of selectors that would go stale:

| job | what it looks like | what happens in dark |
|---|---|---|
| foreground | `color`, `stroke`, or a component's own foreground custom property, valued exactly at the ground token | takes `--on-dark` |
| ground | a `background` or a `border` painted with the same token | keeps the token and flips |

### AN ARROW'S COLOUR FOLLOWS ITS DISC, NEVER THE PAGE

This is the part that is not obvious, and Andrew caught it by eye on the first
fix: every arrow had been sent to `--on-dark` because the PAGE was dark, so the
arrow on a disc that had **kept** its light value came out white on white.

A disc is not a page. So a disc painted with the ground token keeps the light
value too, and then each arrow is **measured against its own disc** in the dark
scheme and moved only when it does not clear 3:1 there. Nothing in the emitter
names a button variant; the law does it by measurement, and it reproduces all
three ruled pairs plus a fourth the ruling did not name:

| variant | disc in dark | arrow in dark | ratio |
|---|---|---|---|
| plum pill `.btn` | keeps light | the accent, held | 6.69:1 |
| paper button `.btn.paper` | the accent | **moves** to `--on-dark` | 6.69:1 |
| ghost off ink `.btn.ghost` | its disc is the body token, so it flips on its own | flips with it, no override | 19.74:1 |
| ghost on ink `.on-ink .btn.ghost` | keeps light | stays the ink | 19.74:1 |

An arrow whose disc is the hover gradient carries **no number** rather than a
guessed one. It takes `--on-dark` because every stop of that gradient is a dark
accent, and the report says so.

### Ruling 68: accent TYPE on a dark ground

Measured on ink, the accent is 2.95:1 and fails. So on a dark ground accent TYPE
takes the on-ink meta value instead. This does **not** touch the button, which
stays the accent in both themes (ruling 65) — the button carries the accent as a
BACKGROUND, and only `color` declarations on selectors a module registered with
`m.accentType.push(...)` move. Registering at the point of emission is what keeps
the list from drifting away from the CSS.

### Where the overrides are emitted, and why

Inside the scheme blocks, **never in the light `:root`**. Declaring `--on-dark` in
the light `:root` would add one declaration to a block that has to stay identical
to the reference kit, which moves half 1 of the proof. Emitting it inside the dark
blocks gives exactly the ruled behaviour — the foreground resolves to `#FBF7F9` in
both schemes, because in light those declarations still read the ground token,
which is `#FBF7F9` — and adds nothing to the light file.

Two mechanics, both load-bearing, the first taught by Level 2:

- **`:where()`.** A plain `:root[data-theme="dark"] .btn .circ` adds (0,2,0) of
  specificity, so it stops losing to `.btn.paper .circ` — which is the entire
  reason the paper button's plum disc exists. Level 2 caught it at once: the
  paper disc measured white. `:where()` contributes zero specificity, so every
  override keeps the rank its own rule had.
- **They ship last**, in the source order of the rules they override. With no
  specificity to win on, order is the only lever, so an override beats its own
  rule and nothing else.

`--scheme dark` scopes the same overrides to `:root:not([data-theme="light"])`, so
a reader who explicitly chooses light gets the light rules back.

## THE PROOF IS SPLIT, and stays split

A proof that changes two things at once proves neither. So:

- **Half 1, the reproduction.** Level 1 and level 2's reference comparison always
  measure the **light** emission, whatever `--scheme` says. `RESOLVED DIFF EMPTY`
  and zero computed-style disagreements mean the same thing they meant before.
- **Half 2, the delta.** `SCHEME DELTA` diffs the non-light emission against that
  same light file line by line, prints **every** added line and the block it lands
  in, and requires: nothing removed, nothing changed, no line of content outside
  the new blocks. For `dark` a changed `:root` line is expected, and every changed
  token must be one the remap names.

`--selftest` grows a scheme half: the shape each legal value emits, four planted
defects the emitter must REFUSE rather than emit, three mangles that must make the
delta prover itself go red, and — for ruling 69 — **an arrow planted so it follows
its PAGE instead of its disc**, which must collapse three pairs to 1:1 and make the
law verifier go red. That defect is the exact mistake Andrew caught by eye, so the
check that catches it is the one worth testing.

## Level 2 in dark

The reference kit has no dark blocks, so level 1 can say nothing about them and
the light comparison cannot either — in a light browser the new blocks never
apply. The dark rendering is therefore measured on its own terms, with
`page.emulateMediaFeatures`:

0. **The cascade.** Every combination of OS preference and reader choice is
   loaded for real and the tokens read back, because "an explicit choice wins in
   both directions" is a claim about the cascade, not about the text of the file.
1. The remapped tokens resolve to their dark values.
2. The ladder tokens and the accent hold.
3. **WCAG AA** over every text/background pair and every SVG stroke, split into
   NEW IN DARK and already failing in light — the light baseline is measured on
   the **reference** kit, so "pre-existing" is a claim about the live stylesheet.
   A failure here is a design finding, not an emitter fault, and it is printed
   loudly rather than swallowed.
3b. **The disc/arrow law, measured again.** The emitter measures the same pairs
   off its own values; this measures them in a real engine at a real OS
   preference, which is the only instrument that can see the cascade. Asserted,
   not merely printed: the ghost-on-ink pair was 1:1 before the split, and a pair
   that cannot be resolved counts as a failure, never as a quiet pass.
4. **`.on-ink` on a dark page**, the open question the pack records at
   `outputs.web.dark.openQuestion`. Measured and printed. Not answered: the pack
   names Andrew as who rules it.

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


## KNOWN INSTABILITY: Level 2 is not perfectly repeatable (observed 2026-09-09)

`LEVEL 2 (light)` returned **FAIL, 1 disagreement** once, then **PASS on the next five consecutive
runs** with the input completely unchanged. Roughly 1 in 6.

**It is the verifier, not the emitter, and that is provable rather than assumed.** The light
emission was byte-identical across the change being tested at the time, sha
`70428d42b74dd947dadcc44077aa7935a7e6397d57a4212fbd955bae873f19ef`, so nothing about the CSS
moved between the failing run and the passing ones. The instability is in the measurement.

**The cause is NOT known.** The obvious suspect is already handled: `kit-verify-computed.mjs`
awaits `document.fonts.ready` after `networkidle0` on both pages before measuring. Whatever wobbles
is something else, and nobody has caught it in the act, because the failing run did not print which
property disagreed before it was re-run.

**Why this matters more than a flaky test usually would.** Level 2 is the proof the entire kit
emitter rests on. A checker that produces a false FAIL 1 time in 6 can produce a false PASS too,
and the direction nobody notices is the dangerous one. Until this is understood:

- **A single green Level 2 run is not proof.** Run it at least 3 times and require all of them.
- **Never dismiss a FAIL as "probably the flake."** Capture which property disagreed, on which
  element, in both renders, before re-running. That output is the only lead anyone will get.
- The fix likely starts by making a failing run dump its disagreement to a file automatically, so
  the next occurrence is diagnosable instead of gone.
