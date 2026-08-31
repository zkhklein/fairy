/**
 * OpenAPI 3.0 spec for the FMB localhost HTTP API (Task 15).
 *
 * Hand-written (rather than @hono/zod-openapi) because the project pins zod v3
 * and the zod-openapi adapter requires zod v4. This keeps a single source of
 * truth for the public API surface that Swagger UI renders at GET /api/v1/docs.
 *
 * Covers the 8 resource groups: health, plugins, workflows, runs, schedules,
 * queue/jobs, errors, rpc.
 */
export const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Fairy Maid Brigade API',
    version: '1.0.0',
    description: 'Localhost-only HTTP API for agents and external tools. All endpoints except /health require a Bearer token (see settings http.token).',
  },
  servers: [{ url: 'http://127.0.0.1:18765/api/v1', description: 'Localhost (loopback only)' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'hex-token' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'integer' },
          detail: { type: 'string' },
          instance: { type: 'string' },
        },
      },
      Health: {
        type: 'object',
        properties: {
          version: { type: 'string' },
          uptimeMs: { type: 'integer' },
          activeWorkers: { type: 'integer' },
          pendingJobs: { type: 'integer' },
          activeRuns: { type: 'integer' },
          enabledPlugins: { type: 'integer' },
          dbOk: { type: 'boolean' },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'system', description: 'Health + OpenAPI metadata' },
    { name: 'plugins', description: 'Plugin lifecycle' },
    { name: 'workflows', description: 'Workflow definitions + runs' },
    { name: 'schedules', description: 'Scheduled triggers' },
    { name: 'queue', description: 'Job queue + dead-letter' },
    { name: 'errors', description: 'Error calendar entries' },
    { name: 'rpc', description: 'JSON-RPC 2.0 batch' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['system'],
        summary: 'Liveness + basic health (no auth)',
        security: [],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } } } },
      },
    },
    '/openapi.json': {
      get: { tags: ['system'], summary: 'OpenAPI 3.0 document (no auth)', security: [], responses: { '200': { description: 'spec' } } },
    },
    '/plugins': {
      get: { tags: ['plugins'], summary: 'List plugins', parameters: listParams(), responses: { '200': { description: 'paged list' } } },
      post: { tags: ['plugins'], summary: 'Install plugin from zip', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { zipPath: { type: 'string' } }, required: ['zipPath'] } } } }, responses: { '201': { description: 'installed plugin' }, '400': { description: 'install failed', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
    },
    '/plugins/{id}': {
      get: { tags: ['plugins'], summary: 'Get plugin detail', parameters: [idParam()], responses: { '200': { description: 'plugin' }, '404': { description: 'not found' } } },
      patch: { tags: ['plugins'], summary: 'Update plugin (e.g. status field)', parameters: [idParam()], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['enabled', 'disabled'] } } } } } }, responses: { '200': { description: 'updated' } } },
    },
    '/plugins/{id}/actions/{action}': {
      post: {
        tags: ['plugins'], summary: 'enable / disable / switch-version',
        parameters: [idParam(), { name: 'action', in: 'path', required: true, schema: { type: 'string', enum: ['enable', 'disable', 'switch-version'] } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { version: { type: 'string' } } } } } },
        responses: { '200': { description: 'ok' }, '400': { description: 'action failed' } },
      },
    },
    '/workflows': {
      get: { tags: ['workflows'], summary: 'List workflows', parameters: listParams(), responses: { '200': { description: 'paged list' } } },
      post: { tags: ['workflows'], summary: 'Create workflow', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, definition: { type: 'object' }, vars: { type: 'object' } }, required: ['id', 'name'] } } } }, responses: { '201': { description: 'created' } } },
    },
    '/workflows/{id}': {
      get: { tags: ['workflows'], summary: 'Get workflow', parameters: [idParam()], responses: { '200': { description: 'workflow' }, '404': { description: 'not found' } } },
      put: { tags: ['workflows'], summary: 'Update workflow', parameters: [idParam()], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '200': { description: 'updated' } } },
      delete: { tags: ['workflows'], summary: 'Delete workflow', parameters: [idParam()], responses: { '200': { description: 'deleted' } } },
    },
    '/workflows/{id}/runs': {
      get: { tags: ['workflows'], summary: 'List runs for a workflow', parameters: [idParam(), ...listParams()], responses: { '200': { description: 'paged runs' } } },
      post: { tags: ['workflows'], summary: 'Start a run', parameters: [idParam()], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { input: { type: 'object' } } } } } }, responses: { '201': { description: 'run created', content: { 'application/json': { schema: { type: 'object', properties: { run_id: { type: 'string' }, status: { type: 'string' } } } } } } } },
    },
    '/runs/{runId}': {
      get: { tags: ['workflows'], summary: 'Get a run by id', parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'run' }, '404': { description: 'not found' } } },
    },
    '/schedules': {
      get: { tags: ['schedules'], summary: 'List schedules', parameters: listParams(), responses: { '200': { description: 'paged list' } } },
      post: { tags: ['schedules'], summary: 'Create schedule', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, cronExpr: { type: 'string' }, oneShotAtMs: { type: 'integer' }, workflowId: { type: 'string' }, input: { type: 'object' }, enabled: { type: 'boolean' }, misfirePolicy: { type: 'string', enum: ['run_now', 'skip', 'last_missed'] }, timezone: { type: 'string' } }, required: ['name', 'workflowId'] } } } }, responses: { '201': { description: 'created' } } },
    },
    '/schedules/{id}': {
      patch: { tags: ['schedules'], summary: 'Update schedule (e.g. enabled)', parameters: [idParam()], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { enabled: { type: 'boolean' } } } } } }, responses: { '200': { description: 'updated' } } },
      delete: { tags: ['schedules'], summary: 'Delete schedule', parameters: [idParam()], responses: { '200': { description: 'deleted' } } },
    },
    '/schedules/{id}/actions/{action}': {
      post: {
        tags: ['schedules'], summary: 'pause / resume',
        parameters: [idParam(), { name: 'action', in: 'path', required: true, schema: { type: 'string', enum: ['pause', 'resume'] } }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/queue/stats': {
      get: { tags: ['queue'], summary: 'Queue metrics + per-status counts', responses: { '200': { description: 'metrics' } } },
    },
    '/queue/jobs': {
      get: { tags: ['queue'], summary: 'List jobs', parameters: [listParams()[0], { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'type', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'paged jobs' } } },
    },
    '/queue/actions/retry-dead': {
      post: { tags: ['queue'], summary: 'Re-enqueue all dead jobs', responses: { '200': { description: 'retried count' } } },
    },
    '/queue/actions/clear-dead': {
      post: { tags: ['queue'], summary: 'Delete all dead jobs', responses: { '200': { description: 'cleared count' } } },
    },
    '/errors': {
      get: { tags: ['errors'], summary: 'Query error logs', parameters: [listParams()[0], { name: 'level', in: 'query', schema: { type: 'string' } }, { name: 'source', in: 'query', schema: { type: 'string' } }, { name: 'resolved', in: 'query', schema: { type: 'integer' } }, { name: 'from', in: 'query', schema: { type: 'integer' } }, { name: 'to', in: 'query', schema: { type: 'integer' } }], responses: { '200': { description: 'paged errors' } } },
    },
    '/errors/{id}': {
      patch: { tags: ['errors'], summary: 'Mark resolved / ignored', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { resolved: { type: 'boolean' }, ignored: { type: 'boolean' } } } } } }, responses: { '200': { description: 'updated' } } },
    },
    '/rpc': {
      post: {
        tags: ['rpc'], summary: 'JSON-RPC 2.0 batch entry',
        requestBody: { content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { jsonrpc: { type: 'string' }, id: {}, method: { type: 'string' }, params: { type: 'object' } } } } } } },
        responses: { '200': { description: 'array of result/error objects, one per request id' } },
      },
    },
  },
};

function idParam() {
  return { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
}
function listParams() {
  return [
    { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
    { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 20 } },
  ];
}
