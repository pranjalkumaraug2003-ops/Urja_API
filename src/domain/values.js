// Small value converters shared by the cleaning code (D3 rules 1 and 3).

// Trims a value to a string; blank or missing becomes null.
export function cleanString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

// Accepts a number or a numeric string; anything else becomes null.
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = cleanString(value);
  if (text === null) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

// "CT Operated" -> "ct_operated", "Installed" -> "installed" (D8: lowercase snake case enums).
export function toEnum(value) {
  const text = cleanString(value);
  if (text === null) return null;
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Groups items into a Map by key. (Map.groupBy exists only from Node 21; we support Node 20.)
export function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

// The most frequent non-null value; ties go to the value seen first.
export function mostCommon(values) {
  const counts = new Map();
  for (const value of values) {
    if (value !== null && value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}
