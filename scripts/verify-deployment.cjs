#!/usr/bin/env node
/* Verify the generated GitHub Pages root matches its canonical website/ outputs. */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "build-manifest.json"), "utf8"));
const failures = [];
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

for (const relativeSource of manifest.deployment.githubPages.files) {
    const source = path.join(root, relativeSource);
    const destination = path.join(root, path.basename(relativeSource));
    if (!fs.existsSync(source)) failures.push(`Missing generated source: ${relativeSource}`);
    else if (!fs.existsSync(destination)) failures.push(`Missing Pages copy: ${path.basename(relativeSource)}`);
    else if (digest(source) !== digest(destination)) failures.push(`Stale Pages copy: ${path.basename(relativeSource)} differs from ${relativeSource}`);
}

const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
if (!index.includes('src="beepbox_editor.min.js"')) {
    failures.push("Root index.html does not load the root production editor bundle.");
}
const notFound = fs.readFileSync(path.join(root, "404.html"), "utf8");
if (notFound.includes("slarmoo.github.io/slarmoosbox")) {
    failures.push("404.html still depends on the retired Slarmoo's Box deployment.");
}

if (failures.length > 0) {
    console.error("GitHub Pages artifact verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
}
console.log("GitHub Pages artifacts are synchronized with website/ outputs.");
