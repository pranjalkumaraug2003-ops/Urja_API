// Builds the network tree (zone > circle > division > subdivision > substation > feeder > DT) from cleaned meters (D5).
// A node is identified by its full path of codes, because the same code appears under different parents.

import { LEVELS } from './normalise.js';
import { mostCommon } from './values.js';

function emptyCounts() {
  return { meters: 0, byStatus: {} };
}

function addMeter(counts, meter) {
  counts.meters += 1;
  const status = meter.installStatus ?? 'unknown';
  counts.byStatus[status] = (counts.byStatus[status] ?? 0) + 1;
}

export function buildNetwork(meters) {
  const nodes = new Map(); // path -> node
  const names = new Map(); // path -> names seen (the most common one wins)
  const parentsOfCode = LEVELS.map(() => new Map()); // per level: code -> Set of parent paths

  const roots = [];
  for (const meter of meters) {
    const segments = meter.hierarchy.path.split('/');
    let parent = null;
    LEVELS.forEach((level, depth) => {
      const path = segments.slice(0, depth + 1).join('/');
      let node = nodes.get(path);
      if (!node) {
        node = { level, code: meter.hierarchy[level].code, name: null, path, counts: emptyCounts(), children: [] };
        if (level === 'dt') node.meterIds = [];
        nodes.set(path, node);
        names.set(path, []);
        (parent ? parent.children : roots).push(node);
      }
      addMeter(node.counts, meter);
      names.get(path).push(meter.hierarchy[level].name);
      if (level === 'dt') node.meterIds.push(meter.meterId);

      const code = segments.at(depth);
      const parentPath = segments.slice(0, depth).join('/');
      if (!parentsOfCode[depth].has(code)) parentsOfCode[depth].set(code, new Set());
      parentsOfCode[depth].get(code).add(parentPath);
      parent = node;
    });
  }

  for (const [path, node] of nodes) node.name = mostCommon(names.get(path));

  // Stable output: children sorted by code, then path.
  const sortTree = (list) => {
    list.sort((a, b) => (a.code ?? '').localeCompare(b.code ?? '') || a.path.localeCompare(b.path));
    list.forEach((node) => sortTree(node.children));
  };
  sortTree(roots);

  const nodeCounts = {};
  LEVELS.forEach((level) => (nodeCounts[level] = 0));
  for (const node of nodes.values()) nodeCounts[node.level] += 1;

  // Codes that appear under more than one parent: the reason codes alone cannot identify a node.
  const codesUnderMultipleParents = parentsOfCode.reduce(
    (total, byCode) => total + [...byCode.values()].filter((parents) => parents.size > 1).length,
    0,
  );

  return {
    summary: { meters: meters.length, nodeCounts, codesUnderMultipleParents },
    tree: roots,
  };
}
