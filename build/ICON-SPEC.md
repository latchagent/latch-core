# Latch Desktop — App Icon Specification

Design a cross-platform app icon for **Latch** — a terminal-first control plane
for AI coding agents that wraps PTY shells, manages git worktrees, enforces
policies, and coordinates multi-agent workflows.

---

## Concept

A single, geometric glyph that evokes a **latch mechanism** — something that
fastens, governs, and controls. The icon should feel like it belongs next to
Warp, Raycast, or Linear in someone's dock: precise, quiet, unmistakably a
developer tool.

The mark is a **left square bracket `[` with a downward-facing catch/hook at the
end of its top bar** — the bracket reads as code/terminal, and the hook
transforms it into a latch clasp. Two ideas in one glyph: developer tooling
meets governance.

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                         ┃
┃   ┌──────────────┐      ┃
┃   │              │      ┃  ← catch/hook
┃   │              └──────┛
┃   │
┃   │
┃   │
┃   │              ┌──────┐
┃   └──────────────┘      ┃
┃                         ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

At 16×16 it reads as a clean bracket. At 512×512 the latch detail becomes the
distinctive element.

---

## ASCII wordmark (reference)

The app's existing ASCII identity, rendered in the welcome screen:

```
██╗      █████╗ ████████╗ ██████╗██╗  ██╗
██║     ██╔══██╗╚══██╔══╝██╔════╝██║  ██║
██║     ███████║   ██║   ██║     ███████║
██║     ██╔══██║   ██║   ██║     ██╔══██║
███████╗██║  ██║   ██║   ╚██████╗██║  ██║
╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝
```

The icon glyph should feel like it comes from the same family — geometric,
monospaced cadence, block-letter confidence.

---

## Visual direction

- The glyph is a single filled shape (not stroked). Thick, confident bars with
  uniform weight (~7% of canvas width).
- The shape should feel machined — precise corners, deliberate proportions. Not
  playful, not rounded. Think CNC-cut metal, not hand-drawn.
- A top-to-bottom linear gradient gives the glyph subtle dimensionality: bright
  white at the top fading to a muted silver at the bottom, as if lit from a
  single overhead source.
- A very faint ambient glow behind the glyph suggests the mark is self-luminous
  — a shape materializing on a dark display.

---

## Color

| Element     | Value                              | Notes                                    |
|-------------|------------------------------------|------------------------------------------|
| Background  | `#000000` (pure black)             | Matches app's `--bg-app` token           |
| Glyph top   | `rgba(255,255,255,0.95)`           | Near-white, matches welcome ASCII title  |
| Glyph bottom| `rgba(255,255,255,0.55)`           | Silver fade, same gradient as wordmark   |
| Glow        | `#ffffff` at 8% opacity, 12px blur | Barely visible halo behind the glyph     |

No accent color. The monochrome palette is the brand — pure black and white,
like a terminal waiting in the dark.

---

## Geometry (1024×1024 canvas)

The glyph is centered at (512, 512) with ~20% optical padding.

| Element        | Coordinates (x, y, w, h)         |
|----------------|----------------------------------|
| Vertical bar   | (292, 232) → 72 × 560           |
| Top bar        | (292, 232) → 440 × 72           |
| Bottom bar     | (292, 720) → 440 × 72           |
| Catch/hook     | (660, 304) → 72 × 128           |

Total glyph bounds: 440 × 560, centered.

---

## Style constraints

- **macOS Big Sur / Sequoia language**: rounded super-ellipse (squircle) mask
  applied by the OS. The 1024×1024 PNG is square with the black background
  filling the full canvas.
- **No text, no letters** inside the icon. The bracket glyph is abstract enough
  to not read as a specific letter.
- **No generic AI imagery** — no brain, no circuit board, no robot, no sparkles.
- **No glossy or skeuomorphic finishes**. The depth comes from the single
  gradient and the faint glow, nothing more.
- Reads clearly at 16×16 and looks refined at 512×512.
- Feels like a tool made by someone who ships at 2 AM — quiet confidence, not
  shouting for attention.

---

## Mood references

- A cursor blinking in the void, waiting for a command
- The glow of a single terminal in a dark server room
- Machined aluminum, matte anodized black
- The way Linear's icon is just geometry that implies precision
- A latch clicking shut — satisfying, definitive, controlled

---

## What to avoid

- Literal locks, padlocks, keys, or shield shapes
- Bright colors, busy gradients, multiple accent hues
- Rounded / bubbly / friendly shapes — this is infrastructure, not a consumer app
- Anything that looks AI-generated (suspiciously smooth, too symmetric gradients)
- Generic developer icons (wrench, gear, code brackets `</>`, terminal prompt `>_`)
- The letter "L" — the bracket glyph should read as abstract, not alphabetic

---

## Platform outputs

| Platform | Format         | Sizes                                         |
|----------|----------------|-----------------------------------------------|
| macOS    | `.icns`        | 16, 32, 64, 128, 256, 512, 1024 (+ @2x)      |
| Windows  | `.ico`         | 16, 24, 32, 48, 64, 128, 256                  |
| Linux    | `.png` set     | 16, 24, 32, 48, 64, 128, 256, 512             |
| Source   | `.svg` + `.png`| 1024×1024, transparency                        |

The source SVG lives at `build/icon.svg`. All rasterized assets are generated
by `scripts/generate-icons.mjs`.

---

## Tagline (for reference, not in the icon)

> Run any agent. Govern everything.
