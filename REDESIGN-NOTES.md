# SF SKODE – "Glass" redesign

A ground-up rebuild of the look, motion and navigation. Content, routes, article data, cover matching and the Playground
back end are unchanged.

## Run it
```
npm install          # needed once after this update: the font packages changed
npm run dev          # http://localhost:4321
npm run build        # production build to dist/
npm run test:sf      # Playground end-to-end tests against a mock org
```
Run these in the folder that contains `package.json`. Your covers in `src/assets/covers` are matched to articles by slug as before.
Playground setup: see `PLAYGROUND-SETUP.md` and `.env.example`.

## Identity
* **Glossy, soft, silky.** Frosted-glass surfaces (blur + saturation, thin light edge, soft shadow) float over a slow
  aurora background that drifts, shifts a little as you scroll, and has a faint pool of light following the pointer.
* **Type:** Inter (a close cousin of Apple's SF) for everything, tight display tracking, gradient emphasis instead of italics.
  Geist Mono is used for code only.
* **Light:** white glass over pale sky-blue. **Dark:** graphite glass with only faint colour glows (no navy).
* Pill buttons with a light sweep on hover, squircle icon tiles, generous radii (12 / 16 / 22 / 30). All tokens are at the
  top of `src/styles/base.css`.
* Layers: `reset, tokens, base, layout, components, pages, prose, motion`.

## What changed in this round
* **Covers are never cropped.** Cards size themselves to the image's own proportions (no zoom on hover either).
* **Featured carousel.** Three full cards in a scrolling row, every card is a real link. Arrows, swipe, keyboard
  (Left/Right when the row is focused) and dots.
* **Rotating badge** now fits the whole text: `SALESFORCE · LEARN · BUILD · SHIP ·` (SVG text is stretched to the circle).
* **Tag strip** is small quiet pills, no stars; it still speeds up/reverses with your scroll direction.
* **Tracks** are a bento grid of glass tiles (no hover image following the cursor).
* **Hover = tilt.** Cards, tiles and panels lean toward the pointer with a lit edge. The old overlay shadow on images is gone.
* **Kept as requested:** the labelled cursor, the card-to-article shared-cover page transition, the Agentforce background
  word drifting with scroll, the wavy theme switch.
* Footer wordmark reads **SKODE**.

## Motion (all progressive enhancement, all off under "reduce motion")
* Page transitions: diagonal wipe; the cover image travels between a card and its article and back (Chromium browsers).
* Theme switch: wave from the top-right corner to the bottom-left.
* Headlines reveal word by word; the home headline's letters rise and swell near the pointer, with a slow idle wave.
* Home: playground typing demo, scroll-reactive tag strip, "continue reading" strip.
* Everywhere: scroll progress line in the floating header, labelled cursor, parallax words, footer wordmark that swells
  under the pointer, mobile menu that opens with a glass wipe.

## Files worth knowing
| File | What it does |
| --- | --- |
| `src/styles/base.css` | tokens (light + graphite dark), reset, aurora, layout |
| `src/styles/ui.css` | buttons, forms, header, mobile menu, footer, cards, tiles, tilt edge |
| `src/styles/home.css`, `pages.css` | home sections; list/search/about/contact/article/prose + transitions |
| `src/scripts/motion.ts` | site-wide motion (reveals, cursor, aurora, tilt, progress, shared-cover transitions) |
| `src/scripts/home.ts` | kinetic headline, carousel, typing demo, marquee, live search |
| `src/scripts/theme.ts` | theme state + wave |

## Known limits
Tested in Chromium (desktop and mobile sizes, both themes). Shared-cover and page-wipe transitions are Chromium-only
enhancements. The Playground has not been run against a real Salesforce org.
