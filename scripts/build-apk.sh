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

# Copia www/ dentro del proyecto Android
npx cap sync android

# Usa el Gradle instalado si lo hay; si no, el del proyecto
if command -v gradle >/dev/null 2>&1; then
  gradle -p android assembleDebug --console=plain
else
  (cd android && ./gradlew assembleDebug --console=plain)
fi

mkdir -p dist
cp android/app/build/outputs/apk/debug/app-debug.apk dist/MisFinanzas-debug.apk
ls -la dist/MisFinanzas-debug.apk
