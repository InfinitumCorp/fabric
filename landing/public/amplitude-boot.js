/* Amplitude analytics: page views and sessions only (vendored Browser SDK 2.49.2, US region,
   no autocapture of forms or clicks, no session replay, no remote config, no IP address).
   The key below is the public API key, never the Secret key.

   A page view records the page URL, and sign-in hands secrets over in the URL for a moment
   (Cumulus ID's cid_token in the hash, a code in the query, #join= space keys). So this waits
   until the page has cleaned its URL and starts only when there is no hash and no query
   parameter other than the harmless ones below. If the URL never becomes clean, it never starts. */
(function () {
  var KEY = "756c0bc80c5cb27386bfd7b2b13196c8";
  var HARMLESS = { profile: 1, lang: 1 };
  var tries = 0;
  function clean() {
    if (location.hash) return false;
    var keys = new URLSearchParams(location.search).keys();
    for (var k = keys.next(); !k.done; k = keys.next()) if (!HARMLESS[k.value]) return false;
    return true;
  }
  function start() {
    if (typeof initInfinitumAmplitude !== "function") return;
    if (clean()) initInfinitumAmplitude(KEY);
    else if (++tries < 60) setTimeout(start, 1000);
  }
  start();
})();
