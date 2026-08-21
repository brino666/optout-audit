# Signal Check — Opt-Out Compliance Scanner

Paste a URL, get a plain-language report on whether the site's privacy
opt-out mechanism (Do Not Sell/Share, Global Privacy Control) actually
works — not just whether a button exists.

One scan, one report. No account, no subscription, no ongoing monitoring
relationship with the customer.

## What it checks

1. **Link presence** — is there a working opt-out / "Your Privacy Choices" link
2. **GPC signal** — does the site stop known ad-tracking requests when the
   browser sends the Global Privacy Control header
3. **Opt-out flow** — clicking through the real opt-out UI and checking whether
   tracking requests actually stop afterward
4. **Form friction** — does the opt-out page demand new personal info (name/email)
   before it'll process the request
5. **California visible-confirmation check** — as of 2026, CA requires a visible
   on-page confirmation that GPC was honored, not just silent processing

State relevance for each check lives in one file: `server/stateRules.js`.
That's the only place that needs updating if a state's requirements change —
the scan engine itself doesn't need to change.

## Why this needs a real server (not just a webpage)

A page running in someone's browser can't inspect cookies on another domain,
and can't reliably send a GPC header while navigating to a third-party site —
browsers block that for the same reason they block most cross-origin snooping.
So this uses **Playwright** (a real, server-controlled headless browser) to do
the actual navigation, header-setting, and cookie/network inspection, then
sends a JSON report back to the front end.

## Running it locally

```bash
npm install          # also downloads a headless Chromium via the postinstall hook
cp .env.example .env
npm start
```

Then open `http://localhost:3000`.

## Deploying it

This needs a host that allows running a headless browser (some serverless
platforms don't, or need extra config). Reasonable, low-effort options:

- **Render** or **Railway** — simplest, supports long-running Node processes
  and Playwright out of the box with a standard `npm install && npm start`.
- **A small VPS** (e.g. DigitalOcean, Hetzner) if you want full control —
  more setup, but nothing exotic; a $6-12/mo box handles this fine at
  low-to-moderate volume.
- Avoid pure serverless (Vercel/Netlify functions) unless you specifically
  configure a Playwright-compatible serverless build — it's extra friction
  for no real benefit at this scale.

## Adding payment (pay-per-use)

The server has a placeholder in `server/index.js`
(`verifyPaymentPlaceholder`). To make this a real pay-per-use product:

1. Add Stripe: `npm install stripe`
2. On the front end, before calling `/api/scan`, redirect to a Stripe
   Checkout Session for a one-time payment.
3. On success, Stripe redirects back with a session ID — pass that as
   `paymentSessionId` in the `/api/scan` request body.
4. In `verifyPaymentPlaceholder`, look up the session with the Stripe SDK
   and confirm `payment_status === 'paid'` before letting the scan run.
5. Set `REQUIRE_PAYMENT=true` in your `.env` once this is wired up.

This keeps billing a single transaction per scan — no subscriptions, no
recurring billing infrastructure to maintain.

## Honest limitations (tell customers this, don't hide it)

- **Not legal advice.** The report says so, and means it. It doesn't
  determine whether a given state's law even applies to a specific business
  (revenue thresholds, consumer-count thresholds, industry carve-outs).
- **Persistence over time isn't fully testable in one scan.** A single scan
  can't confirm an opt-out survives a week without resetting. The report
  flags this explicitly as "unknown — manual recheck recommended" rather
  than guessing.
- **The ad-tracking domain list is a proxy, not exhaustive.** It's the
  lowest-effort thing to extend over time (`AD_TRACKING_DOMAINS` in
  `server/scanner.js`) — a JSON-list update, not a logic rewrite. This is
  the main ongoing maintenance surface, and it's small and mechanical.
- **Some sites will actively block headless browsers.** The scan degrades
  gracefully (reports "unknown," not a false pass/fail) rather than
  pretending to have data it doesn't have.

## Maintenance reality check

This was built specifically to minimize the "ongoing monitoring" burden you
were worried about:

- The core check logic (link detection, GPC header handling, cookie
  inspection) doesn't need to change often — it's checking against a stable
  technical standard (GPC), not a specific vendor's UI.
- The parts that *do* drift over time (tracking domain list, consent
  platform fingerprints, state law list) are isolated in small, clearly
  labeled config-like sections, not scattered through the logic.
- It's pay-per-use, not a monitored subscription — you're not on the hook to
  watch anything happen in the background. A customer runs a scan, gets a
  report, and the transaction is done.

When you want to extend it (new state, new tracking domain, new consent
platform), bring the relevant file back into a chat with Claude and it's a
small, scoped edit — not a rebuild.
