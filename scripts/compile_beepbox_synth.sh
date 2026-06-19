#!/bin/bash
set -e

# Compile synth/synth.ts into build/synth/synth.js and dependencies
npx tsc -p tsconfig_synth_only.json

# Compile worklet processor separately (must be a module)
npx tsc -p tsconfig_worklet.json
# Copy worklet to expected location (lowercase with hyphen)
cp website/synth/BreakBoxProcessor.js website/breakbox-processor.js
cp website/synth/BreakBoxProcessor.js.map website/breakbox-processor.js.map 2>/dev/null || true
# Also copy to repo root for GitHub Pages (serves from root)
cp website/synth/BreakBoxProcessor.js breakbox-processor.js
cp website/synth/BreakBoxProcessor.js.map breakbox-processor.js.map 2>/dev/null || true

# Combine build/synth/synth.js and dependencies into website/beepbox_synth.js
npx rollup build/synth/synth.js \
	--file ./website/beepbox_synth.js \
	--format iife \
	--output.name beepbox \
	--context exports \
	--sourcemap \
	--plugin @rollup/plugin-node-resolve

# Minify website/beepbox_synth.js into website/beepbox_synth.min.js
npx terser \
	./website/beepbox_synth.js \
	--source-map "content='./website/beepbox_synth.js.map',url=beepbox_synth.min.js.map" \
	-o ./website/beepbox_synth.min.js \
	--compress \
	--define OFFLINE=false \
	--mangle \
	--mangle-props regex="/^_.+/;"

# Minify worklet processor
npx terser \
	./website/breakbox-processor.js \
	--source-map "content='./website/breakbox-processor.js.map',url=breakbox-processor.min.js.map" \
	-o ./website/breakbox-processor.min.js \
	--compress \
	--mangle \
	--mangle-props regex="/^_.+/;"
