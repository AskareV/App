package com.askarev.misfinanzas;

import android.app.Notification;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

/**
 * Lee las notificaciones de las apps que el usuario eligió (su banco) y guarda su texto
 * para que la app lo convierta en un gasto "por revisar".
 *
 * Solo funciona si el usuario le dio a la app el permiso de "acceso a notificaciones".
 * No mira las notificaciones de ninguna otra app y no envía nada fuera del teléfono.
 */
public class PaymentNotificationListener extends NotificationListenerService {

    private static final String TAG = "MisFinanzas";

    @Override
    public void onListenerConnected() {
        // Al conectarse (por ejemplo tras reiniciar el teléfono) se repasan las notificaciones
        // que siguen a la vista, por si alguna llegó mientras el servicio no estaba activo.
        try {
            StatusBarNotification[] active = getActiveNotifications();
            if (active == null) return;
            for (StatusBarNotification notification : active) capture(notification);
        } catch (RuntimeException e) {
            Log.w(TAG, "No se pudieron repasar las notificaciones activas", e);
        }
    }

    @Override
    public void onNotificationPosted(StatusBarNotification notification) {
        capture(notification);
    }

    private void capture(StatusBarNotification sbn) {
        try {
            if (sbn == null) return;
            String packageName = sbn.getPackageName();
            if (packageName == null || packageName.equals(getPackageName())) return;

            long since = CaptureStore.watchedSince(this, packageName);
            if (since < 0 || sbn.getPostTime() < since) return;

            Notification notification = sbn.getNotification();
            if (notification == null || notification.extras == null) return;
            // El resumen de un grupo repite lo que ya dicen las notificaciones individuales
            if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;

            Bundle extras = notification.extras;
            String title = clean(extras.getCharSequence(Notification.EXTRA_TITLE));
            String text = clean(extras.getCharSequence(Notification.EXTRA_TEXT));
            String bigText = clean(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
            // La versión desplegada suele traer el mensaje completo
            if (bigText.length() > text.length()) text = bigText;
            if (text.isEmpty()) {
                CharSequence[] lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
                if (lines != null) {
                    StringBuilder joined = new StringBuilder();
                    for (CharSequence line : lines) {
                        String cleaned = clean(line);
                        if (cleaned.isEmpty()) continue;
                        if (joined.length() > 0) joined.append('\n');
                        joined.append(cleaned);
                    }
                    text = joined.toString();
                }
            }
            if (title.isEmpty() && text.isEmpty()) return;

            String label = appLabel(packageName);
            boolean added = CaptureStore.add(this, packageName, label, sbn.getKey(), notification.when, sbn.getPostTime(), title, text);
            if (added) {
                PaymentCapturePlugin.notifyCaptured();
                // Con la app cerrada, aviso propio para ponerle nombre al pago
                PaymentAlert.onCaptured(this, label, title, text, sbn.getPostTime());
            }
        } catch (RuntimeException e) {
            // Un aviso raro nunca debe tumbar el servicio
            Log.w(TAG, "No se pudo leer una notificación", e);
        }
    }

    private String appLabel(String packageName) {
        try {
            PackageManager pm = getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString();
        } catch (PackageManager.NameNotFoundException | RuntimeException e) {
            return packageName;
        }
    }

    private static String clean(CharSequence value) {
        if (value == null) return "";
        String text = value.toString().trim();
        // Límite de seguridad: un aviso de pago es corto
        return text.length() > 2000 ? text.substring(0, 2000) : text;
    }
}
