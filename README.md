# Mis Finanzas

App personal para registrar gastos, ingresos y metas de ahorro, en bolivianos.
Los datos se guardan solo en el dispositivo.

## Estructura

- `www/`: la app (HTML, CSS y JavaScript).
- `android/`: proyecto Android (Capacitor) que empaqueta `www/` como app instalable.
- `scripts/build-apk.sh`: genera el APK.

## Generar el APK

Requisitos: Node 22 o superior, Java 21 y el Android SDK (plataforma 36,
build-tools 35.0.0) en `ANDROID_HOME`; si no está definida se usa `/opt/android-sdk`.

```bash
npm ci
```

```bash
npm run apk
```

El resultado queda en `dist/MisFinanzas-debug.apk`.
