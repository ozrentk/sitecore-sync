/** Endpoint shared by Browse and Compare content navigation. */
export interface ContentEndpoint {
  readonly connectionId: string;
  readonly language: string;
  readonly rootPath: string;
  readonly selectedItemId?: string;
}

export type ContentSessionState =
  | { readonly mode: "browse"; readonly source: ContentEndpoint }
  | { readonly mode: "compare"; readonly left: ContentEndpoint; readonly right: ContentEndpoint; readonly languagesLocked: boolean };

function endpoint(value: ContentEndpoint): ContentEndpoint {
  if (!value || typeof value.connectionId !== "string" || !value.connectionId.trim() ||
      typeof value.language !== "string" || !value.language.trim() ||
      typeof value.rootPath !== "string" || !value.rootPath.startsWith("/") ||
      (value.selectedItemId !== undefined && (typeof value.selectedItemId !== "string" || !value.selectedItemId.trim()))) {
    throw new Error("A content endpoint requires a connection, language and absolute root path.");
  }
  return Object.freeze({ connectionId: value.connectionId, language: value.language,
    rootPath: value.rootPath, selectedItemId: value.selectedItemId });
}

function snapshot(value: ContentSessionState): ContentSessionState {
  if (value.mode === "browse") return Object.freeze({ mode: "browse", source: endpoint(value.source) });
  if (value.mode !== "compare" || typeof value.languagesLocked !== "boolean") throw new Error("Invalid content mode.");
  const left = endpoint(value.left);
  const right = endpoint(value.right);
  if (value.languagesLocked && left.language.toLowerCase() !== right.language.toLowerCase()) {
    throw new Error("Locked comparison languages must match.");
  }
  return Object.freeze({ mode: "compare", left, right, languagesLocked: value.languagesLocked });
}

/** Own one per content panel; no secrets, persistence, VS Code or network dependency. */
export class ContentSession {
  private current: ContentSessionState | undefined;
  private revision = 0;
  private closed = false;
  private transitionController: AbortController | undefined;
  private readonly loads = new Map<string, AbortController>();

  get state(): ContentSessionState | undefined { return this.current; }
  get revisionId(): number { return this.revision; }

  /** Fence asynchronous panel adapters that publish several progress messages. */
  capture(): () => boolean {
    const revision = this.revision;
    return () => !this.closed && revision === this.revision;
  }

  openConnection(source: ContentEndpoint): void {
    this.setState({ mode: "browse", source });
  }

  openCompare(left: ContentEndpoint, right: ContentEndpoint, languagesLocked = false): void {
    this.setState({ mode: "compare", left, right, languagesLocked });
  }

  retainSide(side: "left" | "right"): void {
    this.ensureOpen();
    if (this.current?.mode !== "compare") throw new Error("Choose a retained side from Compare mode.");
    this.openConnection(this.current[side]);
  }

  /** Connection/language/root/selection changes invalidate all previous load results, even A→B→A. */
  setState(next: ContentSessionState): void {
    this.ensureOpen();
    const value = snapshot(next);
    this.cancelPending();
    this.current = value;
  }

  /** A cancelled picker or failed preparation leaves the committed mode and selection intact. */
  async transition(resolve: (signal: AbortSignal) => Promise<ContentSessionState | undefined>): Promise<boolean> {
    this.ensureOpen();
    this.cancelPending();
    const controller = new AbortController();
    this.transitionController = controller;
    try {
      const next = await resolve(controller.signal);
      if (controller.signal.aborted || this.closed || this.transitionController !== controller || !next) return false;
      this.current = snapshot(next);
      return true;
    } catch (error: unknown) {
      if (controller.signal.aborted) return false;
      throw error;
    } finally {
      if (this.transitionController === controller) this.transitionController = undefined;
    }
  }

  /** Only a current result can reach the synchronous publisher; same-key loads supersede each other. */
  async load<T>(key: string, resolve: (state: ContentSessionState, signal: AbortSignal) => Promise<T>, publish: (value: T) => void): Promise<boolean> {
    this.ensureOpen();
    if (!key.trim()) throw new Error("A load key is required.");
    if (!this.current || this.transitionController) return false;
    this.loads.get(key)?.abort();
    const controller = new AbortController();
    const revision = this.revision;
    const state = this.current;
    this.loads.set(key, controller);
    try {
      const value = await resolve(state, controller.signal);
      if (controller.signal.aborted || this.closed || revision !== this.revision || this.loads.get(key) !== controller) return false;
      publish(value);
      return true;
    } catch (error: unknown) {
      if (controller.signal.aborted) return false;
      throw error;
    } finally {
      if (this.loads.get(key) === controller) this.loads.delete(key);
    }
  }

  cancelPending(): void {
    this.revision += 1;
    this.transitionController?.abort();
    this.transitionController = undefined;
    for (const controller of this.loads.values()) controller.abort();
    this.loads.clear();
  }

  dispose(): void {
    this.closed = true;
    this.cancelPending();
    this.current = undefined;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Content session is disposed.");
  }
}
