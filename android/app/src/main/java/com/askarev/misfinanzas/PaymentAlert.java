package com.askarev.misfinanzas;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.text.NumberFormat;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Aviso propio de la app cuando anota un pago y la app no está abierta:
 * "Pagaste Bs. 50,00 · ¿en qué fue?". Al tocarlo se abre «Por revisar».
 *
 * Guarda los pagos avisados hasta que se abre la app, para que el aviso los
 * muestre todos ("3 movimientos por revisar") y no solo el último.
 */
final class PaymentAlert {

    static final String CHANNEL_ID = "pagos_detectados";
    static final int NOTIFICATION_ID = 1001;
    static final String ACTION_REVIEW = "com.askarev.misfinanzas.REVIEW";
    static final String EXTRA_OPEN_REVIEW = "com.askarev.misfinanzas.OPEN_REVIEW";

    private static final String TAG = "MisFinanzas";
    private static final String PREFS = "payment_capture";
    private static final String KEY_ENABLED = "alert_enabled";
    /** Lista JSON de pagos avisados desde la última vez que se abrió la app. */
    private static final String KEY_PENDING = "alert_pending";
    private static final int MAX_PENDING = 30;
    private static final int MAX_LINES = 5;

    private PaymentAlert() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isEnabled(Context c) {
        return prefs(c).getBoolean(KEY_ENABLED, true);
    }

    static void setEnabled(Context c, boolean enabled) {
        prefs(c).edit().putBoolean(KEY_ENABLED, enabled).apply();
        if (!enabled) clear(c);
    }

    /** Si Android deja a la app mostrar notificaciones. */
    static boolean canPost(Context c) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false;
        }
        return NotificationManagerCompat.from(c).areNotificationsEnabled();
    }

    /** La app se abrió: el aviso ya no hace falta. */
    static synchronized void clear(Context c) {
        prefs(c).edit().remove(KEY_PENDING).apply();
        try {
            NotificationManagerCompat.from(c).cancel(NOTIFICATION_ID);
        } catch (RuntimeException e) {
            Log.w(TAG, "No se pudo quitar el aviso", e);
        }
    }

    /**
     * Se llama al guardar un aviso nuevo del banco. Si trae un monto en bolivianos y la app
     * no está a la vista, muestra (o actualiza) el aviso propio.
     */
    static synchronized void onCaptured(Context context, String app, String title, String text, long when) {
        Context c = context.getApplicationContext();
        try {
            if (!isEnabled(c) || PaymentCapturePlugin.isAppVisible()) return;
            NoticeAmount parsed = NoticeAmount.parse(title, text);
            if (parsed == null) return; // promociones, códigos, etc.

            JSONArray pending = readPending(c);
            JSONObject item = new JSONObject();
            item.put("app", app);
            item.put("in", parsed.incoming);
            item.put("amount", parsed.amount);
            item.put("when", when);
            pending.put(item);
            while (pending.length() > MAX_PENDING) pending.remove(0);
            prefs(c).edit().putString(KEY_PENDING, pending.toString()).apply();

            if (canPost(c)) post(c, pending);
        } catch (JSONException | RuntimeException e) {
            // Un fallo aquí nunca debe impedir que el pago quede guardado
            Log.w(TAG, "No se pudo preparar el aviso", e);
        }
    }

    private static JSONArray readPending(Context c) {
        try {
            return new JSONArray(prefs(c).getString(KEY_PENDING, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    @SuppressLint("MissingPermission") // canPost() ya comprobó el permiso
    private static void post(Context c, JSONArray pending) {
        int count = pending.length();
        if (count == 0) return;
        ensureChannel(c);

        // Lo más reciente primero
        List<String> lines = new ArrayList<>();
        JSONObject newest = null;
        long lastWhen = 0;
        for (int i = count - 1; i >= 0; i--) {
            JSONObject it = pending.optJSONObject(i);
            if (it == null) continue;
            if (newest == null) newest = it;
            lastWhen = Math.max(lastWhen, it.optLong("when"));
            if (lines.size() < MAX_LINES) {
                lines.add(what(it) + " · " + it.optString("app") + " · " + time(it.optLong("when")));
            }
        }
        if (newest == null) return;

        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_payment)
            .setColor(0xFFD4A847)
            .setContentIntent(openReviewIntent(c))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setWhen(lastWhen > 0 ? lastWhen : System.currentTimeMillis())
            .setShowWhen(true);
        if (count == 1) {
            boolean incoming = newest.optBoolean("in");
            String app = newest.optString("app");
            b
                .setContentTitle(what(newest) + (incoming ? " · ¿de qué es?" : " · ¿en qué fue?"))
                .setContentText(app.isEmpty() ? "Toca para ponerle nombre" : "Toca para ponerle nombre · " + app);
        } else {
            NotificationCompat.InboxStyle style = new NotificationCompat.InboxStyle();
            for (String line : lines) style.addLine(line);
            if (count > lines.size()) style.setSummaryText("y " + (count - lines.size()) + " más");
            b
                .setContentTitle(count + " movimientos por revisar")
                .setContentText("Toca para ponerles nombre")
                .setNumber(count)
                .setStyle(style);
        }
        NotificationManagerCompat.from(c).notify(NOTIFICATION_ID, b.build());
    }

    private static String what(JSONObject it) {
        return (it.optBoolean("in") ? "Recibiste " : "Pagaste ") + money(it.optDouble("amount"));
    }

    private static String money(double value) {
        NumberFormat f = NumberFormat.getNumberInstance(Locale.forLanguageTag("es-BO"));
        f.setMinimumFractionDigits(2);
        f.setMaximumFractionDigits(2);
        return "Bs. " + f.format(value);
    }

    private static String time(long when) {
        return when > 0 ? new SimpleDateFormat("HH:mm", Locale.ROOT).format(new Date(when)) : "";
    }

    private static PendingIntent openReviewIntent(Context c) {
        Intent intent = new Intent(c, MainActivity.class)
            .setAction(ACTION_REVIEW)
            .putExtra(EXTRA_OPEN_REVIEW, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Pagos detectados", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Te avisa cuando la app anota un pago, para que le pongas nombre");
        // Sin sonido: el aviso del banco ya sonó en ese momento
        channel.setSound(null, null);
        channel.enableVibration(false);
        nm.createNotificationChannel(channel);
    }
}
