// /burn.html: burn every burner number of an account with its emergency burn code (no sign-in).
const $ = (id) => document.getElementById(id);

$('burn-form').onsubmit = async (ev) => {
  ev.preventDefault();
  const handle = $('burn-handle').value.trim();
  const code = $('burn-code').value.trim();
  if (!confirm(`Burn every burner number of ${handle}? This can't be undone.`)) return;
  $('burn-go').disabled = true;
  $('burn-msg').textContent = 'Burning…';
  try {
    const r = await fetch('/api/phone/burn-all', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, code }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    $('burn-code').value = '';
    $('burn-msg').textContent = body.burned
      ? `Done: ${body.burned} burner number${body.burned === 1 ? '' : 's'} burned. The code no longer works.`
      : 'Done. The account had no burner numbers left. The code no longer works.';
  } catch (e) {
    $('burn-msg').textContent = `Not burned: ${e.message}.`;
    $('burn-go').disabled = false;
  }
};
