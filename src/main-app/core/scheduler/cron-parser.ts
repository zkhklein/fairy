/**
 * Lightweight 5-field cron expression parser.
 *
 * Fields: minute hour day-of-month month day-of-week
 * Supports: wildcard, step (star-slash-N), range (N-M), list (N,M), literal (N)
 *
 * Does NOT support: names (MON, JAN), @reboot, L, W, hash macros.
 * That is sufficient for FMB's scheduling needs.
 */

const FIELD_RANGES: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 }, // 0=Sunday
];

export interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

export class CronParseError extends Error {
  override name = 'CronParseError';
}

// Parse a single field: wildcard, star-slash-5 (step), 1-5 (range), 1,3,5 (list), 10 (literal)
function parseField(field: string, min: number, max: number, name: string): number[] {
  if (field === '*' || field === '?') {
    const result: number[] = [];
    for (let i = min; i <= max; i++) result.push(i);
    return result;
  }

  // Handle step: */N or N-M/S
  const stepMatch = field.match(/^(.+?)\/(\d+)$/);
  let step = 1;
  let rangePart = field;
  if (stepMatch) {
    step = parseInt(stepMatch[2], 10);
    if (step < 1) throw new CronParseError(`Invalid step "${step}" in field "${name}"`);
    rangePart = stepMatch[1];
  }

  if (rangePart === '*') {
    const result: number[] = [];
    for (let i = min; i <= max; i += step) result.push(i);
    return result;
  }

  // Handle comma-separated values
  const parts = rangePart.split(',');
  const result = new Set<number>();
  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start < min || end > max || start > end) {
        throw new CronParseError(`Range "${part}" out of bounds for field "${name}" (min=${min}, max=${max})`);
      }
      for (let i = start; i <= end; i += step) result.add(i);
    } else {
      const val = parseInt(part, 10);
      if (isNaN(val)) throw new CronParseError(`Invalid value "${part}" in field "${name}"`);
      if (val < min || val > max) {
        throw new CronParseError(`Value ${val} out of bounds for field "${name}" (min=${min}, max=${max})`);
      }
      result.add(val);
    }
  }
  return Array.from(result).sort((a, b) => a - b);
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(`Expected 5 fields, got ${parts.length} in "${expr}"`);
  }
  return {
    minute: parseField(parts[0], FIELD_RANGES[0].min, FIELD_RANGES[0].max, 'minute'),
    hour: parseField(parts[1], FIELD_RANGES[1].min, FIELD_RANGES[1].max, 'hour'),
    dayOfMonth: parseField(parts[2], FIELD_RANGES[2].min, FIELD_RANGES[2].max, 'dayOfMonth'),
    month: parseField(parts[3], FIELD_RANGES[3].min, FIELD_RANGES[3].max, 'month'),
    dayOfWeek: parseField(parts[4], FIELD_RANGES[4].min, FIELD_RANGES[4].max, 'dayOfWeek'),
  };
}

/** Check if a given Date matches the cron fields. */
export function matchesCron(date: Date, fields: CronFields): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-based
  const dayOfWeek = date.getDay(); // 0=Sunday in JS

  // Cron spec: if both dayOfMonth and dayOfWeek are restricted (not *), match if either matches
  // (standard cron "OR" behavior)
  const domMatch = fields.dayOfMonth.includes(dayOfMonth);
  const dowMatch = fields.dayOfWeek.includes(dayOfWeek);
  const domIsWildcard = fields.dayOfMonth.length === 31; // all 1-31
  const dowIsWildcard = fields.dayOfWeek.length === 7; // all 0-6

  const dayMatches = domIsWildcard || dowIsWildcard
    ? domMatch && dowMatch
    : domMatch || dowMatch;

  return fields.minute.includes(minute) && fields.hour.includes(hour) && dayMatches && fields.month.includes(month);
}

/** Compute the next N firing times after `from` (default now). */
export function nextRunTimes(fields: CronFields, count = 5, from = new Date()): Date[] {
  const results: Date[] = [];
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1); // Start from next minute

  const maxIterations = 525_600; // 1 year of minutes as safety limit
  for (let i = 0; i < maxIterations && results.length < count; i++) {
    if (matchesCron(cursor, fields)) {
      results.push(new Date(cursor));
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return results;
}
