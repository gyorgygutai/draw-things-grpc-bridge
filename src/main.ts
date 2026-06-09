import { Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, TFile, normalizePath, Notice } from "obsidian";
import { makeClient, generate } from "./lib";
import * as grpc from "@grpc/grpc-js";

const VIEW_TYPE = "draw-things-grpc-bridge";

interface PromptRegion {
  text: string;
  startLine: number;
  endLine: number;
}

function parsePrompt(content: string): PromptRegion | null {
  const lines = content.split("\n");
  let headingLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() === "## prompt") {
      headingLine = i;
      break;
    }
  }
  if (headingLine === -1) return null;

  const bodyStart = headingLine + 1;
  let bodyEnd = lines.length;
  for (let i = bodyStart; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      bodyEnd = i;
      break;
    }
  }

  const text = lines
    .slice(bodyStart, bodyEnd)
    .filter(l => l.trim().length > 0)
    .join("\n")
    .trim();

  if (!text) return null;
  return { text, startLine: bodyStart, endLine: bodyEnd };
}

const SAMPLERS: [string, number][] = [
  ["DPM++ 2M Karras", 0], ["Euler A", 1], ["DDIM", 2], ["PLMS", 3],
  ["DPM++ SDE Karras", 4], ["UniPC", 5], ["LCM", 6], ["Euler A Substep", 7],
  ["DPM++ SDE Substep", 8], ["TCD", 9], ["Euler A Trailing", 10],
  ["DPM++ SDE Trailing", 11], ["DPM++ 2M AYS", 12], ["Euler A AYS", 13],
  ["DPM++ SDE AYS", 14], ["DPM++ 2M Trailing", 15], ["DDIM Trailing", 16],
];

const DEFAULT_FORM_VALUES = {
  model: "flux_2_klein_9b_q8p.ckpt",
  sampler: 16,
  steps: 4,
  cfg: 1,
  width: 512,
  height: 512,
};

interface DTSettings { host: string; out: string; recentImagesCount: number; }
const DEFAULTS: DTSettings = { host: "127.0.0.1:7888", out: ".dt-output", recentImagesCount: 15 };

class DTView extends ItemView {
  plugin: DTPlugin;
  private intersectionObserver: IntersectionObserver | null = null;
  private generating = false;

  constructor(leaf: WorkspaceLeaf, plugin: DTPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Draw Things"; }
  getIcon() { return "image"; }

  async onOpen() {
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.render()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.render()));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (file === this.app.workspace.getActiveFile()) this.render();
    }));
    this.registerEvent(this.app.vault.on('rename', (file) => {
      if (file === this.app.workspace.getActiveFile()) this.render();
    }));
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      if (file === this.app.workspace.getActiveFile()) this.render();
    }));

    this.intersectionObserver = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) this.render(); },
      { threshold: 0 }
    );
    this.intersectionObserver.observe(this.containerEl);

    this.render();
  }

  async onClose() {
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
  }

  async render() {
    const file = this.app.workspace.getActiveFile();
    if (file instanceof TFile) await this.app.vault.cachedRead(file);
    const fm = (file instanceof TFile) ? (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) : {};

    const values = {
      model:   typeof fm["dt-model"]   === "string" ? fm["dt-model"]             : DEFAULT_FORM_VALUES.model,
      sampler: fm["dt-sampler"]        !== undefined ? parseInt(fm["dt-sampler"]) : DEFAULT_FORM_VALUES.sampler,
      steps:   fm["dt-steps"]          !== undefined ? parseInt(fm["dt-steps"])   : DEFAULT_FORM_VALUES.steps,
      cfg:     fm["dt-cfg"]            !== undefined ? parseFloat(fm["dt-cfg"])   : DEFAULT_FORM_VALUES.cfg,
      width:   fm["dt-width"]          !== undefined ? parseInt(fm["dt-width"])   : DEFAULT_FORM_VALUES.width,
      height:  fm["dt-height"]         !== undefined ? parseInt(fm["dt-height"])  : DEFAULT_FORM_VALUES.height,
      images:  Array.isArray(fm["dt-generated-images"]) ? fm["dt-generated-images"] as string[] : [],
    };

    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.style.cssText = "padding:12px;display:flex;flex-direction:column;gap:8px;";

    const row = (label: string, parent = root) => {
      const r = parent.createDiv({ cls: "dt-row" });
      r.createEl("label", { text: label, cls: "dt-label" });
      return r;
    };

    // --- Model ---
    const modelRow = row("Model");
    modelRow.createEl("span", { text: values.model, cls: "dt-model" });
    root.createEl("hr", { cls: "dt-hr" });

    // --- Sampler ---
    const sampRow = row("Sampler");
    const sampSel = sampRow.createEl("select", { cls: "dt-sel" });
    SAMPLERS.forEach(([n, v]) => {
      const opt = sampSel.createEl("option", { value: String(v), text: n });
      if (v === values.sampler) opt.selected = true;
    });

    // --- Steps ---
    const stepsRow = row("Steps");
    const stepsWrap = stepsRow.createDiv({ cls: "dt-slider-wrap" });
    const stepsSlider = stepsWrap.createEl("input", {
      type: "range", attr: { min: "1", max: "100", value: String(values.steps) }
    });
    const stepsVal = stepsWrap.createEl("span", { text: String(values.steps), cls: "dt-val" });
    stepsSlider.oninput = () => stepsVal.textContent = stepsSlider.value;

    // --- CFG ---
    const cfgRow = row("CFG");
    const cfgWrap = cfgRow.createDiv({ cls: "dt-slider-wrap" });
    const cfgSlider = cfgWrap.createEl("input", {
      type: "range", attr: { min: "1", max: "20", step: "0.5", value: String(values.cfg) }
    });
    const cfgVal = cfgWrap.createEl("span", { text: String(values.cfg), cls: "dt-val" });
    cfgSlider.oninput = () => cfgVal.textContent = cfgSlider.value;
    root.createEl("hr", { cls: "dt-hr" });

    // --- Size ---
    const sizeRow = row("Size");
    const sizeWrap = sizeRow.createDiv({ cls: "dt-size-wrap" });
    const wIn = sizeWrap.createEl("input", { cls: "dt-num", type: "number", value: String(values.width) });
    sizeWrap.createEl("span", { text: "×", cls: "dt-x" });
    const hIn = sizeWrap.createEl("input", { cls: "dt-num", type: "number", value: String(values.height) });
    root.createEl("hr", { cls: "dt-hr" });

    // --- Input Image ---
    const inputImgRow = row("Input Image");
    const inputImgInput = inputImgRow.createEl("input", { type: "file", attr: { accept: "image/*" }, cls: "dt-file-input" });
    let inputImageFile: File | null = null;
    inputImgInput.onchange = () => { inputImageFile = inputImgInput.files?.[0] ?? null; };

    // --- Reference Images ---
    const refImageFiles: (File | null)[] = [null, null, null];
    for (let i = 1; i <= 3; i++) {
      const refRow = row(`Reference ${i}`);
      const refIn = refRow.createEl("input", { type: "file", attr: { accept: "image/*" }, cls: "dt-file-input" });
      refIn.onchange = ((idx) => () => { refImageFiles[idx] = refIn.files?.[0] ?? null; })(i - 1);
    }
    root.createEl("hr", { cls: "dt-hr" });

    // --- Generate Button ---
    const btn = root.createEl("button", { text: this.generating ? "Generating..." : "Generate", cls: "dt-btn" });
    if (this.generating) btn.disabled = true;
    btn.onclick = async () => {
      const file = this.app.workspace.getActiveFile();
      if (!(file instanceof TFile)) { new Notice("No active note"); return; }

      const content = await this.app.vault.read(file);
      const region = parsePrompt(content);
      if (!region) { new Notice("No ## Prompt section found"); return; }
      const prompt = region.text;

      let inputImageBytes: Uint8Array | undefined;
      if (inputImageFile) inputImageBytes = new Uint8Array(await inputImageFile.arrayBuffer());

      const refImageBytes: Uint8Array[] = [];
      for (const f of refImageFiles) {
        if (f) refImageBytes.push(new Uint8Array(await f.arrayBuffer()));
      }

      const w = parseInt(wIn.value);
      const h = parseInt(hIn.value);
      if (isNaN(w) || w < 64 || isNaN(h) || h < 64) { new Notice("Width and height must be at least 64"); return; }

      const currentModel = (modelRow.querySelector(".dt-model") as HTMLElement)?.textContent || values.model;

      this.generating = true;
      this.render();

      try {
        const name = await generate(
          this.plugin.getClient(), prompt,
          parseInt(stepsSlider.value), parseFloat(cfgSlider.value), parseInt(sampSel.value),
          w, h, Math.floor(Math.random() * 0xffffffff), currentModel,
          this.app.vault, normalizePath(this.plugin.settings.out),
          inputImageBytes, refImageBytes
        );

        await this.app.fileManager.processFrontMatter(file, (fm) => {
          const existing: string[] = Array.isArray(fm["dt-generated-images"]) ? fm["dt-generated-images"] : [];
          fm["dt-generated-images"] = [name, ...existing];
        });

        new Notice(`Image generated: ${name}`);
      } catch (e: any) {
        new Notice(`Error: ${e.message ?? String(e)}`);
      } finally {
        this.generating = false;
        this.render();
      }
    };

    injectStyles();

    // --- Image Strip ---
    const strip = root.createDiv({ cls: "dt-image-strip" });
    for (const name of values.images.slice(0, this.plugin.settings.recentImagesCount)) {
      const path = normalizePath(`${this.plugin.settings.out}/${name}`);
      const url = this.app.vault.adapter.getResourcePath(path);
      const img = strip.createEl("img", { cls: "dt-thumb" });
      img.src = url;
      img.onerror = () => img.remove();
    }

    // --- Dimming ---
    if (!(file instanceof TFile)) {
      root.classList.add('dt-dimmed');
    } else {
      this.app.vault.cachedRead(file).then(content => {
        if (!parsePrompt(content)) root.classList.add('dt-dimmed');
        else root.classList.remove('dt-dimmed');
      });
    }
  }
}

export default class DTPlugin extends Plugin {
  settings: DTSettings = { ...DEFAULTS };
  client: grpc.Client | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new DTSettingsTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new DTView(leaf, this));
    this.activateView();
  }

  onunload() { this.client?.close(); }

  async loadSettings() { this.settings = Object.assign({}, DEFAULTS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  getClient(): grpc.Client {
    if (!this.client) this.client = makeClient(this.settings.host);
    return this.client;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}

function injectStyles() {
  if (document.getElementById("dt-styles")) return;
  const s = document.createElement("style");
  s.id = "dt-styles";
  s.textContent = `
    .dt-row { display:flex; align-items:center; gap:8px; }
    .dt-label { min-width:56px; font-size:12px; color:var(--text-muted); flex-shrink:0; }
    .dt-model { font-size:11px; color:var(--text-faint); font-family:monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .dt-sel { flex:1; background:var(--background-secondary); border:1px solid var(--background-modifier-border); border-radius:4px; color:var(--text-normal); padding:3px 6px; font-size:12px; }
    .dt-slider-wrap { flex:1; display:flex; align-items:center; gap:6px; }
    .dt-slider-wrap input[type=range] { flex:1; }
    .dt-val { font-size:11px; min-width:28px; text-align:right; font-family:monospace; color:var(--text-accent); }
    .dt-size-wrap { flex:1; display:flex; align-items:center; gap:6px; }
    .dt-num { flex:1; background:var(--background-secondary); border:1px solid var(--background-modifier-border); border-radius:4px; color:var(--text-normal); padding:3px 6px; font-size:12px; width:0; }
    .dt-x { color:var(--text-muted); font-size:12px; }
    .dt-file-input { flex:1; font-size:12px; color:var(--text-normal); min-width:0; }
    .dt-btn { width:100%; padding:6px; background:var(--interactive-accent); color:var(--text-on-accent); border:none; border-radius:4px; cursor:pointer; font-size:13px; }
    .dt-btn:disabled { opacity:.5; cursor:default; }
    .dt-dimmed { opacity: 0.6; pointer-events: none; }
    .dt-image-strip { display:flex; flex-direction:row; gap:6px; overflow-x:scroll; padding:4px 0; scrollbar-width:thin; min-height: 90px; background: var(--background-secondary); border-radius: 4px; }
    .dt-thumb { height:160px; width:auto; flex-shrink:0; border-radius:4px; object-fit:cover; }
    .dt-hr { border: 0; border-top: 1px solid var(--background-modifier-border); margin: 8px 0; width: 100%; }
  `;
  document.head.appendChild(s);
}

class DTSettingsTab extends PluginSettingTab {
  plugin: DTPlugin;
  constructor(app: any, plugin: DTPlugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Host").addText(t =>
      t.setValue(this.plugin.settings.host).onChange(async v => {
        this.plugin.settings.host = v;
        this.plugin.client?.close();
        this.plugin.client = null;
        await this.plugin.saveSettings();
      })
    );
    new Setting(containerEl).setName("Output folder").addText(t =>
      t.setValue(this.plugin.settings.out).onChange(async v => {
        this.plugin.settings.out = v;
        await this.plugin.saveSettings();
      })
    );
  }
}
