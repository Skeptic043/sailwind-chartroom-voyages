// A world's heatmap: for each cell of a grid, how many different voyages passed through it. Counting voyages
// rather than positions keeps one long idle stretch from outweighing everyone else. Each leg between readings
// counts every cell it crosses, so a fine grid doesn't come out as dots. There are two grids: a coarse one for
// the whole chart and a fine one that keeps the lanes between nearby islands apart when zoomed in.
import { MAX_SEGMENT_DEG } from "./race.mjs";

export const CELL_DEGREES = [0.2, 0.02];

// The keys of the cells a leg from a to b crosses, from a's cell to b's. A leg long enough to be a recording
// gap counts only its ends.
function cellsAlong(a, b, size) {
  let row = Math.floor(a.lat / size);
  let column = Math.floor(a.lon / size);
  const keys = [`${row},${column}`];
  const endRow = Math.floor(b.lat / size);
  const endColumn = Math.floor(b.lon / size);
  const dLat = b.lat - a.lat;
  const dLon = b.lon - a.lon;
  if (Math.hypot(dLat, dLon) > MAX_SEGMENT_DEG) return [...keys, `${endRow},${endColumn}`];
  const stepRow = Math.sign(endRow - row);
  const stepColumn = Math.sign(endColumn - column);
  // How far along the leg, from 0 to 1, the next row and column edges are, and how far one whole cell is.
  const deltaRow = size / Math.abs(dLat);
  const deltaColumn = size / Math.abs(dLon);
  let nextRow = stepRow ? ((stepRow > 0 ? (row + 1) * size - a.lat : a.lat - row * size) / Math.abs(dLat)) : Infinity;
  let nextColumn = stepColumn ? ((stepColumn > 0 ? (column + 1) * size - a.lon : a.lon - column * size) / Math.abs(dLon)) : Infinity;
  for (let steps = Math.abs(endRow - row) + Math.abs(endColumn - column); steps > 0; steps--) {
    if (column === endColumn || (row !== endRow && nextRow < nextColumn)) { row += stepRow; nextRow += deltaRow; }
    else { column += stepColumn; nextColumn += deltaColumn; }
    keys.push(`${row},${column}`);
  }
  return keys;
}

function buildLevel(voyages, size) {
  const cells = {};
  for (const voyage of voyages) {
    const seen = new Set();
    const points = voyage.points;
    seen.add(`${Math.floor(points[0].lat / size)},${Math.floor(points[0].lon / size)}`);
    for (let index = 1; index < points.length; index++) {
      for (const key of cellsAlong(points[index - 1], points[index], size)) seen.add(key);
    }
    for (const cell of seen) cells[cell] = (cells[cell] ?? 0) + 1;
  }
  return { cellDegrees: size, cells, max: Object.values(cells).reduce((most, count) => Math.max(most, count), 0) };
}

// { levels: [{ cellDegrees, cells: { "row,column": count }, max }, ...] from coarse to fine, voyages }.
export function buildHeatmap(voyages) {
  return { levels: CELL_DEGREES.map((size) => buildLevel(voyages, size)), voyages: voyages.length };
}
