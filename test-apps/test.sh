#!/bin/bash
# Builds HelloCpp.app, HelloSwift.app and HelloJava.app (and checks HelloElectron.app if build-electron.sh was run), then checks how toexe treats them.
# If the build fails with a "tapi error: malformed file" the Command Line Tools SDK is newer than the
# compiler; point SDKROOT at an older SDK, e.g.
#   SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk ./test.sh
set -uo pipefail
cd "$(dirname "$0")"
./build.sh >/dev/null || { echo "build failed"; exit 2; }
fail=0
check() { # label, expected text, app
  out=$(node ../cli/bin/toexe.js --check --no-color "build/$3.app" 2>&1); code=$?
  if [ $code -eq 1 ] && grep -qF "$2" <<<"$out"; then echo "PASS  $1"; else echo "FAIL  $1 (exit $code)"; echo "$out"; fail=1; fi
}
check "Swift app is blocked with the Swift message" "Swift based apps cannot become exe" HelloSwift
check "C++ app is refused as unrecognized (nothing produced)" "Unrecognized app type" HelloCpp

# Java app: the one kind toexe can wrap. Expect a wrapper folder with a .bat, the jar and exit code 0.
if [ -d build/HelloJava.app ]; then
  tmp=$(mktemp -d)
  out=$(node ../cli/bin/toexe.js --no-color --out "$tmp" build/HelloJava.app 2>&1); code=$?
  w="$tmp/HelloJava-java-wrapper"
  if [ $code -eq 0 ] && [ -f "$w/HelloJava.bat" ] && [ -f "$w/app/Java/HelloJava.jar" ] && grep -qF "NOT a native .exe" <<<"$out"; then
    echo "PASS  Java app is converted to a labelled wrapper (.bat + jar)"
  else echo "FAIL  Java app (exit $code)"; echo "$out"; fail=1; fi
  rm -rf "$tmp"
else
  echo "SKIP  Java app (HelloJava.app was not built; needs a JDK)"
fi

# Electron app: only if build-electron.sh was run (it downloads ~100 MB; the conversion downloads the Windows runtime too).
if [ -d build/HelloElectron.app ]; then
  tmp=$(mktemp -d)
  out=$(node ../cli/bin/toexe.js --no-color --out "$tmp" build/HelloElectron.app 2>&1); code=$?
  exe="$tmp/HelloElectron-win32-x64/HelloElectron.exe"
  if [ $code -eq 0 ] && file "$exe" | grep -q "PE32+ executable" && [ -f "$tmp/HelloElectron-win32-x64/resources/app/main.js" ]; then
    echo "PASS  Electron app is repackaged into a real Windows PE exe + app code"
  else echo "FAIL  Electron app (exit $code)"; echo "$out"; fail=1; fi
  rm -rf "$tmp"
else
  echo "SKIP  Electron app (run ./build-electron.sh first)"
fi
exit $fail
