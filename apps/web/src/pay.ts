/**
 * Sandbox hosted checkout (/pay/sandbox/:id) — test mode only, never real money.
 * Like a real gateway page: the outcome is sent to the platform as a SIGNED webhook from the
 * server, and the order changes only when that webhook is verified.
 */
import { logo } from './lib/brand.ts';
import { esc, spApi, title, toast } from './lib/sp.ts';

const app = document.getElementById('app')!;
const id = location.pathname.split('/').pop()!;
const LABEL: Record<string, string> = { upi: 'UPI (VPA)', upi_qr: 'UPI QR', card: 'Debit / credit card', netbanking: 'Net banking', wallet: 'Wallet', international_card: 'International card' };

async function boot() {
  let info: any;
  try {
    info = await spApi('GET', `/api/pay/sandbox/${encodeURIComponent(id)}`);
  } catch (e: any) {
    app.innerHTML = `<div class="empty"><h1>Checkout not found</h1><p>${esc(e.message)}</p></div>`;
    return;
  }
  document.title = `Pay ${info.amount} — test checkout`;
  app.innerHTML = `<div class="pay-test-banner">TEST MODE — no real money moves. This page stands in for Razorpay / Stripe / Cashfree.</div>
  <main class="pay-wrap"><section class="pay-card card">
    <header>${logo('light', 'logo')}<span class="muted">Secure checkout</span></header>
    <p class="muted">${esc(info.description)}</p>
    <p class="pay-amount">${esc(info.amount)}</p>
    ${info.status !== 'created' ? `<p class="notice">This checkout is already ${esc(info.status)}.</p>` : `
    <form id="pf"><fieldset class="pay-methods"><legend>Pay with</legend>${info.methods.map((m: string, i: number) => `<label><input type="radio" name="method" value="${m}" ${i === 0 ? 'checked' : ''}> ${esc(LABEL[m] ?? title(m))}</label>`).join('')}</fieldset>
      <div class="pay-detail" id="pd"></div>
      <button class="btn btn-primary" data-outcome="success">Pay ${esc(info.amount)}</button>
      <button class="btn btn-quiet" type="button" data-outcome="failure">Simulate a failed payment</button></form>`}
    <p class="muted small">Order ${esc(info.orderNumber ?? '')}</p></section></main>`;
  const f = app.querySelector<HTMLFormElement>('#pf');
  if (!f) return;
  const detail = () => {
    const m = (f.querySelector('input[name="method"]:checked') as HTMLInputElement).value;
    (f.querySelector('#pd') as HTMLElement).innerHTML = m === 'upi' ? '<label>UPI ID<input value="success@upi" readonly></label>' : m === 'upi_qr' ? `<img class="pay-qr" src="/api/qr?data=${encodeURIComponent('upi://pay?pa=test@sportsdiary&am=1&tn=TEST')}" alt="Test UPI QR">` : m.includes('card') ? '<label>Card number<input value="4111 1111 1111 1111" readonly></label>' : `<label>Bank / wallet<select><option>Test ${esc(LABEL[m])}</option></select></label>`;
  };
  f.addEventListener('change', detail);
  detail();
  f.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-outcome]');
    if (!b) return;
    e.preventDefault();
    f.querySelectorAll('button').forEach((x) => (x.disabled = true));
    b.textContent = 'Processing…';
    try {
      const method = (f.querySelector('input[name="method"]:checked') as HTMLInputElement).value;
      const r = await spApi('POST', `/api/pay/sandbox/${encodeURIComponent(id)}/complete`, { outcome: b.dataset.outcome, method });
      location.href = r.redirect || '/sponsor';
    } catch (err: any) {
      toast(err.message, 'error');
      f.querySelectorAll('button').forEach((x) => (x.disabled = false));
    }
  });
}
boot();
