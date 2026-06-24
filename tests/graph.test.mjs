// Unit tests for the smart-graph core (pure, no Node/Obsidian deps).
//
// Bundled by `npm run build:test` (esbuild src/runtime/graph.ts ->
// tests/.build/graph.mjs), then run with the Node built-in test runner.

import test from "node:test";
import assert from "node:assert/strict";
import {
  clampExcerpt,
  buildAnalysisPrompt,
  extractJson,
  buildSmartGraph,
  seedPositions,
  tickForces,
  DEFAULT_LAYOUT
} from "./.build/graph.mjs";

const notes = [
  { path: "a.md", title: "A", excerpt: "alpha", links: ["b.md"] },
  { path: "b.md", title: "B", excerpt: "beta", links: [] },
  { path: "c.md", title: "C", excerpt: "gamma", links: ["missing.md"] }
];

test("clampExcerpt collapses whitespace and caps length", () => {
  assert.equal(clampExcerpt("  hello   world \n x "), "hello world x");
  const long = "x".repeat(500);
  const out = clampExcerpt(long, 10);
  assert.equal(out.length, 11); // 10 chars + ellipsis
  assert.ok(out.endsWith("…"));
});

test("buildAnalysisPrompt embeds exact paths and forbids tools", () => {
  const prompt = buildAnalysisPrompt(notes);
  assert.ok(prompt.includes('"a.md"'));
  assert.ok(prompt.includes("Output JSON only"));
  assert.ok(/do not use any tools/i.test(prompt));
});

test("extractJson parses clean, fenced, and embedded JSON", () => {
  assert.deepEqual(extractJson('{"x":1}'), { x: 1 });
  assert.deepEqual(extractJson('```json\n{"x":2}\n```'), { x: 2 });
  assert.deepEqual(extractJson('here is the result: {"x":3} done'), { x: 3 });
  assert.equal(extractJson("not json at all"), null);
  assert.equal(extractJson(""), null);
});

test("buildSmartGraph builds one node per note and never invents nodes", () => {
  const parsed = { edges: [{ source: "a.md", target: "zzz.md", weight: 0.9 }] };
  const g = buildSmartGraph(notes, parsed);
  assert.equal(g.nodes.length, 3);
  // Edge to an unknown id is dropped; only the valid wikilink a->b survives.
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0].kind, "link");
});

test("buildSmartGraph keeps wikilink edges and drops out-of-vault links", () => {
  const g = buildSmartGraph(notes, {});
  const link = g.edges.find((e) => e.kind === "link");
  assert.ok(link);
  assert.equal(link.source, "a.md");
  assert.equal(link.target, "b.md");
  // c.md -> missing.md is not in the vault, so it is excluded.
  assert.ok(!g.edges.some((e) => e.target === "missing.md"));
});

test("buildSmartGraph filters semantic edges by minWeight and clamps", () => {
  const parsed = {
    edges: [
      { source: "a.md", target: "c.md", weight: 0.8, rel: "same topic" },
      { source: "b.md", target: "c.md", weight: 0.1 } // below default 0.3 -> dropped
    ]
  };
  const g = buildSmartGraph(notes, parsed);
  const semantic = g.edges.filter((e) => e.kind === "semantic");
  assert.equal(semantic.length, 1);
  assert.equal(semantic[0].rel, "same topic");
  assert.equal(semantic[0].weight, 0.8);
});

test("buildSmartGraph: wikilink wins the unordered pair over a semantic dup", () => {
  // a.md<->b.md already exists as a wikilink; a semantic edge for the same pair
  // must not be added a second time.
  const parsed = { edges: [{ source: "b.md", target: "a.md", weight: 0.9 }] };
  const g = buildSmartGraph(notes, parsed);
  const ab = g.edges.filter(
    (e) => (e.source === "a.md" && e.target === "b.md") || (e.source === "b.md" && e.target === "a.md")
  );
  assert.equal(ab.length, 1);
  assert.equal(ab[0].kind, "link");
});

test("buildSmartGraph honours includeWikilinks:false", () => {
  const g = buildSmartGraph(notes, {}, { includeWikilinks: false });
  assert.equal(g.edges.length, 0);
});

test("buildSmartGraph assigns topic groups to known nodes only", () => {
  const parsed = { groups: [{ name: "Greek", members: ["a.md", "b.md", "ghost.md"] }] };
  const g = buildSmartGraph(notes, parsed);
  assert.equal(g.nodes.find((n) => n.id === "a.md").group, "Greek");
  assert.equal(g.nodes.find((n) => n.id === "c.md").group, undefined);
});

test("seedPositions is deterministic and finite", () => {
  const p1 = seedPositions(5, 100, 100, 50);
  const p2 = seedPositions(5, 100, 100, 50);
  assert.deepEqual(p1, p2);
  assert.equal(p1.length, 5);
  for (const pt of p1) {
    assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y));
  }
});

test("tickForces keeps positions finite and pulls a connected pair together", () => {
  const pts = [
    { x: 0, y: 0, vx: 0, vy: 0 },
    { x: 400, y: 0, vx: 0, vy: 0 }
  ];
  const edges = [{ a: 0, b: 1, w: 1 }];
  const before = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  let energy = 0;
  for (let i = 0; i < 60; i++) {
    energy = tickForces(pts, edges, 200, 0, DEFAULT_LAYOUT);
  }
  for (const pt of pts) assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y));
  const after = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  // The spring (rest length 90) pulls a 400px-apart pair closer.
  assert.ok(after < before);
  assert.ok(Number.isFinite(energy));
});

test("tickForces respects fixed points", () => {
  const pts = [
    { x: 10, y: 10, vx: 0, vy: 0, fixed: true },
    { x: 300, y: 10, vx: 0, vy: 0 }
  ];
  tickForces(pts, [{ a: 0, b: 1, w: 1 }], 150, 10, DEFAULT_LAYOUT);
  assert.equal(pts[0].x, 10);
  assert.equal(pts[0].y, 10);
});
