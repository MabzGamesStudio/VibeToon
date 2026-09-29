import { useEffect, useRef } from 'react';
import type { FlowNode } from '@vibetoon/shared';

/**
 * Unattended runs, for Generate all on a batch flow.
 *
 * Most flows make their files on the server, and the server runs every item of
 * a batch by itself. Some make them in the editor — a video has to be decoded
 * where it can be played — and for those Generate all goes through the items
 * one by one in the editor: it shows each item, and the editor, which offers a
 * way to do its whole job without a hand on it (`useBatchRun`), does it.
 */

type Runner = { key: string; run: () => Promise<void> };

const runners = new Map<string, Runner>();
const waiting = new Set<() => void>();

/**
 * Offer a way to make this item's files unattended: whatever the editor's
 * buttons would do, in order, ending with sending them. Only an editor showing
 * one item of a batch registers.
 */
export function useBatchRun(node: FlowNode, run: () => Promise<void>): void {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (node.itemOf === undefined) return undefined;
    const entry: Runner = { key: node.itemOf, run: () => latest.current() };
    runners.set(node.id, entry);
    for (const wake of waiting) wake();
    return () => {
      if (runners.get(node.id) === entry) runners.delete(node.id);
    };
  }, [node.id, node.itemOf]);
}

/** True when the editor open on this flow can run an item unattended. */
export function hasBatchRunner(nodeId: string): boolean {
  return runners.has(nodeId);
}

/** The run for one item, once its editor is showing it; undefined if it does not come in time. */
export function waitForRunner(nodeId: string, key: string, timeoutMs = 20000): Promise<(() => Promise<void>) | undefined> {
  return new Promise((resolve) => {
    const check = () => {
      const entry = runners.get(nodeId);
      if (entry && entry.key === key) {
        finish(entry.run);
        return true;
      }
      return false;
    };
    const timer = window.setTimeout(() => finish(undefined), timeoutMs);
    const finish = (result: (() => Promise<void>) | undefined) => {
      window.clearTimeout(timer);
      waiting.delete(wake);
      resolve(result);
    };
    const wake = () => void check();
    if (check()) return;
    waiting.add(wake);
  });
}

/** Resolve once `ready` gives something, checking every frame; reject after the timeout. */
export async function waitUntil<T>(ready: () => T | null | undefined | false, what: string, timeoutMs = 30000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = ready();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`${what} took too long`);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }
}
