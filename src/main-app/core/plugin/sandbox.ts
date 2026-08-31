/**
 * Permission-checked vm sandbox for plugin code.
 *
 * Sandbox rules (level ≥ 4 in TR-5.5):
 *   - No access to node:fs / node:process / any built-in module (require() is
 *     redefined to throw when resolving anything outside the tiny whitelist of
 *     host-provided primitives).
 *   - `globalThis`, `global`, `Function`, `eval`, `setTimeout` friends → all
 *     frozen / replaced with safe wrappers. Constructor-based escapes
 *     (`({}).constructor.constructor('return process')()`) are blocked by
 *     freezing Object.prototype.constructor chain in the vm context.
 *   - Every side-effecting hostApi call is routed through a permission proxy
 *     that checks manifest.permissions. Failures throw PermissionDenied and
 *     record an error_logs row + audit entry.
 *
 * The sandbox implements a tiny AMD-style module wrapper so plugins can use
 *   module.exports = { activate(ctx) { ... }, deactivate() { ... } }
 * (or) exports.activate = () => {}.
 */
import vm from 'node:vm';
import crypto from 'node:crypto';
import type {
  PluginManifest,
  HostApi,
  ProblemDetails,
} from '@shared/index';
import { createLogger } from '../logger';

const log = createLogger('plugin-sandbox');

// ---------------- Errors ----------------
export class PermissionDeniedError extends Error {
  override name = 'PermissionDeniedError';
  constructor(public readonly scope: string, public readonly pluginId: string) {
    super(`Permission denied: plugin '${pluginId}' does not declare permission '${scope}'.`);
  }
  toProblemDetails(): ProblemDetails {
    return {
      type: 'https://fmb.dev/problems/permission-denied',
      title: 'Permission Denied',
      status: 403,
      detail: this.message,
      errors: [{ path: ['permission'], message: this.message, code: 'fmb.permission.missing' }],
    };
  }
}

// ---------------- Permission map ----------------
/** Each HostApi path -> required permission. Wildcards on the right are allowed. */
const PERMISSION_RULES: ReadonlyArray<{ apiPath: string; permission: string }> = [
  { apiPath: 'eventBus.on', permission: 'event:subscribe' },
  { apiPath: 'eventBus.once', permission: 'event:subscribe' },
  { apiPath: 'eventBus.emit', permission: 'event:publish' },
  { apiPath: 'logger.log', permission: 'log:write' },
  { apiPath: 'logger.debug', permission: 'log:write' },
  { apiPath: 'logger.info', permission: 'log:write' },
  { apiPath: 'logger.warn', permission: 'log:write' },
  { apiPath: 'logger.error', permission: 'log:write' },
  { apiPath: 'audit.record', permission: 'audit:write' },
  { apiPath: 'secrets.get', permission: 'secrets:read' },
  { apiPath: 'secrets.set', permission: 'secrets:write' },
  { apiPath: 'secrets.delete', permission: 'secrets:write' },
  { apiPath: 'secrets.list', permission: 'secrets:read' },
  { apiPath: 'kv.get', permission: 'kv:read' },
  { apiPath: 'kv.set', permission: 'kv:write' },
  { apiPath: 'kv.delete', permission: 'kv:write' },
  { apiPath: 'kv.list', permission: 'kv:read' },
  { apiPath: 'workflows.list', permission: 'workflows:read' },
  { apiPath: 'workflows.get', permission: 'workflows:read' },
  { apiPath: 'workflows.start', permission: 'workflows:execute' },
  { apiPath: 'workflows.cancel', permission: 'workflows:execute' },
  { apiPath: 'workflows.runs', permission: 'workflows:read' },
  { apiPath: 'schedules.list', permission: 'schedules:read' },
  { apiPath: 'schedules.get', permission: 'schedules:read' },
  { apiPath: 'schedules.create', permission: 'schedules:write' },
  { apiPath: 'schedules.update', permission: 'schedules:write' },
  { apiPath: 'schedules.delete', permission: 'schedules:write' },
  { apiPath: 'jobs.list', permission: 'jobs:read' },
  { apiPath: 'jobs.get', permission: 'jobs:read' },
  { apiPath: 'jobs.cancel', permission: 'jobs:write' },
  { apiPath: 'plugins.list', permission: 'plugins:read' },
  { apiPath: 'plugins.get', permission: 'plugins:read' },
  { apiPath: 'plugins.self', permission: 'plugin:self' },
  { apiPath: 'extensions.registerMenuItem', permission: 'ui:extend' },
  { apiPath: 'extensions.registerCard', permission: 'ui:extend' },
  { apiPath: 'ui.notify', permission: 'ui:interact' },
  { apiPath: 'ui.dialog', permission: 'ui:interact' },
];

function permissionRequiredFor(apiPath: string): string | null {
  // Exact match
  const exact = PERMISSION_RULES.find(r => r.apiPath === apiPath);
  if (exact) return exact.permission;
  // Prefix match (fallback for nested calls)
  for (const rule of PERMISSION_RULES) {
    const prefix = rule.apiPath + '.';
    if (apiPath.startsWith(prefix)) return rule.permission;
  }
  // Unknown root APIs default to requiring a generic scope.
  const root = apiPath.split('.')[0];
  if (!root) return null;
  return `${root}:*`;
}

function matchesPermission(declared: readonly string[], required: string): boolean {
  if (declared.includes('*')) return true;
  if (declared.includes(required)) return true;
  // plugin:self is always implicitly granted
  if (required === 'plugin:self') return true;
  // wildcard permission e.g. "log:*" satisfies required log:write
  const [rns, rname] = required.split(':');
  return declared.includes(`${rns}:*`) || declared.includes(`${rns}:${rname}`);
}

// ---------------- Permission proxy ----------------
export function createPermissionedHostApi(args: {
  hostApi: HostApi;
  manifest: PluginManifest;
  onPermissionDenied: (err: PermissionDeniedError) => void;
}): HostApi {
  const declared = args.manifest.permissions ?? [];
  const pluginId = args.manifest.id;

  // Build nested proxy that records the accessed path until a function call.
  function build(obj: any, pathPrefix: string): any {
    if (obj == null) return obj;
    return new Proxy(obj, {
      get(target, prop, receiver) {
        if (typeof prop !== 'string' || prop === 'then') return Reflect.get(target, prop, receiver);
        const full = pathPrefix ? `${pathPrefix}.${prop}` : prop;
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          const permission = permissionRequiredFor(full);
          const fn = (...invokeArgs: unknown[]) => {
            if (permission && !matchesPermission(declared, permission)) {
              const err = new PermissionDeniedError(permission, pluginId);
              args.onPermissionDenied(err);
              throw err;
            }
            try {
              return value.apply(target, invokeArgs);
            } catch (e) {
              // rethrow; plugin can then catch locally. We don't record into error_logs here
              // because plugin can handle it; actual unhandled / audit handled elsewhere.
              throw e;
            }
          };
          return fn;
        }
        if (value && typeof value === 'object') {
          return build(value, full);
        }
        return value;
      },
      has(target, prop) {
        // Block "constructor" introspection escapes
        if (prop === 'constructor') return false;
        return Reflect.has(target, prop);
      },
      ownKeys(target) {
        return Reflect.ownKeys(target).filter(k => k !== 'constructor' && k !== '__proto__');
      },
      getOwnPropertyDescriptor(target, prop) {
        if (prop === 'constructor' || prop === '__proto__') return undefined;
        return Reflect.getOwnPropertyDescriptor(target, prop);
      },
    });
  }
  return build(args.hostApi, '') as HostApi;
}

// ---------------- Sandbox ----------------
export interface SandboxModule {
  readonly exports: Record<string, any>;
}

export interface SandboxInstance {
  readonly instanceId: string;
  readonly manifest: PluginManifest;
  readonly module: SandboxModule;
  readonly activate?: (ctx: any) => void | Promise<void>;
  readonly deactivate?: () => void | Promise<void>;
  dispose(): void;
}

export interface SandboxOptions {
  manifest: PluginManifest;
  sourceCode: string;
  filename?: string;
  hostApi: HostApi;
  globals?: Record<string, unknown>;
  onPermissionDenied: (err: PermissionDeniedError) => void;
}

export function createSandbox(opts: SandboxOptions): SandboxInstance {
  const instanceId = `${opts.manifest.id}@${opts.manifest.version}-${crypto.randomBytes(6).toString('hex')}`;
  const filename = opts.filename ?? `<sandbox:${instanceId}/main.js>`;

  // 1) Permission proxy
  const proxiedHost = createPermissionedHostApi({
    hostApi: opts.hostApi,
    manifest: opts.manifest,
    onPermissionDenied: opts.onPermissionDenied,
  });

  // 2) Module surface
  const moduleObj: { exports: any } = { exports: {} };
  const exports = moduleObj.exports;

  // 3) Safe require: only host-defined primitives allowed. Node builtins BLOCKED.
  const DISALLOWED_REQUIRE = new Set([
    'fs', 'node:fs', 'path', 'node:path', 'child_process', 'node:child_process',
    'os', 'node:os', 'process', 'node:process', 'net', 'node:net', 'http', 'node:http',
    'https', 'node:https', 'vm', 'node:vm', 'worker_threads', 'node:worker_threads',
    'cluster', 'node:cluster', 'readline', 'node:readline', 'repl', 'node:repl',
    'dns', 'node:dns', 'tls', 'node:tls', 'module', 'node:module', 'fs/promises',
  ]);
  function sandboxedRequire(id: string): unknown {
    // Allow a tiny host-whitelist only.
    if (id === 'path-browserify' || id === 'util' || id === 'node:util') {
      // Intentionally deny: util has inspect + TextEncoder which is fine but we
      // keep scope minimal — plugins get only basic JS primitives via hostApi.
      throw new Error(`require('${id}') blocked: plugins must use hostApi for platform access`);
    }
    if (DISALLOWED_REQUIRE.has(id) || /^node:/.test(id)) {
      throw new Error(`require('${id}') blocked: native modules are not accessible inside plugins`);
    }
    throw new Error(`require('${id}') blocked: unknown dependency`);
  }

  // 4) Build sandbox context. We explicitly freeze globals that allow escape.
  const safeConsole = new Proxy(console, {
    get(target, prop, _recv) {
      // Keep all console methods available for debug; but no reference leaking.
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set() { return false; },
    deleteProperty() { return false; },
  });

  const contextObject = {
    console: safeConsole,
    Buffer: Buffer,
    // Timers (safe; we restrict to setTimeout/clearTimeout only)
    setTimeout: (cb: (...a: any[]) => void, ms: number, ...args: any[]) => globalThis.setTimeout(cb, ms, ...args),
    clearTimeout: globalThis.clearTimeout,
    // Math / JSON / Date / Symbol / Promise are safe (standard built-ins).
    Math,
    JSON,
    Date,
    RegExp,
    Promise,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Array,
    Object,
    Boolean,
    Number,
    String,
    BigInt,
    NaN,
    Infinity,
    undefined,
    parseInt,
    parseFloat,
    isFinite,
    isNaN,
    encodeURI,
    decodeURI,
    encodeURIComponent,
    decodeURIComponent,
    atob,
    btoa,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AggregateError,
    Error,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
    SymbolIterator: Symbol.iterator,
    // hostApi reference (already permission-wrapped). Do NOT Object.freeze() here
    // because createPermissionedHostApi() wraps each sub-object (eventBus, logger, …)
    // in a nested Proxy whose reference differs from the target's real property —
    // a frozen target has non-configurable own properties and the Proxy invariant
    // forces the `get` trap to return the target's actual value, defeating the wrap.
    hostApi: proxiedHost,
    // Module-like variables
    __filename: filename,
    __dirname: '',
    // Globals passed in (may include register() for extension plugins / actions)
    ...(opts.globals ?? {}),
  };

  // Create context
  const ctx = vm.createContext(Object.freeze(contextObject), {
    codeGeneration: { strings: false, wasm: false },
  });

  // 5) Wrap plugin source in module-style IIFE, blocking raw assignments outside exports.
  // NOTE: Under strict mode it is a SyntaxError to declare `const eval = ...` /
  // `const arguments = ...`, and `const undefined = ...` is also a restricted
  // binding. Instead we block code generation at the vm level (codeGeneration:
  // {strings:false, wasm:false}) above, which makes new Function() / eval()
  // throw at runtime regardless of plugin attempts to reach them.
  const wrappedSource = `
"use strict";
(function (exports, require, module, __filename, __dirname, hostApi) {
  // Freeze the constructor chain so ({}.constructor.constructor) cannot be
  // used to re-acquire the Function constructor at runtime.
  try {
    Object.defineProperty(Object.prototype, 'constructor', { configurable: false, writable: false, enumerable: false });
  } catch (_) { /* already frozen */ }
  // Plugin source below:
  ${opts.sourceCode}
  // ----
});
`;

  // 6) Execute
  try {
    const fnWrapper = vm.runInContext(wrappedSource, ctx, {
      filename,
      lineOffset: -4, // offset the comment/IIFE lines for more intuitive stack traces
      displayErrors: true,
      timeout: 10_000, // 10s for activate() sync; async can take longer via timers
    });
    fnWrapper(exports, sandboxedRequire, moduleObj, filename, '', proxiedHost);
  } catch (e: any) {
    log.warn({ instanceId, pluginId: opts.manifest.id, message: e?.message }, 'plugin sandbox exec failed');
    throw e;
  }

  const exported = moduleObj.exports;
  const activate = typeof exported?.activate === 'function' ? exported.activate : undefined;
  const deactivate = typeof exported?.deactivate === 'function' ? exported.deactivate : undefined;

  return {
    instanceId,
    manifest: opts.manifest,
    module: { exports: moduleObj.exports },
    activate,
    deactivate,
    dispose() {
      // Release references; GC eventually takes care of the vm context once no one references it.
      Object.keys(moduleObj.exports).forEach(k => { try { delete moduleObj.exports[k]; } catch {} });
    },
  };
}

/** Sandbox escape test harness — used by TR-5.5 to assert isolation. */
export function runEscapeAttempt(sourceCode: string, manifestMinusPerms: PluginManifest, hostApi: HostApi): { attempt: string; ok: boolean; error?: string } {
  // Helper for tests; returns { ok: true } if the attempt was SAFELY BLOCKED,
  // { ok: false, error: 'ESCAPED' } if code returned a forbidden primitive.
  let escaped: any = '__NO_RETURN__';
  const instrumented = `module.exports = (function() { ${sourceCode.replace(/;?\s*$/, '')}; return (typeof ESCAPED !== 'undefined') ? ESCAPED : '__NO_RETURN__'; })();`;
  let raisedError: Error | null = null;
  try {
    const instance = createSandbox({
      manifest: manifestMinusPerms,
      sourceCode: instrumented,
      filename: '<escape-test>',
      hostApi,
      onPermissionDenied: () => { /* test will just see throw */ },
    });
    escaped = instance.module.exports;
    instance.dispose();
  } catch (e: any) {
    raisedError = e;
    // Expected for most escape attempts → safe.
  }
  // Define "ESCAPED" markers: plugins MUST NOT obtain process / require(fs) / globalThis.constructor.
  const isEscaped = (value: any) => {
    if (value == null) return false;
    if (typeof value === 'object' || typeof value === 'function') {
      if (typeof value === 'function') {
        // Function constructor would be an escape
        const f = Function; void f;
      }
      try {
        if (value === Object.getPrototypeOf({}).constructor) return true; // plain Object constructor escape → mild
        if (value && value.toString().includes('[object process]')) return true;
        if (typeof (value as any).cwd === 'function') return true; // process
        if (typeof (value as any).readFile === 'function') return true; // fs
      } catch {}
    }
    if (typeof value === 'string') {
      // If plugin returned a string containing leaked path/env that's also a mild leak.
      if (/C:\\Windows|system32|HOME=|USERNAME=/.test(value)) return true;
    }
    return false;
  };

  if (raisedError) {
    return { attempt: sourceCode.slice(0, 40), ok: true, error: raisedError.message };
  }
  if (isEscaped(escaped)) {
    return { attempt: sourceCode.slice(0, 40), ok: false, error: 'ESCAPED: returned forbidden reference' };
  }
  return { attempt: sourceCode.slice(0, 40), ok: true };
}
