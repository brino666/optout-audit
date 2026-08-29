const { chromium } = require('playwright');

/**
 * CIPA (California Invasion of Privacy Act) pre-consent tracking check.
 *
 * This is a DIFFERENT legal theory from the CCPA opt-out checks in
 * scanner.js. CCPA asks "does the opt-out mechanism work." CIPA — an old
 * (1967) wiretapping statute now being applied to websites — asks "did
 * tracking/recording tools start capturing the visitor's activity BEFORE
 * they had any chance to consent at all." Plaintiffs argue this amounts to
 * unlawful interception under Penal Code § 631, or an unlawful "pen
 * register" under § 638.51.
 *
 * IMPORTANT LEGAL CONTEXT (surfaced in the report, not just here): whether
 * these 1960s statutes actually reach modern website tracking is legally
 * UNSETTLED. No definitive California appellate ruling has resolved this as
 * of mid-2026, and a relevant case (Variety Media v. Superior Court) is
 * pending. This check reports technical facts (what fired, and when,
 * relative to consent) — it deliberately does NOT assert that a given
 * result is or isn't a violation, because that legal question isn't settled
 * even among courts.
 */

// Session-replay tools: the original and still most litigated CIPA target.
// These record mouse movement, keystrokes, and form input.
const SESSION_REPLAY_DOMAINS = [
  'hotjar.com',
  'fullstory.com',
  'clarity.ms',
  'mouseflow.com',
  'luckyorange.com',
  'smartlook.com',
  'inspectlet.com',
];

// Live chat / chatbot vendors — the newer wave of CIPA claims specifically
// target chat tools that log, store, or train on conversation content.
const CHAT_WIDGET_DOMAINS = [
  'intercom.io',
  'drift.com',
  'livechatinc.com',
  'tawk.to',
  'zendesk.com',
  'crisp.chat',
  'olark.com',
  'zopim.com',
  'freshchat.com',
];

// Ad/analytics pixels — also implicated in CIPA claims (the same domains
// checked in scanner.js's opt-out flow, reused here for a different purpose:
// timing relative to consent, not post-opt-out persistence).
const AD_ANALYTICS_DOMAINS = [
  'doubleclick.net',
  'google-analytics.com',
  'googletagmanager.com',
  'connect.facebook.net',
  'analytics.tiktok.com',
  'bat.bing.com',
];

const ALL_TRACKED_DOMAINS = [
  ...SESSION_REPLAY_DOMAINS.map((d) => ({ domain: d, category: 'session replay' })),
  ...CHAT_WIDGET_DOMAINS.map((d) => ({ domain: d, category: 'chat/chatbot' })),
  ...AD_ANALYTICS_DOMAINS.map((d) => ({ domain: d, category: 'ad/analytics pixel' })),
];

// Detects a visible cookie-consent banner using the same CMP fingerprints
// and generic text patterns as the CCPA scanner — a banner existing doesn't
// mean scripts are actually gated behind it (that's the whole point of this
// check), but its absence is itself informative.
async function detectConsentBanner(page) {
  try {
    const html = await page.content();
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    const cmpPresent = /onetrust|osano|usercentrics|trustarc|cookiebot/i.test(html);
    const genericBannerText = /we use cookies|this (site|website) uses cookies|accept all cookies|manage (cookie|consent) preferences/i.test(bodyText);
    return cmpPresent || genericBannerText;
  } catch (e) {
    return false;
  }
}

/**
 * Runs the CIPA pre-consent check against a single URL. Loads the page in a
 * completely fresh, cookie-free session and watches what fires in the
 * window before any interaction — this mirrors the real scenario the CIPA
 * claims are built on (a visitor who hasn't clicked anything yet).
 */
async function runCipaScan(targetUrl) {
  const findings = [];
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    throw new Error('CIPA scan engine failed to start.');
  }

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const preConsentHits = new Map(); // domain -> category
    page.on('request', (req) => {
      const url = req.url();
      for (const { domain, category } of ALL_TRACKED_DOMAINS) {
        if (url.includes(domain) && !preConsentHits.has(domain)) {
          preConsentHits.set(domain, category);
        }
      }
    });

    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 20000 });
    } catch (e) {
      await browser.close();
      return { fatalError: `Could not load ${targetUrl} for the CIPA check.`, findings: [] };
    }

    // Deliberately does NOT click anything — this is the point. We're
    // observing what fires in the window before any human interaction.
    await page.waitForTimeout(3000);

    const hasBanner = await detectConsentBanner(page);
    const hitsByCategory = {};
    for (const [domain, category] of preConsentHits.entries()) {
      hitsByCategory[category] = hitsByCategory[category] || [];
      hitsByCategory[category].push(domain);
    }

    findings.push({
      checkName: 'consentBannerPresence',
      status: hasBanner ? 'pass' : 'unknown',
      detail: hasBanner
        ? 'A cookie/consent banner was detected on the page.'
        : 'No cookie/consent banner was detected. This does not by itself confirm a violation, but means there was no visible mechanism offering the visitor a choice before tracking could begin.',
    });

    if (preConsentHits.size === 0) {
      findings.push({
        checkName: 'preConsentTracking',
        status: 'pass',
        detail: 'No known session-replay, chat-widget, or ad/analytics tracking requests were observed firing before any interaction with the page.',
      });
    } else {
      const categoryLines = Object.entries(hitsByCategory)
        .map(([cat, domains]) => `${cat} (${domains.join(', ')})`)
        .join('; ');
      findings.push({
        checkName: 'preConsentTracking',
        status: 'fail',
        detail: `The following tracking requests fired before any user interaction with the page: ${categoryLines}. ${hasBanner ? 'A consent banner was present but did not appear to block these requests from loading.' : 'No consent banner was present at all.'} This is the specific technical pattern CIPA claims are built on — it is not, by itself, a legal determination that a violation occurred.`,
      });
    }

    await context.close();
    await browser.close();
    return { fatalError: null, findings };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    throw e;
  }
}

module.exports = { runCipaScan, SESSION_REPLAY_DOMAINS, CHAT_WIDGET_DOMAINS, AD_ANALYTICS_DOMAINS };
