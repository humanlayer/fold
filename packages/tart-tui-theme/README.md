# tart-tui-theme

A playable OpenTUI app that renders a GitHub PR/issue browser as a cyberpunk HUD in **two
swappable themes**, so you can decide which aesthetic to carry into the real Tart TUI. Both
themes render exactly the same data; press `t` to swap them live and judge them side by
side. This package exists to make that decision, not to be production code — see
[What this is not](#what-this-is-not).

For the design system itself — the palette, the glow threshold that decides which colors emit
light, the typography rules, and exactly how the glitch works — see **[STYLE.md](./STYLE.md)**.
It is written to be self-contained: enough to rebuild this look from scratch without reading
the source.

## Run it

From this directory (the repo is a Bun workspace; run `bun install` at the root once if you
haven't):

```bash
bun run demo
```

That is the zero-setup path: `--demo` forces the bundled fixtures, so it needs no network
and no GitHub token. Use `bun run start` to pull live data from GitHub instead, or `bun run
augmented` / `bun run tactical` to start on a specific theme. The app accepts `--theme
<augmented|tactical>`, `--repo <owner/repo>` (default `humanlayer/tart`), and `--demo`.

Live data is best-effort: the client discovers a token from `GITHUB_TOKEN`, `GH_TOKEN`, or
`gh auth token`, and falls back to the fixtures on **any** failure — no token, no network,
rate limit, private repo, 404. The network can never take the playground down. When it does
fall back, the header's RATE readout reads `OFFLINE` and the SOURCE panel names the reason.

## Everything on screen is real

Every panel is derived from records GitHub actually returned. The rail used to carry a
spinning targeting reticle, sine-wave CPU/MEM/NET/IO gauges, fabricated LAT/LON coordinates,
and a random-hex "data stream" — all of it is gone. The rule now: if a panel can't be backed
by a function in `src/github/stats.ts` or a field on `Feed`, it doesn't belong on screen.

```
┌─ TART │ NAME + tagline │ REPO// owner/repo │ AUTH · RATE ─────────────────────────┐
├───────────────┬──────────────────────────────────────┬──────────────────────────┤
│ INDEX         │ RECORD                               │ STATE                    │
│  PULLS /      │  title · state chip · author ·       │  counts per state,       │
│  ISSUES       │  dates · comments · labels           │  bars in semantic slots  │
│  + rows,      │  ────────────────────                ├──────────────────────────┤
│  glyph per    │  // DESCRIPTION                      │ LABELS     top 5         │
│  row          │  scrollbox, markdown-ish body        ├──────────────────────────┤
│               │                                      │ AUTHORS    top 4         │
│               │                                      ├──────────────────────────┤
│               │                                      │ ACTIVITY   14-day spark  │
│               │                                      ├──────────────────────────┤
│               │                                      │ SOURCE     LIVE/FIXTURES │
├───────────────┴──────────────────────────────────────┴──────────────────────────┤
│ ↑↓/jk SELECT   TAB PULLS/ISSUES   T THEME   Q QUIT           FX//  B S G V R     │
└───────────────────────────────────────────────────────────────────────────────────┘
```

- **INDEX** — the PULLS / ISSUES list, with per-tab counts and a state glyph on each row.
  `Tab` switches lists; `j`/`k` moves the cursor.
- **RECORD** — the selected item in full: title, state chip, author / opened / updated /
  comments (plus the branch-ref arrow on PRs), labels, and a scrolling, lightly-marked-up
  body.
- **STATE** (`stateTallies`) — counts per `open`/`draft`/`merged`/`closed`, each bar drawn
  in the same `semantic` slot the list uses; zero-count rows render muted.
- **LABELS** (`labelTallies`) — the top 5 labels by frequency.
- **AUTHORS** (`authorTallies`) — the top 4 authors by record count.
- **ACTIVITY** (`updatesByDay`) — a 14-day sparkline of how many records were last updated
  each day, with running total and peak.
- **SOURCE** — whether the feed is `LIVE` or `FIXTURES`; when live, the rate-limit reset
  countdown; when it fell back, the reason (a 404, a rate limit). `offlineReason` and the
  reset countdown were the only `Feed` fields nothing else surfaced.

The layout is responsive: below ~118 columns the right-hand rail (STATE / LABELS / AUTHORS /
ACTIVITY / SOURCE) drops; below ~84 the INDEX list narrows (to 40% of width, floored, min 24
cells). RECORD always survives.

## Comparing the two themes

`t` swaps the theme in place — same data, same layout, different palette and post-process
chain — so the comparison is instantaneous. The two are deliberately pulled apart along these
axes:

| Axis            | AUGMENTED                             | TACTICAL                                           |
| --------------- | ------------------------------------- | -------------------------------------------------- |
| Canvas          | absolute black                        | murky brown-black, like a dirty optic              |
| Neon            | teal **and** laser purple **and** red | amber only; a rare cyan flash; red                 |
| "Injected" slot | laser purple                          | bright yellow (same system, running hot)           |
| Frame           | thin `single` border, cool teal       | `heavy` border, burnt orange                       |
| Heading prefix  | `// `                                 | `[ `                                               |
| Signature FX    | glow + chromatic-aberration bursts    | vignette + CRT rolling bar + chroma-dropout bursts |
| Motion          | fast, occasionally unstable           | slow, constant                                     |

With the reticle gone, the fastest reads are the **border color** (cool teal vs burnt
orange), the **`semantic` state colors** in STATE and INDEX (MERGED is laser purple in A, a
rare cyan in B), the **"injected" slot** (purple vs yellow), and the **FX signature**: glow
plus a glitch burst that momentarily separates the color layers and snaps back in A, versus a
vignette + CRT rolling bar + denser scanlines in B, whose bursts instead **drop chroma** — the
whole frame washes toward monochrome and snaps back (`glitch.chromaticAberration` is pinned at
`0` in tactical and `chromaDropout` carries the corruption: an unstable analog signal, not a
splice).

The names carry the intent. **AUGMENTED — "amber substrate // neon graft"** is an old amber
system hacked with experimental cybernetics: amber carries the structure, electric teal is
cool relief on borders and structural data, laser purple marks anything "injected" (merged
records, `#123` cross-references, count badges), and piercing red is rare — all against a
pitch-black void that supplies none of its own light. **TACTICAL — "optic feed // nominal"**
is the view through a cyborg's lens: amber and burnt orange own the whole screen, neon red is
the only loud voice, cyan is a single rare flash, and the dominant artifact is the CRT itself.

## The theming system

This is the part that actually informs the decision: is this the right token interface to
carry forward?

- **`Theme` is one flat token interface** (`src/theme/types.ts`): `name` / `tagline`,
  a `color` object, `chrome`, `semantic`, `fx`, and two block ramps — `barRamp`
  (`▏▎▍▌▋▊▉█`, left-to-right) for the horizontal count bars and `sparkRamp` (`▁▂▃▄▅▆▇█`,
  bottom-up) for the activity sparkline. `augmented.ts` and `tactical.ts` each define a
  private local `palette` of raw colors and map it onto those tokens.
- **No hex literal exists outside `src/theme/*.ts`.** Every component calls `useTheme()` and
  references a _slot_ — `color.core`, `color.inject`, `color.alert` — never a color. Slots are
  named by role, not hue: a foundation (`core`/`coreBright`/`coreDim`), a cool "augmentation"
  pair (`grid`/`gridDim`), an "injected" slot (`inject`), a critical slot (`alert`), and a
  text hierarchy. Every slot has a reader — the dead ones were deleted, because a token
  interface carrying unused slots lies about what the aesthetic needs. Swapping themes is
  just swapping which raw
  colors sit in those roles; the components don't change. (Verified: `rg '#[0-9a-fA-F]{6}'
src` matches only the two theme files.)
- **The post-process chain is assembled from `fx` tokens** (`src/hud/postfx.ts`).
  `installPostFx(renderer, theme, toggles)` walks the `PostFx` tokens in a fixed order (glow →
  vignette → scanlines → CRT bar → glitch) and pushes one pass per token that is _both_
  present in the theme and enabled by the runtime toggle. It returns a disposer; `App.tsx`
  tears the chain down and rebuilds it whenever the theme or a toggle changes. **Every pass is
  independently switchable**, and a pass runs only when the theme declares it _and_ the toggle
  permits it — so AUGMENTED, which defines no vignette and no rolling bar, shows `V:-- R:--` in
  the footer rather than pretending they are on. The scrolling CRT bar has its own switch (`r`)
  because it is the only pass that animates continuously; treat it as opt-in in any product
  that embeds this style.
- **`semantic` maps GitHub states onto palette slots.** `open`/`closed`/`merged`/`draft` each
  name a color slot; `displayState()` in `src/github/types.ts` collapses `state`/`draft`/
  `merged` into one token, and `useStateStyle()` in `src/components/atoms.tsx` turns that into
  a `{ glyph, color, label }` used by both the INDEX rows and the STATE panel. This is where
  the "no green, red is rare" rule lives: in both themes OPEN is not green, and red is spent
  only on CLOSED, target locks, and destructive arrows.

If you carry this forward, the load-bearing ideas are role-named color slots instead of hues,
and an FX chain derived from tokens with per-effect runtime gates.

## Gotchas a maintainer will trip on

These are real and mostly non-obvious. Do not "simplify" them away.

- **Post-process `deltaTime` is milliseconds — but the bundled effects disagree.**
  `CRTRollingBarEffect` divides by 1000 internally (it wants ms), while `DistortionEffect`
  treats the value as seconds. Fed raw ms, `DistortionEffect` fires roughly every frame and
  expires the next, degenerating into constant static instead of occasional bursts. This is
  _why_ `postfx.ts` hand-rolls a `GlitchDirector` (seconds internally) rather than reusing
  `DistortionEffect`, and passes raw ms straight to `CRTRollingBarEffect`. Keep it.
- **Do not use opentui's `BloomEffect`.** Its emitter test is `lum(fg) > threshold` and it
  never looks at the cell's _character_. A blank cell still carries a foreground, and the
  default foreground is white (luminance 1.0) — so on a mostly-empty HUD over a black void
  every empty cell becomes a maximum-intensity emitter, `threshold` goes inert, and the
  palette drowns in a flat white wash (measured: 48% of glyphs rendered pure white).
  `src/hud/GlowEffect.ts` replaces it: only real glyphs emit (it reads `buffers.char` and
  skips space/unset), and the glow lands on neighbours' **backgrounds**, tinted toward the
  emitter's foreground, never on foregrounds — so glyph colours survive exactly, which is what
  "outer glow" actually means.
- **Terminal cells are ~2:1 (tall:wide).** `GlowEffect`'s kernel spans `radius * CELL_ASPECT`
  cells horizontally (`CELL_ASPECT = 2`), or every halo renders as a vertical smear.
- **The glow is `O(w·h·r²)`.** That is why it is toggleable with `b` and `radius` stays pinned
  at 2 — the first thing to turn off if a terminal chugs.

## Verifying changes without a TTY

`scripts/preview.tsx` renders one frame into the test harness so you can iterate on layout and
geometry without launching the full app. It always uses the fixtures, so no token or network
is involved.

```bash
bun run scripts/preview.tsx --theme augmented --size 140x44
bun run scripts/preview.tsx --theme tactical  --size 140x44 --keys tab,j,j   # drive to 3rd issue
bun run scripts/preview.tsx --theme augmented --size 140x44 --spans          # palette histogram
bun run scripts/preview.tsx --theme augmented --size 90x30                   # narrow: rail drops
```

The flags:

- **`--theme <augmented|tactical>`** and **`--size WxH`** (default `140x44`).
- **`--keys a,b,c`** drives the app through a comma-separated key sequence before the frame is
  captured, exactly as a user would type it. Friendly names (`tab`, `up`, `pageup`, …) map to
  their escape sequences; single letters (`j`, `t`, …) pass straight through — so `--keys
tab,j,j` lands on the third issue and `--keys t` swaps to TACTICAL.
- **`--spans`** prints a foreground-color histogram instead of the character grid: every
  distinct color, how many _visible_ (non-space) cells it paints, and its share of the frame.
  `--spans-top N` widens how many colors are listed before the tail is folded into one line.

`captureCharFrame()` — what preview prints by default — is **monochrome**: it proves _layout_
(that panels tile, that the sparkline fits its box, that text does not overflow) but says
nothing about _color_, which is the whole point of this package. `--spans` is the only way to
weigh the palette from the CLI — to answer "is red actually rare? does amber dominate?" — and
the rendered frame in a real terminal is the final arbiter.

One harness subtlety worth knowing: `settleFrame()` yields **two** macrotasks before drawing,
not one. The first lets React flush the _commit_ queued by the key handler; but React 19
flushes **passive effects** (`useEffect`) on a later task, and `App` installs the post-process
chain from one — so a single yield would draw the new tree through the _old_ FX chain (a
one-key `--keys b --spans` reported the glow still on).

## Keybindings

Every row is sourced from `App.tsx`'s `useKeyboard`:

| Key                    | Action                            |
| ---------------------- | --------------------------------- |
| `↑` / `k`, `↓` / `j`   | Move selection                    |
| `PageUp` / `PageDown`  | Jump 8 rows                       |
| `Tab`                  | Switch PULLS ↔ ISSUES             |
| `t`                    | Swap theme (AUGMENTED ↔ TACTICAL) |
| `b`                    | Toggle glow (the `fx.glow` token) |
| `s`                    | Toggle scanlines                  |
| `g`                    | Toggle glitch                     |
| `v`                    | Toggle vignette                   |
| `r`                    | Toggle the scrolling CRT bar      |
| `q` / `Esc` / `Ctrl-C` | Quit                              |

A toggle shows `--` when the active theme declares no such effect.

## What this is not

This is a **theme playground, not production architecture.** Nowhere is that clearer than
`src/github/client.ts`: it is plain `async`/`fetch`, with `Bun.spawn` for `gh auth token` and
`Promise.allSettled` across the two list calls so one disabled endpoint doesn't sink the whole
feed — deliberately **not** Effect, even though the rest of Tart is. The point here is the
pixels, and Effect would only add ceremony between you and the frame. The real Tart TUI will
wire its data through Effect; do not cargo-cult this client into it.
