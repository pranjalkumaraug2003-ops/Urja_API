// Request validation with zod (D6): strict, unknown parameters rejected, every problem listed.

import { z } from 'zod';
import { ApiError } from './errors.js';

// Max days in one energy request, counting both ends (D6).
export const MAX_RANGE_DAYS = 31;

// Missing -> "is required"; repeated (?a=1&a=2 arrives as an array) -> "must be a single value".
const singleValue = (issue) => (issue.input === undefined ? 'is required' : 'must be a single value');

// A query value that must be a whole number in [min, max]; absent -> fallback.
const wholeNumber = (min, max, fallback) =>
  z
    .string({ error: singleValue })
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`))
    .optional()
    .transform((value) => value ?? fallback);

// "2026-02-31" has the right shape but is not a real day: the round trip through Date catches it.
function isRealDate(text) {
  const time = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === text;
}

const isoDate = z
  .string({ error: singleValue })
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD format')
  .refine(isRealDate, 'is not a real calendar date');

const daysBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

export const schemas = {
  meterListQuery: z.strictObject({
    limit: wholeNumber(1, 500, 100),
    offset: wholeNumber(0, Number.MAX_SAFE_INTEGER, 0),
  }),

  energyQuery: z.strictObject({ from: isoDate, to: isoDate }).superRefine((query, ctx) => {
    // zod still runs this when a date failed its own check; comparing an impossible date
    // (Date.parse rolls 2026-02-31 into March) would add a misleading second error.
    if (!isRealDate(query.from) || !isRealDate(query.to)) return;
    const days = daysBetween(query.from, query.to);
    if (days < 0) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'must not be before from' });
    } else if (days + 1 > MAX_RANGE_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: `range must be at most ${MAX_RANGE_DAYS} days` });
    }
  }),

  noQuery: z.strictObject({}),

  meterId: z
    .string()
    .min(1, 'is required')
    .max(32, 'must be at most 32 characters')
    .transform((id) => id.toUpperCase()), // D8: meter IDs are case-insensitive
};

// zod issues -> our details list: [{ param, issue }].
function toDetails(error) {
  return error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({ param: key, issue: 'unknown parameter' }))
      : [{ param: issue.path.join('.') || 'query', issue: issue.message }],
  );
}

// Validates input against a schema; returns the cleaned value or throws a 400.
export function parse(schema, input, param) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details = toDetails(result.error).map((d) => (param ? { ...d, param } : d));
  throw new ApiError(400, 'validation_error', 'Invalid request parameters.', { details });
}
