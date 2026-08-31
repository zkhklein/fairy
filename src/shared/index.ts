/**
 * Shared code barrel export — single entry `import {} from '@shared/index'`
 * OR `import type * as FMB from '@shared/index'` works everywhere.
 */

export { FMB_PROJECT_NAME } from './project';

// Domain types + Zod schemas
export * from './types';

// ProblemDetails RFC 9457 envelope + converters
export * from './errors/problem-details';

// IPC channel contract registry
export * from './ipc';
export type { IpcChannel } from './ipc';

// Host ↔ Plugin API boundary
export * from './plugin-api';
export type {
  HostApi,
  HostMethod,
  PluginEntryArgs,
  PluginLifecycleHandlers,
  PluginMain,
  PluginRegister,
  PluginActionContext,
} from './plugin-api';

// HTTP API route contract registry (Hono mounting in T16)
export * from './http-api';
export type { HttpRoute, HttpMethod } from './http-api';
