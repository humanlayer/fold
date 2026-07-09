# tart-tui-theme

A playable OpenTUI app that renders a GitHub PR/issue browser as a cyberpunk HUD in
**two swappable themes**, so you can decide which aesthetic to carry into the real Tart
TUI. Both themes do exactly the same thing; press `t` to swap them live and judge them
side by side. This package exists to make that decision, not to be production code — see
[What this is not](#what-this-is-not).

## Run it

From this directory (the repo is a Bun workspace; run `bun install` at the root once if
you haven't):

```bash
bun run demo
```

That is the zero-setup path: it forces the bundled fixtures, so it needs no network and no
GitHub token. Use `bun run start` to pull live data from GitHub instead, or `bun run
augmented` / `bun run tactical` to start on a specific theme. The app takes `--theme
<augmented|tactical>`, `--repo <owner/repo>` (default `humanlayer/tart`), and `--demo`.

Live data is best-effort: the client discovers a token from `GITHUB_TOKEN`, `GH_TOKEN`, or
`gh auth token`, and falls back to the fixtures on **any** failure — no token, no network,
rate limit, private repo. The network can never take the playground down; the header's RATE
readout shows `OFFLINE` when it happens (the underlying reason is captured on the feed but
not surfaced in the UI).

## The screen

```
┌─ TART │ theme name + tagline │ REPO// │ AUTH + RATE ──────────────────────────┐
├─────────────┬──────────────────────────────────┬───────────────────────────────┤
│ INDEX       │ RECORD                           │ OPTIC   (reticle + LAT/LON)   │
│  PULLS /    │  title, state chip, meta,        ├───────────────────────────────┤
│  ISSUES     │  labels, rule, description        │ TELEMETRY (CPU/MEM/NET/IO)    │
│  rows       │  (scrollbox, markdown-ish)        ├───────────────────────────────┤
│             │                                   │ INJECT  (data stream)         │
├─────────────┴──────────────────────────────────┴───────────────────────────────┤
│ footer: keybinds │ FX toggles                                                   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

The layout is responsive: below roughly 118 columns the right-hand rail (OPTIC / TELEMETRY
/ INJECT) drops, and below roughly 84 the INDEX list narrows. RECORD always survives.

Two of the rail panels layer a receding dot-lattice behind their contents —
`GridRenderable`, mounted as `<grid>` in `src/components/StatusRail.tsx`. In OPTIC a sparse
`mode="nodes"` lattice sits behind the reticle and frames the crosshair; in INJECT tighter
dot-rows sit behind the data stream — the horizontal plane the falling code crosses, which
makes brief A's "cylindrical, spinning column of amber text intersected by a flat,
horizontal plane of teal gridlines" literal. Both draw in `color.gridDim` under the DIM
attribute, so they stay a distant background texture the foreground is pushed in front of.

## Comparing the two themes

`t` swaps the theme in place — same data, same layout, different palette and post-process
chain — so the comparison is instantaneous. The two are deliberately pulled apart along
these axes; watch them as you toggle:

| Axis | AUGMENTED (A) | TACTICAL (B) |
|---|---|---|
| Canvas | absolute black | murky brown-black, like a dirty optic |
| Neon | teal **and** laser purple **and** red | amber only; a rare cyan flash; red |
| "Injected" slot | laser purple | bright yellow (same system, running hot) |
| Frame | thin border, cool teal | heavy border, burnt orange |
| Heading prefix | `//` | `[` |
| Signature FX | bloom + chromatic aberration on glitch bursts | vignette + CRT rolling bar + heavier scanlines |
| Motion | fast, mechanical, occasionally unstable | slow, mechanical, constant |

The reticle in OPTIC is the fastest read: A layers three colors of counter-rotating rings
(amber baseline, fast purple graft, receded teal); B is all amber gradations turning
slowly, with red reserved for the target lock. Also worth toggling FX (`b/s/g/c`) per theme
— glitch on A separates the color layers and snaps back; glitch on B just tears rows with
no color separation, because it is an unstable signal, not a splice.

### AUGMENTED — "amber substrate // neon graft"

An older, robust military-grade amber system that has been hacked and augmented with
experimental cybernetics. Amber carries the structure; electric teal is cool relief on
borders and coordinates; laser purple marks anything "injected" (the header spinner, the
data stream, the mid reticle ring); piercing red is rare, reserved for target locks and
failures. The brief's words: chaotic, dense, spectacular, against a pitch-black void that
supplies none of its own light.

### TACTICAL — "optic feed // nominal"

Classic cyberpunk optics — looking through the lens of a cyborg or a surveillance rig.
Serious, gritty, analytical. Amber and burnt orange own nearly the whole screen; neon red
is the only loud voice; cyan appears as a brief, rare flash. The canvas is not pure black
but a murky brown, and the dominant artifact is the CRT itself: vignette, a rolling
brightness bar, and heavier scanlines. This is a *lens*, not a graft.

## The theming system

This is the part that actually informs the decision: is this the right abstraction to carry
forward? The shape:

- **`Theme` is one flat token interface** (`src/theme/types.ts`). A theme is `color`,
  `chrome`, `semantic`, `reticle`, and `fx` sub-objects plus a few odds and ends (spinner
  frames, the data-stream charset, the telemetry bar ramp). `augmented.ts` and `tactical.ts`
  each define a private local `palette` of raw colors and then map it onto those tokens.
- **No hex literal exists outside `src/theme/*.ts`.** Every component calls `useTheme()` and
  references a *slot* — `color.core`, `color.inject`, `color.alert` — never a color. The
  color tokens are organized by role, not by hue: a foundation (`core`/`coreBright`/
  `coreDim`), a cool "augmentation" pair (`grid`/`gridDim`), an "injected" pair (`inject`/
  `injectDim`), a critical pair (`alert`/`alertDim`), and a text hierarchy. Swapping themes
  is therefore just swapping which raw colors sit in those roles; the components don't
  change. (Verified: the only 6-digit hex literals in `src/` are in the two theme files.)
- **The reticle is declarative.** `ThemeReticle` is a `RingSpec[]` plus a crosshair, a lock
  color, and an optional sweep. Each `RingSpec` is data — a radius, a color, an angular
  speed whose *sign* picks the rotation direction, a segment count, a duty cycle. Crucially
  `radius` is a **design unit, not cells**: `ReticleRenderable` (`src/hud/ReticleRenderable.ts`)
  scales the whole reticle to whatever box it lands in and drops or thins rings that would
  collapse, so a theme reads the same in the 32-column rail as it does full-screen. A theme
  author never touches the renderer.
- **The post-process chain is assembled from `fx` tokens** (`src/hud/postfx.ts`).
  `installPostFx(renderer, theme, toggles)` walks the `PostFx` tokens in a fixed order
  (bloom → vignette → scanlines → CRT bar → glitch) and pushes one pass per token that is
  *both* present in the theme and enabled by the runtime toggle. It returns a disposer;
  `App.tsx` tears the chain down and rebuilds it whenever the theme or a toggle changes.
  Because passes are gated on the token existing, `c` (CRT) is a no-op on AUGMENTED, which
  defines no vignette or rolling bar.
- **`semantic` maps GitHub states onto palette slots.** `open`/`closed`/`merged`/`draft`
  each name a color slot; `displayState()` in
  `src/github/types.ts` collapses `state`/`draft`/`merged` into one token, and
  `useStateStyle()` in `src/components/atoms.tsx` turns that into a `{ glyph, color, label }`.
  This is where the "no green, red is rare" rule lives: in both themes OPEN is not green, and
  red is spent only on CLOSED, locks, and destructive arrows.

If you carry this forward, the load-bearing ideas are: role-named color slots instead of
hues, declarative reticle specs, and an FX chain derived from tokens with per-effect
runtime gates.

## Gotchas a maintainer will trip on

These are real and mostly non-obvious. Do not "simplify" them away.

- **Post-process `deltaTime` is milliseconds — but the bundled effects disagree with each
  other.** `CRTRollingBarEffect` divides by 1000 internally (wants ms), while
  `DistortionEffect` treats the value as seconds. Fed raw ms, `DistortionEffect` fires
  roughly every frame and expires the next, degenerating into constant static instead of
  occasional bursts. This is *why* `postfx.ts` hand-rolls a `GlitchDirector` (seconds
  internally) instead of using `DistortionEffect`, and passes raw ms straight to
  `CRTRollingBarEffect`. Keep it.
- **Terminal cells are ~2:1 (tall:wide).** Any circle multiplies its horizontal component by
  `CELL_ASPECT` (`src/hud/glyphs.ts`), or it renders as an ellipse.
- **`live: true` renderables keep the renderer looping.** The reticle and data stream set it
  so `onUpdate` runs every frame — which means `onUpdate` must **not** call
  `requestRender()`, and the test harness's `waitForVisualIdle()`/`flush()` will hang on
  them (see the previews below, which render a single static frame instead).
- **Custom renderables need a setter for every prop that changes at runtime.** The React
  reconciler assigns props as `instance[key] = value`; without a setter that creates a
  shadowing own-property and your private field goes stale. `ReticleRenderable.spec`,
  `DataStreamRenderable`'s color/char setters, and `GridRenderable`'s setters all exist for
  this reason — the theme swap flows through them.
- **`BloomEffect` is O(w·h·r²) in JS** and allocates per bright cell per frame, which is why
  every FX is toggleable and bloom's radius stays small. On a large bright terminal it is the
  first thing to turn off.

## Verifying changes without a TTY

Two scripts render into the test harness so you can iterate on layout and geometry without
launching the full app. Both use the fixtures, so no token or network is involved.

| Command | What it does |
|---|---|
| `bun run scripts/preview.tsx --theme <id> --size WxH [--keys …] [--spans]` | Renders one frame of the whole app and prints it — see the two flags below |
| `bun run scripts/reticle.tsx --theme <id> --size WxH` | Renders the reticle alone at any size, for tuning ring geometry |
| `bun run typecheck` | `tsc --noEmit` (this repo is strict: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`) |

`preview.tsx` takes two flags worth knowing:

- **`--keys a,b,c`** drives the app through a comma-separated key sequence before the frame
  is captured, exactly as a user would type it. Friendly names (`tab`, `up`, `pageup`, …)
  are mapped to their escape sequences; single letters (`j`, `t`, …) pass straight through.
  Use it to script a state and then read the frame — e.g. `--keys tab,j,j` lands on the
  third issue, `--keys t` swaps to TACTICAL.
- **`--spans`** prints a foreground-color histogram instead of the character grid: every
  distinct color, how many *visible* (non-space) cells it paints, and its share of the
  frame. Because the default character capture is monochrome, this is the only way to check
  palette from the CLI — to answer "is red actually rare? does amber dominate?". `--spans-top
  N` widens how many colors are listed before the tail is folded into one line.

For example:

```bash
bun run scripts/preview.tsx --theme augmented --size 140x44
bun run scripts/preview.tsx --theme tactical  --size 140x44 --keys tab,j,j   # drive to 3rd issue
bun run scripts/preview.tsx --theme augmented --size 140x44 --spans          # palette histogram
bun run scripts/reticle.tsx --theme tactical  --size 60x30
bun run scripts/reticle.tsx --theme tactical  --size 32x18   # rail-sized; rings degrade
```

**`captureCharFrame()` (what `preview.tsx` prints by default) is monochrome.** It proves
*layout* — that panels tile, that the reticle fits its box, that text does not overflow —
but says nothing about *color*, which is the whole point of this package. Pass `--spans`
(above) for a color histogram from the CLI, or in a test call `captureSpans()`, which
carries a color per cell. The rendered frame is the real arbiter of a theme; look at it in a
terminal.

## Keybindings

| Key | Action |
|---|---|
| `↑` / `k`, `↓` / `j` | Move selection |
| `PageUp` / `PageDown` | Jump 8 rows |
| `Tab` | Switch PULLS ↔ ISSUES |
| `t` | Swap theme (AUGMENTED ↔ TACTICAL) |
| `b` | Toggle bloom |
| `s` | Toggle scanlines |
| `g` | Toggle glitch |
| `c` | Toggle CRT (vignette + rolling bar) |
| `q` / `Esc` / `Ctrl-C` | Quit |

## What this is not

This is a **theme playground, not production architecture**. Nowhere is that clearer than
`src/github/client.ts`: it is plain `async`/`fetch`, with `Bun.spawn` for `gh auth token`
and `Promise.allSettled` for the two list calls — deliberately **not** Effect, even though
the rest of Tart is. The point here is the pixels, and Effect would only add ceremony
between you and the frame. The real Tart TUI will wire its data through Effect; do not
cargo-cult this client into it.
