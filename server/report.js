const { CHECK_STATE_RELEVANCE } = require('./stateRules');
const { CIPA_CHECK_RELEVANCE } = require('./cipaRules');

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

module.exports = { buildReport, buildCipaReport };

function buildCipaReport({ findings }) {
  const items = findings.map((f) => {
    const rule = CIPA_CHECK_RELEVANCE[f.checkName] || { label: f.checkName, citations: {}, legalNote: '' };
    return {
      check: rule.label,
      status: f.status,
      detail: f.detail,
      citations: rule.citations || {},
      legalNote: rule.legalNote,
    };
  });

  const failCount = items.filter((i) => i.status === 'fail').length;

  return {
    summary: failCount > 0
      ? 'Tracking activity was observed before any user interaction with the page.'
      : 'No known tracking activity was observed before user interaction.',
    items,
    disclaimer:
      'CIPA\'s application to website tracking is legally unsettled — courts have not definitively resolved whether this 1960s wiretapping law reaches modern tracking tools. This section reports technical facts only, not a legal determination. Consult a privacy attorney to assess actual exposure.',
  };
}
