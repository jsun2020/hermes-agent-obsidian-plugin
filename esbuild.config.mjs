// Build script for the Hermes Agent Obsidian plugin.
// Bundles src/main.ts -> main.js (CommonJS) using esbuild, mirroring the
// approach used by the Claudian plugin. The Ignis-compatible transport relies
// on browser fetch rather than Node http/https.
import esbuild from "esbuild";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2018",
  platform: "node",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  outfile: "main.js",
  external: [
    "obsidian",
    "electron",
    "url",
    "fs",
    "os",
    "path",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common"
  ]
});

if (production) {
  await context.rebuild();
  await context.dispose();
  process.exit(0);
} else {
  await context.watch();
  console.log("[hermes-agent] watching for changes...");
}
