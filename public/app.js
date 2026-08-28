const form = document.getElementById('scan-form');
const input = document.getElementById('url-input');
const button = document.getElementById('scan-button');
const statusEl = document.getElementById('status');
const reportEl = document.getElementById('report');
const cardSection = document.getElementById('card-section');
const cardErrors = document.getElementById('card-errors');
const authCheckbox = document.getElementById('auth-checkbox');
const cipaCheckbox = document.getElementById('cipa-checkbox');
const priceDisplay = document.getElementById('price-display');

const BASE_PRICE = 9.00;
const CIPA_ADDON_PRICE = 7.00;

function updatePriceDisplay() {
  const total = BASE_PRICE + (cipaCheckbox.checked ? CIPA_ADDON_PRICE : 0);
  priceDisplay.textContent = total.toFixed(2);
}
cipaCheckbox.addEventListener('change', updatePriceDisplay);

// Set window.STRIPE_PUBLISHABLE_KEY in a <script> tag before this file loads,
// or inject it server-side when rendering index.html. Never put the secret
// key here — only the publishable key belongs in front-end code.
const stripe = window.STRIPE_PUBLISHABLE_KEY ? Stripe(window.STRIPE_PUBLISHABLE_KEY) : null;
let elements, cardElement;

if (stripe) {
  elements = stripe.elements();
  cardElement = elements.create('card', {
    style: {
      base: {
        color: '#E7ECF3',
        fontFamily: '"IBM Plex Mono", monospace',
        fontSize: '15px',
        '::placeholder': { color: '#7C8AA5' },
      },
      invalid: { color: '#F26D6D' },
    },
  });
  cardSection.hidden = false;
  cardElement.mount('#card-element');
  cardElement.on('change', (event) => {
    cardErrors.textContent = event.error ? event.error.message : '';
  });
}

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

    const citationEntries = Object.entries(item.citations || {});
    const citationsHtml = citationEntries.length
      ? citationEntries.map(([jurisdiction, c]) =>
          `<div class="check-citation">
            <a href="${c.url}" target="_blank" rel="noopener">${jurisdiction}: ${c.statute}</a>
            <span class="citation-summary"> — ${c.summary}</span>
          </div>`
        ).join('')
      : '';

    card.innerHTML = `
      <div class="check-top">
        <span class="check-name">${item.check}</span>
        <span class="check-badge ${item.status}">${item.status}</span>
      </div>
      <p class="check-detail">${item.detail}</p>
      ${item.whyItMatters ? `<p class="check-detail">${item.whyItMatters}</p>` : ''}
      ${statesLine ? `<p class="check-states">${statesLine}</p>` : ''}
      ${citationsHtml}
    `;
    reportEl.appendChild(card);
  }

  const disclaimer = document.createElement('p');
  disclaimer.className = 'report-disclaimer';
  disclaimer.textContent = report.disclaimer;
  reportEl.appendChild(disclaimer);
}

function renderCipaReport(cipa) {
  const section = document.createElement('div');
  section.className = 'cipa-report-section';

  if (cipa.error) {
    section.innerHTML = `
      <p class="cipa-report-title">CIPA Pre-Consent Tracking Check</p>
      <p class="check-detail">${cipa.error}</p>
    `;
    reportEl.appendChild(section);
    return;
  }

  let html = `<p class="cipa-report-title">CIPA Pre-Consent Tracking Check</p>
    <p class="check-detail">${cipa.summary}</p>`;

  for (const item of cipa.items) {
    const citationEntries = Object.entries(item.citations || {});
    const citationsHtml = citationEntries.length
      ? citationEntries.map(([jurisdiction, c]) =>
          `<div class="check-citation">
            <a href="${c.url}" target="_blank" rel="noopener">${jurisdiction}: ${c.statute}</a>
            <span class="citation-summary"> — ${c.summary}</span>
          </div>`
        ).join('')
      : '';
    html += `
      <div class="check-card cipa ${item.status}">
        <div class="check-top">
          <span class="check-name">${item.check}</span>
          <span class="check-badge ${item.status}">${item.status}</span>
        </div>
        <p class="check-detail">${item.detail}</p>
        ${item.legalNote ? `<p class="check-detail">${item.legalNote}</p>` : ''}
        ${citationsHtml}
      </div>
    `;
  }
  html += `<p class="report-disclaimer">${cipa.disclaimer}</p>`;
  section.innerHTML = html;
  reportEl.appendChild(section);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  reportEl.hidden = true;
  reportEl.innerHTML = '';
  cardErrors.textContent = '';

  const targetUrl = normalizeUrl(input.value);
  const includeCipa = cipaCheckbox.checked;
  button.disabled = true;

  try {
    let paymentIntentId = null;

    if (stripe) {
      // Step 1: create the hold (authorize, don't charge yet)
      setStatus('authorizing payment...');
      const intentRes = await fetch('/api/create-payment-intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl, includeCipa }),
      });
      const intentData = await intentRes.json();
      if (!intentRes.ok) {
        setStatus(intentData.error || 'Could not start payment.', true);
        button.disabled = false;
        return;
      }

      const confirmResult = await stripe.confirmCardPayment(intentData.clientSecret, {
        payment_method: { card: cardElement },
      });
      if (confirmResult.error) {
        cardErrors.textContent = confirmResult.error.message;
        setStatus('Payment authorization failed — your card was not charged.', true);
        button.disabled = false;
        return;
      }
      paymentIntentId = confirmResult.paymentIntent.id;
    }

    // Step 2: run the scan. Server captures on success, cancels on failure.
    setStatus(`scanning ${targetUrl} — this takes 15-30 seconds${includeCipa ? ' (a bit longer with the CIPA add-on)' : ''}...`);
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl, paymentIntentId, authorizedAttestation: authCheckbox.checked, includeCipa }),
    });
    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || 'Scan failed.', true);
      return;
    }

    clearStatus();
    renderReport(data);
    if (data.cipa) {
      renderCipaReport(data.cipa);
    }
  } catch (err) {
    setStatus('Network error — could not complete the request.', true);
  } finally {
    button.disabled = false;
  }
});
