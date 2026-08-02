---
name: BunnyFile
description: Files, shared. That's it. — a quiet self-hosted file desk.
colors:
  background: "#f8fafc"
  foreground: "#0f1729"
  surface: "#ffffff"
  surface-2: "#f1f5f9"
  muted: "#ebeff5"
  muted-foreground: "#546378"
  border: "#dde4ee"
  ring: "#2463eb"
  primary: "#2463eb"
  primary-foreground: "#ffffff"
  secondary: "#3c83f6"
  accent: "#db7706"
  destructive: "#dc2828"
  success: "#1eae53"
  warning: "#f59f0a"
  dark-background: "#080c16"
  dark-foreground: "#f8fafc"
  dark-surface: "#101623"
  dark-primary: "#3c83f6"
  dark-accent: "#f69e23"
  dark-muted-foreground: "#94a3b8"
typography:
  display:
    fontFamily: "Figtree Variable, Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "3rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Figtree Variable, Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Figtree Variable, Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "Figtree Variable, Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Figtree Variable, Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.04em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "0.25rem"
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.75rem"
  xl: "1rem"
  2xl: "1.25rem"
spacing:
  page-x: "1rem"
  page-x-sm: "1.5rem"
  page-y: "2rem"
  stack: "1.5rem"
  control-gap: "0.5rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "2.75rem"
    padding: "0 1rem"
  button-primary-sm:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "2.5rem"
    padding: "0 0.75rem"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "2.75rem"
    padding: "0 1rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "2.75rem"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0 0.75rem"
  badge:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    padding: "0.125rem 0.5rem"
  card-surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "1.25rem"
---

# Design System: BunnyFile

## Overview

**Creative North Star: "The Quiet File Desk"**

*(Assumption — inferred from the product tagline “Files, shared. That’s it.” No PRODUCT.md interview was available.)*

BunnyFile’s UI should feel like a calm desk for real files: clear hierarchy, soft paper surfaces, and just enough brand warmth that it never reads as a generic SaaS admin. Density stays practical — Operate mode first. Expression lives in precise tokens, Figtree’s slightly friendly geometry, and a restrained amber accent against a trustworthy blue primary.

Depth comes from tonal layering and light ambient glows, not heavy chrome. Motion explains open/close and feedback; it never stages the product.

**Key Characteristics:**
- Semantic HSL tokens with light + dark themes
- Figtree Variable for UI; JetBrains Mono for code/paths
- Soft surfaces (`surface` / `surface-2`) over a cool paper background
- Blue primary + amber accent; red only for destructive work
- Mobile-first touch targets (≥44px) that densify from `sm` up

## Colors

Cool paper neutrals with a clear action blue and a warm amber for attention — never purple gradients or cream-serif editorial defaults.

### Primary
- **Trust Blue** (`#2463eb` / `hsl(221 83% 53%)`): primary actions, active nav, focus rings, links.

### Secondary
- **Bright Action Blue** (`#3c83f6`): secondary emphasis; dark-theme primary shift.

### Tertiary
- **Warm Amber** (`#db7706` / `hsl(32 95% 44%)`): accent highlights, unread dots, storage gradient endpoint. Use sparingly.

### Neutral
- **Cool Paper** (`#f8fafc`): app background
- **Ink** (`#0f1729`): body text
- **Sheet** (`#ffffff`) / **Sheet 2** (`#f1f5f9`): panels and nested wells
- **Quiet Ink** (`#546378`): secondary text (AA+)
- **Hairline** (`#dde4ee`): borders and dividers

### Status
- **Danger** `#dc2828` · **Success** `#1eae53` · **Warning** `#f59f0a`

### Named Rules
**The One Accent Rule.** Amber is a signal, not a theme. Prefer blue for routine actions; reserve amber for attention and brand sparks.

**The Token Rule.** Colors go through `hsl(var(--token))` (or the Tailwind `@theme` bridges). Do not invent one-off hex in components except true overlays that need pure black scrims.

## Typography

**Display / UI Font:** Figtree Variable (fallback: Figtree, system UI)
**Mono Font:** JetBrains Mono

**Character:** Slightly rounded, modern, and readable at dense UI sizes — friendlier than Inter without becoming display-y.

### Hierarchy
- **Display** (600, ~3rem / `text-4xl`–`text-5xl`, tight tracking): landing and empty-state heroes
- **Headline** (600, `text-2xl`–`text-3xl`): page titles (`Files`, dashboard)
- **Title** (600, `text-lg`): section headings, modal titles
- **Body** (400, `text-sm` / 14px): default product copy; keep ~65ch on marketing prose
- **Label** (500, `text-xs`, optional uppercase + tracking): eyebrows, meta, storage captions
- **Mono** (400–500, `text-sm`): paths, code viewers, keys

### Named Rules
**The Role Rule.** Size + weight + color together mark hierarchy. Don’t invent a new size for every screen — reuse the roles above.

## Layout

Operate shell: fixed sidebar (`w-64`) from `md` up; left drawer on small screens. Content columns cap around `max-w-6xl` (files/home) or `max-w-5xl` / `max-w-2xl` for narrower tools.

Page padding: `px-4 py-8` → `sm:px-6` (and `lg:px-8` where the files/home pages already do). Stack rhythm is generous (`space-y-6`–`space-y-8`); control clusters use tight `gap-2`.

Breakpoints follow Tailwind defaults (`sm` 640, `md` 768, `lg` 1024). Primary toolbars must wrap; never force a single non-wrapping action row on phones.

## Elevation & Depth

Hybrid: mostly flat tonal surfaces with soft ambient shadows and optional glass (`backdrop-blur`) on chrome (topbar, sidebar). Overlays use a dark scrim + blur.

### Shadow Vocabulary
- **Sheet** (`shadow-sm` / `shadow-md shadow-black/5`): resting panels and file browser
- **Lifted** (`shadow-xl shadow-black/5`, dark: `/30`): auth cards and modals (`shadow-2xl`)
- **Ambient glow**: radial brand washes behind shells (`primary` / `accent` at low alpha) — decorative, `aria-hidden`

### Named Rules
**The Flat-By-Default Rule.** Surfaces rest flat. Shadows respond to elevation (modal, auth card) or hover on interactive sheets — not every card.

## Shapes

Radii from tokens: controls `md` (8px), panels `xl`–`2xl` (16–20px), pills only for tiny badges/chips. Borders are 1px hairlines using `--border`. Active sidebar items may use a thin left rail (`w-0.5`); never a thick AI “side-tab” card border.

## Components

### Buttons
- **Shape:** `rounded-md` (8px); touch-first heights (`min-h-11`) densifying from `sm`
- **Primary / Accent / Destructive:** filled semantic colors
- **Outline / Ghost / Secondary:** quiet chrome for secondary work
- **Focus:** ring using `--ring` + offset against `--background`
- **Loading:** spinner replaces leading icon; button disabled while pending

### Cards / Containers
- Surface fill + 1px border + `rounded-xl`/`rounded-2xl`
- Internal padding typically `p-5`–`p-6`
- Prefer tonal nesting (`surface-2` wells) over stacked bordered cards

### Inputs / Fields
- `h-9` field on `surface`, border `--input`
- Focus: border `--ring` + soft 4px ring at 15% alpha
- Icons inset left/right; always pair with a visible `Label` or `aria-label`

### Navigation
- Sidebar links: icon + label; `aria-current="page"` when active
- Active: primary-tinted fill + thin left rail
- Mobile: hamburger opens left drawer with the same sidebar

### Badges
- Compact, `rounded-sm`; outline “live” only for truly polled metrics

### Modals / Drawers
- Radix dialog primitives; titled + described; close control ≥40px on touch
- Content animates with short opacity/scale; reduced-motion collapses to opacity only

## Do's and Don'ts

### Do:
- **Do** use semantic tokens (`--primary`, `--surface`, `--destructive`, …) for every durable color.
- **Do** keep icon-only controls labeled (`aria-label`) and ≥44×44px on touch viewports.
- **Do** announce errors with `role="alert"` and pair searches with accessible names.
- **Do** reserve “live” / shortcut chrome for behaviors that actually exist.

### Don't:
- **Don't** ship Inter / Geist / Plus Jakarta / Space Grotesk as the UI face.
- **Don't** nest forms or use placeholder text as the only field label.
- **Don't** blanket-kill motion to `0.01ms` — keep brief opacity feedback for state changes.
- **Don't** decorate with thick side borders, gradient text, or purple-on-white SaaS skins.
