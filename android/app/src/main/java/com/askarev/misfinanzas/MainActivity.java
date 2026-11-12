package com.askarev.misfinanzas;

import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.ArrayDeque;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "MisFinanzas";
    /** Si el WebView se cae tantas veces en este tiempo, se deja de reabrir la pantalla. */
    private static final int MAX_RENDERER_LOSSES = 3;
    private static final long RENDERER_LOSS_WINDOW_MS = 2 * 60 * 1000;
    /** Momentos de las últimas caídas; es estático para sobrevivir a recreate(). */
    private static final ArrayDeque<Long> rendererLosses = new ArrayDeque<>();

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Los plugins propios se registran antes de que arranque el puente con la parte web
        registerPlugin(PaymentCapturePlugin.class);
        super.onCreate(savedInstanceState);
        if (bridge != null) bridge.addWebViewListener(new RendererGuard());
    }

    /**
     * Si el proceso que dibuja la página se cae (Android lo cierra por falta de memoria, o
     * falla el WebView del teléfono), por defecto Android cierra la app con un error.
     * En su lugar se vuelve a abrir la pantalla: los datos ya están guardados, no se pierde nada.
     * Si se cae una y otra vez en poco tiempo, la app se cierra sin más para no quedar en bucle.
     */
    private class RendererGuard extends WebViewListener {

        @Override
        public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
            boolean crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail.didCrash();
            long now = SystemClock.elapsedRealtime();
            synchronized (rendererLosses) {
                while (!rendererLosses.isEmpty() && now - rendererLosses.peekFirst() > RENDERER_LOSS_WINDOW_MS) {
                    rendererLosses.pollFirst();
                }
                rendererLosses.addLast(now);
                if (rendererLosses.size() >= MAX_RENDERER_LOSSES) {
                    Log.e(TAG, "El WebView se cayó " + rendererLosses.size() + " veces seguidas; se cierra la app");
                    rendererLosses.clear();
                    finishAndRemoveTask();
                    return true;
                }
            }
            Log.w(TAG, "El WebView se cayó (fallo=" + crashed + "); se vuelve a abrir la pantalla");
            recreate();
            return true;
        }
    }
}
