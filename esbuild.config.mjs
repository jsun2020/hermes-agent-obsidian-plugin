// Build script for the Hermes Agent Obsidian plugin.
//
// Bundles src/main.ts -> main.js (CommonJS) using esbuild, mirroring the
// approach used by the Claudian plugin.
//
// IMPORTANT (mobile/iOS port): this plugin deliberately uses the browser
// `fetch` API (available in both Obsidian desktop's Electron renderer and
// Obsidian mobile's webview) instead of Node's `http`/`https`. Node builtins
// must therefore NOT be listed as `external` here — making them external would
// emit `require("http")` / `require("fs")` calls that crash at load time on
// mobile, where there is no Node runtime. They are no longer imported by the
// source at all. `platform` is set to "browser" so esbuild treats runtime
// globals (`fetch`, `TextDecoder`, `AbortController`, `ReadableStream`) as
// provided by the host rather than trying to polyfill or bundle them.
//
// `obsidian` and `electron` stay external: `obsidian` is injected by the host,
// and `electron` is reached only via a guarded `window.require("electron")`
// call in the working-folder picker (which falls back gracefully on mobile).
import esbuild from "esbuild";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2020",
  platform: "browser",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  outfile: "main.js",
  external: [
    "obsidian",
    "electron",
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
