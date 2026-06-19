#!/bin/bash
set -e

# Compile synth/synth.ts into build/synth/synth.js and dependencies
npx tsc -p tsconfig_synth_only.json

# Compile AudioWorklet processor separately (must be a module)
npx tsc -p tsconfig_processor.json

# Combine build/synth/synth.js and dependencies into website/beepbox_synth.js
npx rollup build/synth/synth.js \
    --file ./website/beepbox_synth.js \
    --format iife \
    --output.name beepbox \
    --context exports \
    --sourcemap \
    --plugin @rollup/plugin-node-resolve

# Copy processor to website (as a module)
cp build/synth/synth/BreakBoxProcessor.js ./website/breakbox-processor.js
cp build/synth/synth/BreakBoxProcessor.js.map ./website/breakbox-processor.js.map

# Minify website/beepbox_synth.js into website/beepbox_synth.min.js
npx terser \
    ./website/beepbox_synth.js \
    --source-map "content='./website/beepbox_synth.js.map',url=beepbox_synth.min.js.map" \
    -o ./website/beepbox_synth.min.js \
    --compress \
    --define OFFLINE=false \
    --mangle \
    --mangle-props regex="/^_.+/;"

# Minify processor
npx terser \
    ./website/breakbox-processor.js \
    --source-map "content='./website/breakbox-processor.js.map',url=breakbox-processor.min.js.map" \
    -o ./website/breakbox-processor.min.js \
    --compress \
    --mangle \
    --module