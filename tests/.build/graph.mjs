// src/runtime/graph.ts
var MAX_EXCERPT = 320;
function clampExcerpt(text, max = MAX_EXCERPT) {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}\u2026` : flat;
}
function buildAnalysisPrompt(notes) {
  const payload = notes.map((n) => ({
    path: n.path,
    title: n.title,
    excerpt: clampExcerpt(n.excerpt)
  }));
  return [
    "You are analysing an Obsidian vault to build a SEMANTIC relationship graph.",
    "Explicit [[wikilinks]] are already known and handled separately, so focus ONLY on",
    "relationships that are NOT explicit links: shared topic, conceptual overlap, one note",
    "elaborating another, prerequisite/dependency, or contradiction.",
    "",
    "Return ONLY a JSON object (no prose, no code fence) of this exact shape:",
    '{"edges":[{"source":"<path>","target":"<path>","weight":0.0,"rel":"short label"}],',
    ' "groups":[{"name":"<topic>","members":["<path>"]}]}',
    "",
    "Rules:",
    "- Use the EXACT `path` strings below as ids. Never invent a path.",
    "- Only include an edge when the relationship is real; weight in [0.3, 1.0]. Omit weak ones.",
    "- At most ~3 edges per note; prefer the strongest.",
    "- `rel` is at most 4 words. `groups` is optional (cluster notes by topic).",
    "- Do NOT use any tools or read files. Reason only from the summaries. Output JSON only.",
    "",
    "NOTES:",
    JSON.stringify(payload)
  ].join("\n");
}
function extractJson(text) {
  if (!text) return null;
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const direct = tryParse(text.trim());
  if (direct !== null) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const f = tryParse(fence[1].trim());
    if (f !== null) return f;
  }
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"]
  ]) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const span = tryParse(text.slice(start, end + 1));
      if (span !== null) return span;
    }
  }
  return null;
}
var clamp01 = (n) => n < 0 ? 0 : n > 1 ? 1 : n;
var pairKey = (a, b) => a < b ? `${a}\0${b}` : `${b}\0${a}`;
function buildSmartGraph(notes, parsed, opts = {}) {
  const minWeight = opts.minWeight ?? 0.3;
  const includeWikilinks = opts.includeWikilinks ?? true;
  const ids = new Set(notes.map((n) => n.path));
  const nodes = notes.map((n) => ({ id: n.path, title: n.title }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const raw = parsed ?? {};
  if (Array.isArray(raw.groups)) {
    for (const g of raw.groups) {
      const name = typeof g?.name === "string" ? g.name.trim() : "";
      if (!name || !Array.isArray(g.members)) continue;
      for (const m of g.members) {
        if (typeof m !== "string") continue;
        const node = nodeById.get(m);
        if (node && !node.group) node.group = name;
      }
    }
  }
  const edges = [];
  const seen = /* @__PURE__ */ new Set();
  if (includeWikilinks) {
    for (const n of notes) {
      for (const target of n.links) {
        if (target === n.path || !ids.has(target)) continue;
        const key = pairKey(n.path, target);
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: n.path, target, weight: 1, rel: "links", kind: "link" });
      }
    }
  }
  if (Array.isArray(raw.edges)) {
    for (const e of raw.edges) {
      const source = typeof e?.source === "string" ? e.source : "";
      const target = typeof e?.target === "string" ? e.target : "";
      if (!source || !target || source === target) continue;
      if (!ids.has(source) || !ids.has(target)) continue;
      const key = pairKey(source, target);
      if (seen.has(key)) continue;
      const weightNum = typeof e.weight === "number" ? e.weight : typeof e.weight === "string" ? parseFloat(e.weight) : NaN;
      const weight = Number.isFinite(weightNum) ? clamp01(weightNum) : 0.5;
      if (weight < minWeight) continue;
      seen.add(key);
      const rel = typeof e.rel === "string" ? e.rel.trim().slice(0, 40) : "";
      edges.push({ source, target, weight, kind: "semantic", ...rel ? { rel } : {} });
    }
  }
  return { nodes, edges };
}
var DEFAULT_LAYOUT = {
  repulsion: 6e3,
  spring: 0.02,
  springLen: 90,
  gravity: 0.015,
  damping: 0.85
};
function seedPositions(count, cx, cy, radius) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points = [];
  for (let i = 0; i < count; i++) {
    const r = count <= 1 ? 0 : radius * Math.sqrt((i + 0.5) / count);
    const a = i * golden;
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), vx: 0, vy: 0 });
  }
  return points;
}
function tickForces(points, edges, cx, cy, p = DEFAULT_LAYOUT) {
  const n = points.length;
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let dx = points[i].x - points[j].x;
      let dy = points[i].y - points[j].y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        dx = (i - j) * 0.01 + 0.01;
        dy = 0.01;
        d2 = dx * dx + dy * dy;
      }
      const f = p.repulsion / d2;
      const d = Math.sqrt(d2);
      const ux = dx / d * f;
      const uy = dy / d * f;
      fx[i] += ux;
      fy[i] += uy;
      fx[j] -= ux;
      fy[j] -= uy;
    }
  }
  for (const e of edges) {
    const A = points[e.a];
    const B = points[e.b];
    if (!A || !B) continue;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const stiffness = p.spring * (0.4 + 0.6 * e.w);
    const force = (d - p.springLen) * stiffness;
    const ux = dx / d * force;
    const uy = dy / d * force;
    fx[e.a] += ux;
    fy[e.a] += uy;
    fx[e.b] -= ux;
    fy[e.b] -= uy;
  }
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const pt = points[i];
    if (pt.fixed) {
      pt.vx = 0;
      pt.vy = 0;
      continue;
    }
    fx[i] += (cx - pt.x) * p.gravity;
    fy[i] += (cy - pt.y) * p.gravity;
    pt.vx = (pt.vx + fx[i]) * p.damping;
    pt.vy = (pt.vy + fy[i]) * p.damping;
    pt.x += pt.vx;
    pt.y += pt.vy;
    energy += pt.vx * pt.vx + pt.vy * pt.vy;
  }
  return energy;
}
export {
  DEFAULT_LAYOUT,
  buildAnalysisPrompt,
  buildSmartGraph,
  clampExcerpt,
  extractJson,
  seedPositions,
  tickForces
};
