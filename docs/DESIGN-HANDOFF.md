# What to hand a designer

This is the brief for somebody designing new screens for Xetral, and the
reason it is written this way: **the constraint is not the tool they design in,
it is that one design has to be built twice.** The web app is HTML and CSS; the
phone app is React Native, which has no CSS, no cascade, no media queries and
no `gap` on every layout. A screen that only works in one of them is half a
screen.

So the ask is not "a pretty mockup". It is **a mockup pinned to the system
below**, because everything in that system already exists in both apps and can
be shipped without reinterpretation.

---

## 1. The stack, for the designer's information

| Part | What it is |
|---|---|
| Web app | **Next.js 16** (App Router, React 19.1, `--webpack` not Turbopack), TypeScript |
| Phone app | **Expo SDK 54 / React Native 0.81.5**, `expo-router`, TypeScript |
| Styling, web | **Plain CSS** in one stylesheet, `apps/web/src/app/globals.css`, driven by custom properties. No Tailwind, no CSS-in-JS, no component library |
| Styling, phone | **`StyleSheet.create`** against tokens in `apps/mobile/src/theme.ts`, which mirror the web's by name |
| Shared logic | `packages/client` — money formatting, the API surface, error codes, currency marks, catalogues. Both apps import it |
| Icons | Hand-drawn SVG paths in `packages/client/src/icons.ts`, rendered by `ui/icon.tsx` on web and `react-native-svg` on the phone. **No icon font, no icon package** |
| Fonts | **Inter** (everything) and **Spline Sans Mono** (figures in tables), self-hosted `.woff2`, no Google Fonts request |
| Backend | NestJS + PostgreSQL 16 — not something a designer touches, listed so nobody proposes a hosted UI kit that assumes a different one |

**There is no design tool file today.** The system lives in code. The fastest
path is for the designer to work in Figma and for the tokens below to be set up
as Figma variables and text styles first — then every mockup is already
expressed in the vocabulary the build uses.

---

## 2. The tokens — these are the design system

Copy these into Figma as variables before drawing anything. They are the real
values from `globals.css`, and a mockup using a colour that is not here is a
mockup that cannot be built exactly.

### Colour — light

| Token | Value | What it is |
|---|---|---|
| `--brand` | `#0D1B3E` | Navy. Primary buttons, headings, the mark |
| `--accent` | `#F5A623` | Amber. The mark's stroke, promotional flashes |
| `--link` | `#4B7BF5` | Links and selected states |
| `--bg` | `#FFFFFF` | The page |
| `--surface` | `#F1F3F9` | Cards, panels — **recessed**, one step down from the page |
| `--field` | `#E4E8F0` | A text input — one step down from the card holding it |
| `--surface-raised` | `#FFFFFF` | Only what floats: menus, sheets, modals |
| `--line` | `#E7EAF0` | A divider between things that would otherwise run together |
| `--line-strong` | `#D5D9E2` | A heavier divider |
| `--text` | `#0D1B3E` | Body text |
| `--text-muted` | `#4A5878` | Secondary text |
| `--on-brand` | `#FFFFFF` | Text on a navy fill |
| `--ok` / `--ok-bg` | `#0F9D58` / `#E7F6EE` | Money arriving, success |
| `--warn` / `--warn-bg` | `#B7791F` / `#FDF3E2` | Pending, attention |
| `--danger` / `--danger-bg` | `#D64545` / `#FDECEC` | **Money leaving**, errors |
| `--info` / `--info-bg` | `#3866E0` / `#EAF0FE` | Neutral information |

### Colour — dark

Dark is a **real second palette, not an inversion**, and every screen must be
drawn in both. The values that surprise people:

| Token | Dark value | Note |
|---|---|---|
| `--brand` | `#FFFFFF` | **The brand colour inverts to white.** A "navy button" is a white button in dark |
| `--bg` | `#000000` | True black |
| `--surface` | `#0C0D10` | |
| `--field` | `#141519` | |
| `--surface-raised` | `#1B1D23` | |
| `--edge` | `var(--line)` | **In light this is `transparent`.** A light card is already darker than the page, which is what reads as recessed; on black there is no darker fill to recess into, so dark keeps a hairline and light does not |
| `--text` | `#EEF2FA` | |
| `--on-brand` | `#0D1B3E` | Navy text on the white "brand" fill |

### Spacing — six steps, and nothing between them

```
--s-1:  6px   a label to its field, a heading to its own subtitle
--s-2: 10px
--s-3: 14px   inside a card
--s-4: 18px
--s-5: 22px   between blocks on a page
--s-6: 32px   between parts of a page that are about different things
```

**Every gap in a mockup must be one of these six numbers.** This is the single
most common way a mockup becomes unbuildable-as-drawn: a 16px gap here and a
20px gap there means the build either invents a seventh step or rounds, and
rounding is how two screens stop lining up.

### Radii

```
--r-sm:  10px    --r: 14px    --r-md: 18px    --r-lg: 24px    --r-pill: 999px
```

### Type

One family — **Inter** — for headings, labels and body alike. The scale is what
separates them, not the typeface:

| Role | Size | Notes |
|---|---|---|
| Body | 15px | |
| h1 | 26px (30px from 720px wide) | |
| h2 | 19px (21px from 720px) | |
| h3 | 16px | |
| Hint / secondary | 13px | |
| Label (uppercase) | 12px | with letter-spacing |
| Balance figure | 34px (40px from 720px) | the one deliberately large thing |

**Spline Sans Mono** is used only where figures must line up in columns.

### Motion

One curve, three durations. Nothing in the product moves to a timing nobody
chose.

```
--ease:     cubic-bezier(.32, .72, 0, 1)
--t-fast:   140ms      --t: 220ms      --t-slow: 380ms
```

---

## 3. The rules a mockup must respect

These are not preferences. Each is something that has already gone wrong here,
and a design that ignores one produces a screen that has to be redrawn.

1. **Design at 320px first.** Not 375, not 390. A Nigerian customer on a small
   Android handset is a real customer, and the balance card's three buttons
   have already had to be redesigned once because they were wider than the
   card. Draw 320, 390 and a desktop width; the middle one is not enough.

2. **Both themes, every screen.** See the dark palette above — particularly
   that the brand colour inverts. A dark mockup produced by inverting a light
   one will be wrong.

3. **Money leaving is red; money arriving is green.** For a while an outgoing
   amount took the default text colour and the only thing separating "you were
   paid" from "you paid" at a glance was a minus sign.

4. **Never a native `<select>`, and never a dropdown for two options.** The
   closed control takes styling and the open list does not — Android draws a
   full-screen dialog in the system font and iOS a wheel, so a customer in dark
   mode gets a white sheet in a stranger's typeface. Use the app's own
   `ui/select.tsx`, and for two mutually exclusive choices use the `Segmented`
   control: full width, equal halves, the choice visible without opening
   anything.

5. **No emoji flags.** Windows ships no flag glyphs, so `🇳🇬` renders as the
   letters "NG" in a box — on the currency selector, which is on the screen
   every customer opens. Flags are drawn as SVG from data in
   `packages/client`. A flag is used **only where a flag is the recognisable
   thing**: naira, cedi and shilling are each one country's money; a dollar is
   not, and a US flag beside USD would be actively wrong next to USDT and USDC.

6. **No icon the icon set does not have.** Icons are hand-drawn paths in one
   file. A mockup using an icon from a stock set means somebody has to draw it
   to match the existing stroke weight — flag it deliberately rather than
   assuming.

7. **Tap targets are 44–48px.** Including on the web, which is used on phones.

8. **A disabled control must say why, next to itself.** A greyed-out button
   with its cause in another panel reads as a broken app. If a control can be
   disabled, the mockup needs the sentence that appears beside it.

9. **Every state, not just the happy one.** For each screen: loading, empty,
   error, and the refused case. "Empty" is where most fintech apps look
   unfinished, and it is the first screen a new customer sees.

10. **One design across Nigeria, Ghana and Kenya.** The three countries share
    every screen — only the currency, the rail and the copy differ, and all of
    that is data. Do not design a "Ghana screen".

11. **Lists scroll inside themselves where they must.** Five tabs do not fit
    across a 320px handset, and a row that does not fit makes the whole page
    scroll sideways. Rails scroll horizontally within their own strip.

12. **No amount on anything that reaches a lock screen.** Push notification
    copy carries no figure, ever — it is read by whoever picks the phone up.

---

## 4. What to send back, so it ships as an exact match

Ask for all of this. The first three are the ones that decide whether the build
is an exact match or an interpretation.

- **A Figma file using the variables above**, not raw hexes and not arbitrary
  spacing. If a token is missing for something the design needs, say so
  explicitly — adding a token is a decision, and silently using `16px` is not.
- **Light and dark frames for every screen**, at **320px, 390px and 1280px**.
- **Every state per screen**: default, loading, empty, error, disabled,
  success.
- **The copy, final.** Button labels, empty-state sentences, error messages.
  Words are design material here; placeholder text means the build invents it.
- **Redlines only where the design departs from the system** — spacing and
  colour come from tokens, so annotating them again is noise. What needs
  annotating is anything new.
- **Named components**, so a card in one screen and a card in another are
  identifiably the same component rather than two drawings that resemble each
  other.
- **Exported SVGs for any new icon or illustration**, single-colour and on the
  same grid as the existing set, so they can be dropped into
  `packages/client/src/icons.ts`.

---

## 5. The sentence to send them

> Design in Figma. Before you draw anything, set up the colour, spacing, radius
> and type tokens from `docs/DESIGN-HANDOFF.md` as Figma variables and text
> styles, and use only those values — every gap must be one of the six spacing
> steps. Every screen needs a light and a dark frame at 320, 390 and 1280
> wide, and every state: loading, empty, error, disabled. Copy should be final,
> not placeholder. Flags and icons are drawn as SVG and there is a fixed icon
> set, so tell us if you need one we do not have. It is one design for Nigeria,
> Ghana and Kenya — only the currency and the copy differ. And design 320px
> first: a lot of our customers are on small Android handsets.

---

## 6. Where the current system lives, for reference

| | |
|---|---|
| Tokens, web | `apps/web/src/app/globals.css` (the `:root` block) |
| Tokens, phone | `apps/mobile/src/theme.ts` |
| Shared primitives | `apps/web/src/ui/` — `select.tsx`, `icon.tsx`, `logo.tsx`, `toast.tsx`, `currency-mark.tsx`, `shell.tsx` |
| Icons and flags | `packages/client/src/icons.ts`, `packages/client/src/currency-marks.ts` |
| Customer screens | `apps/web/src/app/*/page.tsx` and `apps/mobile/app/*.tsx` — 17 each, same names |
| Operations screens | `apps/web/src/app/admin/` — 27, and not part of a customer-facing revamp unless asked |

A design-system change is a change to the token files plus a pass over every
screen in both apps. It is not a pile of bespoke screens — the parity tests
(`palette-parity.test.ts`, `class-coverage.test.ts`, `select-coverage.test.ts`)
fail the build when the two apps drift apart.
