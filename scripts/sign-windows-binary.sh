#!/bin/sh
# Velopack --signTemplate target: Authenticode-sign one file with the Certum
# SimplySign key. Non-PE files reach this script because Velopack signs every
# file it packs; non-win32 .node prebuilds are ELF or Mach-O and jsign rejects
# them, so skip anything that is not a Windows PE image.
set -eu

file="$1"

if [ -z "${MEMRY_SIGN_PIN:-}" ]; then
  echo "MEMRY_SIGN_PIN is not set. scripts/release.mjs exports it from the macOS Keychain." >&2
  exit 1
fi

case "$(file -b "$file")" in
PE32*) ;;
*)
  echo "skip non-PE: $file"
  exit 0
  ;;
esac

# The Certum key lives on a cloud HSM reached over the network, so a single sign
# can fail with CKR_FUNCTION_FAILED or a timestamping hiccup while the session is
# still valid. Velopack aborts the whole pack on the first non-zero exit, so retry
# here instead of losing 40 already-signed files.
attempt=1
while true; do
  if jsign \
    --storetype PKCS11 \
    --keystore "$HOME/.config/memrynote/simplysign-pkcs11.cfg" \
    --storepass env:MEMRY_SIGN_PIN \
    --alias 57D2B94F4B6C4356BD26F757F3855C1F \
    --certfile "$HOME/.config/memrynote/certum-chain.pem" \
    --replace \
    --alg SHA-256 \
    --tsaurl http://time.certum.pl \
    --tsmode RFC3161 \
    "$file"; then
    exit 0
  fi

  if [ "$attempt" -ge 4 ]; then
    echo "jsign failed 4 times for $file" >&2
    exit 1
  fi

  echo "jsign failed for $file, retrying in $((attempt * 5))s (attempt $attempt)" >&2
  sleep $((attempt * 5))
  attempt=$((attempt + 1))
done
