# Orders page

## Goal
Shop staff can see the shop's orders on one page, add an order taken over the phone,
look at an order's details, and remove an order entered by mistake.

## Context
- `serve.mjs:31-49` — the orders API: `GET /api/orders`, `POST /api/orders` (422 with
  `{ field, error }` when a field is invalid), `DELETE /api/orders/<id>`. Already done.
- `serve.mjs:51-64` — `page()`: `/orders` serves `orders.html`.
- `js/api.js` — `apiUrl()` (passes `?state=` on), `money()`, `escapeHtml()`.
- `styles/tokens.css` — the tokens to use; `styles/app.css` — `.button`, `.visually-hidden`, focus ring.
- `index.html:13-15` — the main nav; add an Orders link.
- `tests/helpers.js`, `tests/home.test.js` — how tests start the server and drive Chromium.

## Scope
- `orders.html`, `styles/orders.css`, `js/orders.js`: the page.
- A table of orders: number, customer (with the number of items), date placed, status,
  total, and actions to view and delete each one.
- A New order form: customer and total.
- A details dialog for one order, also opened by `/orders?order=<id>`.
- An Orders link in the main nav.

## Out of scope
- Editing orders. Paging or sorting the table. Signing in.

## Screens
| Screen | State | How to reach it |
|---|---|---|
| `/orders` | default | The three orders `serve.mjs` starts with. |
| `/orders` | empty | `/orders?state=empty` — the API returns no orders. |
| `/orders` | error | `/orders?state=error` — the API returns 500. |
| `/orders` | details-dialog | `/orders?order=1` opens order #1's details. |

## Acceptance criteria
1. AC1 — `/orders` lists every order with its number, customer, item count, date
   placed, status and total. With no orders it says so and what to do next; when the
   orders can't be loaded it says so and how to recover.
2. AC2 (flow) — add an order:
   1. On `/orders` (default), type "Grace Hopper" in **Customer** and "18.75" in **Total (£)**.
   2. Press **Add order**.
   3. Expect: a row for Grace Hopper appears and "Order added." is announced.
3. AC3 (flow) — remove an order:
   1. On `/orders` (default), press **Delete** on order #1.
   2. Expect: order #1 is gone from the list and "Order removed." is announced.
4. AC4 — a rejected order shows the API's message under the field it names
   ("Enter a total greater than 0."), and keeps what was typed.
5. AC5 — **View order #<n>** opens that order's details in a dialog; **Close** or
   Escape closes it and puts focus back on the button that opened it.

## Test plan
- AC1–AC3: Playwright tests in `tests/orders.test.js`, run by `npm test`. AC2 and AC3
  drive the page by role and label.
- AC4, AC5: manual, in the browser.

## Assumptions
- No loading state: the API is local and answers in milliseconds, so the list area is
  briefly empty instead.
- The page stays in the light theme, like the rest of the app.
