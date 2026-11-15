# Build — 001-orders-page

## Summary
Added the Orders page: a table of orders with view and delete actions, a New order
form with per-field errors, a details dialog (also opened by `?order=<id>`), and an
Orders link in the main nav. Styles use the design tokens throughout.

## Changes
- `orders.html` — the page: heading, status region, New order form, orders list, details dialog.
- `styles/orders.css` — the page's styles.
- `js/orders.js` — loads, renders, adds and removes orders; opens and closes the dialog.
- `tests/orders.test.js` — tests for AC1–AC3 (with the empty and error states) and the dialog's deep link.
- `index.html` — Orders link in the main nav.

## Acceptance criteria
| AC | How it's met | Evidence (test name or check) |
|---|---|---|
| AC1 | `load()` and `render()` in `js/orders.js` | "AC1: lists the orders", "AC1: says when there are no orders", "AC1: says when the orders can't be loaded" |
| AC2 | The form's submit handler posts and renders the new row | "AC2: adds an order" |
| AC3 | `removeOrder()` deletes and re-renders | "AC3: removes an order" |
| AC4 | The submit handler puts the API's `error` in `<field>-error` | manual |
| AC5 | `openDetails()` / `closeDetails()`; Escape handler | "AC5: /orders?order=<id> opens that order's details"; closing by hand |

## Checks
`npm test`: 7 tests pass.

## Notes
The dialog keeps Tab inside itself while it's open.
