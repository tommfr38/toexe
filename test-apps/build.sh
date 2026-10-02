#!/bin/bash
# Builds minimal .app bundles for testing toexe: HelloCpp.app (C++), HelloSwift.app (Swift)
# and HelloJava.app (pure Java/JAR, the one kind toexe can wrap).
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-build}"
mkdir -p "$OUT"; rm -rf "$OUT/HelloCpp.app" "$OUT/HelloSwift.app" "$OUT/HelloJava.app"  # keep HelloElectron.app and the download cache

make_app() { # name, executable, bundle id
  local app="$OUT/$1.app"
  mkdir -p "$app/Contents/MacOS"
  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>$1</string>
<key>CFBundleExecutable</key><string>$2</string>
<key>CFBundleIdentifier</key><string>$3</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>
PLIST
  echo "$app/Contents/MacOS/$2"
}

clang++ -std=c++17 -O1 src/hello.cpp -o "$(make_app HelloCpp HelloCpp com.toexe.test.hellocpp)"
swiftc -O src/hello.swift -o "$(make_app HelloSwift HelloSwift com.toexe.test.helloswift)"

# Java app: a jar in Contents/Java plus a JavaAppLauncher script, no macOS natives, no bundled JRE.
# /usr/bin/javac is only a stub on Macs without a JDK, so look for a working one.
JDK_BIN=""
for c in "${JAVA_HOME:+$JAVA_HOME/bin}" /opt/homebrew/opt/openjdk/bin /usr/local/opt/openjdk/bin /usr/bin; do
  [ -n "$c" ] && [ -x "$c/javac" ] && "$c/javac" -version >/dev/null 2>&1 && JDK_BIN="$c" && break
done
if [ -n "$JDK_BIN" ]; then
  export PATH="$JDK_BIN:$PATH"
  JAVA_APP="$OUT/HelloJava.app"
  mkdir -p "$JAVA_APP/Contents/MacOS" "$JAVA_APP/Contents/Java" "$OUT/.java-classes"
  javac --release 11 -d "$OUT/.java-classes" src/HelloJava.java
  jar cfe "$JAVA_APP/Contents/Java/HelloJava.jar" HelloJava -C "$OUT/.java-classes" .
  rm -rf "$OUT/.java-classes"
  cat > "$JAVA_APP/Contents/MacOS/JavaAppLauncher" <<'LAUNCH'
#!/bin/sh
exec java -jar "$(dirname "$0")/../Java/HelloJava.jar" "$@"
LAUNCH
  chmod +x "$JAVA_APP/Contents/MacOS/JavaAppLauncher"
  cat > "$JAVA_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>HelloJava</string>
<key>CFBundleExecutable</key><string>JavaAppLauncher</string>
<key>CFBundleIdentifier</key><string>com.toexe.test.hellojava</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>JVMMainClassName</key><string>HelloJava</string>
<key>JVMClassPath</key><array><string>$APP_ROOT/Contents/Java/HelloJava.jar</string></array>
</dict></plist>
PLIST
  echo "Built: $OUT/HelloCpp.app $OUT/HelloSwift.app $JAVA_APP"
else
  echo "Built: $OUT/HelloCpp.app $OUT/HelloSwift.app (no working JDK found, skipped HelloJava.app; try brew install openjdk)"
fi
