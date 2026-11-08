package com.infinitum.fabric;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.FrameLayout;
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
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        fitSystemBars(root);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " FabricAndroid/0.15.1");

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

    /**
     * Android 15 draws apps edge to edge (behind the status bar, navigation bar and keyboard) and
     * ignores adjustResize, so pad the page by those insets ourselves, and use dark system icons
     * on the white background so the clock and battery stay readable instead of covering the page.
     */
    @SuppressWarnings("deprecation")
    private void fitSystemBars(FrameLayout root) {
        Window w = getWindow();
        w.setStatusBarColor(Color.WHITE);
        w.setNavigationBarColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= 30) {
            int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            WindowInsetsController c = w.getInsetsController();
            if (c != null) c.setSystemBarsAppearance(light, light);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            });
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
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
        // Keep the app (and any call in progress) alive in the background, as a messenger should,
        // instead of finishing the activity and orphaning the page.
        if (web.canGoBack()) web.goBack(); else moveTaskToBack(true);
    }

    @Override
    protected void onDestroy() {
        // A finished activity must not leave its page running: it would keep the microphone
        // and camera of an abandoned call open.
        if (web != null) {
            web.loadUrl("about:blank");
            ((FrameLayout) web.getParent()).removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
