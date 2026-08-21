const form = document.getElementById('scan-form');
const input = document.getElementById('url-input');
const button = document.getElementById('scan-button');
const statusEl = document.getElementById('status');
const reportEl = document.getElementById('report');

function normalizeUrl(raw) {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function setStatus(message, isError = false) {
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function clearStatus() {
  statusEl.hidden = true;
  statusEl.textContent = '';
}

function renderReport(report) {
  reportEl.hidden = false;
  reportEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'report-header';
  header.innerHTML = `
    <p class="report-target">${report.targetUrl}</p>
    <p class="report-summary">${report.summary}</p>
    <div class="report-counts">
      <span class="count-pass">${report.counts.pass} pass</span>
      <span class="count-fail">${report.counts.fail} fail</span>
      <span class="count-unknown">${report.counts.unknown} unverified</span>
    </div>
  `;
  reportEl.appendChild(header);

  for (const item of report.items) {
    const card = document.createElement('div');
    card.className = `check-card ${item.status}`;
    const statesLine = item.relevantStates && item.relevantStates.length
      ? `Relevant in: ${item.relevantStates.join(', ')}`
      : '';
    card.innerHTML = `
      <div class="check-top">
        <span class="check-name">${item.check}</span>
        <span class="check-badge ${item.status}">${item.status}</span>
      </div>
      <p class="check-detail">${item.detail}</p>
      ${item.whyItMatters ? `<p class="check-detail">${item.whyItMatters}</p>` : ''}
      ${statesLine ? `<p class="check-states">${statesLine}</p>` : ''}
    `;
    reportEl.appendChild(card);
  }

  const disclaimer = document.createElement('p');
  disclaimer.className = 'report-disclaimer';
  disclaimer.textContent = report.disclaimer;
  reportEl.appendChild(disclaimer);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  reportEl.hidden = true;
  reportEl.innerHTML = '';

  const targetUrl = normalizeUrl(input.value);
  button.disabled = true;
  setStatus(`scanning ${targetUrl} — this takes 15-30 seconds...`);

  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl }),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || 'Scan failed.', true);
      return;
    }

    clearStatus();
    renderReport(data);
  } catch (err) {
    setStatus('Network error — could not reach the scan engine.', true);
  } finally {
    button.disabled = false;
  }
});
