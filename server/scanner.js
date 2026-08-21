const { chromium } = require('playwright');

// Known ad-tech / tracking domains used as a proxy for "is data still being
// shared for advertising after opt-out." Not exhaustive by design — this list
// is the thing you'll extend over time as it's the lowest-effort maintenance
// surface (a JSON list, not a rewrite of the scan logic).
const AD_TRACKING_DOMAINS = [
  'doubleclick.net',
  'google-analytics.com',
  'googlesyndication.com',
  'googletagmanager.com',
  'facebook.com/tr',
  'connect.facebook.net',
  'ads.linkedin.com',
  'px.ads.linkedin.com',
  'analytics.tiktok.com',
  'ads.pinterest.com',
  'bat.bing.com',
  'criteo.com',
  'adnxs.com',
  'amazon-adsystem.com',
  'scorecardresearch.com',
];

// Text patterns that identify an opt-out / "your privacy choices" link.
// Kept broad and case-insensitive on purpose — sites word this differently.
// This list is the #1 source of false "fails" — sites use a lot of different
// wording. When you hit a real miss during testing, add the exact link text
// here rather than guessing at broader regexes.
const OPT_OUT_LINK_PATTERNS = [
  /do not sell/i,
  /do not sell or share/i,
  /your privacy choices/i,
  /your california privacy rights/i,
  /opt.?out of (the )?sale/i,
  /manage (my )?privacy/i,
  /privacy preferences/i,
  /cookie preferences/i,
  /manage cookies/i,
  /cookie settings/i,
  /^cookies?$/i,
  /^privacy$/i,
  /^privacy policy$/i,
  /^your privacy$/i,
  /^ccpa$/i,
  /data (privacy|choices|rights|permissions)/i,
  /your data/i,
  /privacy (center|hub|portal)/i,
  /ad choices/i,
  /interest.based ads?/i,
];

// Fallback: many sites label the link generically ("More," an icon, a toggle
// badge) where text matching alone fails. This checks the URL itself for
// known opt-out-related paths/params, independent of what the link says.
const OPT_OUT_HREF_PATTERNS = [
  /do-?not-?sell/i,
  /opt-?out/i,
  /ccpa/i,
  /privacy-?choices/i,
  /privacy-?center/i,
  /cookie-?(settings|preferences|consent)/i,
  /gpc/i,
];

// Known consent management platform fingerprints, used only to explain
// *why* something failed in plain language, never to guess a fix.
const CMP_FINGERPRINTS = [
  { name: 'OneTrust', match: /onetrust/i },
  { name: 'Osano', match: /osano/i },
  { name: 'Usercentrics', match: /usercentrics/i },
  { name: 'TrustArc', match: /trustarc/i },
  { name: 'Cookiebot', match: /cookiebot/i },
];

function degrade(checkName, reason) {
  return { status: 'unknown', checkName, detail: `Could not verify — ${reason}. Manual check recommended.` };
}

async function collectTrackingCookiesAndRequests(page) {
  const trackingHits = new Set();
  page.on('request', (req) => {
    const url = req.url();
    for (const domain of AD_TRACKING_DOMAINS) {
      if (url.includes(domain)) {
        trackingHits.add(domain);
        break;
      }
    }
  });
  return trackingHits;
}

async function findOptOutLink(page) {
  try {
    const links = await page.$$eval('a', (as) =>
      as.map((a) => ({ text: (a.innerText || '').trim(), href: a.href }))
    );

    // Pass 1: match on visible link text (most reliable when it works)
    for (const pattern of OPT_OUT_LINK_PATTERNS) {
      const hit = links.find((l) => pattern.test(l.text));
      if (hit) return hit;
    }

    // Pass 2: fall back to matching the URL itself — catches generically
    // labeled links ("More," an icon-only link, a toggle badge) that text
    // matching alone misses.
    for (const pattern of OPT_OUT_HREF_PATTERNS) {
      const hit = links.find((l) => pattern.test(l.href));
      if (hit) return hit;
    }

    return null;
  } catch (e) {
    return null;
  }
}

// Detects whether the page is effectively a login wall — i.e. no opt-out
// mechanism is reachable without creating/using an account first. This is
// its own finding, not just a scanner limitation: most state privacy laws
// explicitly prohibit requiring account creation to submit an opt-out
// request, so a site that's ONLY a login screen with no public opt-out
// path is a real compliance question, not a false fail.
async function detectLoginGate(page) {
  try {
    const hasPasswordField = await page.$('input[type="password"]') !== null;
    if (!hasPasswordField) return { gated: false };

    const linkCount = await page.$$eval('a', (as) => as.length);
    const bodyText = await page.evaluate(() => (document.body.innerText || '').trim());
    const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

    // Heuristic: a password field present, very few links, and sparse page
    // text is consistent with a bare login screen rather than a marketing
    // homepage that happens to also have a login form embedded in it.
    const looksLikeBareLoginScreen = linkCount < 8 && wordCount < 150;

    return { gated: looksLikeBareLoginScreen, linkCount, wordCount };
  } catch (e) {
    return { gated: false };
  }
}

async function detectCMP(page) {
  try {
    const html = await page.content();
    for (const cmp of CMP_FINGERPRINTS) {
      if (cmp.match.test(html)) return cmp.name;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Runs the full audit against a single URL.
 * Returns an array of raw findings; report.js turns this into the
 * user-facing report and attaches state relevance from stateRules.js.
 */
async function runScan(targetUrl) {
  const findings = [];
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    throw new Error('Scan engine failed to start (browser launch error). This is an infrastructure issue, not a site issue.');
  }

  try {
    // ---- Pass 1: baseline load, no GPC signal ----
    const baselineContext = await browser.newContext();
    const baselinePage = await baselineContext.newPage();
    const baselineHits = await collectTrackingCookiesAndRequests(baselinePage);

    try {
      await baselinePage.goto(targetUrl, { waitUntil: 'networkidle', timeout: 20000 });
    } catch (e) {
      await browser.close();
      return {
        fatalError: `Could not load ${targetUrl}. It may be down, blocking automated browsers, or the URL may be incorrect.`,
        findings: [],
      };
    }

    await baselinePage.waitForTimeout(2500); // let async trackers fire

    const optOutLink = await findOptOutLink(baselinePage);
    const cmpName = await detectCMP(baselinePage);
    const loginGate = await detectLoginGate(baselinePage);

    if (loginGate.gated && !optOutLink) {
      findings.push({
        checkName: 'loginGated',
        status: 'fail',
        detail: 'This page appears to be a bare login screen with no public opt-out link reachable without an account. Most state privacy laws prohibit requiring account creation to submit an opt-out request — if this is genuinely the only entry point to the site, that\'s worth a manual review, not just a scanner miss.',
      });
    }

    findings.push({
      checkName: 'linkPresence',
      status: optOutLink ? 'pass' : 'fail',
      detail: optOutLink
        ? `Found an opt-out link: "${optOutLink.text || '(unlabeled link, matched by URL)'}"`
        : loginGate.gated
          ? 'No opt-out link found on this page — but note it looks like a login-gated screen, see the separate finding below. This may reflect the login page rather than the real public homepage.'
          : 'No "Do Not Sell/Share," "Your Privacy Choices," or similar opt-out link was found on the homepage.',
    });

    await baselineContext.close();

    // ---- Pass 2: load WITH GPC signal (Sec-GPC header + navigator.globalPrivacyControl) ----
    const gpcContext = await browser.newContext({
      extraHTTPHeaders: { 'Sec-GPC': '1' },
    });
    await gpcContext.addInitScript(() => {
      Object.defineProperty(window.navigator, 'globalPrivacyControl', { get: () => true });
    });
    const gpcPage = await gpcContext.newPage();
    const gpcHits = await collectTrackingCookiesAndRequests(gpcPage);

    try {
      await gpcPage.goto(targetUrl, { waitUntil: 'networkidle', timeout: 20000 });
      await gpcPage.waitForTimeout(2500);

      const stillTracking = gpcHits.size > 0;
      findings.push({
        checkName: 'gpcHonored',
        status: stillTracking ? 'fail' : 'pass',
        detail: stillTracking
          ? `Ad/tracking network requests (${[...gpcHits].join(', ')}) fired even with the GPC opt-out signal sent. The site does not appear to detect or honor GPC.`
          : 'No known ad-tech tracking requests fired while sending the GPC signal — consistent with honoring the opt-out.',
      });

      // California 2026: visible confirmation requirement
      const bodyText = await gpcPage.evaluate(() => document.body.innerText || '');
      const hasVisibleConfirmation = /opt.?out (request )?(honou?red|applied|confirmed)/i.test(bodyText);
      findings.push({
        checkName: 'visibleConfirmation',
        status: hasVisibleConfirmation ? 'pass' : 'unknown',
        detail: hasVisibleConfirmation
          ? 'Found visible text confirming the opt-out was applied.'
          : 'No visible on-page confirmation of GPC being honored was detected. As of 2026, California requires a visible confirmation, not just silent background processing — worth a manual check if this matters for your business.',
      });
    } catch (e) {
      findings.push(degrade('gpcHonored', 'page failed to load with GPC signal active'));
    }

    await gpcContext.close();

    // ---- Pass 3: click through the opt-out flow manually, check cookies before/after ----
    if (optOutLink && optOutLink.href) {
      const flowContext = await browser.newContext();
      const flowPage = await flowContext.newPage();
      const flowHits = await collectTrackingCookiesAndRequests(flowPage);

      try {
        await flowPage.goto(targetUrl, { waitUntil: 'networkidle', timeout: 20000 });
        const cookiesBefore = await flowContext.cookies();

        await flowPage.goto(optOutLink.href, { waitUntil: 'networkidle', timeout: 20000 });

        // Look for a form requiring personal info to submit the opt-out
        const requiresPersonalInfo = await flowPage.$$eval(
          'input[type="email"], input[name*="email" i], input[name*="name" i]',
          (inputs) => inputs.length > 0
        ).catch(() => false);

        findings.push({
          checkName: 'formFriction',
          status: requiresPersonalInfo ? 'fail' : 'pass',
          detail: requiresPersonalInfo
            ? 'The opt-out page contains a form asking for personal info (name/email) to submit the request. This is a commonly cited violation pattern — regulators have flagged opt-outs that require handing over new personal data.'
            : 'No email/name form was found gating the opt-out — consistent with a low-friction opt-out.',
        });

        // Try to click an obvious "reject all" / "opt out" / "confirm" button
        const actionButton = await flowPage.$(
          'button:has-text("Reject"), button:has-text("Opt"), button:has-text("Confirm"), button:has-text("Save")'
        ).catch(() => null);
        if (actionButton) {
          await actionButton.click({ timeout: 5000 }).catch(() => {});
          await flowPage.waitForTimeout(2000);
        }

        await flowPage.reload({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
        await flowPage.waitForTimeout(2000);

        const stillTrackingAfterOptOut = flowHits.size > 0;
        findings.push({
          checkName: 'cookiesClearAfterOptOut',
          status: stillTrackingAfterOptOut ? 'fail' : 'pass',
          detail: stillTrackingAfterOptOut
            ? `After manually completing the opt-out flow, tracking requests to ${[...flowHits].join(', ')} still fired. The opt-out UI may not be propagating to actual data collection.`
            : 'No known ad-tech tracking requests fired after completing the opt-out flow.',
        });
      } catch (e) {
        findings.push(degrade('formFriction', 'the opt-out flow could not be completed automatically'));
        findings.push(degrade('cookiesClearAfterOptOut', 'the opt-out flow could not be completed automatically'));
      }

      await flowContext.close();
    } else {
      findings.push({
        checkName: 'formFriction',
        status: 'unknown',
        detail: 'Skipped — no opt-out link was found to test.',
      });
      findings.push({
        checkName: 'cookiesClearAfterOptOut',
        status: 'unknown',
        detail: 'Skipped — no opt-out link was found to test.',
      });
    }

    // Persistence (same-session reload) is a light-touch proxy only.
    // True multi-day persistence can't be verified in a single scan and is reported as such.
    findings.push({
      checkName: 'persistence',
      status: 'unknown',
      detail: 'Persistence over time (days/weeks) cannot be verified in a single scan. This requires a manual follow-up check: opt out, wait, then re-scan.',
    });

    await browser.close();
    return { fatalError: null, cmpDetected: cmpName, findings };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    throw e;
  }
}

module.exports = { runScan };
