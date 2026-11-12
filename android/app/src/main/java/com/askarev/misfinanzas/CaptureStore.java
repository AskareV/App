package com.askarev.misfinanzas;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Guarda en el teléfono (y solo ahí) qué apps se vigilan y los avisos capturados
 * que la parte web todavía no ha procesado.
 *
 * El servicio que escucha notificaciones y el plugin que habla con la parte web
 * viven en el mismo proceso, así que basta con sincronizar los métodos.
 */
final class CaptureStore {

    private static final String PREFS = "payment_capture";
    /** Objeto JSON: paquete de la app vigilada → momento desde el que se vigila (ms). */
    private static final String KEY_WATCHED = "watched";
    /** Lista JSON de avisos capturados pendientes de procesar. */
    private static final String KEY_QUEUE = "queue";
    /** Lista JSON de huellas de avisos ya vistos, para no capturar dos veces el mismo. */
    private static final String KEY_SEEN = "seen";
    private static final String KEY_NEXT_ID = "next_id";

    private static final int MAX_QUEUE = 300;
    private static final int MAX_SEEN = 150;
    /** Dos avisos idénticos de la misma app en menos de este tiempo se cuentan como uno. */
    private static final long SAME_NOTICE_WINDOW_MS = 15_000;

    private CaptureStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSONObject readObject(Context context, String key) {
        try {
            return new JSONObject(prefs(context).getString(key, "{}"));
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    private static JSONArray readArray(Context context, String key) {
        try {
            return new JSONArray(prefs(context).getString(key, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    // ── Apps vigiladas ────────────────────────────────────────────────────

    static synchronized Set<String> getWatched(Context context) {
        Set<String> result = new HashSet<>();
        Iterator<String> keys = readObject(context, KEY_WATCHED).keys();
        while (keys.hasNext()) result.add(keys.next());
        return result;
    }

    /**
     * Momento desde el que se vigila esa app, o -1 si no se vigila. Los avisos anteriores
     * no se capturan: podrían ser pagos que ya se anotaron a mano.
     */
    static synchronized long watchedSince(Context context, String packageName) {
        return readObject(context, KEY_WATCHED).optLong(packageName, -1);
    }

    static synchronized void setWatched(Context context, Collection<String> packages) {
        JSONObject previous = readObject(context, KEY_WATCHED);
        JSONObject next = new JSONObject();
        long now = System.currentTimeMillis();
        try {
            for (String packageName : packages) {
                if (packageName == null || packageName.isEmpty()) continue;
                next.put(packageName, previous.optLong(packageName, now));
            }
        } catch (JSONException ignored) {
            // put() solo falla con claves nulas, ya descartadas
        }
        prefs(context).edit().putString(KEY_WATCHED, next.toString()).apply();
    }

    // ── Avisos capturados ─────────────────────────────────────────────────

    static synchronized JSONArray getQueue(Context context) {
        return readArray(context, KEY_QUEUE);
    }

    /**
     * Añade un aviso a la cola. Devuelve false si es una repetición de uno ya visto
     * (la misma notificación vuelta a publicar) y por tanto no se guardó.
     */
    static synchronized boolean add(
        Context context,
        String packageName,
        String appLabel,
        String notificationKey,
        long notificationWhen,
        long postedAt,
        String title,
        String text
    ) {
        String content = packageName + "\n" + title + "\n" + text;
        String contentPrint = fingerprint(content);
        String exactPrint = fingerprint(notificationKey + "\n" + notificationWhen + "\n" + content);

        JSONArray seen = readArray(context, KEY_SEEN);
        for (int i = 0; i < seen.length(); i++) {
            JSONObject entry = seen.optJSONObject(i);
            if (entry == null) continue;
            if (exactPrint.equals(entry.optString("e"))) return false;
            boolean sameContent = contentPrint.equals(entry.optString("c"));
            if (sameContent && Math.abs(postedAt - entry.optLong("t")) < SAME_NOTICE_WINDOW_MS) return false;
        }

        SharedPreferences prefs = prefs(context);
        long id = prefs.getLong(KEY_NEXT_ID, 1);
        JSONArray queue = readArray(context, KEY_QUEUE);
        try {
            JSONObject item = new JSONObject();
            item.put("id", "n" + id);
            item.put("pkg", packageName);
            item.put("app", appLabel);
            item.put("title", title);
            item.put("text", text);
            item.put("when", postedAt);
            queue.put(item);

            JSONObject print = new JSONObject();
            print.put("e", exactPrint);
            print.put("c", contentPrint);
            print.put("t", postedAt);
            seen.put(print);
        } catch (JSONException e) {
            return false;
        }

        prefs
            .edit()
            .putLong(KEY_NEXT_ID, id + 1)
            .putString(KEY_QUEUE, lastItems(queue, MAX_QUEUE).toString())
            .putString(KEY_SEEN, lastItems(seen, MAX_SEEN).toString())
            .apply();
        return true;
    }

    /** Quita de la cola los avisos que la parte web ya procesó. */
    static synchronized void remove(Context context, Collection<String> ids) {
        JSONArray queue = readArray(context, KEY_QUEUE);
        JSONArray kept = new JSONArray();
        for (int i = 0; i < queue.length(); i++) {
            JSONObject item = queue.optJSONObject(i);
            if (item != null && !ids.contains(item.optString("id"))) kept.put(item);
        }
        prefs(context).edit().putString(KEY_QUEUE, kept.toString()).apply();
    }

    private static JSONArray lastItems(JSONArray array, int max) {
        if (array.length() <= max) return array;
        List<Object> tail = new ArrayList<>();
        for (int i = array.length() - max; i < array.length(); i++) tail.add(array.opt(i));
        return new JSONArray(tail);
    }

    private static String fingerprint(String value) {
        return Integer.toHexString(value.hashCode()) + ":" + value.length();
    }
}
