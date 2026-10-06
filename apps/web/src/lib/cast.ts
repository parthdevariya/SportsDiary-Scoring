/**
 * "Cast to TV" — every route to a big screen, in order of how little the organizer must do:
 *   1. Send to a screen that is already paired (one tap)
 *   2. Pair a new screen by typing the 6-digit PIN it shows (or scanning its QR)
 *   3. Cast this tab's TV view via the browser's Presentation API (Chrome → Chromecast)
 *   4. Open the TV link on any browser — no login needed for public matches
 */
import { api, toast } from './api.ts';
import { esc } from './board.ts';

export async function openCastSheet(match: { id: string; code: string; title: string }) {
  const tvUrl = `${location.origin}/tv/m/${match.code}`;
  const sheet = document.createElement('dialog');
  sheet.className = 'sheet cast-sheet';
  let screens: any[] = [];
  try {
    screens = await api('GET', '/api/displays');
  } catch { /* scorer roles can't manage screens: they still get the link + cast options */ }
  const canPresent = 'PresentationRequest' in window;
  sheet.innerHTML = `
    <form method="dialog" class="sheet-body">
      <header class="sheet-head"><h2>Put this match on a screen</h2><button class="icon-btn" value="close" aria-label="Close">✕</button></header>
      ${screens.length ? `<section><h3>Your screens</h3><ul class="screen-list">${screens.map((s) => `
        <li><button type="button" class="screen-pick" data-id="${esc(s.id)}" ${s.locked ? 'disabled' : ''}>
          <span class="dot dot-${esc(s.status)}"></span><strong>${esc(s.name)}</strong><small>${esc(s.locked ? 'Locked' : s.assignmentLabel)}</small>
        </button></li>`).join('')}</ul></section>` : ''}
      <section><h3>Pair a new screen</h3>
        <p class="muted">Open <code>${esc(location.host)}/tv</code> on the TV. Type the code it shows.</p>
        <div class="pin-row"><input name="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="6-digit code" aria-label="Pairing code"><input name="name" placeholder="Screen name (e.g. Court 1 TV)" aria-label="Screen name"><button type="button" class="btn btn-primary" data-act="pair">Pair and show</button></div>
      </section>
      <section><h3>Other ways</h3>
        <div class="cast-ways">
          ${canPresent ? '<button type="button" class="btn" data-act="present">Cast this tab</button>' : ''}
          <a class="btn" href="${esc(tvUrl)}" target="_blank" rel="noopener">Open TV view</a>
          <button type="button" class="btn" data-act="copy">Copy TV link</button>
        </div>
        <div class="cast-qr"><img src="/api/qr?data=${encodeURIComponent(tvUrl)}" alt="QR code for the TV link" width="120" height="120"><p class="muted">Scan on a TV or streaming stick browser, or a phone connected to the screen.</p></div>
      </section>
    </form>`;
  document.body.appendChild(sheet);
  sheet.addEventListener('close', () => sheet.remove());
  sheet.showModal();

  sheet.querySelectorAll<HTMLButtonElement>('.screen-pick').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api('PATCH', `/api/displays/${b.dataset.id}`, { assignment: { mode: 'match', matchId: match.id } });
        toast(`Showing on ${b.querySelector('strong')!.textContent}`);
        sheet.close();
      } catch (e: any) {
        toast(e.message, 'error');
      }
    }),
  );
  sheet.querySelector('[data-act="pair"]')?.addEventListener('click', async () => {
    const pin = (sheet.querySelector('[name="pin"]') as HTMLInputElement).value.trim();
    const name = (sheet.querySelector('[name="name"]') as HTMLInputElement).value.trim();
    if (!/^\d{6}$/.test(pin)) return toast('Enter the 6-digit code shown on the screen', 'error');
    try {
      const d = await api('POST', '/api/displays/pair', { code: pin, name: name || undefined, assignment: { mode: 'match', matchId: match.id } });
      toast(`Paired ${d.name} — showing this match`);
      sheet.close();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  });
  sheet.querySelector('[data-act="present"]')?.addEventListener('click', async () => {
    try {
      const req = new (window as any).PresentationRequest([tvUrl]);
      await req.start();
      sheet.close();
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast('Casting is not available here — use the TV link instead', 'error');
    }
  });
  sheet.querySelector('[data-act="copy"]')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(tvUrl);
      toast('TV link copied');
    } catch {
      prompt('Copy the TV link', tvUrl);
    }
  });
}
