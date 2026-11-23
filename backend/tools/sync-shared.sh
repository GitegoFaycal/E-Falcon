#!/bin/sh
# The rules in frontend/src/lib are the single source of truth for tariff maths, status
# derivation, pricing precedence, the limit snapshot and the permission catalogue.
# The backend runs the same files. Run this after editing any of them (a test checks they match).
cd "$(dirname "$0")/.." || exit 1
for f in tariff permissions status selectors format; do cp "../frontend/src/lib/$f.js" "src/shared/$f.js"; done
echo "shared rules synced"
