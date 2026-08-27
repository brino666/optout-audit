require('dotenv').config();
const express = require('express');
const path = require('path');
const { runScan } = require('./scanner');
const { buildReport } = require('./report');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe is optional at boot — lets local dev run without a key set, but
// fails loudly if someone tries to actually take payment without one.
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

const SCAN_PRICE_CENTS = parseInt(process.env.SCAN_PRICE_CENTS || '900', 10); // default $9.00
const SCAN_CURRENCY = process.env.SCAN_CURRENCY || 'usd';

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

// --- STEP 1: Authorize ---
// Creates a PaymentIntent with manual capture — this puts a hold on the
// card, it does NOT charge it yet. The front end confirms this PaymentIntent
// with Stripe.js (card details never touch this server). Once confirmed,
// the front end gets back a paymentIntentId, which it sends to /api/scan.
app.post('/api/create-payment-intent', rateLimit, async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Payment is not configured on this server (missing STRIPE_SECRET_KEY).' });
  }
  const { targetUrl } = req.body;
  if (!targetUrl || !isSafeTarget(targetUrl)) {
    return res.status(400).json({ error: 'Invalid or missing targetUrl.' });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: SCAN_PRICE_CENTS,
      currency: SCAN_CURRENCY,
      capture_method: 'manual', // authorize now, capture later — see README
      automatic_payment_methods: { enabled: true },
      metadata: { targetUrl },
    });
    return res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (e) {
    console.error('Stripe PaymentIntent creation failed:', e);
    return res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

// --- STEP 2: Run the scan, then capture or cancel based on outcome ---
app.post('/api/scan', rateLimit, async (req, res) => {
  const { targetUrl, paymentIntentId } = req.body;

  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: 'Missing targetUrl.' });
  }
  if (!isSafeTarget(targetUrl)) {
    return res.status(400).json({ error: 'Invalid or disallowed URL.' });
  }

  if (process.env.REQUIRE_PAYMENT === 'true') {
    if (!stripe) {
      return res.status(500).json({ error: 'Payment is required but not configured on this server.' });
    }
    if (!paymentIntentId) {
      return res.status(402).json({ error: 'Payment required.' });
    }
    // Confirm the hold is actually in place before doing any work.
    try {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (intent.status !== 'requires_capture') {
        return res.status(402).json({ error: `Payment not ready (status: ${intent.status}). Please try again.` });
      }
      if (intent.metadata.targetUrl !== targetUrl) {
        return res.status(400).json({ error: 'Payment does not match the requested scan.' });
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
  return res.json(report);
});

app.listen(PORT, () => {
  console.log(`Opt-out audit tool running on http://localhost:${PORT}`);
  if (!stripe) {
    console.log('Note: STRIPE_SECRET_KEY not set — payment endpoints will error if called.');
  }
});
