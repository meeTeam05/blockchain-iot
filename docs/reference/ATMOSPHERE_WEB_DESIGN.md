---
version: alpha
name: Atmosphere-Web
description: Web port of the "Atmosphere" design system already shipping in app/ (Expo/React Native). This file is the single reference for building web3/'s UI (Task 5 dApp) without re-deriving tokens from the mobile codebase each time. Source of truth for every value below is app/src/theme/*.ts and app/src/components/atoms/*.tsx — this file documents them, it does not define new ones.

colors:
  brand: "#0F6B5C"
  brandDeep: "#0A4F44"
  brandTint: "#E4F0EC"
  brandTint2: "#D5E8E1"
  accent: "#2C6BF0"
  accentTint: "#E5EEFD"
  warn: "#E07A1A"
  warnTint: "#FFF1DF"
  danger: "#D9462E"
  dangerTint: "#FFE5E0"
  amber: "#E8A33C"
  mint: "#BFE6D8"
  online: "#1A8767"
  ink: "#0E1F1B"
  ink2: "#3F5751"
  ink3: "#6E827D"
  line: "#E3EAE7"
  line2: "#EEF3F1"
  bg: "#F5F7F6"
  paper: "#FFFFFF"

typography:
  pageTitle:
    fontFamily: "'Plus Jakarta Sans', sans-serif"
    fontSize: 36px
    fontWeight: 700
    letterSpacing: -0.9px
  h1:
    fontFamily: "'Plus Jakarta Sans', sans-serif"
    fontSize: 26px
    fontWeight: 700
    letterSpacing: -0.5px
  h2:
    fontFamily: "'Plus Jakarta Sans', sans-serif"
    fontSize: 22px
    fontWeight: 700
    letterSpacing: -0.4px
  label:
    fontFamily: "'Plus Jakarta Sans', sans-serif"
    fontSize: 11px
    fontWeight: 700
    letterSpacing: 1.4px
  body:
    fontFamily: "'Plus Jakarta Sans', sans-serif"
    fontSize: 15px
    fontWeight: 500
  caption:
    fontFamily: "'Plus Jakarta Sans', sans-serif"
    fontSize: 13px
    fontWeight: 400
  pill:
    fontFamily: "'Plus Jakarta Sans', sans-serif"
    fontSize: 11px
    fontWeight: 600
    letterSpacing: 0.2px
  mono:
    fontFamily: "'JetBrains Mono', monospace"
    fontSize: 13px
    fontWeight: 400

rounded:
  input: 16px
  button: 14px
  tile: 20px
  card: 22px
  pill: 999px

spacing:
  space2: 2px
  space4: 4px
  space6: 6px
  space8: 8px
  space12: 12px
  space16: 16px
  space20: 20px
  space24: 24px
  space32: 32px

components:
  app-bar-brand:
    height: 56px
    backgroundColor: "{colors.bg}"
    content: "logo + 'smart-air' left, actions right"
  app-bar-back:
    height: 56px
    backgroundColor: "{colors.bg}"
    content: "back arrow + title left, actions right"
  card:
    backgroundColor: "{colors.paper}"
    borderColor: "{colors.line}"
    borderWidth: 1px
    rounded: "{rounded.card}"
    padding: "{spacing.space16}"
  pill:
    rounded: "{rounded.pill}"
    padding: 4px 10px
    textTransform: uppercase
    typography: "{typography.pill}"
  button-primary:
    height: 52px
    backgroundColor: "{colors.brand}"
    textColor: "{colors.paper}"
    rounded: "{rounded.button}"
    disabledOpacity: 0.5
  button-danger:
    height: 52px
    backgroundColor: "{colors.danger}"
    textColor: "{colors.paper}"
    rounded: "{rounded.button}"
  button-ghost:
    height: 52px
    backgroundColor: "{colors.paper}"
    borderColor: "{colors.brand}"
    borderWidth: 1.5px
    textColor: "{colors.brand}"
    rounded: "{rounded.button}"
  confirm-dialog:
    backdrop: rgba(0,0,0,0.4)
    cardWidth: 85%
    rounded: 16px
    padding: 20px
  history-row:
    iconBoxSize: 40px
    iconBoxRounded: 10px
    iconBoxBackground: "{colors.line2}"
  empty-state:
    iconCircleSize: 120px
    iconCircleBackground: "{colors.line2}"
  field:
    height: 56px
    rounded: "{rounded.input}"
    borderWidth: 1px
    errorBorderColor: "{colors.danger}"
---

## Overview

Atmosphere-Web ports the existing "Atmosphere" design system to the browser for the
Task 5 dApp (`web3/`). It carries exactly one voice forward from `app/` (Expo/React Native): a calm teal-green brand (`{colors.brand}` —
`#0F6B5C`) on a near-white canvas, with semantic warn/danger accents reserved for
incident severity and transaction errors. There is no separate "web3 aesthetic" —
the dApp is a continuation of the same product, opened from the same app's
notification link.

**Key characteristics:**
- Single brand color (`#0F6B5C`), used sparingly on primary actions and the brand
  mark — never as a large fill.
- Semantic colors carry real meaning, not decoration: `warn` (#E07A1A) = early
  warning / pending, `danger` (#D9462E) = exceeded / reverted tx, `online` (#1A8767)
  = confirmed / resolved, `accent` (#2C6BF0) = acknowledged / informational.
- Soft, rounded geometry throughout: `{rounded.pill}` (999px) for every badge and
  status chip, `{rounded.card}` (22px) for every container, `{rounded.button}`
  (14px) for actions. No sharp corners.
- Numeric/hex values (hashes, addresses, tx IDs) always render in
  `{typography.mono}` (JetBrains Mono) — never the UI sans font.
- Light mode only for this phase (see Known Gaps).

## Colors

### Brand & Semantic
- **Brand** (`{colors.brand}` — #0F6B5C): primary buttons, links, brand mark.
- **Brand Deep** (`{colors.brandDeep}` — #0A4F44): press/active state.
- **Brand Tint** / **Brand Tint 2** (`#E4F0EC` / `#D5E8E1`): soft background for
  brand-tone pills and highlighted rows.
- **Accent** (`{colors.accent}` — #2C6BF0) + **Accent Tint** (#E5EEFD): secondary
  informational tone — used for "acknowledged" status.
- **Warn** (`{colors.warn}` — #E07A1A) + **Warn Tint** (#FFF1DF): early-warning
  severity, pending states.
- **Danger** (`{colors.danger}` — #D9462E) + **Danger Tint** (#FFE5E0): exceeded
  severity, reverted/error transaction states.
- **Online** (`{colors.online}` — #1A8767): confirmed/resolved/device-online
  states. [source: app/src/theme/appColors.ts — lives outside tokens.ts as a
  theme-independent brand color, not a palette-derived one]
- **Amber** (#E8A33C) / **Mint** (#BFE6D8): decorative-only, not used for status.

### Neutrals & Surface
- **Ink** / **Ink2** / **Ink3** (#0E1F1B / #3F5751 / #6E827D): text primary,
  secondary, tertiary (captions, disabled).
- **Line** / **Line2** (#E3EAE7 / #EEF3F1): borders and icon-box backgrounds.
- **Bg** (#F5F7F6): page background. **Paper** (#FFFFFF): card/surface background.

### Alpha blending
RN's `withAlpha(hex, alpha)` helper [source: app/src/theme/color.ts] produces
an rgba() string. On the web, use Tailwind's native opacity-modifier syntax
instead: `bg-[#1A8767]/15` is the direct equivalent of `withAlpha('#1A8767', 0.15)`.

## Typography

Font family: **Plus Jakarta Sans** (UI text, all weights) + **JetBrains Mono**
(hashes, addresses, tx IDs, numeric values). Both are open Google Fonts — no
licensing constraint, unlike proprietary brand typefaces. [source: app/src/theme/textStyles.ts]

| Token | Size | Weight | Letter spacing | Use |
|---|---|---|---|---|
| `{typography.pageTitle}` | 36px | 700 | -0.9px | Top-level page heading |
| `{typography.h1}` | 26px | 700 | -0.5px | Section heading, empty-state title |
| `{typography.h2}` | 22px | 700 | -0.4px | Dialog title |
| `{typography.label}` | 11px | 700 | 1.4px | Uppercase field/section labels |
| `{typography.body}` | 15px | 500 | 0 | Default body text |
| `{typography.caption}` | 13px | 400 | 0 | Secondary/sub text, timestamps |
| `{typography.pill}` | 11px | 600 | 0.2px | Badge text (always uppercase) |
| `{typography.mono}` | 13px | 400 | 0 | Hex hashes, addresses, tx hashes, sequence numbers |

## Layout

Spacing scale (4px base unit): `{spacing.space2}` 2px · `{spacing.space4}` 4px ·
`{spacing.space6}` 6px · `{spacing.space8}` 8px · `{spacing.space12}` 12px ·
`{spacing.space16}` 16px · `{spacing.space20}` 20px · `{spacing.space24}` 24px ·
`{spacing.space32}` 32px. [source: app/src/theme/tokens.ts]

Content is mobile-first and narrow by default — the dApp is most often opened
inside MetaMask Mobile's in-app browser via a deep link from a notification, not
from a desktop bookmark. A single centered column (max ~480px) is sufficient for
Task 5's three routes; no multi-column desktop layout is required for M1-M3.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Flat | 1px `{colors.line}` border, no shadow | Default card state (`AtmosphereCard` non-elevated) |
| Elevated | `shadowCard`: `0 4px 12px rgba(0,0,0,0.067)` | Cards that need to stand out (e.g. active incident card) |
| Modal | `shadowFab`-style deeper shadow or backdrop-only | `confirm-dialog` backdrop `rgba(0,0,0,0.4)` is usually enough; no extra card shadow needed under a dark backdrop |

[source: app/src/theme/tokens.ts — shadowCard, shadowFab]

## Shapes

| Token | Value | Use |
|---|---|---|
| `{rounded.pill}` | 999px | Status badges, chips |
| `{rounded.card}` | 22px | Device cards, incident cards, verify block |
| `{rounded.button}` | 14px | Primary/danger/ghost buttons |
| `{rounded.tile}` | 20px | Reserved — sensor-tile pattern, not used by Task 5 |
| `{rounded.input}` | 16px | Text inputs (login form) |

## Components

### App bar
**`app-bar-brand`** — used on `/`. Logo + "smart-air" wordmark left, wallet-connect
button / connected-address chip right. 56px content height.
**`app-bar-back`** — used on `/d/:deviceId` and `/d/:deviceId/i/:incidentId`. Back
arrow (lucide `ArrowLeft`) + page title left, actions right.
[source: app/src/components/shell/AtmosphereAppBar.tsx]

### Card
**`card`** — `{colors.paper}` background, 1px `{colors.line}` border, `{rounded.card}`
(22px), `{spacing.space16}` padding, optional elevated shadow. Used for every
device card, incident card, and the verify checklist block.
[source: app/src/components/atoms/AtmosphereCard.tsx]

### Pill (status badge)
Six tones, each a `(background, text)` pair. Background values are exactly
`app`'s [source: app/src/components/atoms/Pill.tsx]. **Text values are
web-only overrides**, darkened to pass WCAG AA — see note below.

| Tone | Background | Text (app, mobile) | Text (web, AA-adjusted) | Contrast | Task 5 use |
|---|---|---|---|---|---|
| `online` | `withAlpha('#1A8767', 0.15)` on paper → `rgb(221,237,232)` | `#1A8767` (3.69:1 — fails AA) | `#17765A` | 4.60:1 | device online, incident resolved |
| `offline` | `withAlpha(ink3, 0.15)` → `rgb(233,236,236)` | `#6E827D` (3.43:1 — fails AA) | `#5C6D69` | 4.60:1 | device offline, "chờ đăng ký on-chain" |
| `warn` | `warnTint` = `#FFF1DF` | `#E07A1A` (2.71:1 — fails even large-text AA) | `#A65A13` | 4.60:1 | incident severity = warning / pending ack |
| `brand` | `brandTint` = `#E4F0EC` | `#0F6B5C` (5.48:1 — already passes) | `#0F6B5C` (unchanged) | 5.48:1 | neutral/"Bạn" owner label |
| `accent` | `accentTint` = `#E5EEFD` | `#2C6BF0` (4.02:1 — fails AA) | `#1A5FEF` | 4.60:1 | incident status = acknowledged |
| `danger` | `dangerTint` = `#FFE5E0` | `#D9462E` (3.60:1 — fails AA) | `#BF3923` | 4.60:1 | incident severity = danger, tx reverted |

**Why this diverges from app:** computing WCAG 2.1 contrast on the exact
hex pairs shipping in `app` today shows 5 of 6 pill tones fail AA for
normal-weight 11px text (the pill label size) — `warn` fails even the relaxed
3:1 large-text threshold. This is a pre-existing gap in the mobile apps, not
something Task 5 introduced; it is **not** fixed here in `tokens.ts`/`Pill.tsx`
(out of scope — would ripple across every screen in two apps the team doesn't
own under Task 5). For the web dApp specifically, since incident severity is
safety-relevant and the code is new, the **text** color only is darkened in
HSL-lightness space until contrast reaches ≥4.6:1, keeping the exact same
background tint so the badge still reads as "the same color family" at a
glance. [source: computed 2026-10-01 via the WCAG 2.1 relative-luminance
formula — see tmp/02_decisions/2026-10-01_task5-dapp-incident-decisions.md
decision #21]

Label always renders uppercase in `{typography.pill}`.

### Buttons
**`button-primary`** — 52px height, `{colors.brand}` background, white text,
`{rounded.button}`, built-in loading spinner state. Maps directly onto the
`<TxButton>` states `simulating` / `awaiting_wallet` / `pending` (render as
`loading=true`).
**`button-danger`** — same geometry, `{colors.danger}` background. Use for
decode-error retry actions.
**`button-ghost`** — same geometry, transparent background, 1.5px brand border,
brand text. Use for secondary actions (e.g. "Hủy" next to a primary confirm).
[source: app/src/components/atoms/PrimaryButton.tsx, DangerButton.tsx, GhostButton.tsx]

### Confirm dialog
Backdrop `rgba(0,0,0,0.4)`, centered card at 85% width (cap at ~400px on desktop),
`{rounded.card}`-adjacent 16px radius, 20px padding. Title in `{typography.h2}`,
message in `{typography.body}`, Cancel/Confirm right-aligned with 16px gap. Maps
directly onto the TxButton confirmation step before `simulateContract`.
[source: app/src/components/atoms/ConfirmDialog.tsx]

### History row
40×40px icon box (`{colors.line2}` background, 10px radius) + two-line text
(label in `{typography.body}`, sub in `{typography.caption}`) + optional trailing
Pill. Used for every row in B6 ("Lịch sử on-chain").
[source: app/src/components/atoms/HistoryRow.tsx]

### Empty state
120px icon circle (`{colors.line2}` background) + `{typography.h1}` title +
`{typography.body}` body + optional primary/secondary action buttons. Used for
"chưa có incident" and "chưa đăng ký on-chain" states.
[source: app/src/components/atoms/EmptyState.tsx]

### Field
Label above (`{typography.body}`), 56px input (`{rounded.input}`, 1px border,
border turns `{colors.danger}` on error), error caption below in
`{typography.caption}` danger-colored. Used for the API login form (B1).
[source: app/src/components/atoms/Field.tsx]

## Task 5 component map

| B-block | Component(s) |
|---|---|
| B0 (domain mismatch banner) | full-width `{colors.dangerTint}` banner below app-bar, locks every `button-primary`/`button-danger` on the page |
| B1 (login + wallet connect) | `field` × 2, `button-primary` (login), address chip in app-bar |
| B2 (device list) | `card` × N, `pill` (active/revoked/chờ đăng ký), `empty-state` if list is empty |
| B3 (incident list + detail) | `card`, `pill` (severity + merged chain/API status), `app-bar-back` |
| B4 (verify) | `card` containing 4 checklist rows (✅/❌ rendered as `online`/`danger` pill or lucide `Check`/`X`), "copy verify link" `button-ghost` |
| B5 (acknowledge/resolve) | `button-primary` (Acknowledge), `button-ghost` or `button-danger` (contextual), `confirm-dialog` for the tx flow |
| B6 (on-chain history) | `history-row` × N inside a `card` |

## Do's and Don'ts

### Do
- Reuse `{colors.*}` hex values exactly as listed — they are the same values
  shipping in `app`, not approximations.
- Render every hash/address/tx-id in `{typography.mono}`.
- Use `{rounded.pill}` for every badge, `{rounded.card}` for every container —
  never introduce a new radius value.
- Drive the `<TxButton>` loading state through `button-primary`'s existing
  `loading` prop pattern rather than building a separate spinner component.

### Don't
- Don't invent a new "web3" dark/neon palette — this is the same product as
  `app`, not a separate brand.
- Don't use `danger`/`warn` as large background fills outside pills and banners
  — in the source apps they are reserved for text/badge tones.
- Don't skip the domain-mismatch banner lock from B0 — it is a safety control,
  not a cosmetic detail.

## Responsive Behavior

| Range | Behavior |
|---|---|
| < 640px (default — MetaMask Mobile in-app browser) | Single column, full-width cards, app-bar actions collapse to icon-only |
| ≥ 640px (desktop, manual testing/demo) | Content caps at ~480px centered column; no multi-column grid needed for Task 5's three routes |

## Known Gaps

- Dark mode is intentionally **not** specified here. `app` both default
  to light mode and ship a `darkPalette` in `palette.ts`, but Task 5 scopes to
  light-only for M1-M3 (decision #17, `tmp/02_decisions/2026-10-01_task5-dapp-incident-decisions.md`).
  If dark mode is added later, port `darkPalette`'s values the same way this file
  ports `lightPalette`.
- Task 8 (wallet/keeper/params pages) components are out of scope for this file
  — it only maps B0-B6.
- `SensorTile`, `Sparkline`, `ModeCard`, `RelayCard`, `AiCard`, `FilterChip`,
  `StepDots`, `TextLinkButton`, `PromptDialog`, `AtmosphereSwitch`, `DotLogo` exist
  in `app/src/components/atoms/` but have no Task 5 use and are not mapped
  here.
- Exact Tailwind config (CSS variable names, font loading via `@fontsource` or a
  Google Fonts `<link>`) is left to implementation — this file specifies values,
  not the build wiring.
