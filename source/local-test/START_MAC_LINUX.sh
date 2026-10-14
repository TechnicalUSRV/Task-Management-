#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 24 LTS from https://nodejs.org/en/download first.'
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || exit 1
exec node server.mjs --open
