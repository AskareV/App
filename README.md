# Mis Finanzas

App personal para registrar gastos, ingresos y metas de ahorro, en bolivianos.
Los datos se guardan solo en el dispositivo; la app no se conecta a internet.

## Estructura

- `www/`: la app (HTML, CSS y JavaScript en `index.html`; tipografías en `fonts/`).
  Funciona igual en un navegador y dentro de la app Android.
- `android/`: proyecto Android (Capacitor 8) que empaqueta `www/` como app instalable.
- `scripts/build-apk.sh`: genera el APK.
- `scripts/make-icons.js`: dibuja el icono de la app en todos los tamaños.
- `tests/run.js`: pruebas en un navegador real a tamaño de teléfono y con hora de Bolivia.

## Datos

Todo se guarda en `localStorage`:

| Clave | Contenido |
| --- | --- |
| `gastos-app-v1` | Lista de gastos: `{id, amount, detail, cat, date}` |
| `ingresos-app-v1` | Lista de ingresos, mismo formato |
| `analisis-pcts` | Metas en porcentaje: `{gastos, ahorro, diezmo}` |
| `app-mode` | Modo abierto: `gastos`, `ingresos` o `analisis` |

Las fechas se guardan como `AAAA-MM-DDT12:00:00` (mediodía, hora local).
En Ajustes (el engranaje) se puede exportar todo a un archivo e importarlo de vuelta.

## Pruebas

Requieren Playwright con Chromium instalado en el sistema.

```bash
npm test
```

## Generar el APK

Requisitos: Node 22 o superior, Java 21 y el Android SDK (plataforma 36,
build-tools 35.0.0) en `ANDROID_HOME`; si no está definida se usa `/opt/android-sdk`.

```bash
npm ci
```

```bash
npm run apk
```

El resultado queda en `dist/MisFinanzas-debug.apk`. La versión que muestra la app
sale de `version` en `package.json` y del número de commits.
