# BRIEF: `bbe brief <brand>` — the protocol that loads a brand before anything gets designed

Phase A step 2 of the every-pixel-wired plan (dh-hub vault
`vault/artifacts/2026-09-09/PLAN-every-pixel-wired-2026-09-09.md` §6b). Built alongside
6a (the pack carries values, not evidence pointers) and the gate extension; all three
land together.

Andrew's spec, verbatim: *"whenever AI starts to get into something, it should have
like a protocol, like, boom, boom, boom, boom. It goes and activates... okay, I'm up to
speed, I'm ready to start designing. I know exactly where everything is... no wasted
time or going back."*

## What it is

`bbe brief <brand>` reads one brand pack (`<vault>/core/brand-packs/<slug>.brandpack.json`)
plus a fixed set of vault and project paths, and writes ONE markdown file: the brand as
it is **right now** — identity, type, button, radius, motion, dark ladder, every "law"
string the pack carries, the messaging gate, rulings from the last 30 days, the brand's
`CURRENT.md`, what is actually live and where, the media manifest, and which page
sections are locked. It ends with a `<meta name="bbe-brief" content="<brand>@<version>">`
tag a built page is expected to carry.

Every section is built from a file that actually exists. Where a source is missing —
because the brand pack has not migrated to schema 1.1, because a brand has no
brand-level `CURRENT.md`, because `outputs.web.origins` was never measured — the brief
prints `ABSENT — <what it needed> (checked <exact path or key>)`. It never invents a
value to fill the gap and it never crashes on a missing file; a pack that predates the
2.1.0 value contract (bex-co today) gets a banner at the top saying so, and everything
downstream reads ABSENT honestly instead of silently passing.

Full usage: `tools/build-brief.mjs`'s own header comment, or `bbe brief --help`.

## Why a protocol and not a memory

A ruling that lives only in a markdown file, or only in someone's memory of a call, is
a ruling a builder has no way to find before making the same mistake again. The brief
is the single thing loaded FIRST, every time, so "I know exactly where everything is"
is true mechanically, not aspirationally.

## The three wiring points

**1. The project-folder SessionStart hook runs it when the card names a brand.**
`~/.claude/hooks/session-start.sh` already prints machine + vault state in under 16
lines, silent when everything is fine (see its own header comment). The brief slots in
the same way: resolve which brand this project folder is for (today, by grepping the
project's own `CLAUDE.md` card for a known pack slug — the DH card names `design-hacker`,
a bex-facing project card would name `bex-co`), then print ONE line: the brief's own
version line plus the ABSENT count, never the full brief inline. Andrew reads the vault
card in his own session; the hook's job is a tripwire, not a document viewer.

This tool does **not** edit `~/.claude/hooks/session-start.sh` — that file is shared
across every session on this machine and Andrew approves changes to it. The snippet
below is ready to paste in by hand, immediately before the hook's closing `} | ...`
block (matching the existing `NX`/`TR` tripwire sections' shape: a guarded block that
adds at most one line to `OUT`, and is silent on success).

```bash
# bbe brief tripwire: if this project folder's card names a brand pack slug this
# machine's bbe checkout knows about, run the brief and surface its version line +
# ABSENT count. Silent if the card names no known brand, if bbe is not checked out,
# or if the brief itself fails — this is a convenience ping, never a session blocker.
CARD="$(pwd)/CLAUDE.md"
BBE_BRIEF="$HOME/dh-work/bbe/tools/build-brief.mjs"
if [ -f "$CARD" ] && [ -f "$BBE_BRIEF" ]; then
  BRAND=$(grep -oE '\b(design-hacker|bex-co|embody-society|franchise-watchlist|gabriella|heathers-heroes|kelli|prove-it-network|vhc)\b' "$CARD" | head -1)
  if [ -n "$BRAND" ]; then
    BRIEF_JSON=$(node "$BBE_BRIEF" "$BRAND" --json 2>/dev/null)
    if [ -n "$BRIEF_JSON" ]; then
      BRIEF_VER=$(printf '%s' "$BRIEF_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=j.version||{};console.log(`${j.brand} pack v${v.packVersion} (schema ${v.schema}) · ${(j.absences||[]).length} ABSENT`)}catch{}})' 2>/dev/null)
      [ -n "$BRIEF_VER" ] && OUT+=("brief: ${BRIEF_VER}")
    fi
  fi
fi
```

The brand-slug list in the grep is the same nine packs `core/brand-packs/` carries
today; add a slug there when a tenth pack is minted. If this list drifts, the tripwire
just stays silent for that brand — it never guesses a slug that is not in the list.

**2. Every builder prompt begins with it.** Before a design or copy task starts, run
`bbe brief <brand> --stdout` (or read the day's already-written
`<vault>/artifacts/<date>/BRIEF-<brand>-<date>.md` if one exists from earlier the same
day) and paste its content — or at minimum its Identity, The System, and The Law
sections — into the builder's own context before it touches a pixel. A builder that
starts from the brief cannot ship Poppins on a Inter brand, cannot invent a button
shape, and cannot miss a locked section, because the brief already told it.

**3. A built page carries the meta tag; the gate checks for it.** Section 11 of every
brief is `<meta name="bbe-brief" content="<brand>@<packVersion>">`, ready to copy into
the page's `<head>`. The Phase A gate extension (a sibling worktree,
`~/dh-work/bbe-gate`) is the piece that refuses a built page with no such tag, or one
whose version does not match the pack the gate itself is checking against — that
enforcement is not part of this file, only the tag this file hands a builder to place.
This is what makes "a ruling that is not in the pack is not in the brief" (plan §6b)
into "a page built from a stale brief fails the gate," instead of a sentence nobody
checks.

## Degrading honestly: reading a pre-2.1.0 pack

`bex-co.brandpack.json` is schema 1.0 today. Running `bbe brief bex-co` against it is
the real test of this tool, not a side case: the brief opens with a banner saying the
pack has not migrated, then eleven-plus ABSENT lines follow for type, button, radius,
motion, dark, the kit URL, origins, locked-section context and conflicts — each one
naming the exact `outputs.web.*` key it looked for. bex-co's Identity section still
renders (name, tagline, contact info, the legacy `outputs.web.fonts` block labelled
as legacy), because that much bex-co's pack does carry. Nothing is invented to make a
schema-1.0 pack look more complete than it is.

## Where the output goes

Default: `<vault>/artifacts/<YYYY-MM-DD>/BRIEF-<brand>-<YYYY-MM-DD>.md`, same convention
as every other dated vault artifact. `--out <dir>` overrides. `--stdout` prints the
markdown and writes nothing. `--json` prints the same data as JSON to stdout (for the
SessionStart snippet above, or any other machine consumer) and also writes nothing.
