/**
 * EventBusService — shared event bus wrapper around EventEmitter2.
 *
 * Differences from plain EventEmitter2:
 *   1. Singleton pattern (enforced through getEventBus() factory).
 *   2. Wildcard + delimiter '.' enabled (requirement for workflow.* subscriptions).
 *   3. `safeEmit` calls every listener inside its own try/catch (or async
 *      catch) so a single broken handler never starves other listeners.
 *      Failed handlers are written to error_logs (level=warn) so they are
 *      visible in the error calendar instead of invisible swallowed rejections.
 *   4. listBindings returns metadata per handler including handler name and
 *      owning pluginId — useful for the extension-points UI page.
 *
 * Rules for internal modules:
 *   - Prefer safeEmit for any call that goes through extension points (plugins
 *     are untrusted code). Use raw emit for tight core-only flows.
 *   - Always include `traceId` if one is in scope for the payload.
 */
import _eventemitter2 from 'eventemitter2';
import type {
  ExtensionEventMap,
  ExtensionPointName,
  ExtensionPayload,
} from './extension-points';
import { EXTENSION_POINTS } from './extension-points';
import { nanoid } from 'nanoid';
import { createLogger } from '../logger';

// eventemitter2 is a CommonJS module without ESM named exports; under esbuild's
// ESM output the named import `import { EventEmitter2 }` fails with
// "SyntaxError: Named export 'EventEmitter2' not found". Pull it off the
// default export instead (default interop works for CJS-as-ESM).
type EventEmitter2 = InstanceType<
  (typeof _eventemitter2 extends { EventEmitter2: infer C } ? C : typeof _eventemitter2)
>;
const EventEmitter2Ctor =
  (_eventemitter2 as any).EventEmitter2 ?? (_eventemitter2 as any).default ?? _eventemitter2;

const logger = createLogger('eventBus');

// ---------------- Types ----------------
export interface HandlerMeta {
  /** Handler function (for debugging; bound functions are anonymised) */
  name: string;
  /** If registered by a plugin, this is its id. Core listeners use 'system'. */
  owner: string;
  /** Wildcard / exact / once */
  kind: 'exact' | 'wildcard' | 'once';
  /** True for async handlers (heuristic: returns Promise). */
  async: boolean;
}

interface ListenerEntry {
  meta: HandlerMeta;
  fn: (...args: any[]) => any;
  rawListener: (...args: any[]) => any;
}

// ---------------- Minimal fallback error sink ----------------
// Until T9 wires up `recordError`, keep a local helper that at least logs
// through pino so events are never lost silently. Actual DB writes in T9.
type ErrorSinkFn = (args: { level: 'error' | 'warn' | 'info'; source: string; message: string; stack?: string; traceId?: string; }) => void;
let _fallbackSink: ErrorSinkFn = ({ level, source, message, stack, traceId }) => {
  logger[level === 'warn' ? 'warn' : level]({ source, message, stack, traceId }, 'eventBus handler error');
};
export function setEventBusErrorSink(sink: ErrorSinkFn): void { _fallbackSink = sink; }

// ---------------- Service ----------------
export class EventBusService {
  readonly emitter: EventEmitter2;
  private readonly entries = new Map<string, Set<ListenerEntry>>();
  private readonly emitterByOwner = new Map<string, Set<string>>();

  constructor(options?: { maxListeners?: number }) {
    this.emitter = new EventEmitter2Ctor({
      wildcard: true,
      delimiter: '.',
      newListener: false,
      removeListener: false,
      maxListeners: options?.maxListeners ?? 50,
      verboseMemoryLeak: true,
      ignoreErrors: false, // we wrap handlers, not EventEmitter2
    });
  }

  // ---------- Metadata ----------
  get registeredExtensionPoints(): readonly ExtensionPointName[] {
    return EXTENSION_POINTS;
  }

  isExtensionPoint(event: string): boolean {
    return (EXTENSION_POINTS as readonly string[]).includes(event);
  }

  /**
   * Register a listener. Compared to raw `.on`, this tracks metadata so
   * listBindings() can return a rich view (plugin id / handler name / etc).
   */
  on<E extends string>(
    event: E,
    handler: (payload: E extends ExtensionPointName ? ExtensionPayload<E> : unknown) => void | Promise<void>,
    meta: Partial<HandlerMeta> = {},
  ): () => void {
    const owner = meta.owner ?? 'system';
    const m: HandlerMeta = {
      name: meta.name ?? (handler.name || '<anonymous>'),
      owner,
      kind: event.includes('*') ? 'wildcard' : 'exact',
      async: meta.async ?? handler.constructor.name === 'AsyncFunction',
    };
    const wrapped: (...args: any[]) => any = handler as any; // use raw handler — errors are wrapped at emit-time
    const entry: ListenerEntry = { meta: m, fn: wrapped, rawListener: handler as any };

    const set = this.entries.get(event) ?? new Set();
    set.add(entry);
    this.entries.set(event, set);
    const ownerSet = this.emitterByOwner.get(owner) ?? new Set();
    ownerSet.add(event);
    this.emitterByOwner.set(owner, ownerSet);
    this.emitter.on(event, wrapped);

    return () => { this.off(event, handler, meta); };
  }

  once<E extends string>(
    event: E,
    handler: (payload: E extends ExtensionPointName ? ExtensionPayload<E> : unknown) => void | Promise<void>,
    meta: Partial<HandlerMeta> = {},
  ): void {
    const owner = meta.owner ?? 'system';
    const wrapped: (...args: any[]) => any = (...args: any[]) => {
      // remove from bookkeeping after fire:
      queueMicrotask(() => {
        const set = this.entries.get(event);
        if (set) {
          for (const e of Array.from(set)) if (e.rawListener === handler) set.delete(e);
        }
      });
      return (handler as any)(...args);
    };
    const entry: ListenerEntry = {
      meta: {
        name: meta.name ?? (handler.name || '<anonymous>'),
        owner,
        kind: 'once',
        async: meta.async ?? handler.constructor.name === 'AsyncFunction',
      },
      fn: wrapped,
      rawListener: handler as any,
    };
    const set = this.entries.get(event) ?? new Set();
    set.add(entry);
    this.entries.set(event, set);
    this.emitter.once(event, wrapped);
  }

  off<E extends string>(
    event: E,
    handler: (payload: E extends ExtensionPointName ? ExtensionPayload<E> : unknown) => void | Promise<void>,
    meta: Partial<HandlerMeta> = {},
  ): void {
    this.emitter.off(event as any, handler as any);
    const set = this.entries.get(event);
    if (set) {
      for (const entry of Array.from(set)) {
        if (entry.rawListener === handler) set.delete(entry);
      }
    }
    const owner = meta.owner;
    if (owner) {
      const ownSet = this.emitterByOwner.get(owner);
      if (ownSet) ownSet.delete(event);
    }
  }

  /**
   * Remove all listeners registered by `owner` (used when plugin is disabled / uninstalled).
   */
  offByOwner(owner: string): void {
    const set = this.emitterByOwner.get(owner);
    if (!set) return;
    for (const event of Array.from(set)) {
      const bucket = this.entries.get(event);
      if (!bucket) continue;
      for (const entry of Array.from(bucket)) {
        if (entry.meta.owner === owner) {
          this.emitter.off(event as any, entry.fn);
          bucket.delete(entry);
        }
      }
    }
    this.emitterByOwner.delete(owner);
  }

  /**
   * Synchronous fire (no error isolation). Use for trusted core-only events
   * where failing fast is desired.
   */
  emit<E extends string>(event: E, payload: E extends ExtensionPointName ? ExtensionPayload<E> : unknown): boolean {
    return this.emitter.emit(event as any, payload);
  }

  /**
   * Safe, async emitter with per-handler error isolation.
   *
   * Guarantees:
   *   - EVERY registered handler (including wildcard matches) runs exactly once.
   *   - Any throw / Promise rejection from a handler is captured → converted
   *     to error_logs row with level=warn (because it's not a fatal platform
   *     error, but a listener bug).
   *   - Returns aggregate stats: { totalListeners, errors, durationMs, traceId }.
   */
  async safeEmit<E extends string>(
    event: E,
    payload: E extends ExtensionPointName ? ExtensionPayload<E> : any,
    ctx: { traceId?: string; source?: string; strict?: boolean } = {},
  ): Promise<{ totalListeners: number; errors: number; durationMs: number; traceId: string; failures: Array<{ meta: HandlerMeta; message: string; stack?: string }> }> {
    const start = performance.now();
    const traceId = ctx.traceId || nanoid(16);
    const source = ctx.source ?? 'eventBus.safeEmit';

    // EventEmitter2 exposes listenersForAny to compute matches including wildcards.
    // Use emitter.listeners(event) to get actually resolved list of handlers.
    // Note: EventEmitter2.listeners() returns ordered matched handlers including wildcard.
    const matchedListeners = new Map<Function, HandlerMeta>();
    // Gather handlers by iterating registered entries and matching patterns.
    for (const [pattern, entries] of this.entries) {
      if (!pattern.includes('*')) {
        if (pattern === event) {
          for (const e of entries) matchedListeners.set(e.rawListener, e.meta);
        }
        continue;
      }
      // Wildcard match: use local wildcardStringMatch (EventEmitter2 internals
      // for pattern matching are not part of the published types/contract).
      const isMatch = wildcardStringMatch(event as string, pattern);
      if (isMatch) {
        for (const e of entries) matchedListeners.set(e.rawListener, e.meta);
      }
    }

    // Now actually resolve listeners via EventEmitter2 to keep ordering the same
    // as the underlying library (otherwise we'd invoke them differently).
    const emitterListeners = this.emitter.listeners(event as any) as Array<(...args: any[]) => any>;
    const orderedHandlers: Array<{ fn: (...args: any[]) => any; meta: HandlerMeta }> = [];
    for (const l of emitterListeners) {
      const meta = matchedListeners.get(l) ?? {
        name: l.name || '<anonymous>',
        owner: 'unknown',
        kind: 'exact',
        async: l.constructor.name === 'AsyncFunction',
      };
      orderedHandlers.push({ fn: l, meta });
    }

    const failures: Array<{ meta: HandlerMeta; message: string; stack?: string }> = [];
    let errors = 0;

    // We can't run in parallel safely (some listeners may mutate shared payload/state).
    // Run sequentially — same semantics as EventEmitter.emit() but async-safe.
    for (const { fn, meta } of orderedHandlers) {
      try {
        const result = fn(payload);
        if (result != null && typeof result === 'object' && typeof (result as Promise<any>).then === 'function') {
          await result;
        }
      } catch (rawErr) {
        const err = rawErr instanceof Error ? rawErr : new Error(String(rawErr));
        errors += 1;
        failures.push({ meta, message: err.message, stack: err.stack });
        try {
          _fallbackSink({
            level: 'warn',
            source: `${source}:${event}:${meta.owner}`,
            message: `handler error: ${err.message}`,
            stack: err.stack,
            traceId,
          });
        } catch { /* swallow sink failure to protect emitter itself */ }
      }
    }

    const durationMs = Math.round(performance.now() - start);
    if (ctx.strict && failures.length > 0) {
      // Strict mode: upgrade the last failure to a combined throw (after all
      // handlers have been attempted and logged). Rarely used.
      const msg = `${failures.length} safeEmit handler(s) failed for ${event}`;
      let err: Error;
      if (typeof AggregateError !== 'undefined') {
        err = new AggregateError(failures.map(f => new Error(f.message, { cause: f.stack })), msg);
      } else {
        err = new Error(msg);
      }
      throw err;
    }
    return { totalListeners: orderedHandlers.length, errors, durationMs, traceId, failures };
  }

  /**
   * Like safeEmit, but also collects each handler's return value into
   * `values[]` (in handler order). Used by `hostApi.extensions.call` so
   * plugins can invoke cross-plugin extension-point handlers and receive
   * results back (e.g. atomic watchers → return `{ running, execPath, ... }`
   * to the app watchdog orchestrator).
   *
   * Return shape intentionally includes stats so callers can distinguish
   * "no handlers matched" (totalListeners===0, values===[]) from
   * "handlers matched but all returned undefined" (values filled with
   * undefined, totalListeners>0).
   */
  async callAndCollect<E extends string>(
    event: E,
    payload: E extends ExtensionPointName ? ExtensionPayload<E> : any,
    ctx: { traceId?: string; source?: string; strict?: boolean } = {},
  ): Promise<{ values: unknown[]; totalListeners: number; errors: number; durationMs: number; traceId: string; failures: Array<{ meta: HandlerMeta; message: string; stack?: string }> }> {
    const start = performance.now();
    const traceId = ctx.traceId || nanoid(16);
    const source = ctx.source ?? 'eventBus.callAndCollect';

    // Replicate safeEmit's ordered-handler resolution exactly so behaviour
    // parity is guaranteed: exact + wildcard matches, EventEmitter2 order.
    const matchedListeners = new Map<Function, HandlerMeta>();
    for (const [pattern, entries] of this.entries) {
      if (!pattern.includes('*')) {
        if (pattern === event) {
          for (const e of entries) matchedListeners.set(e.rawListener, e.meta);
        }
        continue;
      }
      const isMatch = wildcardStringMatch(event as string, pattern);
      if (isMatch) {
        for (const e of entries) matchedListeners.set(e.rawListener, e.meta);
      }
    }
    const emitterListeners = this.emitter.listeners(event as any) as Array<(...args: any[]) => any>;
    const orderedHandlers: Array<{ fn: (...args: any[]) => any; meta: HandlerMeta }> = [];
    for (const l of emitterListeners) {
      const meta = matchedListeners.get(l) ?? {
        name: l.name || '<anonymous>',
        owner: 'unknown',
        kind: 'exact',
        async: l.constructor.name === 'AsyncFunction',
      };
      orderedHandlers.push({ fn: l, meta });
    }

    const values: unknown[] = [];
    const failures: Array<{ meta: HandlerMeta; message: string; stack?: string }> = [];
    let errors = 0;
    for (const { fn, meta } of orderedHandlers) {
      try {
        const result = fn(payload);
        if (result != null && typeof result === 'object' && typeof (result as Promise<any>).then === 'function') {
          values.push(await result);
        } else {
          values.push(result);
        }
      } catch (rawErr) {
        const err = rawErr instanceof Error ? rawErr : new Error(String(rawErr));
        errors += 1;
        values.push(undefined);
        failures.push({ meta, message: err.message, stack: err.stack });
        try {
          _fallbackSink({
            level: 'warn',
            source: `${source}:${event}:${meta.owner}`,
            message: `handler error: ${err.message}`,
            stack: err.stack,
            traceId,
          });
        } catch { /* swallow */ }
      }
    }

    const durationMs = Math.round(performance.now() - start);
    if (ctx.strict && failures.length > 0) {
      const msg = `${failures.length} callAndCollect handler(s) failed for ${event}`;
      const err = (typeof AggregateError !== 'undefined')
        ? new AggregateError(failures.map(f => new Error(f.message, { cause: f.stack })), msg)
        : new Error(msg);
      throw err;
    }
    return { values, totalListeners: orderedHandlers.length, errors, durationMs, traceId, failures };
  }

  /**
   * Return rich listener metadata for a given event / wildcard pattern.
   * If event is left empty returns all bindings.
   *
   * Returns a list of "buckets": one bucket per matching event-pattern, each
   * bucket contains the pattern `event` + an array of handler metadata
   * entries currently registered for that pattern.
   */
  listBindings(event?: string): Array<{ event: string; meta: HandlerMeta[] }> {
    const results: Array<{ event: string; meta: HandlerMeta[] }> = [];
    for (const [pattern, entries] of this.entries) {
      if (!event) {
        results.push({ event: pattern, meta: Array.from(entries).map(e => e.meta) });
        continue;
      }
      const matches = event === pattern || (pattern.includes('*') && wildcardStringMatch(event, pattern));
      if (matches) results.push({ event: pattern, meta: Array.from(entries).map(e => e.meta) });
    }
    return results;
  }

  /** Number of listeners (including wildcards) that would match `event`. */
  countListeners(event: string): number {
    return this.emitter.listenerCount(event as any);
  }

  removeAllListeners(event?: string): void {
    if (event == null) {
      this.emitter.removeAllListeners();
      this.entries.clear();
      this.emitterByOwner.clear();
      return;
    }
    this.emitter.removeAllListeners(event as any);
    this.entries.delete(event);
    // Clean owners map too
    for (const [owner, events] of this.emitterByOwner) {
      events.delete(event);
      if (events.size === 0) this.emitterByOwner.delete(owner);
    }
  }
}

// ---------------- Singleton factory ----------------
let _singleton: EventBusService | null = null;
export function initEventBus(opts?: { maxListeners?: number }): EventBusService {
  if (_singleton) return _singleton;
  _singleton = new EventBusService(opts);
  return _singleton;
}
export function getEventBus(): EventBusService {
  if (!_singleton) throw new Error('EventBus not initialized: call initEventBus() at boot');
  return _singleton;
}

// ---------------- Wildcard helper ----------------
// (Fallback matcher if EventEmitter2 internal matcher API is unstable).
export function wildcardStringMatch(event: string, pattern: string): boolean {
  if (!pattern.includes('*')) return event === pattern;
  const regexStr = pattern
    .split('.')
    .map((seg) => {
      if (seg === '**') return '.*';
      if (seg === '*') return '[^.]*';
      return seg.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('\\.');
  return new RegExp(`^${regexStr}$`).test(event);
}
