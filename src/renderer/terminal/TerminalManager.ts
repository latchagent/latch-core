/**
 * @module TerminalManager
 * @description Singleton that manages xterm.js Terminal instances outside the
 * React render cycle. Each terminal tab gets one Terminal + FitAddon instance,
 * keyed by tabId.
 *
 * Terminals must not be unmounted/remounted (that would reset the scrollback
 * buffer). Instead, we keep them always mounted in the DOM and toggle CSS
 * visibility to show/hide them.
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const TERMINAL_THEME = {
  background:  '#000000',
  foreground:  '#ffffff',
  cursor:      '#ffffff',
  selection:   '#333333',
  black:       '#000000',
  red:         '#f87171',
  green:       '#4ade80',
  yellow:      '#fbbf24',
  blue:        '#888888',
  magenta:     '#888888',
  cyan:        '#888888',
  white:       '#ffffff',
};

interface TermInstance {
  term: Terminal;
  fitAddon: FitAddon;
  /** Callback registered via term.onData() — stored so we can replace it if needed. */
  onDataDisposable: { dispose: () => void } | null;
}

class TerminalManager {
  private instances: Map<string, TermInstance> = new Map();

  /**
   * Mount a new xterm.js Terminal into the given container element.
   * No-op if a terminal is already mounted for this tabId.
   *
   * @param tabId     Unique tab identifier.
   * @param container DOM element to open the terminal into.
   * @param onData    Callback invoked with user keystrokes (raw terminal input).
   * @returns The Terminal instance.
   */
  mount(tabId: string, container: HTMLDivElement, onData: (data: string) => void): Terminal {
    const existing = this.instances.get(tabId);
    if (existing) {
      // Re-attach existing terminal to the new container (happens after session switch
      // when React creates a new TabPane DOM element for the same tabId).
      if (existing.term.element && existing.term.element.parentElement !== container) {
        container.appendChild(existing.term.element);
        requestAnimationFrame(() => {
          try { existing.fitAddon.fit(); } catch { /* not yet visible */ }
        });
      }
      return existing.term;
    }

    const term = new Terminal({
      theme:       TERMINAL_THEME,
      fontFamily:  '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize:    12,
      cursorBlink: true,
      scrollback:  2000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch { /* not yet visible */ }
    });

    const onDataDisposable = term.onData(onData);

    this.instances.set(tabId, { term, fitAddon, onDataDisposable });
    return term;
  }

  /**
   * Dispose and remove a terminal instance.
   * Called when a tab is closed.
   */
  unmount(tabId: string): void {
    const instance = this.instances.get(tabId);
    if (!instance) return;
    instance.onDataDisposable?.dispose();
    instance.term.dispose();
    this.instances.delete(tabId);
  }

  /** Write PTY output data to the terminal and scroll to bottom. */
  write(tabId: string, data: string): void {
    const term = this.instances.get(tabId)?.term;
    if (!term) return;
    term.write(data);
    term.scrollToBottom();
  }

  /** Write a line of informational text (dimmed) to the terminal. */
  writeln(tabId: string, text: string): void {
    const term = this.instances.get(tabId)?.term;
    if (!term) return;
    term.writeln(text);
    term.scrollToBottom();
  }

  /** Trigger fitAddon.fit() to sync terminal dimensions with the container. */
  fit(tabId: string): void {
    const instance = this.instances.get(tabId);
    if (!instance) return;
    try { instance.fitAddon.fit(); } catch { /* not yet visible */ }
  }

  /** Focus the terminal (so keystrokes route to it). */
  focus(tabId: string): void {
    this.instances.get(tabId)?.term.focus();
  }

  /** Return the Terminal instance, or undefined if not mounted. */
  get(tabId: string): Terminal | undefined {
    return this.instances.get(tabId)?.term;
  }

  /** Return { cols, rows } for the terminal, or defaults if not mounted. */
  dimensions(tabId: string): { cols: number; rows: number } {
    const term = this.instances.get(tabId)?.term;
    return { cols: term?.cols ?? 100, rows: term?.rows ?? 32 };
  }

  /** Dispose all terminal instances (called on app teardown). */
  disposeAll(): void {
    this.instances.forEach((instance) => {
      instance.onDataDisposable?.dispose();
      instance.term.dispose();
    });
    this.instances.clear();
  }
}

// Module-level singleton — shared across the entire renderer process.
export const terminalManager = new TerminalManager();
