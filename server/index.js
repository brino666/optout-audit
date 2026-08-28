require('dotenv').config();
const express = require('express');
const path = require('path');
const { runScan } = require('./scanner');
const { runCipaScan } = require('./cipaScanner');
const { buildReport, buildCipaReport } = require('./report');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe is optional at boot — lets local dev run without a key set, but
// fails loudly if someone tries to actually take payment without one.
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

const SCAN_PRICE_CENTS = parseInt(process.env.SCAN_PRICE_CENTS || '900', 10); // default $9.00
const CIPA_ADDON_CENTS = parseInt(process.env.CIPA_ADDON_CENTS || '700', 10); // default +$7.00 (tier 2)
const SCAN_CURRENCY = process.env.SCAN_CURRENCY || 'usd';

// Price is always computed server-side from a boolean flag — never trust a
// client-provided amount for what to charge.
function computePriceCents(includeCipa) {
  return SCAN_PRICE_CENTS + (includeCipa ? CIPA_ADDON_CENTS : 0);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Basic in-memory rate limiting (per IP) ---
// Good enough for a low-volume pay-per-use tool. Replace with Redis-backed
// limiting if this ever needs to scale past one server instance.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const record = hits.get(ip) || { count: 0, windowStart: now };
  if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    record.count = 0;
    record.windowStart = now;
  }
  record.count += 1;
  hits.set(ip, record);
  if (record.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many scan requests. Please wait a minute and try again.' });
  }
  next();
}

// --- URL validation / SSRF guard ---
// Blocks obvious attempts to point the scanner at internal infrastructure
// (localhost, private IP ranges, cloud metadata endpoints) since this server
// will be making outbound requests on the caller's behalf.
function isSafeTarget(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;

  const host = parsed.hostname.toLowerCase();
  const blockedHosts = ['localhost', '0.0.0.0', '169.254.169.254'];
  if (blockedHosts.includes(host)) return false;

  const privateIpPattern = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|::1$|fc00:|fe80:)/;
  if (privateIpPattern.test(host)) return false;

  return true;
}

// --- Per-TARGET rate limiting ---
// Separate from the per-caller limit above. This protects the site being
// scanned, not the person doing the scanning — no single domain should get
// hit with repeated automated scans in a short window, regardless of how
// many different people are running them. Keeps the tool clearly on the
// "single compliance check" side of the line, not anything resembling load.
const TARGET_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const TARGET_RATE_LIMIT_MAX = 3;
const targetHits = new Map();
function targetRateLimit(targetUrl) {
  let hostname;
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch (e) {
    return { ok: true }; // isSafeTarget will reject invalid URLs elsewhere
  }
  const now = Date.now();
  const record = targetHits.get(hostname) || { count: 0, windowStart: now };
  if (now - record.windowStart > TARGET_RATE_LIMIT_WINDOW_MS) {
    record.count = 0;
    record.windowStart = now;
  }
  record.count += 1;
  targetHits.set(hostname, record);
  if (record.count > TARGET_RATE_LIMIT_MAX) {
    return { ok: false, reason: `This site has already been scanned ${TARGET_RATE_LIMIT_MAX} times in the last 10 minutes. Please wait before scanning it again — this limit protects the target site from repeated automated load.` };
  }
  return { ok: true };
}

// --- robots.txt awareness ---
// Not a strict legal requirement for a single-page compliance check (this
// isn't a crawler indexing the site), but checking it and being willing to
// flag/skip on an explicit disallow is a good-faith signal of acting within
// normal, expected web-access boundaries — never a bad idea to check.
async function checkRobotsTxt(targetUrl) {
  try {
    const origin = new URL(targetUrl).origin;
    const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { disallowed: false };
    const text = await res.text();
    // Coarse check: a blanket "Disallow: /" under a wildcard user-agent.
    const wildcardBlock = /user-agent:\s*\*[\s\S]{0,200}?disallow:\s*\/\s*($|\n)/im.test(text);
    return { disallowed: wildcardBlock };
  } catch (e) {
    return { disallowed: false }; // fail open — don't block a scan over a robots.txt fetch error
  }
}

// --- STEP 1: Authorize ---
// Creates a PaymentIntent with manual capture — this puts a hold on the
// card, it does NOT charge it yet. The front end confirms this PaymentIntent
// with Stripe.js (card details never touch this server). Once confirmed,
// the front end gets back a paymentIntentId, which it sends to /api/scan.
app.post('/api/create-payment-intent', rateLimit, async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Payment is not configured on this server (missing STRIPE_SECRET_KEY).' });
  }
  const { targetUrl, includeCipa } = req.body;
  if (!targetUrl || !isSafeTarget(targetUrl)) {
    return res.status(400).json({ error: 'Invalid or missing targetUrl.' });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: computePriceCents(!!includeCipa),
      currency: SCAN_CURRENCY,
      capture_method: 'manual', // authorize now, capture later — see README
      automatic_payment_methods: { enabled: true },
      metadata: { targetUrl, includeCipa: includeCipa ? 'true' : 'false' },
    });
    return res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (e) {
    console.error('Stripe PaymentIntent creation failed:', e);
    return res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

// --- STEP 2: Run the scan, then capture or cancel based on outcome ---
app.post('/api/scan', rateLimit, async (req, res) => {
  const { targetUrl, paymentIntentId, authorizedAttestation, includeCipa } = req.body;

  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: 'Missing targetUrl.' });
  }
  if (!isSafeTarget(targetUrl)) {
    return res.status(400).json({ error: 'Invalid or disallowed URL.' });
  }

  // Require an explicit attestation that the person is authorized to test
  // this site (owns it, or has permission). This doesn't change what the
  // tool technically does, but it puts responsibility for authorization
  // where it belongs, and is standard practice for any scanning/testing tool.
  if (!authorizedAttestation) {
    return res.status(400).json({ error: 'Please confirm you are authorized to test this website before scanning.' });
  }

  const targetLimit = targetRateLimit(targetUrl);
  if (!targetLimit.ok) {
    return res.status(429).json({ error: targetLimit.reason });
  }

  const robotsCheck = await checkRobotsTxt(targetUrl);
  // Informational only — logged, not blocking. A blanket robots.txt
  // disallow is aimed at search-indexing crawlers, not a single-page
  // compliance check triggered by a human, but it's worth having visibility
  // into for future review.
  if (robotsCheck.disallowed) {
    console.log(`Note: ${targetUrl} has a blanket robots.txt disallow. Scanning anyway (single-page check, not a crawler), but logged for visibility.`);
  }

  if (process.env.REQUIRE_PAYMENT === 'true') {
    if (!stripe) {
      return res.status(500).json({ error: 'Payment is required but not configured on this server.' });
    }
    if (!paymentIntentId) {
      return res.status(402).json({ error: 'Payment required.' });
    }
    // Confirm the hold is actually in place before doing any work, and that
    // the CIPA add-on selection matches what was actually paid for.
    try {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (intent.status !== 'requires_capture') {
        return res.status(402).json({ error: `Payment not ready (status: ${intent.status}). Please try again.` });
      }
      if (intent.metadata.targetUrl !== targetUrl) {
        return res.status(400).json({ error: 'Payment does not match the requested scan.' });
      }
      if (intent.metadata.includeCipa !== (includeCipa ? 'true' : 'false')) {
        return res.status(400).json({ error: 'Payment does not match the requested scan options.' });
      }
    } catch (e) {
      return res.status(402).json({ error: 'Could not verify payment.' });
    }
  }

  let result;
  try {
    result = await runScan(targetUrl);
  } catch (e) {
    console.error('Scan failed:', e);
    // Scan errored — cancel the hold, never charge for a failed scan.
    if (process.env.REQUIRE_PAYMENT === 'true' && stripe && paymentIntentId) {
      await stripe.paymentIntents.cancel(paymentIntentId).catch((err) => console.error('Cancel failed:', err));
    }
    return res.status(500).json({ error: 'Scan engine encountered an unexpected error. You have not been charged. Please try again.' });
  }

  if (result.fatalError) {
    // Site couldn't be loaded at all — cancel the hold, never charge.
    if (process.env.REQUIRE_PAYMENT === 'true' && stripe && paymentIntentId) {
      await stripe.paymentIntents.cancel(paymentIntentId).catch((err) => console.error('Cancel failed:', err));
    }
    return res.status(422).json({ error: `${result.fatalError} You have not been charged.` });
  }

  // Run the CIPA add-on scan if requested. A failure here shouldn't void the
  // CCPA results already obtained — it's reported as its own error instead.
  let cipaReport = null;
  if (includeCipa) {
    try {
      const cipaResult = await runCipaScan(targetUrl);
      if (!cipaResult.fatalError) {
        cipaReport = buildCipaReport({ findings: cipaResult.findings });
      } else {
        cipaReport = { error: cipaResult.fatalError };
      }
    } catch (e) {
      console.error('CIPA scan failed:', e);
      cipaReport = { error: 'CIPA check could not be completed.' };
    }
  }

  // Scan produced a real report — capture the payment now.
  if (process.env.REQUIRE_PAYMENT === 'true' && stripe && paymentIntentId) {
    try {
      await stripe.paymentIntents.capture(paymentIntentId);
    } catch (e) {
      console.error('Capture failed:', e);
      // Report was already generated — return it, but log this for manual
      // follow-up. A capture failure this late is rare (e.g. the 7-day
      // authorization window expired) and shouldn't block delivering results
      // the scan already produced.
    }
  }

  const report = buildReport({
    targetUrl,
    cmpDetected: result.cmpDetected,
    findings: result.findings,
  });
  if (cipaReport) {
    report.cipa = cipaReport;
  }
  return res.json(report);
});

app.listen(PORT, () => {
  console.log(`Opt-out audit tool running on http://localhost:${PORT}`);
  if (!stripe) {
    console.log('Note: STRIPE_SECRET_KEY not set — payment endpoints will error if called.');
  }
});
