#!/usr/bin/env node
/* Cross-platform local production preview for BreakBox.
 * Serves the repository root, matching GitHub Pages' deployment layout. */
const path = require("path");
const express = require("express");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "127.0.0.1";
const app = express();

app.use(express.static(root, { extensions: ["html"] }));
app.listen(port, host, () => {
    console.log(`BreakBox preview: http://${host}:${port}/`);
});
