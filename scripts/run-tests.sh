#!/usr/bin/env bash
# Runs every end-to-end test against a fresh mock Supabase (tests share the
# mock's in-memory state, so each one gets its own instance).
set -u
cd "$(dirname "$0")/.."
python3 -m http.server 8000 >/dev/null 2>&1 &
WEB=$!
trap 'kill $WEB 2>/dev/null; kill $MOCK 2>/dev/null' EXIT
sleep 1
fail=0
for t in *-test.js; do
  node mock-supabase.js >/dev/null 2>&1 &
  MOCK=$!
  sleep 0.7
  if node "$t" > "/tmp/padelzit-$t.log" 2>&1; then
    echo "PASS $t"
  else
    echo "FAIL $t"; tail -20 "/tmp/padelzit-$t.log"; fail=1
  fi
  kill $MOCK 2>/dev/null; wait $MOCK 2>/dev/null
done
exit $fail
