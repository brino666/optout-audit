const { CHECK_STATE_RELEVANCE } = require('./stateRules');

function buildReport({ targetUrl, cmpDetected, findings }) {
  const items = findings.map((f) => {
    const rule = CHECK_STATE_RELEVANCE[f.checkName] || { label: f.checkName, states: [], note: '', citations: {} };
    return {
      check: rule.label,
      status: f.status, // 'pass' | 'fail' | 'unknown'
      detail: f.detail,
      relevantStates: rule.states,
      whyItMatters: rule.note,
      citations: rule.citations || {},
    };
  });

  const failCount = items.filter((i) => i.status === 'fail').length;
  const unknownCount = items.filter((i) => i.status === 'unknown').length;
  const passCount = items.filter((i) => i.status === 'pass').length;

  let summary;
  if (failCount === 0 && unknownCount === 0) {
    summary = 'No issues detected in this scan. This is not a legal guarantee of compliance — see notes below.';
  } else if (failCount === 0) {
    summary = `No failures detected, but ${unknownCount} check(s) could not be fully verified automatically.`;
  } else {
    summary = `${failCount} check(s) failed. Review the detail on each below.`;
  }

  return {
    targetUrl,
    scannedAt: new Date().toISOString(),
    consentPlatformDetected: cmpDetected || null,
    summary,
    counts: { pass: passCount, fail: failCount, unknown: unknownCount },
    items,
    disclaimer:
      'This is an automated technical diagnostic, not legal advice. It does not evaluate whether a given state\'s law applies to your business (revenue/consumer thresholds, etc.), and a clean scan is not a guarantee of compliance. Consult a privacy attorney for compliance decisions.',
  };
}

module.exports = { buildReport };
