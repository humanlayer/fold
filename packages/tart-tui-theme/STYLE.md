# Cyberpunk HUD terminal style — a reproduction guide

Everything needed to rebuild this look from scratch, in any terminal UI, without reading the
source. It documents the color system, the typography, the layout chrome, and — in detail —
the post-processing chain, including the glitch effect that periodically tears rows and
smears their colors.

The reference implementation is `packages/tart-tui-theme`, built on
[OpenTUI](https://github.com/anomalyco/opentui). The ideas are not OpenTUI-specific: they
need only a terminal renderer that exposes a per-cell buffer of `{ char, fgColor, bgColor,
attributes }` and lets you run a function over that buffer after the UI has drawn but before
it is flushed to the terminal.

---

## 1. The premise

The screen is a **void**. Nothing in it is lit except the UI. There is no ambient light, no
surface, no page — every visible pixel is an element _emitting_ light into darkness. That
single commitment drives every other decision:

- Backgrounds are black or near-black, and stay that way. If the background lights up, the
  illusion collapses into "text on a gray page."
- Color is not decoration. It is a **classification channel**. A reader should be able to
  tell what kind of thing they are looking at from its hue alone, without reading it.
- Brightness is a **depth channel**. Bright things are close and active; dim things recede
  into structure. This maps onto a glow threshold (§4.4) and the `DIM` attribute.
- Chrome is machine-like: uppercase, monospaced, bracketed, abbreviated. It should read as a
  readout, not as prose.

Two variants are implemented. **AUGMENTED** is an old amber military system that has been
spliced with experimental neon cybernetics — amber structure, electric teal relief, laser
purple grafts, piercing red alarms, on absolute black. **TACTICAL** is the view through a
cyborg's optic — amber and burnt orange everywhere, one rare flash of cyan, neon red the only
loud voice, on a murky brown-black, seen through visible CRT artifacts.

---

## 2. The rule that makes it maintainable

**No color literal may exist outside the theme files.** Every component asks for a _role_,
never a hue:

```tsx
<text fg={color.core}>       // not fg="#FFA31A"
<text fg={color.alert}>      // not fg="red"
```

A theme is a plain data object mapping roles → hex strings. Swapping themes is swapping which
raw colors sit in those roles; not one component changes. This is the whole reason the style
is reproducible: the aesthetic lives in ~120 lines of data, and the components are colorless.

Enforce it with a grep in CI: `grep -rE '#[0-9a-fA-F]{6}' src/ | grep -v '^src/theme/'` must
be empty.

---

## 3. The token interface

```ts
interface Theme {
	name: string // 'AUGMENTED'
	tagline: string // 'AMBER SUBSTRATE // NEON GRAFT'
	color: ThemeColors
	chrome: ThemeChrome
	semantic: ThemeSemantic
	fx: PostFx
	barRamp: readonly string[] // ▏▎▍▌▋▊▉█   left-to-right, for horizontal bars
	sparkRamp: readonly string[] // ▁▂▃▄▅▆▇█   bottom-up, for sparklines
}

interface ThemeColors {
	void: string // the canvas. black, or near-black.
	panel: string // panel fill. 'transparent' lets the void show through.
	raised: string // fill behind a selected row.

	core: string // FOUNDATION: titles, primary readouts, the dominant hue
	coreBright: string // the hot highlight
	coreDim: string // dim structural tone (headings)

	grid: string // COOL RELIEF: structural data, labels, inline code, refs
	gridDim: string // borders, scrollbar tracks, dim grids

	inject: string // "INJECTED": cross-references, count badges, bullets, highlights
	alert: string // CRITICAL: failures, destructive edges. Rare.

	text: string // body copy
	textDim: string // secondary
	textFaint: string // scaffolding: brackets, empty bar slots, labels
}

interface ThemeChrome {
	frameStyle: BorderStyle // outer frame: 'single' | 'double' | 'rounded' | 'heavy'
	panelStyle: BorderStyle // inner panels
	border: string // border color
	title: string // panel title color
	heading: string // section-heading prefix, e.g. '// ' or '[ '
}

interface ThemeSemantic {
	// domain states → palette slots
	open: string
	closed: string
	merged: string
	draft: string
}
```

Two notes on discipline. First, `semantic` is where the domain leaks in; keep it as the _only_
place. Components ask `useStateStyle(state)` and get back `{ glyph, color, label }` — they
never branch on the domain themselves. Second, **delete any token nothing reads**. A token
interface that carries unused slots is lying about what the aesthetic needs.

---

## 4. Color

### 4.1 The two palettes

**AUGMENTED** — absolute black, amber substrate, neon graft.

| Role         | Hex           | Name                        |
| ------------ | ------------- | --------------------------- |
| `void`       | `#000000`     | absolute black              |
| `panel`      | `transparent` | the void shows through      |
| `raised`     | `#2A1A0C`     | warm ember                  |
| `core`       | `#FFA31A`     | glowing amber               |
| `coreBright` | `#FFD447`     | golden yellow               |
| `coreDim`    | `#A34A00`     | burnt orange                |
| `grid`       | `#12E5C8`     | electric teal               |
| `gridDim`    | `#0A7E6E`     | deep teal (also the border) |
| `inject`     | `#B14CFF`     | laser purple                |
| `alert`      | `#FF3344`     | piercing red                |
| `text`       | `#E8B563`     | bone                        |
| `textDim`    | `#8A5A12`     | umber                       |
| `textFaint`  | `#4A2F0E`     | ash                         |

**TACTICAL** — murky optic, amber lens.

| Role         | Hex       | Name                                    |
| ------------ | --------- | --------------------------------------- |
| `void`       | `#0D0A04` | warm brown-black                        |
| `panel`      | `#191108` | murky surface                           |
| `raised`     | `#30200C` | ember                                   |
| `core`       | `#FF9500` | amber (more orange than A)              |
| `coreBright` | `#FFC61A` | bright yellow                           |
| `coreDim`    | `#A34F00` | burnt orange (also the border)          |
| `grid`       | `#EAA62B` | gold — _warm_, not cyan                 |
| `gridDim`    | `#7E5518` | dim gold                                |
| `inject`     | `#FFC61A` | bright yellow (no purple in this world) |
| `alert`      | `#FF2A1F` | neon red                                |
| `text`       | `#E0A040` | sand                                    |
| `textDim`    | `#7A4A10` | umber                                   |
| `textFaint`  | `#3A2408` | soot                                    |

The single rare cyan `#26C9BE` is bound to exactly one slot in TACTICAL: `semantic.merged`.
That is the whole cool-color budget of the theme, and it is what "brief flashes of cyan" means
in practice — measured on a 140×44 screen it paints **13 of 2233 glyph cells (0.6%)**, all of
them a `◆` glyph or the MERGED bar. Everything else is warm.

### 4.2 Semantic mapping

|          | AUGMENTED                         | TACTICAL                  |
| -------- | --------------------------------- | ------------------------- |
| `open`   | amber (the baseline record)       | amber                     |
| `merged` | laser purple (a graft spliced in) | cyan — the one cold flash |
| `closed` | red (terminated)                  | red                       |
| `draft`  | umber (not yet active)            | umber                     |

No green anywhere. Green reads as "web dashboard," and it is the fastest way to lose the look.

### 4.3 Scarcity is a rule, not a vibe

Red must be **rare**. Measured on a full screen of AUGMENTED: red paints **11 of 2233 visible
glyph cells (0.5%)** and purple **1.7%**, while the teal border (41.7%), body text (18.6%) and
amber (7.5%) carry the screen. If red is common it stops meaning _critical_ and becomes a color.

Budget red for: the selection caret, the `closed` state, a destructive arrow (`──▶`), a spent
rate limit. Nothing else. Verify by histogramming foreground colors, not by eye (§8).

### 4.4 The glow threshold partitions your palette — this is the central mechanic

The glow pass (§6.2) lights only glyphs whose foreground **luminance** exceeds a threshold.
Using Rec. 601 luma, `L = 0.299R + 0.587G + 0.114B` on 0–1 channels, that threshold cuts the
palette into two tiers, and _you choose the cut by choosing your hex values_:

**AUGMENTED, threshold 0.40**

| Role               | Hex       | L    | glows? |
| ------------------ | --------- | ---- | ------ |
| `coreBright`       | `#FFD447` | 0.82 | ●      |
| `text`             | `#E8B563` | 0.73 | ●      |
| `core`             | `#FFA31A` | 0.69 | ●      |
| `grid`             | `#12E5C8` | 0.64 | ●      |
| `inject`           | `#B14CFF` | 0.50 | ●      |
| `alert`            | `#FF3344` | 0.45 | ●      |
| `textDim`          | `#8A5A12` | 0.38 | —      |
| `coreDim`          | `#A34A00` | 0.36 | —      |
| `gridDim` / border | `#0A7E6E` | 0.35 | —      |
| `textFaint`        | `#4A2F0E` | 0.20 | —      |

**TACTICAL, threshold 0.60**

| Role               | Hex       | L    | glows? |
| ------------------ | --------- | ---- | ------ |
| `coreBright`       | `#FFC61A` | 0.77 | ●      |
| `grid`             | `#EAA62B` | 0.68 | ●      |
| `text`             | `#E0A040` | 0.66 | ●      |
| `core`             | `#FF9500` | 0.64 | ●      |
| `merged` (cyan)    | `#26C9BE` | 0.59 | —      |
| `alert`            | `#FF2A1F` | 0.41 | —      |
| `coreDim` / border | `#A34F00` | 0.37 | —      |
| `gridDim`          | `#7E5518` | 0.35 | —      |
| `textFaint`        | `#3A2408` | 0.15 | —      |

Read those tables as a design statement. In AUGMENTED the threshold sits at 0.40 **because**
laser purple (0.50) and piercing red (0.45) must glow — they are the "lasers," and a higher
gate would extinguish exactly the elements the aesthetic is named for. The red was
deliberately brightened from a deep crimson to `#FF3344` so it would clear the gate. Meanwhile
every dim tier, the teal border, and the burnt headings sit _just under_ the gate, so the
frame stays crisp and recedes while the content blooms forward.

TACTICAL sets the gate at 0.60 so only the dominant warm tones emit; its red and its rare cyan
deliberately stay crisp. The lens glows; the warnings do not.

Practical rule: **pick your hexes, compute their luminance, then place the threshold in the gap
between the tier you want lit and the tier you want crisp.** If there is no clean gap, adjust a
hex until there is. This is the single most reproducible thing in this document.

---

## 5. Typography

There is one font: whatever monospace the terminal has. All expression comes from case,
attributes, punctuation, and glyph choice.

**Case.** Chrome is `ALL CAPS`, always: panel titles, headings, field labels, chips, key
hints, state names, empty states. User content (a PR title, a description body) keeps its
original case — that contrast is what makes the chrome read as machine and the content as
human.

**Punctuation as texture.** Brackets, slashes, and underscores are structural:

- section heading: `chrome.heading + TEXT` → `// DESCRIPTION` or `[ DESCRIPTION`
- a tag or state: `[ ENHANCEMENT ]` — brackets in `textFaint`, label in its slot color
- a labeled prefix: `REPO// humanlayer/tart`, `FX//`
- a readout row: `AUTHOR   kylemistele` — label `padEnd(9)` in `textFaint`, value in `text`
- a key hint: `TAB PULLS/ISSUES` — key in `coreBright`, description in `textFaint`

**Attributes are a depth channel, not emphasis.** `BOLD` marks the active/selected thing.
`DIM` pushes an element behind the plane of the text. Never use them to shout.

**Glyphs.** Every glyph must be **narrow and unambiguous-width**. ASCII, box-drawing, and
block elements are safe. CJK, most emoji, and many dingbats are wide or ambiguous and will
tear the cell grid, misaligning every column to their right. Test any new glyph before
adopting it.

The working inventory:

| Purpose             | Glyphs                                                     |
| ------------------- | ---------------------------------------------------------- |
| domain states       | `◇` open · `◆` merged · `✕` closed · `◌` draft             |
| selection caret     | `▸` (in `alert` — the only red in a calm list)             |
| bullets             | `▪` (in `inject`)                                          |
| horizontal bar fill | `█` plus a partial from `barRamp` = `▏▎▍▌▋▊▉█`             |
| bar empty track     | `·` (in `textFaint`)                                       |
| sparkline           | `sparkRamp` = `▁▂▃▄▅▆▇█`, and a space for zero             |
| borders             | box-drawing, via `single` `┌─┐` or `heavy` `┏━┓`           |
| directional         | `──▶` (in `alert`, for a destructive/directional relation) |

**Inline markup in body text.** A light pass gives content the same classification logic as
chrome: `` `inline code` `` → `grid`; a `#123` cross-reference → `inject`; `## Heading` →
`coreBright` + `BOLD`, uppercased, stamped with `chrome.heading`; `- bullet` → an `inject`
`▪` plus `text`. Nothing else is parsed. The point is not markdown support; it is that even
prose obeys the color grammar.

---

## 6. Layout and chrome

**Panel anatomy.** One primitive, used everywhere: a bordered box with a title.

```tsx
<box border borderStyle={chrome.panelStyle} borderColor={chrome.border}
     title=" STATE " titleColor={chrome.title} backgroundColor={color.panel} paddingX={1}>
```

Titles are padded with a leading and trailing space (`" STATE "`) so the border doesn't
crowd the glyphs. The outer frame (header rule, footer rule) uses `chrome.frameStyle` and
single-sided borders — a header is a box with `border={['bottom']}`, a horizontal rule is a
1-row box with `border={['top']}` and nothing inside.

**Frame style is a theme tell.** AUGMENTED frames in thin `single` teal; TACTICAL frames in
`heavy` burnt orange. At a glance, across the room, that alone identifies the theme.

**Selection.** A selected row gets three simultaneous signals: a red `▸` caret, a `raised`
background band, and `BOLD` + `coreBright` on its identifier. Redundant on purpose — one of
the three survives any terminal's color limitations.

**Density and rhythm.** Panels stack without gaps; borders touch. `paddingX={1}` inside,
never vertical padding. Rows are exactly 1 cell tall. Numbers are right-aligned with
`padStart`; labels left-aligned with `padEnd`. The result is a dense, gridded readout with no
wasted space — "cluttered but structured."

**Responsiveness.** Below ~118 columns the right rail drops; below ~84 the list narrows. The
primary content pane never disappears.

---

## 7. Motion and post-processing

This is where the look actually lives. After the UI tree draws into a cell buffer, and before
that buffer is written to the terminal, a chain of functions mutates it in place. Each pass
receives `(buffer, deltaTimeMs)`.

### 7.1 The chain, and why the order is what it is

```
glow  →  vignette  →  scanlines  →  CRT rolling bar  →  glitch
```

- **glow first.** It is the only pass that _adds_ light. Everything after it modulates the lit
  frame.
- **vignette, scanlines, rolling bar** are CRT artifacts. They darken and modulate. Because
  they run after the glow, they carve texture _into the halo the glow just painted_.
- **glitch last.** It corrupts whatever the frame finally looks like, so tearing carries the
  post-processed colors with it.

Each pass is present only if the theme declares its token, and enabled only if a runtime
toggle allows it. Nothing is hard-coded.

> **The non-obvious consequence.** Scanlines darken the **background** buffer only (so text
> stays legible). On an absolute-black canvas there is nothing to darken — with the glow off,
> scanlines are _invisible_. Measured on AUGMENTED: with glow on, mean background luminance
> on scanline rows is `0.067` vs `0.075` elsewhere; with glow on and scanlines off, `0.073` vs
> `0.075`; with glow off entirely, `0.000` vs `0.001`. **Scanlines are a texture carved into
> the glow, not an independent effect.** If your canvas is pure black and your scanlines seem
> to do nothing, this is why.

### 7.2 The glow (an _outer_ glow)

Terminal "bloom" is usually implemented wrong. The naive version tests every cell's foreground
luminance against a threshold and spreads light from the bright ones. But **a blank cell still
carries a foreground color, and the default foreground is white** (luminance 1.0). On a HUD
that is mostly empty cells, every empty cell becomes a maximum-intensity emitter: the threshold
becomes inert (0.70 and 0.99 produce identical output), and the palette drowns under a flat
white wash. Measured with the naive implementation: **48% of all glyphs rendered pure white.**

The correct algorithm has three rules.

1. **Only real glyphs emit.** Read the cell's _character_; skip space (`0x20`) and unset
   (`0x00`). This alone fixes the void-glow and makes `threshold` mean what it says.
2. **Intensity comes from the emitter's foreground luminance**, normalized:
   `emit = ((L - threshold) / (1 - threshold)) * strength`.
3. **The light lands on the BACKGROUND of neighbors**, additively tinted toward the emitter's
   foreground color, with distance falloff, clamped. **The foreground buffer is never
   written.** That is what "outer glow" means — light _around_ an element — and it is why
   glyph colors survive exactly.

```
for each cell (x, y):
    if char[x,y] is space or unset: continue
    L = luma(fg[x,y])
    if L <= threshold: continue
    emit = ((L - threshold) / (1 - threshold)) * strength
    for each neighbor (nx, ny) in kernel:
        bg[nx,ny] += fg[x,y] * emit * weight(nx-x, ny-y)   # clamped to 255
```

**Kernel geometry.** Terminal cells are about 2:1 (tall:wide). A kernel that is circular in
_cell_ space renders as a vertical ellipse — every halo smears up and down. Measure distance in
_screen_ units: a row step counts twice a column step, and let the kernel run `radius * 2` cells
wide.

```
dist   = sqrt(dx² + (2·dy)²)
reach  = 2·(radius + 1)          # zero one ring PAST the edge, so the rim still receives light
weight = max(0, 1 - dist/reach)
```

Do not skip the `radius + 1`: a falloff of `1 - dist/radius` gives the outermost ring exactly
zero, i.e. no halo at all, which is what tempts people into raising the radius until the screen
washes out.

Do **not** glow the emitter's own cell. Tinting a glyph's background toward its own color costs
contrast and buys no halo. Dense text still reads as a glowing mass because adjacent glyphs
light _each other's_ cells; an isolated mark keeps a crisp black center inside its ring.

**Tuning by measurement, not by eye.** Sample the background luminance of every cell and look
at the distribution:

- The void must stay black → **median ≈ 0**.
- A halo must exist → **p99 clearly > 0**.
- A _flat_ distribution (p50 ≈ p90 ≈ p99) means you are washing, not haloing.

Shipped values, at radius 2: AUGMENTED `threshold 0.40, strength 0.10` → bg luminance
p50 `0.02`, p90 `0.22`, p99 `0.46`. TACTICAL `threshold 0.60, strength 0.07` → p99 `0.13`.
Past roughly `strength 0.15` a quarter of the screen lifts and the palette stops being legible.

Cost is `O(w·h·r²)`. At 200×60 with ~900 emitters it measures **0.26 ms/frame**. Keep it
toggleable anyway.

### 7.3 Vignette and CRT rolling bar

- **Vignette**: darken toward the corners as a function of radial distance from center. Static,
  cheap. TACTICAL only (`0.7`) — an optic tunnel belongs to the theme that is looking _through_
  something.
- **CRT rolling bar**: a horizontal band that brightens the rows it passes over (cosine falloff
  from a bright center), scrolling down the screen and wrapping — a mistimed refresh. Both themes
  carry one, tuned to opposite characters.

|                                   | AUGMENTED              | TACTICAL             |
| --------------------------------- | ---------------------- | -------------------- |
| `speed` (rows/sec)                | 9 — a ~6 s sweep       | 6 — a ~9 s sweep     |
| `height` (of screen)              | 0.06, a thin scan line | 0.1, a fat tube roll |
| `intensity` (peak row multiplier) | 0.35 → `1.35×`         | 0.5 → `1.5×`         |
| reads as                          | a system **scanning**  | a tube **failing**   |

The effect multiplies foreground _and_ background. On AUGMENTED's absolute-black canvas there is
no background to lift, so only the glyphs flare as the sweep passes — which is exactly the "gas
tubes in dark space" the palette is after. On TACTICAL's murky canvas both lift, and the band
reads as a physical artifact of the tube.

> **Watch the unit on `speed`.** It is **rows per second**, not a fraction of the screen. The
> effect advances `position += (deltaMs / 1000) * speed` and wraps at
> `cycleHeight = height * (1 + 2 * barHeight)`, so the sweep period is `cycleHeight / speed`
> seconds. At `speed 6` that is ~9 s across a 44-row terminal. A value like `0.35` _reads_ as
> "slow" and is in fact **one sweep every two and a half minutes** — a bar that never visibly
> moves. This exact mistake made TACTICAL look entirely static, and it survives code review
> because the number looks perfectly reasonable.

The bar is each theme's only _continuous_ motion — the glitch is punctuation, not a pulse — so
if the bar stops, the screen looks frozen between bursts.

> **Ship the bar and the glitch on, but always switchable, and make the key discoverable.** They
> are what makes the thing feel alive; defaulting them off ships a still image. But the bar is
> the one pass that never settles — it animates every frame forever, it is what forces a
> continuous render loop (§7.5), and over a long session it is the first effect to go from
> "atmospheric" to "why is my terminal breathing." It is also a reduced-motion concern: a
> brightness band sweeping the screen is exactly the motion such a preference exists to suppress.
>
> So: its own switch, never one shared with the static vignette. And **the switch must announce
> itself** — a footer that reads `B S G V R` teaches nobody that `r` drives the CRT bar. Spell it
> out (`R CRT-BAR:ON`) and collapse to initials only when the terminal is too narrow. An
> undiscoverable toggle is the same as no toggle; users conclude the key is broken.

Every pass in the chain is gated twice: the **theme** declares whether an effect exists, and a
**toggle** decides whether it may run. Both must agree. That is why AUGMENTED's footer reads
`V VIGNETTE:--` — it defines no vignette, and a readout claiming `ON` for a pass that cannot run
would be lying. It is also the trap: a key bound to a pass the current theme never declares looks
exactly like a broken key.

### 7.4 The glitch — including the thing where colors suddenly shift

This is the effect that fires every couple of seconds: a few rows tear sideways, some of them
smear into the wrong color, the whole frame briefly recolors — channels separating (AUGMENTED) or
chroma draining (TACTICAL) — and solid corrupt-colored blocks and tinted runs stamp across the
screen, over the logo and the panel borders, for a few frames before it all snaps back.

**It is a burst, not static.** The director holds two pieces of state: a list of currently
active glitches, and a countdown.

```
apply(buffer, deltaMs):
    dt = min(deltaMs, 100) / 1000            # seconds; clamped so a stall can't fire everything

    if burstRemaining > 0:
        burstRemaining -= dt
        if burstRemaining <= 0: active = []          # burst over → frame snaps back
    else if random() < chancePerSecond * dt:         # per-frame roll ⇒ ~chancePerSecond bursts/sec
        burstRemaining = minDuration + random()*(maxDuration - minDuration)
        beginBurst()                                 # pick rows + blocks + tints, once

    if nothing active: return
    for g in rows:   corruptRow(buffer, g)           # 1. rearrange existing content
    if chromaticAberration: applyChromaticAberration(buffer, ...)   # 2. move / desaturate
    if chromaDropout:       applyChromaDropout(buffer, ...)         #    (a theme picks one)
    for b in blocks: paintBlock(buffer, b)           # 3. INJECT colour — must be last
    for t in tints:  paintTint(buffer, t)
```

Two properties matter. The **same** rows are corrupted every frame for the burst's duration
(`0.05–0.14 s` ≈ 2–4 frames at 30fps), so the tear _holds_ rather than flickering; and the
corruption is applied to the frame buffer, never to the UI tree, so when `active` empties the
next frame is pristine. That is the "snap back."

**`pickRows()`** chooses `1 + random()*maxLines` rows at random, each with a random `amount`
in `1..maxShift` and one of three kinds:

```
kind = random() < colorGlitchChance  ? 'color'
     : random() < shiftFlipRatio     ? 'shift'
     :                                 'flip'
```

**The three corruptions**, all operating on a single row of the cell buffer:

- **`shift`** — rotate the entire row horizontally by `amount` cells, wrapping around.
  Characters, colors and attributes all move together. This is the classic horizontal tear.
- **`flip`** — mirror the row end-to-end.
- **`color`** — **_this is the one where things shift to random colors._** Pick a random start
  column and a run of up to `width/3` cells. Copy the **foreground RGB of the single cell at
  `start`** into every cell of the run. The characters do not move; a stretch of text suddenly
  all takes one of its neighbors' colors.

    Note the color is not randomly _generated_ — it is **smeared** from a randomly _chosen_ cell.
    That is what makes it read as a signal artifact (a stuck sample being held) rather than as
    noise. A run of amber text abruptly becomes purple because a purple `#412` reference happened
    to sit at the start of the run.

    ```
    srcFg = fg[row][start]
    for x in start .. start+len:
        fg[row][x].rgb = srcFg.rgb     # chars, bg and attributes untouched
    ```

#### Row tearing is nil; the whole frame is the glitch — and colour must be _painted_, not only removed

Here is the single most important thing to know about building one of these, and it is not
obvious: **row tearing on its own is nearly invisible.**

Measured on a real 140×44 screen, one burst of `shift` / `flip` / `color` corruption disturbs
about **2% of the visible glyphs**. That is a real effect, and a viewer will not notice it. What
they notice is a pass that recolors the **entire frame** for the two to four frames the burst
lasts, and then releases. Without one, you have a glitch that a stopwatch can find and an eye
cannot.

All the perceived punch comes from what happens to the **whole frame** for those two to four
frames — and that is **two distinct jobs**, not one.

**Job one — a whole-frame pass that MOVES or REMOVES colour**, gated on the burst. Each theme
picks the idiom that matches what kind of machine is failing.

**Chromatic aberration** (AUGMENTED). For each cell, take the red channel from a cell offset to
the left, green from itself, and blue from a cell offset to the right, with the offset growing
with radial distance from the screen center. The color layers slide out of register, strongest
at the edges, zero at the center, then snap back. This is the failure mode of a **spliced**
system — separate layers that lost sync with each other. It suits a palette that already has
distinct color layers (amber / teal / purple) to pull apart.

**Chroma dropout** (TACTICAL). For each cell, slide the color toward its own Rec. 601 luma by
`amount`. The frame briefly goes monochrome and snaps back — a CRT losing chroma sync. This is
the failure mode of an **analog** system. Apply it to foreground _and_ background, or the glow
halo stays warm around desaturated text and reads as a rendering bug rather than a signal fault.

```
luma = 0.299R + 0.587G + 0.114B
R' = R + (luma - R) * amount     # and likewise G, B. No clamping needed:
                                 # luma always lies between min and max channel.
```

The critical property — and the reason this section was rewritten — is that **dropout can only
pull colour toward gray.** By construction it cannot produce a hue, an orange, or a block. A burst
carried by dropout alone therefore reads as _"the screen just darkened in some rows"_: technically
~87% of glyphs changed, perceptually a desaturation. (An RGB channel split _would_ invent hues,
but the wrong ones — it fringes an all-warm palette with cyan and magenta, and TACTICAL stops
looking like a warm tube.) Neither whole-frame pass can add a warm hue that was not already on
screen. A desaturating theme needs a second job.

**Job two — an injection pass that PAINTS colour the whole-frame pass cannot.** Also gated on the
burst, chosen once when it begins and held for its duration. Two kinds, both drawing from a
per-theme `corruptColors` list (theme tokens only — no literal escapes `theme/*`):

- **Blocks.** Stamp a few solid rectangles (3–9 cells wide, 1–3 rows tall) of one corrupt colour
  by setting the cell **background** and forcing the glyph to a space, so the cell reads as a
  filled tile. They land anywhere — over body text, over the `TART` ascii-font logo, over panel
  borders — turning a chunk of the frame a solid amber / red / gray.
- **Tints.** Replace the **foreground** of a run of cells with one chosen corrupt colour. Unlike
  the `color` row-kind (which _smears a neighbour's_ colour), a tint _injects_ a colour you chose:
  a run of text, or a stretch of border, abruptly goes burnt-orange or neon red.

**Ordering is load-bearing.** The stages run rows → whole-frame → injection, and injection **must
be last**. Paint a block _before_ dropout and the dropout pass desaturates it back toward gray —
you paint amber and wash it out in the same frame, straight back to the original bug. Painting
after the desaturation is what lets the injected colour survive the burst at full saturation.
Proof: after a TACTICAL burst the injected cells read back as the _exact_ `corruptColors` hexes,
impossible if any desaturating pass ran after them.

**Borders get mangled by injection** — and there are _two_ traps in finding them, stacked.

First: the box-drawing codepoints are U+2500–U+257F, but the cell buffer does **not** store raw
Unicode. OpenTUI pools every non-ASCII glyph behind flag bits — `0x80000000 | graphemeId` for a
pooled glyph, `0xC0000000` for a wide-glyph continuation — so a border cell reads as `0x800100xx`,
never `0x25xx`. A codepoint-range test finds nothing at all. Detect a pooled glyph by its flag.

Second, and this one is silent: in JavaScript `&` yields a **signed** 32-bit integer, so

```js
;((char[i] & 0xc0000000) ===
	0x80000000(
		// ALWAYS FALSE. -2147483648 !== 2147483648
		(char[i] & 0xc0000000) >>> 0,
	)) ===
	0x80000000 // correct
```

The first form compiles, type-checks, runs, and quietly never matches — your border bias becomes
a no-op and the corruption simply lands somewhere else, which looks plausible. Coerce with
`>>> 0` before comparing any mask whose top bit is set. (I wrote the buggy form in a measurement
probe and it reported _zero_ border cells on a screen made of borders.)

Anchor a share of blocks and tints onto pooled cells. Borders dominate that set, so that is what
hits them: **~37 border cells corrupted per TACTICAL burst** against ~6 from row tearing alone.

**Keep the burst discipline.** Rows, the whole-frame pass, blocks, tints — all chosen when the
burst begins, held for its 2–4 frames, cleared when it ends, so the next frame is pristine.
Nothing persists; the UI tree is never touched. Applied every frame instead, aberration is a
permanent smear, dropout a washed-out theme, and the blocks a broken-looking overlay.

**Parameters.**

|                                   | AUGMENTED                          | TACTICAL                                      |
| --------------------------------- | ---------------------------------- | --------------------------------------------- |
| `chancePerSecond`                 | 0.5                                | 0.45                                          |
| `maxLines`                        | 3                                  | 3                                             |
| `maxShift`                        | 8                                  | 10                                            |
| `shiftFlipRatio`                  | 0.7                                | 0.75                                          |
| `colorGlitchChance`               | 0.3                                | 0.4                                           |
| `minDuration` / `maxDuration` (s) | 0.05 / 0.14                        | 0.05 / 0.16                                   |
| `chromaticAberration`             | **3**                              | 0                                             |
| `chromaDropout`                   | 0                                  | **0.4**                                       |
| `corruptColors`                   | amber · gold · teal · purple · red | amber · yellow · burnt · gold · red · 2× gray |
| `blockChance` / `maxBlocks`       | 0.6 / 2                            | 0.8 / 4                                       |
| `tintChance` / `maxTints`         | 0.6 / 3                            | 0.75 / 3                                      |

`corruptColors` obeys the same rule as the base palette: AUGMENTED keeps its cool signatures
(teal, purple); TACTICAL is warm tones + red + two dark grays and **nothing cool**. Verified over
300 forced bursts — TACTICAL introduces no foreground whose blue channel exceeds its red and green
(its one cool token, `merged` cyan, is never a corrupt colour), while AUGMENTED's aberration
deliberately fringes cyan/magenta.

**Balancing.** Compare the whole-frame passes by mean per-glyph RGB displacement, not changed-cell
counts — aberration makes a large change to a quarter of the screen, dropout a moderate change to
all of it. Injection is measured separately, by cells painted. (Numbers: one forced burst,
averaged over 300, on a clean 140×44 frame; `‖ΔRGB‖` is Euclidean fg distance over non-space
glyphs, 0–441.)

|                                           | mean ‖ΔRGB‖ | recolored (>30) | block bg / burst | tint fg / burst | border injected / burst |
| ----------------------------------------- | ----------- | --------------- | ---------------- | --------------- | ----------------------- |
| row tearing only (either theme)           | ~3          | ~1.3%           | 0                | 0               | 0                       |
| AUGMENTED (aberration + injection)        | 45          | 24%             | 10               | —¹              | 25                      |
| TACTICAL, old (dropout `0.6`, no inject)  | 70          | 87%             | 0                | 0               | 6²                      |
| TACTICAL, now (dropout `0.4` + injection) | 48          | 87%             | 24               | 57              | 28                      |

¹ AUGMENTED's tint-cell count can't be isolated: aberration coincidentally reconstructs exact
palette hexes, so the fg-match metric is swamped by aberration noise. Blocks set `bg` (untouched by
aberration) and are the clean proof: 0 → 10 per burst. ² TACTICAL's baseline 6 is a few cells where
a `shift` moves a space onto a border, not colour injection.

The lesson is in the two right-hand columns. TACTICAL's mean displacement _dropped_ (70 → 48) when
dropout went 0.6 → 0.4, but that number was always the wrong thing to maximise: the old wash scored
high on displacement and still read as "darkening", because displacement _toward gray_ is not
colour. Now ~24 solid colour-block cells and ~57 injected tint cells land per burst, in
warm/red/gray hues, where before there were none — the difference between a frame that darkens and
a frame that corrupts.

### 7.5 Three traps that will cost you an afternoon

**Parameter units.** Every one of these effects takes a scalar whose unit is not written
anywhere. `crtBar.speed` looks like a normalized fraction and is actually rows/second — off by
a factor of ~17 in the value that shipped here. `glow.radius` is in rows, and its kernel must be
widened by the cell aspect ratio. A wrong unit does not crash and does not look broken; it looks
like _the effect is subtle_, and you will spend an hour tuning the wrong knob. Derive the
observable quantity — "seconds per sweep," "cells of halo" — and check it against a measurement
before you trust any number.

**Time units.** A renderer that hands post-process functions a `deltaTime` will hand it in
_milliseconds_. Effects in the wild disagree about this — in OpenTUI, `CRTRollingBarEffect`
divides by 1000 internally (wants ms) while `DistortionEffect` treats the value as seconds. Feed
the latter milliseconds and `random() < chancePerSecond * deltaTime` fires on nearly every frame
while the duration comparison expires immediately: you get constant static instead of occasional
bursts, and it looks like a broken terminal. Convert explicitly at the boundary of every effect,
and write the unit in the parameter name (`deltaMs`).

**On-demand rendering.** Most terminal UIs render only when something changes. But a glitch
burst and a rolling bar are driven by _time_, not by state — they advance only on a rendered
frame. If nothing in your tree animates, the post-process chain never runs and the effects are
frozen after the first paint. Measured here: 4 frames in 1.2s versus ~35 with an explicit loop.
Start a continuous render loop (~30fps) if any time-driven pass exists.

---

## 8. Verifying it, without trusting your eyes

A terminal screenshot lies: it is monochrome text if you capture the characters, and a wall of
escape codes if you capture the bytes. Measure instead.

**Foreground histogram.** Capture the post-processed buffer, count non-space cells by foreground
color, and print a sorted histogram. This answers the questions that actually matter:

- _Is red rare?_ → red should be ~0.5% of glyph cells.
- _Does the foundation dominate?_ → amber and its tiers should top the list.
- _Is the palette intact?_ → the top colors should be your **exact theme hexes**. If you see
  `#ffffff` at the top, your glow is washing the foreground and something is broken.

**Background luminance distribution.** Sample `bg` luminance for every cell, sort, and read the
percentiles. Median ≈ 0 with a high p99 means a halo. A flat distribution means a wash. This is
the only reliable way to tune the glow.

**Bisect the chain.** Make every pass individually toggleable at runtime. When something looks
wrong, turn passes off one at a time and re-measure. The washing-out bug in §7.2 was invisible
until the glow was isolated, because turning off _any single other_ pass left it in place.

---

## 9. Reproduction checklist

1. Set the canvas to black (or, for a "dirty optic," a very dark warm brown). Make panels
   transparent, or one small step above the void.
2. Write the token interface (§3). Ban color literals outside it.
3. Choose the foundation hue and its bright/dim tiers, one cool relief hue, one "injected" hue,
   one critical hue, and a three-step text ramp.
4. Compute Rec. 601 luminance for every token. Place the glow threshold in the gap between the
   tier you want lit and the tier you want crisp (§4.4). Adjust hexes until a clean gap exists.
5. Map domain states onto slots. No green.
6. Uppercase all chrome. Adopt a heading prefix, `[ CHIP ]` brackets, `LABEL   value` readouts.
   Restrict yourself to narrow glyphs.
7. Build one bordered-panel primitive and use it for everything. Rows 1 cell tall, `paddingX 1`,
   numbers right-aligned.
8. Implement the glow as a glyph-aware, background-only, aspect-corrected outer glow. Tune it by
   percentiles, not by eye.
9. Add the glitch director: occasional bursts of `shift` / `flip` / `color` row corruption, with
   chromatic aberration gated on the burst.
10. Start a continuous render loop, or your time-driven effects will never run.
11. Measure: red rare, foundation dominant, no `#ffffff`, background median ≈ 0.
