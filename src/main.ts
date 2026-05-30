import { Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, TFile, normalizePath, Notice, AbstractInputSuggest, SearchResult, App } from "obsidian";
import { makeClient, generate } from "./lib";
import * as grpc from "@grpc/grpc-js";
import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, GutterMarker, gutter } from "@codemirror/view";

const VIEW_TYPE = "draw-things-grpc-bridge";

// --- Prompt parser ---

interface PromptRegion {
  text: string;
  startLine: number; // 0-based, line after the ## Prompt heading
  endLine: number;   // 0-based, exclusive (the --- line or EOF)
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

// --- CM6 decoration extension ---

const setPromptRange = StateEffect.define<{ from: number; to: number } | null>();

const promptRangeField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setPromptRange)) {
        if (!e.value) return Decoration.none;
        const { from, to } = e.value;
        const builder = new RangeSetBuilder<Decoration>();
        const lineDeco = Decoration.line({ attributes: { class: "dt-prompt-line" } });
        for (let pos = from; pos <= to; ) {
          const line = tr.state.doc.lineAt(pos);
          builder.add(line.from, line.from, lineDeco);
          pos = line.to + 1;
        }
        return builder.finish();
      }
    }
    return deco.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f),
});

class PromptGutterMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("div");
    el.className = "dt-gutter-marker";
    return el;
  }
}
const promptGutterMarker = new PromptGutterMarker();

const promptGutterExtension = gutter({
  class: "dt-prompt-gutter",
  markers(view) {
    const deco = view.state.field(promptRangeField, false);
    if (!deco) return Decoration.none as any;
    const builder = new RangeSetBuilder<GutterMarker>();
    deco.between(0, view.state.doc.length, (from) => {
      const line = view.state.doc.lineAt(from);
      builder.add(line.from, line.from, promptGutterMarker);
    });
    return builder.finish();
  },
  initialSpacer: () => promptGutterMarker,
});

const dtEditorExtension = [promptRangeField, promptGutterExtension];

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

interface DTSettings { host: string; out: string; }
const DEFAULTS: DTSettings = { host: "127.0.0.1:7888", out: ".dt-output" };

class FileSuggest extends AbstractInputSuggest<SearchResult> {
  private cb: (file: TFile) => void;
  constructor(app: App, inputEl: HTMLInputElement, cb: (file: TFile) => void) {
    super(app, inputEl);
    this.cb = cb;
  }
  getSuggestions(query: string): SearchResult[] {
    return this.app.vault
      .getFiles()
      .filter(f => f.name.toLowerCase().includes(query.toLowerCase()))
      .map(f => ({ file: f, score: 0 }));
  }
  renderSuggestion(value: SearchResult, el: HTMLElement): void {
    el.createDiv({ text: value.file.name });
  }
  selectSuggestion(value: SearchResult, evt: MouseEvent | KeyboardEvent): void {
    this.inputEl.value = value.file.name;
    this.cb(value.file);
    this.close();
  }
}

class DTView extends ItemView {
  plugin: DTPlugin;
  private intersectionObserver: IntersectionObserver | null = null;
  private sidebarVisible = false;

  constructor(leaf: WorkspaceLeaf, plugin: DTPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Draw Things"; }
  getIcon() { return "image"; }

  async onOpen() {
    this.render();
    this.updateControlsState();
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.updateControlsState())
    );
    this.intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        this.sidebarVisible = entry.isIntersecting;
        if (entry.isIntersecting) {
          this.updateControlsState();
        } else {
          this.clearDecoration();
        }
      },
      { threshold: 0 }
    );
    this.intersectionObserver.observe(this.containerEl);
  }

  async onClose() {
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    this.clearDecoration();
  }

  private clearDecoration() {
    this.app.workspace.iterateAllLeaves(leaf => {
      const cm: EditorView | undefined = (leaf.view as any)?.editor?.cm;
      if (cm) cm.dispatch({ effects: setPromptRange.of(null) });
    });
  }

  private async updateControlsState(): Promise<void> {
    if (!this.sidebarVisible) {
      this.clearDecoration();
      return;
    }
    const file = this.app.workspace.getActiveFile();
    let region: PromptRegion | null = null;

    if (file instanceof TFile) {
      const content = await this.app.vault.cachedRead(file);
      region = parsePrompt(content);
    }

    const enabled = region !== null;
    const controls = this.containerEl.querySelectorAll('input, select, button');
    controls.forEach(el => { (el as HTMLInputElement).disabled = !enabled; });

    const root = this.containerEl.children[1] as HTMLElement;
    if (root) root.classList.toggle('dt-dimmed', !enabled);

    this.applyDecoration(region);
  }

  private applyDecoration(region: PromptRegion | null): void {
    const activeFile = this.app.workspace.getActiveFile();
    let cm: EditorView | undefined;
    this.app.workspace.iterateAllLeaves(leaf => {
      if (cm) return;
      const v = leaf.view as any;
      if (v?.getViewType?.() === 'markdown' && v?.file === activeFile) {
        const candidate: EditorView | undefined = v?.editor?.cm;
        if (candidate) cm = candidate;
      }
    });
    if (!cm) return;

    if (!region) {
      cm.dispatch({ effects: setPromptRange.of(null) });
      return;
    }

    const doc = cm.state.doc;
    const startCM = region.startLine + 1;
    const endCM = region.endLine;
    if (startCM > doc.lines || endCM < startCM) {
      cm.dispatch({ effects: setPromptRange.of(null) });
      return;
    }
    const from = doc.line(Math.min(startCM, doc.lines)).from;
    const to = doc.line(Math.min(Math.max(endCM, startCM), doc.lines)).from;
    cm.dispatch({ effects: setPromptRange.of({ from, to }) });
  }

  render() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.style.cssText = "padding:12px;display:flex;flex-direction:column;gap:8px;";

    const row = (label: string, parent = root) => {
      const r = parent.createDiv({ cls: "dt-row" });
      r.createEl("label", { text: label, cls: "dt-label" });
      return r;
    };

    const modelRow = row("Model");
    modelRow.createEl("span", { text: DEFAULT_FORM_VALUES.model, cls: "dt-model" });

    const sampRow = row("Sampler");
    const sampSel = sampRow.createEl("select", { cls: "dt-sel" });
    SAMPLERS.forEach(([n, v]) => {
      const opt = sampSel.createEl("option", { value: String(v), text: n });
      if (v === DEFAULT_FORM_VALUES.sampler) opt.selected = true;
    });

    const stepsRow = row("Steps");
    const stepsWrap = stepsRow.createDiv({ cls: "dt-slider-wrap" });
    const stepsSlider = stepsWrap.createEl("input", {
      type: "range",
      attr: { min: "1", max: "100", value: String(DEFAULT_FORM_VALUES.steps) }
    });
    const stepsVal = stepsWrap.createEl("span", { text: String(DEFAULT_FORM_VALUES.steps), cls: "dt-val" });
    stepsSlider.oninput = () => stepsVal.textContent = stepsSlider.value;

    const cfgRow = row("CFG");
    const cfgWrap = cfgRow.createDiv({ cls: "dt-slider-wrap" });
    const cfgSlider = cfgWrap.createEl("input", {
      type: "range",
      attr: { min: "1", max: "20", step: "0.5", value: String(DEFAULT_FORM_VALUES.cfg) }
    });
    const cfgVal = cfgWrap.createEl("span", { text: String(DEFAULT_FORM_VALUES.cfg), cls: "dt-val" });
    cfgSlider.oninput = () => cfgVal.textContent = cfgSlider.value;

    const sizeRow = row("Size");
    const sizeWrap = sizeRow.createDiv({ cls: "dt-size-wrap" });
    const wIn = sizeWrap.createEl("input", { cls: "dt-num", type: "number", value: String(DEFAULT_FORM_VALUES.width) });
    sizeWrap.createEl("span", { text: "×", cls: "dt-x" });
    const hIn = sizeWrap.createEl("input", { cls: "dt-num", type: "number", value: String(DEFAULT_FORM_VALUES.height) });

    const inputImgRow = row("Input Image");
    const inputImgInput = inputImgRow.createEl("input", {
      type: "text",
      placeholder: "Select an image...",
      cls: "dt-image-input",
    });
    let inputImageFile: TFile | null = null;
    new FileSuggest(this.app, inputImgInput, (f) => { inputImageFile = f; });

    const refImageFiles: (TFile | null)[] = [null, null, null];
    for (let i = 1; i <= 3; i++) {
      const refRow = row(`Reference ${i}`);
      const refIn = refRow.createEl("input", {
        type: "text",
        placeholder: "Select an image...",
        cls: "dt-image-input",
      });
      new FileSuggest(this.app, refIn, (f) => { refImageFiles[i - 1] = f; });
    }

    const btn = root.createEl("button", { text: "Generate", cls: "dt-btn" });

    let currentModel = DEFAULT_FORM_VALUES.model;
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile instanceof TFile) {
      const fm = this.app.metadataCache.getFileCache(activeFile)?.frontmatter;
      if (fm) {
        if (typeof fm["dt-model"] === "string" && fm["dt-model"].trim().length > 0) {
          currentModel = fm["dt-model"].trim();
          const modelSpan = modelRow.querySelector(".dt-model") as HTMLElement;
          if (modelSpan) modelSpan.textContent = currentModel;
        }
        if (fm["dt-steps"] !== undefined) {
          const v = parseInt(String(fm["dt-steps"]));
          if (!isNaN(v) && v >= 1 && v <= 100) { stepsSlider.value = String(v); stepsVal.textContent = String(v); }
        }
        if (fm["dt-cfg"] !== undefined) {
          const v = parseFloat(String(fm["dt-cfg"]));
          if (!isNaN(v) && v >= 1 && v <= 20) { cfgSlider.value = String(v); cfgVal.textContent = String(v); }
        }
        if (fm["dt-sampler"] !== undefined) {
          const v = parseInt(String(fm["dt-sampler"]));
          if (!isNaN(v) && SAMPLERS.some(([, id]) => id === v)) sampSel.value = String(v);
        }
        if (fm["dt-width"] !== undefined) {
          const v = parseInt(String(fm["dt-width"]));
          if (!isNaN(v) && v > 0) wIn.value = String(v);
        }
        if (fm["dt-height"] !== undefined) {
          const v = parseInt(String(fm["dt-height"]));
          if (!isNaN(v) && v > 0) hIn.value = String(v);
        }
      }
    }

    btn.onclick = async () => {
      const file = this.app.workspace.getActiveFile();
      if (!(file instanceof TFile)) { new Notice("No active note"); return; }

      const content = await this.app.vault.read(file);
      const region = parsePrompt(content);
      if (!region) { new Notice("No ## Prompt section found"); return; }
      const prompt = region.text;

      let inputImageBytes: Uint8Array | undefined;
      if (inputImageFile) inputImageBytes = new Uint8Array(await this.app.vault.readBinary(inputImageFile));

      const refImageBytes: Uint8Array[] = [];
      for (const f of refImageFiles) {
        if (f) refImageBytes.push(new Uint8Array(await this.app.vault.readBinary(f)));
      }

      const w = parseInt(wIn.value);
      const h = parseInt(hIn.value);
      if (isNaN(w) || w < 64 || isNaN(h) || h < 64) { new Notice("Width and height must be at least 64"); return; }

      btn.disabled = true;
      btn.textContent = "Generating...";

      try {
        const name = await generate(
          this.plugin.getClient(),
          prompt,
          parseInt(stepsSlider.value),
          parseFloat(cfgSlider.value),
          parseInt(sampSel.value),
          w, h,
          Math.floor(Math.random() * 0xffffffff),
          currentModel,
          this.app.vault,
          normalizePath(this.plugin.settings.out),
          inputImageBytes,
          refImageBytes
        );

        await this.app.fileManager.processFrontMatter(file, (fm) => {
          const existing: string[] = Array.isArray(fm["dt-generated-images"]) ? fm["dt-generated-images"] : [];
          fm["dt-generated-images"] = [name, ...existing];
        });

        new Notice(`Image generated: ${name}`);
        console.log("[DT] Image saved as:", name);
      } catch (e: any) {
        new Notice(`Error: ${e.message ?? String(e)}`);
      } finally {
        btn.disabled = false;
        btn.textContent = "Generate";
      }
    };

    injectStyles();
  }
}

export default class DTPlugin extends Plugin {
  settings: DTSettings = { ...DEFAULTS };
  client: grpc.Client | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new DTSettingsTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new DTView(leaf, this));
    this.registerEditorExtension(dtEditorExtension);
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
    .dt-image-input { flex:1; background:var(--background-secondary); border:1px solid var(--background-modifier-border); border-radius:4px; color:var(--text-normal); padding:3px 6px; font-size:12px; }
    .dt-btn { width:100%; padding:6px; background:var(--interactive-accent); color:var(--text-on-accent); border:none; border-radius:4px; cursor:pointer; font-size:13px; }
    .dt-prompt-line { background: color-mix(in srgb, var(--background-modifier-active-hover) 25%, transparent); }
    .dt-prompt-gutter { width: 4px !important; }
    .dt-gutter-marker { width: 4px; height: 100%; background: var(--background-modifier-active-hover); opacity: 0.5; border-radius: 2px; }
    .dt-btn:disabled { opacity:.5; cursor:default; }
    .dt-dimmed { opacity: 0.6; pointer-events: none; }
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