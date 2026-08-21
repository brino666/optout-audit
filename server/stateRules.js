/**
 * State relevance map.
 *
 * The scan engine runs ONE set of technical checks. This file is the only
 * place that maps "what we detected" to "which state laws that matters for."
 * This is what keeps the product to one simple engine instead of 20 separate
 * rule sets — when a state's requirements change, only this file needs updating.
 *
 * NOTE: This is informational context for a diagnostic report, not legal advice.
 * Thresholds (revenue, consumer count, etc.) that determine whether a given law
 * applies to a specific business are NOT evaluated here — the report says so
 * explicitly. Sourced from public law-firm and compliance-tracker summaries as
 * of mid-2026; verify against primary sources before relying on this for
 * compliance decisions.
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

const CHECK_STATE_RELEVANCE = {
  linkPresence: {
    label: 'Opt-out link present & reachable',
    states: OPT_OUT_LINK_STATES,
    note: 'Nearly every state comprehensive privacy law requires some form of accessible opt-out mechanism for the sale/sharing of personal information.',
  },
  gpcHonored: {
    label: 'Global Privacy Control (GPC) signal honored',
    states: GPC_REQUIRED_STATES,
    note: 'These states require GPC to be treated as a legally valid opt-out request, not just a suggestion.',
  },
  immediacy: {
    label: 'Opt-out takes effect immediately (not a submit-and-wait request)',
    states: OPT_OUT_LINK_STATES,
    note: 'Opt-out of sale/sharing does not require the same identity-verification burden as data access or deletion requests. A CAPTCHA, legal declaration, email-confirmation step, or multi-day wait window bundled into the opt-out flow is a friction pattern regulators have targeted.',
  },
  cookiesClearAfterOptOut: {
    label: 'Tracking cookies actually cleared after opt-out',
    states: OPT_OUT_LINK_STATES,
    note: 'Several 2026 enforcement actions (e.g. the Disney/ABC settlement) centered specifically on opt-outs that were accepted by the UI but did not propagate to actually stop data sharing.',
  },
  formFriction: {
    label: 'Opt-out does not require submitting extra personal info',
    states: OPT_OUT_LINK_STATES,
    note: 'Requiring a consumer to hand over new personal data (e.g. full name + email) just to exercise an opt-out right is a commonly cited violation pattern.',
  },
  fragmentedSystems: {
    label: 'CCPA request and cookie-consent banner are connected (not fragmented)',
    states: OPT_OUT_LINK_STATES,
    note: 'A site can have a technically working CCPA request form and a technically working cookie-consent banner that still fail consumers in practice, because the two systems don\'t sync. Regulators evaluate the effectiveness of the opt-out as experienced by the consumer, not just whether each piece exists in isolation.',
  },
  loginGated: {
    label: 'Opt-out reachable without creating an account',
    states: OPT_OUT_LINK_STATES,
    note: 'Requiring account creation or login before a consumer can submit an opt-out request is explicitly prohibited by most state comprehensive privacy laws.',
  },
  persistence: {
    label: 'Opt-out preference persists (does not silently reset)',
    states: OPT_OUT_LINK_STATES,
    note: 'An opt-out that expires or resets without the consumer\'s action does not satisfy the "effective opt-out" standard regulators have been enforcing in 2026.',
  },
};

module.exports = { GPC_REQUIRED_STATES, OPT_OUT_LINK_STATES, CHECK_STATE_RELEVANCE };
    
