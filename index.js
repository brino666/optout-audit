require('dotenv').config();
const express = require('express');
const path = require('path');
const { runScan } = require('./scanner');
const { buildReport } = require('./report');

const app = express();
const PORT = process.env.PORT || 3000;

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

// --- PAYMENT STUB ---
// This is intentionally a placeholder. Wire in Stripe Checkout (or similar)
// here before going live: create a Checkout Session, redirect the user,
// verify the session server-side via webhook before allowing a scan to run.
// See README.md "Adding payment" section.
async function verifyPaymentPlaceholder(req) {
  // TODO: replace with real Stripe session verification.
  // For local development/testing, this always allows the scan through.
  if (process.env.REQUIRE_PAYMENT === 'true') {
    const sessionId = req.body.paymentSessionId;
    if (!sessionId) {
      return { ok: false, reason: 'No payment session provided.' };
    }
    // TODO: look up the session with Stripe and confirm it's paid.
  }
  return { ok: true };
}

app.post('/api/scan', rateLimit, async (req, res) => {
  const { targetUrl } = req.body;

  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: 'Missing targetUrl.' });
  }
  if (!isSafeTarget(targetUrl)) {
    return res.status(400).json({ error: 'Invalid or disallowed URL.' });
  }

  const payment = await verifyPaymentPlaceholder(req);
  if (!payment.ok) {
    return res.status(402).json({ error: payment.reason || 'Payment required.' });
  }

  try {
    const result = await runScan(targetUrl);
    if (result.fatalError) {
      return res.status(422).json({ error: result.fatalError });
    }
    const report = buildReport({
      targetUrl,
      cmpDetected: result.cmpDetected,
      findings: result.findings,
    });
    return res.json(report);
  } catch (e) {
    console.error('Scan failed:', e);
    return res.status(500).json({ error: 'Scan engine encountered an unexpected error. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`Opt-out audit tool running on http://localhost:${PORT}`);
});
