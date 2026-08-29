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

// Text patterns split into two tiers. STRONG patterns are unambiguous —
// they specifically name the opt-out mechanism, so a match is trustworthy
// on its own. GENERIC patterns ("Privacy," "Cookies") are common on nearly
// every site regardless of whether a real opt-out exists there — a plain
// privacy-policy page will match these too. A generic match alone is NOT
// treated as proof of a working opt-out; the linked page gets followed and
// checked for real opt-out content before it counts as a pass.
const OPT_OUT_LINK_PATTERNS_STRONG = [
  /do not sell/i,
  /do not sell or share/i,
  /your privacy choices/i,
  /your california privacy rights/i,
  /opt.?out of (the )?sale/i,
  /manage (my )?privacy/i,
  /privacy preferences/i,
  /privacy practices/i,
  /cookie preferences/i,
  /manage cookies/i,
  /cookie settings/i,
  /^ccpa$/i,
  /data (privacy|choices|rights|permissions)/i,
  /privacy (center|hub|portal)/i,
  /ad choices/i,
  /interest.based ads?/i,
];

const OPT_OUT_LINK_PATTERNS_GENERIC = [
  /^cookies?$/i,
  /^privacy$/i,
  /^privacy policy$/i,
  /^your privacy$/i,
  /your data/i,
];

// Kept for backward compatibility with anything referencing the combined list.
const OPT_OUT_LINK_PATTERNS = [...OPT_OUT_LINK_PATTERNS_STRONG, ...OPT_OUT_LINK_PATTERNS_GENERIC];

// § 1798.135(a)(2) requires a SEPARATE link, titled "Limit the Use of My
// Sensitive Personal Information," distinct from the Do Not Sell/Share link.
// Businesses that only use/disclose sensitive PI for CCPA-authorized purposes
// (§ 1798.121(a)) aren't required to have this link — so a miss here is
// reported as "not found," not automatically a violation.
const SENSITIVE_INFO_LINK_PATTERNS_STRONG = [
  /limit the use of my sensitive personal information/i,
  /limit use of sensitive personal information/i,
  /limit use.*sensitive/i,
  /sensitive personal information/i,
];
const SENSITIVE_INFO_HREF_PATTERNS = [
  /limit-?use/i,
  /sensitive-?(personal-?)?info/i,
  /limit-?sensitive/i,
];

// § 1798.130 required privacy-policy disclosure topics. This is a coarse
// keyword presence check on the policy's own text — it confirms the topic is
// addressed somewhere, not that the legal content is accurate or complete.
const PRIVACY_POLICY_REQUIRED_TOPICS = [
  { label: 'categories of personal information collected', pattern: /categories? of (personal information|information) (we |that we )?collect/i },
  { label: 'right to know / access', pattern: /right to know|right to access/i },
  { label: 'right to delete', pattern: /right to delete/i },
  { label: 'right to opt-out of sale/sharing', pattern: /right to opt.?out|do not sell/i },
  { label: 'categories of third parties data is shared with', pattern: /categories? of third part(y|ies)/i },
];

// Fallback: many sites label the link generically ("More," an icon, a toggle
// badge) where text matching alone fails. This checks the URL itself for
// known opt-out-related paths/params, independent of what the link says.
// Href matches are treated as strong — a URL containing "do-not-sell" is
// unambiguous even if the visible link text is empty or generic.
const OPT_OUT_HREF_PATTERNS = [
  /do-?not-?sell/i,
  /opt-?out/i,
  /ccpa/i,
  /privacy-?choices/i,
  /privacy-?center/i,
  /cookie-?(settings|preferences|consent)/i,
  /gpc/i,
];

// Used to verify a GENERIC-matched link's destination actually contains a
// real opt-out mechanism, rather than just being a standard privacy policy
// page. Looking for content, not just the word "privacy" again.
const OPT_OUT_CONTENT_PATTERNS = [
  /do not sell/i,
  /do not share/i,
  /opt.?out of (the )?(sale|sharing)/i,
  /global privacy control/i,
  /\bgpc\b/i,
  /right to opt.?out/i,
  /manage (your )?(cookie|tracking|ad) preferences/i,
];

// Confirms a page contains a visible, human-readable statement that an
// opt-out request was received/applied — not just background processing.
function hasVisibleOptOutConfirmation(bodyText) {
  return /opt.?out (request )?(honou?red|applied|confirmed|received|processed)/i.test(bodyText);
}

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

    // Pass 1: strong text match — trustworthy on its own
    for (const pattern of OPT_OUT_LINK_PATTERNS_STRONG) {
      const hit = links.find((l) => pattern.test(l.text));
      if (hit) return { ...hit, matchStrength: 'strong', matchedVia: 'text' };
    }

    // Pass 2: href match — unambiguous even without matching text
    for (const pattern of OPT_OUT_HREF_PATTERNS) {
      const hit = links.find((l) => pattern.test(l.href));
      if (hit) return { ...hit, matchStrength: 'strong', matchedVia: 'href' };
    }

    // Pass 3: generic text match — needs the destination page verified
    // before it counts as a real opt-out mechanism, not just a policy page.
    for (const pattern of OPT_OUT_LINK_PATTERNS_GENERIC) {
      const hit = links.find((l) => pattern.test(l.text));
      if (hit) return { ...hit, matchStrength: 'generic', matchedVia: 'text' };
    }

    return null;
  } catch (e) {
    return null;
  }
}

// Finds the § 1798.135(a)(2) "Limit the Use of My Sensitive Personal
// Information" link. Separate from the opt-out link on purpose — it's a
// distinct statutory requirement, not a variant of the same link.
async function findSensitiveInfoLink(page) {
  try {
    const links = await page.$$eval('a', (as) =>
      as.map((a) => ({ text: (a.innerText || '').trim(), href: a.href }))
    );
    for (const pattern of SENSITIVE_INFO_LINK_PATTERNS_STRONG) {
      const hit = links.find((l) => pattern.test(l.text));
      if (hit) return { ...hit, matchedVia: 'text' };
    }
    for (const pattern of SENSITIVE_INFO_HREF_PATTERNS) {
      const hit = links.find((l) => pattern.test(l.href));
      if (hit) return { ...hit, matchedVia: 'href' };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Finds a privacy policy link and does a light-touch, keyword-level check
// for the § 1798.130 required disclosure topics. This confirms the topic is
// ADDRESSED SOMEWHERE on the page — it is not a legal-accuracy review, and
// the report says so explicitly.
async function findAndCheckPrivacyPolicy(browser, page) {
  try {
    const links = await page.$$eval('a', (as) =>
      as.map((a) => ({ text: (a.innerText || '').trim(), href: a.href }))
    );
    const policyLink = links.find((l) => /^privacy policy$/i.test(l.text) || /^privacy$/i.test(l.text) || /privacy-policy/i.test(l.href));
    if (!policyLink) {
      return { found: false, reachable: false, topicsFound: [], topicsMissing: PRIVACY_POLICY_REQUIRED_TOPICS.map((t) => t.label) };
    }

    const context = await browser.newContext();
    const policyPage = await context.newPage();
    try {
      await policyPage.goto(policyLink.href, { waitUntil: 'networkidle', timeout: 20000 });
      const bodyText = await policyPage.evaluate(() => document.body.innerText || '');
      const topicsFound = PRIVACY_POLICY_REQUIRED_TOPICS.filter((t) => t.pattern.test(bodyText)).map((t) => t.label);
      const topicsMissing = PRIVACY_POLICY_REQUIRED_TOPICS.filter((t) => !t.pattern.test(bodyText)).map((t) => t.label);
      await context.close();
      return { found: true, reachable: true, url: policyLink.href, topicsFound, topicsMissing };
    } catch (e) {
      await context.close().catch(() => {});
      return { found: true, reachable: false, url: policyLink.href, topicsFound: [], topicsMissing: PRIVACY_POLICY_REQUIRED_TOPICS.map((t) => t.label) };
    }
  } catch (e) {
    return { found: false, reachable: false, topicsFound: [], topicsMissing: PRIVACY_POLICY_REQUIRED_TOPICS.map((t) => t.label) };
  }
}

/**
 * Follows a GENERIC-matched link and checks whether the destination page
 * actually contains real opt-out content (not just standard privacy-policy
 * boilerplate). Also checks for a visible opt-out confirmation on that same
 * page, since that's where such a message would actually live — not the
 * homepage.
 */
async function verifyGenericLinkDestination(browser, href) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(href, { waitUntil: 'networkidle', timeout: 20000 });
    const bodyText = await page.evaluate(() => document.body.innerText || '');

    const hasRealOptOutContent = OPT_OUT_CONTENT_PATTERNS.some((p) => p.test(bodyText));
    const hasConfirmation = hasVisibleOptOutConfirmation(bodyText);

    await context.close();
    return { verified: hasRealOptOutContent, hasConfirmation, reachable: true };
  } catch (e) {
    await context.close().catch(() => {});
    return { verified: false, hasConfirmation: false, reachable: false };
  }
}

// Detects friction patterns in the request process itself — separate from
// formFriction (which checks whether personal info is required). This looks
// for signals that the opt-out is a multi-step *request* pipeline (submit,
// verify, wait) rather than something that takes effect immediately.
// Deliberately does NOT submit the form — attesting to a legal declaration
// (e.g. "under penalty of perjury") on a third-party site, even for testing,
// isn't something this tool should ever do automatically.
async function detectRequestFriction(page) {
  const signals = [];
  try {
    const html = await page.content();
    const bodyText = await page.evaluate(() => document.body.innerText || '');

    if (/captcha/i.test(html)) {
      signals.push('CAPTCHA required');
    }
    if (/check your email|click .?confirm.?|one more step|confirmation notice/i.test(bodyText)) {
      signals.push('requires a second email-confirmation step before the request is submitted');
    }
    if (/penalty of perjury|declare under/i.test(bodyText)) {
      signals.push('requires signing a legal declaration to submit the request');
    }
    const hasFileUpload = await page.$('input[type="file"]') !== null;
    if (hasFileUpload) {
      signals.push('requests supporting document upload');
    }
    if (/\b\d{1,3}\s*business\s*days?\b/i.test(bodyText)) {
      signals.push('states a multi-day response/wait window rather than immediate effect');
    }
  } catch (e) {
    // leave signals as-is; caller treats empty array + no error as inconclusive
  }
  return signals;
}

// Detects whether a site runs a CCPA/state-law request form as one system,
// and a separate cookie-consent preference center (OneTrust, Osano, etc.) as
// another — with no visible indication the two are connected. This is a
// pure detection check: it never interacts with toggles or submits anything.
// Real-world example this was built from: a site whose CCPA "do not sell"
// request form gets confirmed by email, but Analytics/Advertising cookie
// toggles in the separate cookie-consent banner remain switched on — the
// request and the banner are two systems that don't talk to each other.
async function detectFragmentedOptOutSystems(page, optOutLink, cmpName) {
  try {
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    const html = await page.content();

    const hasCcpaRequestFlow =
      (optOutLink && /do not sell|ccpa|opt.?out of (the )?sale/i.test(optOutLink.text || optOutLink.href || '')) ||
      /california consumer privacy act|ccpa request/i.test(bodyText);

    const hasCookieConsentBanner =
      cmpName !== null ||
      /manage consent preferences|cookie settings|cookie preferences/i.test(bodyText) ||
      /onetrust|osano|usercentrics|trustarc|cookiebot/i.test(html);

    return { fragmented: hasCcpaRequestFlow && hasCookieConsentBanner, hasCcpaRequestFlow, hasCookieConsentBanner };
  } catch (e) {
    return { fragmented: false, hasCcpaRequestFlow: false, hasCookieConsentBanner: false };
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

    // Fragmented opt-out systems: a CCPA request flow and a separate cookie
    // consent banner, with no evidence they're connected. Detection only —
    // never touches toggles or submits anything.
    const fragmentation = await detectFragmentedOptOutSystems(baselinePage, optOutLink, cmpName);
    if (fragmentation.fragmented) {
      findings.push({
        checkName: 'fragmentedSystems',
        status: 'unknown',
        detail:
          'This site appears to run two separate opt-out systems: a CCPA/state-law request flow' +
          (cmpName ? ` and a ${cmpName}-powered cookie-consent banner` : ' and a cookie-consent preference banner') +
          '. These often don\'t sync automatically — submitting one may not update the other. ' +
          'This can\'t be confirmed without manually completing both. To check yourself: ' +
          '(1) submit the CCPA/opt-out request form and wait for its confirmation, ' +
          '(2) then separately open the cookie settings/preferences link (often in the site footer) and check whether Analytics/Advertising toggles are already switched off, ' +
          '(3) if they\'re still on, you likely need to opt out in both places — the request form does not automatically update the cookie banner.',
      });
    }

    // If the only match was generic ("Privacy," "Cookies" — links present on
    // nearly every site regardless of compliance), follow it and check
    // whether the destination page actually contains real opt-out content.
    // Without this, a plain privacy-policy page with no opt-out mechanism
    // at all would incorrectly count as a pass.
    let linkStatus = optOutLink ? 'pass' : 'fail';
    let linkDetail = optOutLink
      ? `Found an opt-out link: "${optOutLink.text || '(unlabeled link, matched by URL)'}"`
      : loginGate.gated
        ? 'No opt-out link found on this page — but note it looks like a login-gated screen, see the separate finding below. This may reflect the login page rather than the real public homepage.'
        : 'No "Do Not Sell/Share," "Your Privacy Choices," or similar opt-out link was found on the homepage.';

    let destinationConfirmation = null;
    if (optOutLink && optOutLink.matchStrength === 'generic' && optOutLink.href) {
      const verification = await verifyGenericLinkDestination(browser, optOutLink.href);
      destinationConfirmation = verification.hasConfirmation;

      if (!verification.reachable) {
        linkStatus = 'unknown';
        linkDetail = `Found a generically-labeled link ("${optOutLink.text}"), but its destination page could not be loaded to verify it actually contains an opt-out mechanism. Manual check recommended.`;
      } else if (!verification.verified) {
        linkStatus = 'fail';
        linkDetail = `The link found ("${optOutLink.text}") leads to a standard privacy policy page with no actual "Do Not Sell," opt-out toggle, or GPC-related content. A generic privacy link is not the same as a working opt-out mechanism.`;
      } else {
        linkStatus = 'pass';
        linkDetail = `Verified — the linked page ("${optOutLink.text}") contains real opt-out content, not just standard privacy-policy boilerplate.`;
      }
    }

    findings.push({ checkName: 'linkPresence', status: linkStatus, detail: linkDetail });

    // § 1798.135(a)(2) — separate "Limit the Use of My Sensitive Personal
    // Information" link. Not finding one is only a problem if the business
    // actually uses sensitive PI beyond CCPA-authorized purposes — that's
    // not something this tool can determine from outside, so a miss is
    // reported as informational (unknown), not an automatic fail.
    const sensitiveInfoLink = await findSensitiveInfoLink(baselinePage);
    findings.push({
      checkName: 'sensitiveInfoLink',
      status: sensitiveInfoLink ? 'pass' : 'unknown',
      detail: sensitiveInfoLink
        ? `Found a "Limit the Use of My Sensitive Personal Information" link: "${sensitiveInfoLink.text || '(unlabeled, matched by URL)'}"`
        : 'No separate "Limit the Use of My Sensitive Personal Information" link was found. This is only required if the business uses/discloses sensitive personal information beyond what\'s authorized under § 1798.121(a) — this tool can\'t determine that from outside, so this isn\'t automatically a violation. Worth a manual check if the business collects sensitive data (e.g. precise geolocation, health info, government ID numbers).',
    });

    // § 1798.130 — light-touch check that a privacy policy exists, is
    // reachable, and mentions the required disclosure topics somewhere.
    // Keyword presence only — does not verify legal accuracy or completeness.
    const policyCheck = await findAndCheckPrivacyPolicy(browser, baselinePage);
    if (!policyCheck.found) {
      findings.push({
        checkName: 'privacyPolicy',
        status: 'fail',
        detail: 'No privacy policy link was found on the homepage.',
      });
    } else if (!policyCheck.reachable) {
      findings.push({
        checkName: 'privacyPolicy',
        status: 'unknown',
        detail: `Found a privacy policy link, but the page could not be loaded to check its contents. Manual check recommended: ${policyCheck.url}`,
      });
    } else {
      const allTopicsPresent = policyCheck.topicsMissing.length === 0;
      findings.push({
        checkName: 'privacyPolicy',
        status: allTopicsPresent ? 'pass' : 'unknown',
        detail: allTopicsPresent
          ? 'The privacy policy mentions all commonly-required CCPA disclosure topics (categories collected, right to know, right to delete, right to opt-out, third-party categories). This is a keyword presence check only — it does not verify the content is legally accurate or complete.'
          : `The privacy policy appears to be missing mention of: ${policyCheck.topicsMissing.join(', ')}. This is a keyword presence check only — the topic may be covered elsewhere in different wording. Manual review recommended: ${policyCheck.url}`,
      });
    }

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

      // California 2026: visible confirmation requirement.
      // Check the homepage-under-GPC content, and also the verified opt-out
      // destination page if we found and confirmed one above — that's where
      // a confirmation message is more likely to actually live.
      const bodyText = await gpcPage.evaluate(() => document.body.innerText || '');
      const hasVisibleConfirmation = hasVisibleOptOutConfirmation(bodyText) || destinationConfirmation === true;
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

        // Check for request-pipeline friction: CAPTCHA, legal declarations,
        // email-confirmation steps, document upload, multi-day wait windows.
        // These indicate a "submit a request and wait" model rather than an
        // opt-out that takes effect immediately.
        const frictionSignals = await detectRequestFriction(flowPage);
        findings.push({
          checkName: 'immediacy',
          status: frictionSignals.length >= 2 ? 'fail' : frictionSignals.length === 1 ? 'unknown' : 'pass',
          detail: frictionSignals.length > 0
            ? `This opt-out is a multi-step request process, not an immediate action: ${frictionSignals.join('; ')}.`
            : 'No CAPTCHA, legal declaration, email-confirmation step, or stated multi-day wait was detected — consistent with an immediate opt-out.',
        });

        // Safety guard: if this page requires a legal declaration (e.g. "under
        // penalty of perjury") or a CAPTCHA, do NOT auto-click through it.
        // Submitting a legal attestation on a third-party site is something
        // this tool should never do automatically, regardless of intent.
        const hasLegalOrCaptcha = frictionSignals.some(
          (s) => s.includes('legal declaration') || s.includes('CAPTCHA')
        );

        // Try to click an obvious "reject all" / "opt out" / "confirm" button
        // — but only when it's a simple preference toggle, not a legal form.
        if (!hasLegalOrCaptcha) {
          const actionButton = await flowPage.$(
            'button:has-text("Reject"), button:has-text("Opt"), button:has-text("Confirm"), button:has-text("Save")'
          ).catch(() => null);
          if (actionButton) {
            await actionButton.click({ timeout: 5000 }).catch(() => {});
            await flowPage.waitForTimeout(2000);
          }
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
        findings.push(degrade('immediacy', 'the opt-out flow could not be completed automatically'));
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
        checkName: 'immediacy',
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
