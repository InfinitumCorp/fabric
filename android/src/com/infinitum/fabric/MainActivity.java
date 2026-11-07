package com.infinitum.fabric;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;
import java.util.List;

/**
 * FabriC++ for Android: the web client in a WebView, pointed at one relay. All crypto, the vault
 * and the on-device AI run in the page exactly as in a browser; this shell only adds the camera and
 * microphone permissions calls need, and keeps navigation on the relay's own origin.
 *
 * Relay: http://localhost:8788/ by default (a development relay reached over `adb reverse`).
 * Set another with: adb shell am start -n com.infinitum.fabric/.MainActivity -e relay https://relay.example
 * Only https relays are accepted, apart from localhost.
 */
public class MainActivity extends Activity {
    private static final String DEFAULT_RELAY = "http://localhost:8788/";
    private static final int PERMS = 1;

    private WebView web;
    private Uri relay;
    private PermissionRequest pending;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        SharedPreferences prefs = getSharedPreferences("fabric", MODE_PRIVATE);
        String chosen = getIntent().getStringExtra("relay");
        if (chosen != null && allowedRelay(Uri.parse(chosen))) prefs.edit().putString("relay", chosen).apply();
        relay = Uri.parse(prefs.getString("relay", DEFAULT_RELAY));
        if (!allowedRelay(relay)) relay = Uri.parse(DEFAULT_RELAY);

        // debuggable builds only (FABRIC_DEBUG=1 bash android/build.sh); release builds never expose the page
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " FabricAndroid/0.15.0");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (sameOrigin(u)) return false;
                // anything else (docs, checkout pages) opens in the browser, never inside the app
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> askFor(request));
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(relay.toString());
    }

    private static boolean allowedRelay(Uri u) {
        if (u == null || u.getHost() == null) return false;
        if ("https".equals(u.getScheme())) return true;
        return "http".equals(u.getScheme()) && ("localhost".equals(u.getHost()) || "127.0.0.1".equals(u.getHost()));
    }

    private boolean sameOrigin(Uri u) {
        return u != null && relay.getScheme().equals(u.getScheme()) && relay.getHost().equals(u.getHost()) && relay.getPort() == u.getPort();
    }

    /** Camera/microphone for the relay's own page only, after Android's own permission prompt. */
    private void askFor(PermissionRequest request) {
        if (!sameOrigin(request.getOrigin())) { request.deny(); return; }
        List<String> need = new ArrayList<>();
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.CAMERA);
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.RECORD_AUDIO);
        }
        if (need.isEmpty()) { grantAllowed(request); return; }
        if (pending != null) pending.deny();
        pending = request;
        requestPermissions(need.toArray(new String[0]), PERMS);
    }

    private void grantAllowed(PermissionRequest request) {
        List<String> ok = new ArrayList<>();
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) ok.add(r);
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) ok.add(r);
        }
        if (ok.isEmpty()) request.deny(); else request.grant(ok.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (code == PERMS && pending != null) { grantAllowed(pending); pending = null; }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
