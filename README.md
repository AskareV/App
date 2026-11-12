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
| `capture-apps` | Apps vigiladas para detectar pagos: `[{pkg, label}]` |
| `capture-log` | Últimos avisos leídos y lo que la app entendió de cada uno |
| `capture-done` | Avisos ya convertidos en movimientos (evita duplicados) |
| `fijos-app-v1` | Gastos e ingresos fijos: `{id, kind, name, cat, day, start, amounts: [{from, amount}], upTo}` |

Las fechas se guardan como `AAAA-MM-DDT12:00:00` (mediodía, hora local).

Préstamos: un préstamo es un gasto con `cat: "Préstamo"`, y cada devolución es un ingreso con
`cat: "Devolución"` y `loanId` (el `id` del préstamo). Ninguno de los dos se suma a los
gastos ni a los ingresos; la pestaña «Préstamos» muestra cuánto falta de cada uno, y
«Tengo en la cuenta» (Análisis → Histórico) sí los incluye.

Fijos: cada uno se anota solo una vez al mes, el día `day` (el 31 pasa al último día en
meses cortos), como un movimiento normal con `fixedId`, `fixedMonth` (`AAAA-MM`) y
`fixedAuto: true`. `upTo` es el último mes ya procesado: lo que se borra de un mes no vuelve.
Un cambio de monto se guarda en `amounts` con el mes desde el que vale, así los meses
anteriores no cambian. Si llega el aviso del banco de un fijo (monto ±10 %, ±7 días), la app
pregunta si es el mismo y, si lo es, el aviso reemplaza al anotado solo.
En Ajustes (el engranaje) se puede exportar todo a un archivo e importarlo de vuelta.

## Pruebas

Las de la app requieren Playwright con Chromium instalado en el sistema:

```bash
npm test
```

Las de la lectura de avisos en segundo plano (Java) corren sin teléfono:

```bash
gradle -p android :app:testReleaseUnitTest
```

Las dos usan los mismos avisos de ejemplo, en `tests/notices.tsv`.

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

### Firma propia (para poder actualizar sin perder datos)

Android solo instala una versión nueva encima de la anterior si las dos están firmadas
con la misma llave. Para eso se usa una llave propia que **no** se sube al repositorio:

1. Copiar el archivo de la llave (`.jks`) a `android/`.
2. Crear `android/keystore.properties`:

   ```properties
   storeFile=misfinanzas.jks
   storePassword=…
   keyAlias=misfinanzas
   keyPassword=…
   ```

Con eso, `npm run apk` genera `dist/MisFinanzas.apk` firmado con esa llave.
Ambos archivos están en `.gitignore`.

## Pagos automáticos (Android)

Si el usuario lo activa en Ajustes → «Detectar pagos del banco», el servicio
`PaymentNotificationListener` lee las notificaciones de las apps elegidas (solo esas)
y las guarda en el teléfono. La parte web las convierte en movimientos marcados como
«por revisar» (`pending: true`) con `parsePaymentNotice()`, que extrae el monto en
bolivianos, si es un pago o un ingreso, y un nombre sugerido.

Si la app no está abierta cuando llega un pago, `PaymentAlert` muestra un aviso propio
(«Pagaste Bs. 50,00 · ¿en qué fue?») que al tocarlo abre «Por revisar». Para eso lee el
monto en segundo plano con `NoticeAmount`, una copia en Java de las reglas de
`parsePaymentNotice()`; si se cambia una, hay que cambiar la otra (las pruebas de las dos
usan `tests/notices.tsv`).
