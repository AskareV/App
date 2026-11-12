package com.askarev.misfinanzas;

import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.lang.ref.WeakReference;
import java.text.Collator;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONException;

/**
 * Puente entre la parte web y la captura de notificaciones de pago:
 * elegir qué apps se vigilan, abrir los ajustes del permiso y recoger los avisos capturados.
 */
@CapacitorPlugin(name = "PaymentCapture")
public class PaymentCapturePlugin extends Plugin {

    private static final String EVENT_CAPTURED = "captured";
    private static WeakReference<PaymentCapturePlugin> current = new WeakReference<>(null);

    @Override
    public void load() {
        current = new WeakReference<>(this);
        requestRebindIfEnabled();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        requestRebindIfEnabled();
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        // La pantalla se cerró: los avisos nuevos se recogerán cuando se vuelva a abrir
        if (current.get() == this) current = new WeakReference<>(null);
    }

    /** Lo llama el servicio cuando captura un aviso, por si la app está abierta en ese momento. */
    static void notifyCaptured() {
        PaymentCapturePlugin plugin = current.get();
        if (plugin != null && plugin.getBridge() != null) plugin.notifyListeners(EVENT_CAPTURED, new JSObject());
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", isListenerEnabled());
        result.put("watched", new JSArray(CaptureStore.getWatched(getContext())));
        result.put("androidVersion", Build.VERSION.SDK_INT);
        call.resolve(result);
    }

    /** Apps instaladas que se pueden abrir desde el menú, para que el usuario elija su banco. */
    @PluginMethod
    public void listApps(PluginCall call) {
        Context context = getContext();
        PackageManager pm = context.getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> activities = pm.queryIntentActivities(launcher, 0);

        List<String[]> apps = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (ResolveInfo info : activities) {
            if (info.activityInfo == null) continue;
            String packageName = info.activityInfo.packageName;
            if (packageName == null || packageName.equals(context.getPackageName()) || !seen.add(packageName)) continue;
            CharSequence label = info.activityInfo.applicationInfo.loadLabel(pm);
            apps.add(new String[] { packageName, label == null ? packageName : label.toString() });
        }
        Collator collator = Collator.getInstance(Locale.getDefault());
        collator.setStrength(Collator.PRIMARY);
        apps.sort((a, b) -> collator.compare(a[1], b[1]));

        JSArray list = new JSArray();
        for (String[] app : apps) {
            JSObject item = new JSObject();
            item.put("pkg", app[0]);
            item.put("label", app[1]);
            list.put(item);
        }
        JSObject result = new JSObject();
        result.put("apps", list);
        call.resolve(result);
    }

    @PluginMethod
    public void setWatched(PluginCall call) {
        JSArray packages = call.getArray("packages", new JSArray());
        List<String> names = new ArrayList<>();
        try {
            for (Object value : packages.toList()) if (value instanceof String) names.add((String) value);
        } catch (JSONException e) {
            call.reject("Lista de apps inválida");
            return;
        }
        CaptureStore.setWatched(getContext(), names);
        call.resolve();
    }

    /** Abre la pantalla de Android donde se da el permiso de acceso a notificaciones. */
    @PluginMethod
    public void openAccessSettings(PluginCall call) {
        Context context = getContext();
        Intent general = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // Desde Android 11 se puede ir directo al interruptor de esta app
                Intent detail = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                    .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, listenerComponent().flattenToString())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    context.startActivity(detail);
                    call.resolve();
                    return;
                } catch (ActivityNotFoundException | SecurityException e) {
                    // Algunos fabricantes no tienen esa pantalla: se usa la lista general
                }
            }
            context.startActivity(general);
            call.resolve();
        } catch (ActivityNotFoundException | SecurityException e) {
            call.reject("No se pudo abrir la pantalla de permisos");
        }
    }

    /** Abre la ficha de la app en Ajustes (ahí está "Permitir ajustes restringidos"). */
    @PluginMethod
    public void openAppInfo(PluginCall call) {
        Context context = getContext();
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.getPackageName(), null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException | SecurityException e) {
            call.reject("No se pudo abrir la información de la app");
        }
    }

    /** Avisos capturados que la parte web todavía no ha procesado. */
    @PluginMethod
    public void getCaptured(PluginCall call) {
        JSObject result = new JSObject();
        try {
            result.put("items", JSArray.from(CaptureStore.getQueue(getContext())));
        } catch (RuntimeException e) {
            result.put("items", new JSArray());
        }
        call.resolve(result);
    }

    @PluginMethod
    public void removeCaptured(PluginCall call) {
        JSArray ids = call.getArray("ids", new JSArray());
        Set<String> set = new HashSet<>();
        try {
            for (Object value : ids.toList()) if (value instanceof String) set.add((String) value);
        } catch (JSONException e) {
            call.reject("Lista de avisos inválida");
            return;
        }
        CaptureStore.remove(getContext(), set);
        call.resolve();
    }

    private ComponentName listenerComponent() {
        return new ComponentName(getContext(), PaymentNotificationListener.class);
    }

    private boolean isListenerEnabled() {
        return NotificationManagerCompat.getEnabledListenerPackages(getContext()).contains(getContext().getPackageName());
    }

    /**
     * Si el permiso está dado pero Android desconectó el servicio (pasa a veces tras
     * actualizar la app), le pide que lo vuelva a conectar.
     */
    private void requestRebindIfEnabled() {
        try {
            if (isListenerEnabled()) NotificationListenerService.requestRebind(listenerComponent());
        } catch (RuntimeException ignored) {
            // No es crítico: Android lo reconecta por su cuenta más tarde
        }
    }
}
