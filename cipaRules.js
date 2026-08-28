/**
 * CIPA check relevance/citations.
 *
 * Kept in its own file, separate from stateRules.js, because CIPA is a
 * fundamentally different legal instrument than the state comprehensive
 * privacy laws (CCPA, Colorado, etc.) that stateRules.js covers — it's a
 * 1967 wiretapping statute, not a data-privacy statute, and its application
 * to websites is actively being litigated and is NOT settled law.
 *
 * Citations here are deliberately hedged. Do not upgrade this language to
 * sound more definitive without re-verifying against current case law —
 * this area is moving quickly (a relevant appellate case, Variety Media v.
 * Superior Court, had oral argument scheduled for August 25, 2026).
 */

const CIPA_STATUTE_URL = 'https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=PEN&division=&title=15.&part=1.&chapter=1.5.&article=';

const CIPA_CHECK_RELEVANCE = {
  consentBannerPresence: {
    label: 'Cookie/consent banner present',
    citations: {
      CA: {
        statute: 'Cal. Penal Code § 631 (context)',
        url: CIPA_STATUTE_URL,
        summary: 'A visible consent mechanism is the practical way businesses attempt to establish consent before tracking begins — CIPA itself does not mandate a specific banner, but the presence or absence of one is central to how these claims get argued.',
      },
    },
    legalNote: 'This is informational, not a determination of legal sufficiency. A banner existing does not by itself establish valid consent under CIPA theories.',
  },
  preConsentTracking: {
    label: 'No known tracking tools fire before user interaction',
    citations: {
      CA: {
        statute: 'Cal. Penal Code § 631 (wiretapping/eavesdropping), § 638.51 (pen register/trap-and-trace)',
        url: CIPA_STATUTE_URL,
        summary: 'Plaintiffs\' firms argue that session-replay tools, chat widgets, and ad pixels loading before consent amount to unlawful interception or an unlawful pen register. Whether these 1960s-era statutes actually reach modern website tracking is UNSETTLED — no definitive California appellate ruling has resolved this as of mid-2026, and it is currently being litigated.',
      },
    },
    legalNote: 'This check reports a technical fact (did tracking fire before interaction) — it does not and cannot determine whether that fact constitutes a legal violation, because courts themselves are currently divided on whether CIPA applies to this behavior at all.',
  },
};

module.exports = { CIPA_CHECK_RELEVANCE, CIPA_STATUTE_URL };
