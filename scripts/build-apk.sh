#!/usr/bin/env bash
# Genera el APK de Mis Finanzas a partir de la carpeta www/.
# Resultado: dist/MisFinanzas-debug.apk
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
GRADLE_ARGS=(assembleDebug --console=plain "-PappVersionName=$VERSION_NAME" "-PappVersionCode=$VERSION_CODE")

# Usa el Gradle instalado si lo hay; si no, el del proyecto
if command -v gradle >/dev/null 2>&1; then
  gradle -p android "${GRADLE_ARGS[@]}"
else
  (cd android && ./gradlew "${GRADLE_ARGS[@]}")
fi

mkdir -p dist
cp android/app/build/outputs/apk/debug/app-debug.apk dist/MisFinanzas-debug.apk
echo "Listo: dist/MisFinanzas-debug.apk (versión $VERSION_NAME, compilación $VERSION_CODE)"
