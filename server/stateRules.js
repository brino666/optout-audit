/**
 * State relevance map.
 *
 * The scan engine runs ONE set of technical checks. This file is the only
 * place that maps "what we detected" to "which state laws that matters for."
 * This is what keeps the product to one simple engine instead of 20 separate
 * rule sets — when a state's requirements change, only this file needs updating.
 *
 * CITATIONS: each check can carry a `citations` object keyed by jurisdiction
 * (e.g. "CA"), pointing to the specific statute/regulation section believed
 * to be most relevant. Only populate a citation once it's been verified
 * against the primary source — an approximate or wrong citation is worse
 * than none, since it looks authoritative. Currently only California
 * citations are populated (verified against the CCPA text directly, mid-2026).
 * Adding other states/countries is future work — add a `citations.XX` entry
 * per check as each jurisdiction's specific provision is verified; the report
 * layer already renders whatever's present.
 *
 * NOTE: This is informational context for a diagnostic report, not legal advice.
 * Thresholds (revenue, consumer count, etc.) that determine whether a given law
 * applies to a specific business are NOT evaluated here — the report says so
 * explicitly.
 */

const GPC_REQUIRED_STATES = [
  'California',
  'Colorado',
  'Connecticut',
  'Delaware',
  'Maryland',
  'Minnesota',
  'Montana',
  'Nebraska',
  'New Hampshire',
  'New Jersey',
  'Oregon',
  'Texas',
];

// States with comprehensive privacy laws that require SOME opt-out mechanism
// (link-based at minimum) even where GPC recognition specifically isn't mandated.
const OPT_OUT_LINK_STATES = [
  ...GPC_REQUIRED_STATES,
  'Virginia',
  'Utah',
  'Iowa',
  'Indiana',
  'Kentucky',
  'Tennessee',
  'Rhode Island',
];

const CCPA_FULL_TEXT_URL = 'https://california.public.law/codes/civil_code_section_1798.135';

const CHECK_STATE_RELEVANCE = {
  linkPresence: {
    label: 'Opt-out link present & reachable',
    states: OPT_OUT_LINK_STATES,
    note: 'Nearly every state comprehensive privacy law requires some form of accessible opt-out mechanism for the sale/sharing of personal information.',
    citations: {
      CA: { statute: 'Cal. Civ. Code § 1798.135(a)(1)', url: CCPA_FULL_TEXT_URL, summary: 'Requires a clear and conspicuous "Do Not Sell or Share My Personal Information" link on the business\'s homepage.' },
    },
  },
  sensitiveInfoLink: {
    label: 'Separate "Limit the Use of My Sensitive Personal Information" link',
    states: ['California'],
    note: 'This is a distinct requirement from the Do Not Sell/Share link — a separate link is required if the business uses sensitive personal information beyond CCPA-authorized purposes.',
    citations: {
      CA: { statute: 'Cal. Civ. Code § 1798.135(a)(2), § 1798.121', url: CCPA_FULL_TEXT_URL, summary: 'Requires a separate, clearly titled link enabling consumers to limit use/disclosure of sensitive personal information.' },
    },
  },
  gpcHonored: {
    label: 'Global Privacy Control (GPC) signal honored',
    states: GPC_REQUIRED_STATES,
    note: 'These states require GPC to be treated as a legally valid opt-out request, not just a suggestion.',
    citations: {
      CA: { statute: 'Cal. Civ. Code § 1798.135(b)', url: CCPA_FULL_TEXT_URL, summary: 'Businesses may satisfy the link requirement by responding to and abiding by opt-out preference signals such as GPC.' },
    },
  },
  privacyPolicy: {
    label: 'Privacy policy present, reachable, and covers required topics',
    states: OPT_OUT_LINK_STATES,
    note: 'Most state privacy laws require specific disclosures in a privacy policy — this checks for keyword presence only, not legal accuracy or completeness.',
    citations: {
      CA: { statute: 'Cal. Civ. Code § 1798.130', url: 'https://california.public.law/codes/civil_code_section_1798.130', summary: 'Sets notice, disclosure, correction, and deletion requirements a business must include in its privacy policy.' },
    },
  },
  immediacy: {
    label: 'Opt-out takes effect immediately (not a submit-and-wait request)',
    states: OPT_OUT_LINK_STATES,
    note: 'Opt-out of sale/sharing does not require the same identity-verification burden as data access or deletion requests. A CAPTCHA, legal declaration, email-confirmation step, or multi-day wait window bundled into the opt-out flow is a friction pattern regulators have targeted.',
    citations: {
      CA: { statute: 'Cal. Civ. Code § 1798.135(a)', url: CCPA_FULL_TEXT_URL, summary: 'Requires the opt-out mechanism be provided "in a form that is reasonably accessible to consumers."' },
    },
  },
  cookiesClearAfterOptOut: {
    label: 'Tracking cookies actually cleared after opt-out',
    states: OPT_OUT_LINK_STATES,
    note: 'Several 2026 enforcement actions (e.g. the Disney/ABC settlement) centered specifically on opt-outs that were accepted by the UI but did not propagate to actually stop data sharing.',
    citations: {
      CA: { statute: 'Cal. Civ. Code § 1798.120', url: 'https://california.public.law/codes/civil_code_section_1798.120', summary: 'Establishes the underlying right to opt out of the sale/sharing of personal information — the mechanism must actually achieve this, not just accept the request.' },
    },
  },
  formFriction: {
    label: 'Opt-out does not require submitting extra personal info',
    states: OPT_OUT_LINK_STATES,
    note: 'Requiring a consumer to hand over new personal data (e.g. full name + email) just to exercise an opt-out right is a commonly cited violation pattern.',
    citations: {
      CA: { statute: 'Cal. Civ. Code § 1798.135(a)', url: CCPA_FULL_TEXT_URL, summary: '"Reasonably accessible" is generally read to preclude unnecessary data collection as a precondition of the opt-out.' },
    },
  },
  fragmentedSystems: {
    label: 'CCPA request and cookie-consent banner are connected (not fragmented)',
    states: OPT_OUT_LINK_STATES,
    note: 'A site can have a technically working CCPA request form and a technically working cookie-consent banner that still fail consumers in practice, because the two systems don\'t sync. Regulators evaluate the effectiveness of the opt-out as experienced by the consumer, not just whether each piece exists in isolation.',
    citations: {},
  },
  loginGated: {
    label: 'Opt-out reachable without creating an account',
    states: OPT_OUT_LINK_STATES,
    note: 'Requiring account creation or login before a consumer can submit an opt-out request is explicitly prohibited by most state comprehensive privacy laws.',
    citations: {
      CA: { statute: 'Cal. Civ. Code § 1798.135(a)', url: CCPA_FULL_TEXT_URL, summary: 'The "reasonably accessible" standard is generally understood to preclude requiring account creation just to opt out.' },
    },
  },
  persistence: {
    label: 'Opt-out preference persists (does not silently reset)',
    states: OPT_OUT_LINK_STATES,
    note: 'An opt-out that expires or resets without the consumer\'s action does not satisfy the "effective opt-out" standard regulators have been enforcing in 2026.',
    citations: {},
  },
};

module.exports = { GPC_REQUIRED_STATES, OPT_OUT_LINK_STATES, CHECK_STATE_RELEVANCE, CCPA_FULL_TEXT_URL };
