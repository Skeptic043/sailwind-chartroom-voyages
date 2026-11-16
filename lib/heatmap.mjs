// A world's heatmap: for each cell of a grid, how many different voyages passed through it. Counting voyages
// rather than positions keeps one long idle stretch from outweighing everyone else.

export const CELL_DEGREES = 0.2;

function cellOf(point) {
  return `${Math.floor(point.lat / CELL_DEGREES)},${Math.floor(point.lon / CELL_DEGREES)}`;
}

// { cellDegrees, cells: { "row,column": count }, max, voyages }.
export function buildHeatmap(voyages) {
  const cells = {};
  for (const voyage of voyages) {
    const seen = new Set();
    for (const point of voyage.points) seen.add(cellOf(point));
    for (const cell of seen) cells[cell] = (cells[cell] ?? 0) + 1;
  }
  return { cellDegrees: CELL_DEGREES, cells, max: Math.max(0, ...Object.values(cells)), voyages: voyages.length };
}
