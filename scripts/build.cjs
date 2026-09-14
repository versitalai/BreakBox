#!/usr/bin/env node
/*
 * BreakBox Unified Build Script
 *
 * Replaces the 4+ hardcoded shell build scripts with a single config-driven
 * build pipeline. Reads target configuration from build-manifest.json.
 *
 * Usage:
 *   node scripts/build.js                    # Build all targets
 *   node scripts/build.js synth              # Build specific target (synth + processor)
 *   node scripts/build.js editor             # Build editor only
 *   node scripts/build.js player             # Build player only
 *   node scripts/build.js website            # Build website-only (EditorConfig for manual)
 *   node scripts/build.js --list             # List available targets
 *   node scripts/build.js --deploy           # Build all + sync to repo root for GitHub Pages
 *   node scripts/build.js --help             # Show usage
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function log(msg) {
    console.log('\x1b[36m[build]\x1b[0m ' + msg);
}

function logError(msg) {
    console.error('\x1b[31m[build ERROR]\x1b[0m ' + msg);
}

function logStep(msg) {
    console.log('  \x1b[33m\u2192\x1b[0m ' + msg);
}

function run(cmd, opts = {}) {
    const cwd = opts.cwd || ROOT;
    const silent = opts.silent || false;
    if (!silent) logStep(cmd);
    const result = execSync(cmd, {
        cwd,
        stdio: silent ? 'ignore' : 'inherit',
        encoding: 'utf8',
    });
    return result;
}

function copyFile(from, to) {
    if (fs.existsSync(from)) {
        fs.copyFileSync(from, to);
        logStep('cp ' + path.relative(ROOT, from) + ' -> ' + path.relative(ROOT, to));
    }
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Build a single target from the manifest.
 */
function buildTarget(name) {
    const manifestPath = path.join(ROOT, 'build-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const target = manifest.targets[name];

    if (!target) {
        logError('Unknown target: ' + name);
        process.exit(1);
    }

    log('Building: ' + name + ' -> ' + (target.rollup ? target.rollup.outputFile : target.entry));

    // Step 1: TypeScript compilation
    if (target.tsconfig) {
        logStep('tsc -p ' + target.tsconfig);
        run('npx tsc -p ' + target.tsconfig);
    }

    // Step 2: Copy files (processor)
    if (target.copyToWebsite) {
        copyFile(
            path.join(ROOT, target.copyToWebsite.from),
            path.join(ROOT, target.copyToWebsite.to)
        );
    }
    if (target.copyMapToWebsite) {
        copyFile(
            path.join(ROOT, target.copyMapToWebsite.from),
            path.join(ROOT, target.copyMapToWebsite.to)
        );
    }

    // Step 3: Rollup bundling
    if (target.rollup) {
        const r = target.rollup;
        const buildOutput = target.compiledEntry
            ? path.join(ROOT, target.compiledEntry)
            : path.join(ROOT, 'build', name,
                path.basename(target.entry).replace('.ts', '.js'));

        let rollupCmd = 'npx rollup ' + path.relative(ROOT, buildOutput);
        rollupCmd += ' --file ' + r.outputFile;
        rollupCmd += ' --format ' + r.format;
        rollupCmd += ' --output.name ' + r.outputName;
        rollupCmd += ' --context ' + (r.context || 'exports');
        if (r.sourcemap) rollupCmd += ' --sourcemap';
        for (const plugin of (r.plugins || [])) {
            rollupCmd += ' --plugin ' + plugin;
        }

        logStep('rollup bundle');
        run(rollupCmd);
    }

    // Step 4: Terser minification
    if (target.terser) {
        const t = target.terser;
        let terserCmd = 'npx terser ' + t.input;

        if (t.sourceMap) {
            terserCmd += ' --source-map "content=\'' + t.sourceMap.content + '\',url=\'' + t.sourceMap.url + '\'"';
        }

        terserCmd += ' -o ' + t.outputFile;

        if (t.compress) terserCmd += ' --compress';
        if (t.mangle) terserCmd += ' --mangle';
        if (t.manglePropsRegex) terserCmd += ' --mangle-props regex="' + t.manglePropsRegex + '"';
        if (t.module) terserCmd += ' --module';

        for (const [key, val] of Object.entries(t.define || {})) {
            terserCmd += ' --define ' + key + '=' + val;
        }

        logStep('terser minify');
        run(terserCmd);
    }

    log('\u2713 ' + name + ' complete');
}

/**
 * Sync website build outputs to repo root for GitHub Pages.
 */
function syncToRoot() {
    const manifestPath = path.join(ROOT, 'build-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const files = manifest.deployment.githubPages.files;

    log('Syncing to repo root for GitHub Pages');

    for (const f of files) {
        const src = path.join(ROOT, f);
        const dest = path.join(ROOT, path.basename(f));
        copyFile(src, dest);
    }

    log('\u2713 Root sync complete');
    log('Don\'t forget: git add -A && git commit -m "Deploy website to root" && git push');
}

function listTargets() {
    const manifestPath = path.join(ROOT, 'build-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    console.log('Available build targets:\n');
    for (const [name, target] of Object.entries(manifest.targets)) {
        const outputs = [];
        if (target.rollup && target.rollup.outputFile) outputs.push(target.rollup.outputFile);
        if (target.copyToWebsite && target.copyToWebsite.to) outputs.push(target.copyToWebsite.to);
        if (target.terser && target.terser.outputFile) outputs.push(target.terser.outputFile);
        console.log('  ' + name.padEnd(25) + ' -> ' + outputs.join(', '));
    }
}

function showHelp() {
    console.log(`
BreakBox Build Orchestrator

Usage:
  node scripts/build.js [target]     Build specific target(s)
  node scripts/build.js              Build all targets
  node scripts/build.js --list       List available targets
  node scripts/build.js --deploy     Build all + sync to repo root for GitHub Pages
  node scripts/build.js --help       Show this help

Targets:
  synth                 Build synth + processor
  editor                Build editor
  player                Build player
  website-editor-config Build EditorConfig for manual page
`);
}

function main() {
    const args = process.argv.slice(2).filter(a => a !== '--');

    if (args.includes('--help') || args.includes('-h')) {
        showHelp();
        process.exit(0);
    }

    if (args.includes('--list')) {
        listTargets();
        process.exit(0);
    }

    if (args.includes('--deploy')) {
        const manifestPath = path.join(ROOT, 'build-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        for (const name of Object.keys(manifest.targets)) {
            buildTarget(name);
        }
        syncToRoot();
        log('\n=== Deploy complete! ===');
        process.exit(0);
    }

    const targetNames = args.length > 0 && !args.some(a => a.startsWith('-'))
        ? args.filter(a => !a.startsWith('-'))
        : null;

    const manifestPath = path.join(ROOT, 'build-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const targetsToBuild = targetNames || Object.keys(manifest.targets);

    const actualTargets = [];
    for (const t of targetsToBuild) {
        if (t === 'synth' && !targetNames) {
            actualTargets.push('synth', 'processor');
        } else {
            actualTargets.push(t);
        }
    }

    for (const name of actualTargets) {
        buildTarget(name);
    }

    log('\n\u2713 All builds complete');
}

main();