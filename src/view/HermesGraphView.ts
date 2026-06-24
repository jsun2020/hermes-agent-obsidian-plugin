// HermesGraphView — the agent-built "smart graph" (decision: option 2).
//
// Hermes reads a summary of the vault (note titles + excerpts + existing
// [[wikilinks]]) and returns SEMANTIC relationships the native graph can't see.
// We render the result as an interactive, dependency-free force-directed graph
// on a <canvas>: drag nodes, pan the background, wheel to zoom, click a node to
// open the note. All the maths and validation live in runtime/graph.ts (pure,
// tested); this file is the impure shell (vault reads, Hermes call, painting).

import { ItemView, WorkspaceLeaf, Notice, TFile, setIcon } from "obsidian";
import type HermesPlugin from "../main";
import {
  SmartGraph,
  NoteSummary,
  LayoutPoint,
  LayoutEdge,
  buildAnalysisPrompt,
  extractJson,
  buildSmartGraph,
  seedPositions,
  tickForces
} from "../runtime/graph";

export const VIEW_TYPE_HERMES_GRAPH = "hermes-graph";

interface ThemeColors {
  node: string;
  nodeStroke: string;
  semantic: string;
  link: string;
  text: string;
}

const GROUP_PALETTE = [
  "#e06c75",
  "#61afef",
  "#98c379",
  "#e5c07b",
  "#c678dd",
  "#56b6c2",
  "#d19a66",
  "#56b6c2"
];

export class HermesGraphView extends ItemView {
  private plugin: HermesPlugin;

  private toolbarEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private analyzeBtn!: HTMLButtonElement;
  private canvasWrapEl!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private emptyEl!: HTMLElement;

  // graph + layout state
  private graph: SmartGraph | null = null;
  private points: LayoutPoint[] = [];
  private layoutEdges: LayoutEdge[] = [];
  private idToIndex = new Map<string, number>();
  private degree: number[] = [];
  private groupColors = new Map<string, string>();

  // view transform (world -> screen: world * scale + offset)
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  // interaction
  private dragIndex = -1;
  private panning = false;
  private lastMouse = { x: 0, y: 0 };
  private downAt = { x: 0, y: 0 };
  private moved = 0;
  private hoverIndex = -1;

  // animation
  private rafId = 0;
  private alpha = 0; // cooling factor; >0 means keep simulating
  private analyzing = false;
  private abortAnalyze: (() => void) | null = null;

  private colors: ThemeColors = {
    node: "#888",
    nodeStroke: "#1e1e1e",
    semantic: "#7c6cff",
    link: "#9aa0a6",
    text: "#cccccc"
  };

  constructor(leaf: WorkspaceLeaf, plugin: HermesPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_HERMES_GRAPH;
  }
  getDisplayText(): string {
    return "Hermes Smart Graph";
  }
  getIcon(): string {
    return "git-fork";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("hermes-graph-view");

    // Toolbar
    this.toolbarEl = root.createDiv({ cls: "hermes-graph-toolbar" });
    this.analyzeBtn = this.toolbarEl.createEl("button", { cls: "hermes-graph-btn mod-cta" });
    const analyzeIcon = this.analyzeBtn.createSpan({ cls: "hermes-graph-btn-icon" });
    setIcon(analyzeIcon, "git-fork");
    this.analyzeBtn.createSpan({ text: "Analyze vault" });
    this.analyzeBtn.onclick = () => void this.analyze();

    const fitBtn = this.toolbarEl.createEl("button", { cls: "hermes-graph-btn", attr: { "aria-label": "Fit to view" } });
    setIcon(fitBtn, "maximize");
    fitBtn.onclick = () => {
      this.fitToView();
      this.draw();
    };

    this.statusEl = this.toolbarEl.createDiv({ cls: "hermes-graph-status" });

    // Canvas
    this.canvasWrapEl = root.createDiv({ cls: "hermes-graph-canvas-wrap" });
    this.canvas = this.canvasWrapEl.createEl("canvas", { cls: "hermes-graph-canvas" });
    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      this.canvasWrapEl.createDiv({ cls: "hermes-graph-empty", text: "Canvas not available." });
      return;
    }
    this.ctx = ctx;

    this.emptyEl = this.canvasWrapEl.createDiv({ cls: "hermes-graph-empty" });
    this.emptyEl.createSpan({
      text: 'No graph yet. Click "Analyze vault" to let Hermes map your notes.'
    });

    this.registerInteraction();
    this.registerDomEvent(window, "resize", () => this.resizeCanvas());
    this.readThemeColors();
    this.resizeCanvas();

    // Restore the last analysis if one is cached.
    const cached = await this.plugin.loadGraphCache();
    if (cached && cached.nodes.length) {
      this.setGraph(cached);
      this.setStatus(
        `${cached.nodes.length} notes, ${cached.edges.length} links${
          cached.generatedAt ? ` · cached ${new Date(cached.generatedAt).toLocaleString()}` : ""
        }`
      );
    } else {
      this.toggleEmpty(true);
    }
  }

  async onClose(): Promise<void> {
    if (this.rafId) window.cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.abortAnalyze?.();
  }

  // ---- analysis flow -------------------------------------------------------

  /** Public entry point used by the "Analyze vault for smart graph" command. */
  analyzeFromCommand(): void {
    void this.analyze();
  }

  private async analyze(): Promise<void> {
    if (this.analyzing) return;
    const notes = await this.gatherNotes();
    if (notes.length === 0) {
      new Notice("Hermes: no markdown notes found to analyze.");
      return;
    }
    this.analyzing = true;
    this.analyzeBtn.disabled = true;
    this.setStatus(`Analyzing ${notes.length} notes with Hermes…`);

    const prompt = buildAnalysisPrompt(notes);
    const call = this.plugin.client.runToCompletion(prompt);
    this.abortAnalyze = () => call.abort();
    try {
      const reply = await call.result;
      const parsed = extractJson(reply);
      if (!parsed) {
        this.setStatus("Hermes did not return graph JSON. Try again, or lower 'Max notes'.");
        new Notice("Hermes: could not parse a graph from the reply.");
        return;
      }
      const graph = buildSmartGraph(notes, parsed, {
        minWeight: this.plugin.settings.graphMinEdgeWeight,
        includeWikilinks: this.plugin.settings.graphIncludeWikilinks
      });
      graph.generatedAt = new Date().toISOString();
      this.setGraph(graph);
      await this.plugin.saveGraphCache(graph);
      const semantic = graph.edges.filter((e) => e.kind === "semantic").length;
      this.setStatus(`${graph.nodes.length} notes · ${semantic} semantic · ${graph.edges.length - semantic} wikilink`);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      this.setStatus(`Analysis failed: ${msg}`);
      new Notice(`Hermes graph: ${msg}`);
    } finally {
      this.analyzing = false;
      this.analyzeBtn.disabled = false;
      this.abortAnalyze = null;
    }
  }

  /**
   * Summarise the vault for analysis: title + excerpt + existing resolved
   * [[wikilinks]], capped to the configured maximum (largest/most-linked notes
   * are kept first so the cap keeps the most connected part of the vault).
   */
  private async gatherNotes(): Promise<NoteSummary[]> {
    const resolved = this.app.metadataCache.resolvedLinks;
    const files = this.app.vault.getMarkdownFiles();
    const max = this.plugin.settings.graphMaxNotes;

    // Rank by link degree so the cap favours the connected core.
    const degreeOf = (path: string): number => {
      const out = resolved[path] ? Object.keys(resolved[path]).length : 0;
      let inc = 0;
      for (const src in resolved) if (resolved[src][path]) inc++;
      return out + inc;
    };
    const ranked = files.slice().sort((a, b) => degreeOf(b.path) - degreeOf(a.path));
    const chosen = ranked.slice(0, max);
    const chosenPaths = new Set(chosen.map((f) => f.path));

    const out: NoteSummary[] = [];
    for (const file of chosen) {
      let excerpt = "";
      try {
        excerpt = await this.app.vault.cachedRead(file);
      } catch {
        excerpt = "";
      }
      const links = resolved[file.path]
        ? Object.keys(resolved[file.path]).filter((t) => chosenPaths.has(t))
        : [];
      out.push({ path: file.path, title: this.titleOf(file), excerpt, links });
    }
    return out;
  }

  private titleOf(file: TFile): string {
    return file.basename || file.name || file.path;
  }

  // ---- graph + layout ------------------------------------------------------

  private setGraph(graph: SmartGraph): void {
    this.graph = graph;
    this.idToIndex = new Map(graph.nodes.map((n, i) => [n.id, i]));
    this.degree = new Array<number>(graph.nodes.length).fill(0);
    this.layoutEdges = [];
    for (const e of graph.edges) {
      const a = this.idToIndex.get(e.source);
      const b = this.idToIndex.get(e.target);
      if (a === undefined || b === undefined) continue;
      this.layoutEdges.push({ a, b, w: e.weight });
      this.degree[a]++;
      this.degree[b]++;
    }
    // Assign a colour per topic group.
    this.groupColors.clear();
    let gi = 0;
    for (const n of graph.nodes) {
      if (n.group && !this.groupColors.has(n.group)) {
        this.groupColors.set(n.group, GROUP_PALETTE[gi % GROUP_PALETTE.length]);
        gi++;
      }
    }

    const { width, height } = this.cssSize();
    this.points = seedPositions(graph.nodes.length, width / 2, height / 2, Math.min(width, height) / 2.5);
    this.toggleEmpty(graph.nodes.length === 0);
    this.fitToView();
    this.reheat();
  }

  private reheat(): void {
    this.alpha = 1;
    if (!this.rafId) this.loop();
  }

  private loop(): void {
    const { width, height } = this.cssSize();
    if (this.alpha > 0.02 && this.points.length) {
      const energy = tickForces(this.points, this.layoutEdges, width / 2, height / 2);
      this.alpha *= 0.985;
      if (energy < 0.05) this.alpha = 0;
    }
    this.draw();
    if (this.alpha > 0.02 || this.dragIndex !== -1) {
      this.rafId = window.requestAnimationFrame(() => this.loop());
    } else {
      this.rafId = 0;
    }
  }

  private fitToView(): void {
    if (!this.points.length) {
      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of this.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const { width, height } = this.cssSize();
    const pad = 60;
    const gw = Math.max(maxX - minX, 1);
    const gh = Math.max(maxY - minY, 1);
    this.scale = Math.min((width - pad) / gw, (height - pad) / gh, 2.5);
    if (!Number.isFinite(this.scale) || this.scale <= 0) this.scale = 1;
    this.offsetX = width / 2 - ((minX + maxX) / 2) * this.scale;
    this.offsetY = height / 2 - ((minY + maxY) / 2) * this.scale;
  }

  // ---- rendering -----------------------------------------------------------

  private draw(): void {
    if (!this.ctx) return;
    const { width, height } = this.cssSize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);
    if (!this.graph || !this.points.length) return;

    // Edges
    for (const e of this.layoutEdges) {
      const A = this.points[e.a];
      const B = this.points[e.b];
      if (!A || !B) continue;
      const edge = this.graph.edges[this.layoutEdges.indexOf(e)];
      const semantic = edge?.kind === "semantic";
      ctx.beginPath();
      ctx.moveTo(this.sx(A.x), this.sy(A.y));
      ctx.lineTo(this.sx(B.x), this.sy(B.y));
      ctx.strokeStyle = semantic ? this.colors.semantic : this.colors.link;
      ctx.globalAlpha = semantic ? 0.35 + 0.5 * e.w : 0.25;
      ctx.lineWidth = semantic ? 1 + 2 * e.w : 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Hover edge labels (rel) for the hovered node only
    if (this.hoverIndex !== -1) this.drawHoverLabels();

    // Nodes
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      const node = this.graph.nodes[i];
      const r = this.radius(i);
      ctx.beginPath();
      ctx.arc(this.sx(p.x), this.sy(p.y), r, 0, Math.PI * 2);
      ctx.fillStyle = node.group ? this.groupColors.get(node.group) || this.colors.node : this.colors.node;
      ctx.fill();
      ctx.lineWidth = i === this.hoverIndex ? 2.5 : 1;
      ctx.strokeStyle = i === this.hoverIndex ? this.colors.semantic : this.colors.nodeStroke;
      ctx.stroke();
    }

    // Labels (only when zoomed in enough, or for the hovered node)
    ctx.fillStyle = this.colors.text;
    ctx.font = "11px var(--font-interface, sans-serif)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i < this.points.length; i++) {
      if (this.scale < 0.6 && i !== this.hoverIndex) continue;
      const p = this.points[i];
      const r = this.radius(i);
      ctx.fillText(this.graph.nodes[i].title, this.sx(p.x), this.sy(p.y) + r + 2);
    }
  }

  private drawHoverLabels(): void {
    const ctx = this.ctx;
    if (!this.graph) return;
    ctx.save();
    ctx.font = "10px var(--font-interface, sans-serif)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let k = 0; k < this.layoutEdges.length; k++) {
      const e = this.layoutEdges[k];
      if (e.a !== this.hoverIndex && e.b !== this.hoverIndex) continue;
      const rel = this.graph.edges[k]?.rel;
      if (!rel) continue;
      const A = this.points[e.a];
      const B = this.points[e.b];
      const mx = this.sx((A.x + B.x) / 2);
      const my = this.sy((A.y + B.y) / 2);
      ctx.fillStyle = this.colors.semantic;
      ctx.globalAlpha = 0.9;
      ctx.fillText(rel, mx, my);
    }
    ctx.restore();
  }

  private radius(i: number): number {
    return 4 + Math.min(8, Math.sqrt(this.degree[i] || 0) * 2.2);
  }

  // world -> screen
  private sx(x: number): number {
    return x * this.scale + this.offsetX;
  }
  private sy(y: number): number {
    return y * this.scale + this.offsetY;
  }
  // screen -> world
  private wx(x: number): number {
    return (x - this.offsetX) / this.scale;
  }
  private wy(y: number): number {
    return (y - this.offsetY) / this.scale;
  }

  // ---- interaction ---------------------------------------------------------

  private registerInteraction(): void {
    const c = this.canvas;
    this.registerDomEvent(c, "mousedown", (ev: MouseEvent) => {
      const { x, y } = this.localPos(ev);
      this.downAt = { x, y };
      this.lastMouse = { x, y };
      this.moved = 0;
      const hit = this.hitTest(x, y);
      if (hit !== -1) {
        this.dragIndex = hit;
        this.points[hit].fixed = true;
      } else {
        this.panning = true;
      }
      if (!this.rafId) this.loop();
    });

    this.registerDomEvent(c, "mousemove", (ev: MouseEvent) => {
      const { x, y } = this.localPos(ev);
      if (this.dragIndex !== -1) {
        const p = this.points[this.dragIndex];
        p.x = this.wx(x);
        p.y = this.wy(y);
        p.vx = 0;
        p.vy = 0;
        this.moved += Math.abs(x - this.lastMouse.x) + Math.abs(y - this.lastMouse.y);
        this.reheat();
      } else if (this.panning) {
        this.offsetX += x - this.lastMouse.x;
        this.offsetY += y - this.lastMouse.y;
        this.moved += Math.abs(x - this.lastMouse.x) + Math.abs(y - this.lastMouse.y);
        this.draw();
      } else {
        const hit = this.hitTest(x, y);
        if (hit !== this.hoverIndex) {
          this.hoverIndex = hit;
          c.toggleClass("is-hovering-node", hit !== -1);
          this.draw();
        }
      }
      this.lastMouse = { x, y };
    });

    this.registerDomEvent(c, "mouseup", (ev: MouseEvent) => {
      const wasDrag = this.dragIndex;
      if (this.dragIndex !== -1) this.points[this.dragIndex].fixed = false;
      const click = this.moved < 4;
      this.dragIndex = -1;
      this.panning = false;
      if (click) {
        const { x, y } = this.localPos(ev);
        const hit = wasDrag !== -1 ? wasDrag : this.hitTest(x, y);
        if (hit !== -1) this.openNote(hit);
      }
    });

    this.registerDomEvent(c, "mouseleave", () => {
      if (this.dragIndex !== -1) this.points[this.dragIndex].fixed = false;
      this.dragIndex = -1;
      this.panning = false;
      this.hoverIndex = -1;
    });

    this.registerDomEvent(c, "wheel", (ev: WheelEvent) => {
      ev.preventDefault();
      const { x, y } = this.localPos(ev);
      const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      const wxBefore = this.wx(x);
      const wyBefore = this.wy(y);
      this.scale = Math.max(0.1, Math.min(5, this.scale * factor));
      // keep the cursor anchored over the same world point
      this.offsetX = x - wxBefore * this.scale;
      this.offsetY = y - wyBefore * this.scale;
      this.draw();
    });
  }

  private openNote(index: number): void {
    if (!this.graph) return;
    const node = this.graph.nodes[index];
    if (node) void this.app.workspace.openLinkText(node.id, "", "tab");
  }

  private hitTest(x: number, y: number): number {
    for (let i = this.points.length - 1; i >= 0; i--) {
      const p = this.points[i];
      const dx = this.sx(p.x) - x;
      const dy = this.sy(p.y) - y;
      const r = this.radius(i) + 3;
      if (dx * dx + dy * dy <= r * r) return i;
    }
    return -1;
  }

  private localPos(ev: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  // ---- helpers -------------------------------------------------------------

  private cssSize(): { width: number; height: number } {
    return {
      width: this.canvasWrapEl?.clientWidth || 600,
      height: this.canvasWrapEl?.clientHeight || 400
    };
  }

  private resizeCanvas(): void {
    if (!this.canvas) return;
    const { width, height } = this.cssSize();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(width * dpr));
    this.canvas.height = Math.max(1, Math.floor(height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  private readThemeColors(): void {
    const cs = getComputedStyle(this.contentEl);
    const pick = (name: string, fallback: string): string => {
      const v = cs.getPropertyValue(name).trim();
      return v || fallback;
    };
    this.colors = {
      node: pick("--text-muted", "#888888"),
      nodeStroke: pick("--background-primary", "#1e1e1e"),
      semantic: pick("--interactive-accent", "#7c6cff"),
      link: pick("--text-faint", "#9aa0a6"),
      text: pick("--text-normal", "#cccccc")
    };
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.setText(text);
  }

  private toggleEmpty(show: boolean): void {
    if (this.emptyEl) this.emptyEl.toggleClass("is-visible", show);
  }
}
