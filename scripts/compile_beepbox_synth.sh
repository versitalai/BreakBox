#!/bin/bash
set -e

# Legacy compatibility wrapper — delegates to the config-driven build orchestrator.
# New code should use: node scripts/build.cjs synth
# This script is kept for backward compatibility with existing CI/deploy setups.

echo "[DEPRECATED] compile_beepbox_synth.sh — use 'npm run build-synth' instead"
exec node scripts/build.cjs synth
