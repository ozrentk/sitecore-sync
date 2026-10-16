// Executable design sketch only. Not connected to the extension or Sitecore.
export class DraftExperiment {
  constructor(raw) { this.original = raw; this.raw = raw; this.mode = 'html'; this.history = []; }
  get dirty() { return this.raw !== this.original; }
  enterVisual(parse, supported) {
    if (!supported(this.raw)) return false;
    this.visualBaseline = parse(this.raw); this.visualOriginal = this.raw;
    this.mode = 'visual'; return true;
  }
  enterHTML() { this.mode = 'html'; return this.raw; }
  changeHTML(raw) { this.history.push(this.raw); this.raw = raw; }
  changeVisual(document, serialize) {
    this.history.push(this.raw);
    this.raw = JSON.stringify(document) === JSON.stringify(this.visualBaseline)
      ? this.visualOriginal : serialize(document);
  }
  undo() { if (this.history.length) this.raw = this.history.pop(); }
  backup() { return JSON.stringify({ original: this.original, raw: this.raw }); }
}
