# Project profile

## Stack
A static web app: plain HTML, CSS and ES modules, no framework or build step.
`serve.mjs` (Node, no dependencies) serves the pages and a small in-memory orders API.

## Commands
- install: `npm ci`
- build: none
- test: `npm test` (`node --test tests/*.test.js`; the tests drive Chromium with Playwright)
- lint: none
- typecheck: none

## Test status
1 test passes (the home page).

## Layout
- `*.html` — one file per page; `serve.mjs` maps `/orders` to `orders.html`.
- `styles/tokens.css` — design tokens; `styles/app.css` — shared styles; one stylesheet per page.
- `js/` — page scripts; `js/api.js` has the API URL helper and formatting.
- `tests/` — Playwright tests run by `node --test`; `tests/helpers.js` starts the server and browser.

## Conventions
- Colours, spacing, font sizes, radii, focus ring and z-index come from the tokens
  in `styles/tokens.css`. No literal values where a token exists.
- Buttons use the shared `.button` class; focus is shown with `--focus-ring`.
- Status messages go in the page's `role="status"` element.

## Interface
Has UI: yes — a web app. Run it with `npm start` (port 3000, or `PORT`).
- Tests: Playwright through `node --test`, finding controls by role and label.
- Design tokens: `styles/tokens.css`. Shared styles: `styles/app.css`.
- Themes: light only.
- Static UI gates: none.
- The API takes `?state=empty` or `?state=error` (passed on from the page's URL by
  `js/api.js`) to return no orders or fail.
