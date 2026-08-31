/**
 * Plugin manifest validation.
 *
 * The manifest.json is the source of truth for every plugin zip. It is
 * validated using PluginManifestSchema from @shared/types (T3 Zod schema).
 * This module adds helpers to read a manifest buffer, validate, and produce
 * typed PluginManifest + any I/O / parse errors converted to ProblemDetails.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import {
  PluginManifestSchema,
  type PluginManifest,
  toProblemDetails,
  type ProblemDetails,
} from '@shared/index';

export type ManifestParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: ProblemDetails; rawMessage: string };

/**
 * Parse and validate a manifest text string (JSON).
 */
export function parseManifestText(text: string, ctx: { instance?: string } = {}): ManifestParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    return {
      ok: false,
      rawMessage: e?.message ?? String(e),
      error: {
        type: 'about:blank',
        title: 'Invalid Manifest JSON',
        status: 400,
        detail: `manifest.json is not valid JSON: ${e?.message ?? String(e)}`,
        instance: ctx.instance,
        errors: [{ path: ['manifest'], message: 'JSON parse failed', code: 'json.parse' }],
      },
    };
  }
  const parsedSchema = PluginManifestSchema.safeParse(parsed);
  if (!parsedSchema.success) {
    return {
      ok: false,
      rawMessage: parsedSchema.error.message,
      error: toProblemDetails(parsedSchema.error, {
        status: 400,
        instance: ctx.instance,
        type: 'https://fmb.dev/problems/invalid-manifest',
      }),
    };
  }
  return { ok: true, manifest: parsedSchema.data };
}

/**
 * Read manifest.json from an already-extracted plugin directory on disk.
 */
export function readManifestFromDir(pluginDir: string, ctx?: { instance?: string }): ManifestParseResult {
  const manifestPath = path.join(pluginDir, 'manifest.json');
  try {
    if (!fs.existsSync(manifestPath)) {
      return {
        ok: false,
        rawMessage: 'manifest.json not found',
        error: {
          type: 'https://fmb.dev/problems/manifest-missing',
          title: 'manifest.json missing',
          status: 400,
          detail: `Expected manifest.json at ${manifestPath}`,
          instance: ctx?.instance,
          errors: [{ path: ['manifest', 'path'], message: 'manifest.json missing', code: 'file.missing' }],
        },
      };
    }
    return parseManifestText(fs.readFileSync(manifestPath, 'utf8'), ctx);
  } catch (e) {
    return {
      ok: false,
      rawMessage: (e as Error).message,
      error: toProblemDetails(e, { status: 500, instance: ctx?.instance }),
    };
  }
}

export type { PluginManifest };
export const PluginZodSchemaForRef: typeof PluginManifestSchema = PluginManifestSchema;
