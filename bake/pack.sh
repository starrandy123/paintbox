#!/bin/sh
# The uploaded build: the page, its modules, the three trained painters and the rights declaration. Nothing else.
set -e
cd "$(dirname "$0")/../game"
mkdir -p ../out
NAME="${1:-game}"
rm -f "../out/$NAME.zip"
zip -q -X "../out/$NAME.zip" index.html main.js render.js painter.js world.js m4.js painter.bin surface.bin sky.bin rights.json
ls -l "../out/$NAME.zip" | awk '{print $5, $9}'
unzip -l "../out/$NAME.zip" | tail -n +4 | sed '$d' | sed '$d'
