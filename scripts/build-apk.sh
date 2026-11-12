#!/usr/bin/env bash
# Genera el APK de Mis Finanzas a partir de la carpeta www/ (y un .zip con la versión web).
#
# - Si existe android/keystore.properties (con la llave propia), genera el APK
#   firmado de "release": dist/MisFinanzas.apk. Es el que conviene instalar,
#   porque las versiones siguientes se instalan encima sin perder datos.
# - Si no, genera uno de prueba con la llave de depuración de esta máquina:
#   dist/MisFinanzas-debug.apk.
set -euo pipefail
cd "$(dirname "$0")/.."

export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
if [ ! -d "$ANDROID_HOME/platforms" ]; then
  echo "No encuentro el Android SDK en $ANDROID_HOME" >&2
  exit 1
fi

[ -d node_modules ] || npm ci --no-fund --no-audit

# El "puente" de Capacitor que carga la página debe ser el de la versión instalada
cp node_modules/@capacitor/core/dist/capacitor.js www/vendor/capacitor.js

# Copia www/ dentro del proyecto Android
npx cap sync android

# Versión visible en Ajustes: nombre de package.json y un número que sube con cada cambio
VERSION_NAME="$(node -p "require('./package.json').version")"
VERSION_CODE="$(git rev-list --count HEAD 2>/dev/null || echo 1)"

if [ -f android/keystore.properties ]; then
  TASK=assembleRelease
  SRC=android/app/build/outputs/apk/release/app-release.apk
  DEST=dist/MisFinanzas.apk
else
  TASK=assembleDebug
  SRC=android/app/build/outputs/apk/debug/app-debug.apk
  DEST=dist/MisFinanzas-debug.apk
fi
GRADLE_ARGS=("$TASK" --console=plain "-PappVersionName=$VERSION_NAME" "-PappVersionCode=$VERSION_CODE")

# Usa el Gradle instalado si lo hay; si no, el del proyecto
if command -v gradle >/dev/null 2>&1; then
  gradle -p android "${GRADLE_ARGS[@]}"
else
  (cd android && ./gradlew "${GRADLE_ARGS[@]}")
fi

mkdir -p dist
cp "$SRC" "$DEST"
echo "Listo: $DEST (versión $VERSION_NAME, compilación $VERSION_CODE)"

# La misma app como sitio web (para Netlify): el contenido de www/ en un .zip
rm -f dist/MisFinanzas-web.zip
(cd www && zip -qr ../dist/MisFinanzas-web.zip . -x '.*')
echo "Listo: dist/MisFinanzas-web.zip (versión web)"
