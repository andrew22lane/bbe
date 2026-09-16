# BG-VIDEO: one ambient background video, done once, reused everywhere

Andrew ruled this 2026-09-16, as the one exception to the design standard's "no motion
behind text": ONE ambient background video per page, hero only, slow, low-contrast,
behind a scrim, no faces or text in the clip, poster frame under reduced-motion and on
slow connections, never behind a form or pricing table. Every other section on the page
still uses CSS motion or stays still. This is that recipe as a block, so no project
hand-rolls it again.

## The four rules

1. **Hero only.** One loop per page, in the hero, never stacked section after section.
2. **One per page.** The gate fails a page with more than one `.bg-video`.
3. **A scrim, always.** Text sits on the scrim, never on the raw footage. That is what
   keeps the loop low-contrast enough to read over.
4. **A poster fallback, always.** Reduced motion, a slow connection, and a narrow
   viewport (unless the section opts into mobile video) all get the still poster frame
   instead of the clip. Nothing ever ships a blank hero.

## Using it in a site

```js
import { createEngine } from '@andrew22lane/bbe/engine';
const engine = createEngine(ctx);

// once, in the site's stylesheet
const css = `${siteCSS}\n${engine.bgVideoCSS()}`;

// in a page's body, hero only
const hero = engine.bgVideo({
  mp4: `${BASE}/assets/video/dh-ink.mp4`,
  webm: `${BASE}/assets/video/dh-ink.webm`,
  mobileMp4: `${BASE}/assets/video/dh-ink-mobile.mp4`, // optional
  poster: `${BASE}/assets/video/dh-ink-poster.jpg`,
  posterAlt: '',
  mobile: 'poster',       // or 'video' to allow the clip on phones too
  scrim: 'rgba(10,8,20,.6)', // optional; falls back to the kit's --bgv-scrim
  content: `<h1>Headline over the loop</h1>`
});
```

`engine.page({ body: `<section class="hero">${hero}</section>` ... })` picks up the
upgrade script automatically — `page()` scans the body for `class="bg-video` and only
then appends `bgVideoScript()`. A page that never uses the block ships the exact bytes
it always did.

## The two custom properties a kit sets

The engine ships no color. A brand's kit css sets these once, and every `bgVideo()` call
on that brand inherits them unless it passes its own `scrim`:

| Property | What it controls | Default if the kit sets nothing |
|---|---|---|
| `--bgv-fade` | how long the video takes to fade in once it starts playing | `.6s` |
| `--bgv-scrim` | the overlay color between the footage and the text | `rgba(0,0,0,.55)` |

## Generating a loop

`tools/make-loop.sh <input> <outdir> <name> [--seconds 8] [--width 1920] [--tint #rrggbb]
[--tint-strength 0.6] [--start 0]` takes any source clip (or a synthesized `lavfi:`
input) and writes the five files a `bgVideo()` call needs: `<name>.mp4`, `<name>.webm`,
`<name>-mobile.mp4`, `<name>-poster.webp`, `<name>-poster.jpg`. The seam between the
clip's tail and head is crossfaded so the loop never pops. Full usage: the script's own
header comment.

```
tools/make-loop.sh lavfi:'gradients=size=1920x1080:duration=10:speed=0.015:nb_colors=3:c0=#0c0a12:c1=#5b2a86:c2=#ff6b4a' \
  ~/dh-work/bg-video-media dh-ink --seconds 8 --tint '#0c0a12' --tint-strength 0.4
```

## The gate check

`bbe-gate` runs a `bg-video` check whenever `bbe.config.json` names a `buildDir` (the
same key the kit and head checks already read). Unlike those two, this check only ever
looks at BUILT pages — there is no source fallback — and a site that never uses the
block, or has not built yet, is simply skipped, never blind-failed. It fails a built page
that stacks more than one `.bg-video`, drops `muted`, `playsinline` or `poster=` from the
`<video>`, or has no `bg-video__scrim` on the page.

## Pack vocabulary

A brand pack's `expression.motion.moves` array can now include `"bgVideo"` to mark that
the brand has adopted the block. It's descriptive, not enforced by the engine — the gate
above is what actually holds the line.
