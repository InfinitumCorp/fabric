// Where Cumulus://ID sends the sign-in window back to. The code goes to the FabriC++ tab that
// started the sign-in, over a same-origin BroadcastChannel (this site's cross-origin opener
// policy cuts the link to window.opener). That tab hands it to the relay on the same socket
// that started the sign-in, so a code started anywhere else is refused there.

const p = new URLSearchParams(location.search);
const msg = { state: p.get('state'), code: p.get('code'), error: p.get('error'), errorDescription: p.get('error_description') };
history.replaceState(null, '', location.pathname); // don't leave the code in history

const text = document.getElementById('cid-cb-msg');
if (!msg.state) {
  text.textContent = 'Nothing to finish here. Start Cumulus://ID sign-in from FabriC++.';
} else {
  let answered = false;
  const ch = new BroadcastChannel('fabric-cid');
  ch.onmessage = (e) => {
    if (e.data?.type !== 'taken' || e.data.state !== msg.state) return;
    answered = true;
    text.textContent = msg.error ? 'Sign-in cancelled. You can close this window.' : 'Signed in. You can close this window.';
    setTimeout(() => window.close(), 600);
  };
  ch.postMessage({ type: 'code', ...msg });
  setTimeout(() => {
    if (!answered) text.textContent = 'The FabriC++ tab that started this sign-in is gone, so nothing was done. Close this window and start again.';
  }, 3000);
}
