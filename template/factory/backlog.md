# Backlog

`/factory next` starts the first unchecked item and ticks it off.
`/factory backlog <feature>` adds a well-formed item here for you.

An item is a `- [ ]` line plus any indented lines under it:

<!--
- [ ] Rate-limit the public API per API key
  Outcome: callers over 100 requests a minute get 429 with a Retry-After header.
  Details: limit by API key, not IP; the limit comes from the RATE_LIMIT env var.
  Out of scope: /admin routes.

- [ ] Add a /health endpoint that returns the build version and uptime
-->
