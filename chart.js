// The heatmap chart on world and race pages: a world's islands, where shared voyages or race runs sailed from cold
// (blue) to hot (red), and a race's flags. Click it and scroll, or use the buttons, to zoom; drag to pan; hover
// for counts.
// Secret islands, and voyages far beyond the usual islands, show only with spoilers on.
import { ISLAND_CATALOG } from "./vendor/island-catalog.mjs";

const CATALOG = new Map(ISLAND_CATALOG.map((island) => [island.id, island]));
const MAX_ZOOM = 40;
// With spoilers off, the vanilla chart stops this far past the usual islands, and heat beyond it is left out.
const SPOILER_MARGIN_DEG = 0.5;
const FLAG_HIT_PX = 12;
const SECRET_RADIUS_DEG = 1.5;

const element = (tag, properties = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children);
  return node;
};

function niceStep(span, divisions = 7) {
  const rough = Math.max(Number.EPSILON, span / divisions);
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

function degreeLabel(value, axis, step) {
  const rounded = Math.abs(value) < 1e-8 ? 0 : value;
  const digits = Math.min(2, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
  const number = Math.abs(rounded).toFixed(digits);
  if (rounded === 0) return `${number}°`;
  return `${number}°${axis === "lon" ? (rounded < 0 ? "W" : "E") : (rounded < 0 ? "S" : "N")}`;
}

function cssRgb(style, name) {
  return (style.getPropertyValue(name).match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
}

function mix(a, b, amount) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * amount));
}

// The world's islands to draw: { island (catalog entry), lat, lon, secret }. Vanilla uses the catalog where it
// is; a Scrambled Seas world gives where it put each island.
export function worldIslands(world) {
  if (Array.isArray(world?.islands)) {
    return world.islands.map(({ id, lat, lon }) => ({ island: CATALOG.get(id), lat, lon })).filter(({ island }) => island)
      .map((entry) => ({ ...entry, secret: entry.island.secret === true }));
  }
  if (world?.world?.kind === "scrambled") return [];
  return ISLAND_CATALOG.map((island) => ({ island, lat: island.sourceCenter.lat, lon: island.sourceCenter.lon, secret: island.secret === true }));
}

// Draws the chart into frame and returns a function that removes it. options: { heatmap, islands, bounds
// (a Scrambled Seas world's edges, or null), flags: [{ lat, lon, kind: "start" | "checkpoint" | "finish",
// label, secret }], unit: ["voyage", "voyages"], spoilers, onPick }. With onPick, a click that doesn't drag calls
// onPick({ lat, lon, island }) with the island clicked, if any, and the returned function's setFlags redraws
// the flags without moving the chart.
export function drawChart(frame, options) {
  const { heatmap, unit, spoilers } = options;
  const cellDegrees = heatmap.cellDegrees;
  const islands = options.islands.filter((entry) => spoilers || !entry.secret);
  const usual = options.islands.filter((entry) => !entry.secret);
  // With spoilers off on vanilla, the chart covers the usual islands, and heat beyond them stays hidden.
  const limit = !spoilers && !options.bounds && usual.length ? {
    minLat: Math.min(...usual.map((entry) => entry.lat + entry.island.bounds.minLat)) - SPOILER_MARGIN_DEG,
    maxLat: Math.max(...usual.map((entry) => entry.lat + entry.island.bounds.maxLat)) + SPOILER_MARGIN_DEG,
    minLon: Math.min(...usual.map((entry) => entry.lon + entry.island.bounds.minLon)) - SPOILER_MARGIN_DEG,
    maxLon: Math.max(...usual.map((entry) => entry.lon + entry.island.bounds.maxLon)) + SPOILER_MARGIN_DEG
  } : null;
  // A Scrambled Seas chart always shows the whole world, so with spoilers off the heat near its secret islands
  // is left out instead.
  const secrets = !spoilers && options.bounds ? options.islands.filter((entry) => entry.secret) : [];
  const inside = (lat, lon) => (!limit || (lat >= limit.minLat && lat <= limit.maxLat && lon >= limit.minLon && lon <= limit.maxLon))
    && !secrets.some((entry) => Math.hypot(entry.lat - lat, entry.lon - lon) < SECRET_RADIUS_DEG);
  const cells = Object.entries(heatmap.cells).map(([key, count]) => {
    const [row, column] = key.split(",").map(Number);
    return { key, lat: row * cellDegrees, lon: column * cellDegrees, count };
  }).filter((cell) => inside(cell.lat + cellDegrees / 2, cell.lon + cellDegrees / 2));
  const countByCell = new Map(cells.map((cell) => [cell.key, cell.count]));
  const max = Math.max(1, ...cells.map((cell) => cell.count));
  const shownFlags = (list) => (list ?? []).filter((flag) => spoilers || !flag.secret);
  let flags = shownFlags(options.flags);

  // The whole chart: the world's edges, or everything there is to see.
  const extent = options.bounds ?? limit ?? (() => {
    const lats = [...islands.flatMap((e) => [e.lat + e.island.bounds.minLat, e.lat + e.island.bounds.maxLat]), ...cells.flatMap((c) => [c.lat, c.lat + cellDegrees]), ...flags.map((f) => f.lat)];
    const lons = [...islands.flatMap((e) => [e.lon + e.island.bounds.minLon, e.lon + e.island.bounds.maxLon]), ...cells.flatMap((c) => [c.lon, c.lon + cellDegrees]), ...flags.map((f) => f.lon)];
    if (!lats.length) return { minLat: 0, maxLat: 1, minLon: 0, maxLon: 1 };
    return { minLat: Math.min(...lats) - 0.5, maxLat: Math.max(...lats) + 0.5, minLon: Math.min(...lons) - 0.5, maxLon: Math.max(...lons) + 0.5 };
  })();

  const canvas = element("canvas", { className: "heatmap", tabIndex: 0 });
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `Heatmap of where ${unit[1]} sailed. Scroll or use the buttons to zoom and drag to move around.`);
  const tooltip = element("div", { className: "chart-tooltip", hidden: true });
  tooltip.setAttribute("role", "status");
  const button = (text, label, action) => {
    const node = element("button", { type: "button", textContent: text, title: label });
    node.setAttribute("aria-label", label);
    node.addEventListener("click", action);
    return node;
  };
  const controls = element("div", { className: "chart-controls" },
    button("+", "Zoom in", () => zoomBy(1.6)),
    button("−", "Zoom out", () => zoomBy(1 / 1.6)),
    button("⤢", "Show the whole chart", () => { view = { zoom: 1, lat: centre.lat, lon: centre.lon }; schedule(); }));
  const compass = element("img", { className: "chart-compass", src: "assets/chartroom-icon.png", alt: "" });
  const hint = element("div", { className: "chart-hint", hidden: true, textContent: "Click the chart, then scroll to zoom" });
  const legend = element("div", { className: "chart-legend" }, element("span", { textContent: "Cold" }), element("i"), element("span", { textContent: "Hot" }));
  frame.replaceChildren(canvas, controls, compass, ...(cells.length ? [legend] : []), hint, tooltip);

  const centre = { lat: (extent.minLat + extent.maxLat) / 2, lon: (extent.minLon + extent.maxLon) / 2 };
  let view = { zoom: 1, lat: centre.lat, lon: centre.lon };
  let geometry = null;
  let frameRequest = 0;

  function render() {
    frameRequest = 0;
    const cssWidth = Math.max(280, Math.round(frame.clientWidth || 900));
    const cssHeight = Math.max(200, Math.round(cssWidth * (cssWidth < 520 ? 0.9 : 0.58)));
    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const style = getComputedStyle(document.documentElement);
    const colour = (name) => style.getPropertyValue(name).trim();
    const compact = cssWidth < 520;
    const pad = { left: compact ? 30 : 44, right: 12, top: 12, bottom: compact ? 24 : 30 };
    const width = cssWidth - pad.left - pad.right;
    const height = cssHeight - pad.top - pad.bottom;
    const fitScale = Math.min(width / (extent.maxLon - extent.minLon), height / (extent.maxLat - extent.minLat));
    const scale = fitScale * view.zoom;
    const x = (lon) => pad.left + width / 2 + (lon - view.lon) * scale;
    const y = (lat) => pad.top + height / 2 - (lat - view.lat) * scale;
    const lonAt = (px) => view.lon + (px - pad.left - width / 2) / scale;
    const latAt = (py) => view.lat - (py - pad.top - height / 2) / scale;
    geometry = { cssWidth, cssHeight, pad, width, height, scale, lonAt, latAt, x, y };

    const sea = context.createLinearGradient(0, pad.top, 0, pad.top + height);
    sea.addColorStop(0, colour("--chart-sea"));
    sea.addColorStop(1, colour("--chart-sea-deep"));
    context.fillStyle = sea;
    context.fillRect(0, 0, cssWidth, cssHeight);
    context.save();
    context.beginPath();
    context.rect(pad.left, pad.top, width, height);
    context.clip();

    // Graticule.
    const view0 = { minLon: lonAt(pad.left), maxLon: lonAt(pad.left + width), minLat: latAt(pad.top + height), maxLat: latAt(pad.top) };
    const lonStep = niceStep(view0.maxLon - view0.minLon);
    const latStep = niceStep(view0.maxLat - view0.minLat);
    context.strokeStyle = colour("--chart-grid");
    context.globalAlpha = 0.3;
    context.lineWidth = 0.65;
    context.setLineDash([2, 4]);
    for (let lon = Math.ceil(view0.minLon / lonStep) * lonStep; lon <= view0.maxLon; lon += lonStep) {
      context.beginPath(); context.moveTo(x(lon), pad.top); context.lineTo(x(lon), pad.top + height); context.stroke();
    }
    for (let lat = Math.ceil(view0.minLat / latStep) * latStep; lat <= view0.maxLat; lat += latStep) {
      context.beginPath(); context.moveTo(pad.left, y(lat)); context.lineTo(pad.left + width, y(lat)); context.stroke();
    }
    context.setLineDash([]);
    context.globalAlpha = 1;

    // Islands.
    const landPaths = [];
    for (const { island, lat, lon } of islands) {
      for (const shape of island.shapes) {
        if (shape.kind !== 0) continue;
        const path = new Path2D();
        for (const ring of shape.rings) {
          for (let index = 0; index < ring.length; index += 2) {
            const px = x(lon + ring[index]);
            const py = y(lat + ring[index + 1]);
            if (index) path.lineTo(px, py); else path.moveTo(px, py);
          }
          path.closePath();
        }
        landPaths.push(path);
        context.strokeStyle = colour("--chart-waterline");
        context.lineWidth = compact ? 3 : 4.5;
        context.stroke(path);
        context.fillStyle = colour("--chart-land");
        context.fill(path, "evenodd");
        context.strokeStyle = colour("--chart-coast");
        context.lineWidth = 0.9;
        context.stroke(path);
      }
      const size = Math.max(island.bounds.maxLon - island.bounds.minLon, island.bounds.maxLat - island.bounds.minLat) * scale;
      if (size < 2) {
        context.fillStyle = colour("--chart-coast");
        context.beginPath();
        context.arc(x(lon), y(lat), 1.3, 0, Math.PI * 2);
        context.fill();
      }
    }

    // Heat: a smooth density field. Each cell spreads a Gaussian over a field a third of the chart's size, scaled so
    // a lane one voyage sailed comes out near 1 and n voyages near n. Colour then runs cold to hot with how many
    // voyages passed (one is cold, the busiest hot), the edges fade out, and the field is drawn up to size with
    // smoothing, so lanes blend into each other instead of reading as dots.
    if (cells.length) {
      const factor = 3;
      const fieldWidth = Math.ceil(cssWidth / factor);
      const fieldHeight = Math.ceil(cssHeight / factor);
      const field = new Float32Array(fieldWidth * fieldHeight);
      const spacing = cellDegrees * scale / factor;
      const sigma = Math.max(compact ? 1.8 : 2.3, spacing * 1.1);
      const reach = Math.ceil(sigma * 3);
      const size = reach * 2 + 1;
      const kernel = new Float32Array(size * size);
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) kernel[(dy + reach) * size + dx + reach] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      }
      // What a straight lane of one voyage adds up to, so the field reads in voyages.
      const lane = Math.max(1, Math.sqrt(2 * Math.PI) * sigma / Math.max(spacing, 1e-6));
      for (const cell of cells) {
        const cx = Math.round(x(cell.lon + cellDegrees / 2) / factor);
        const cy = Math.round(y(cell.lat + cellDegrees / 2) / factor);
        if (cx < -reach || cy < -reach || cx >= fieldWidth + reach || cy >= fieldHeight + reach) continue;
        const weight = cell.count / lane;
        for (let dy = -reach; dy <= reach; dy++) {
          const row = cy + dy;
          if (row < 0 || row >= fieldHeight) continue;
          const kernelRow = (dy + reach) * size + reach;
          const fieldRow = row * fieldWidth;
          for (let dx = -reach; dx <= reach; dx++) {
            const column = cx + dx;
            if (column >= 0 && column < fieldWidth) field[fieldRow + column] += weight * kernel[kernelRow + dx];
          }
        }
      }
      const ramp = heatRamp(style);
      const logMax = Math.log(Math.max(2, max));
      const small = document.createElement("canvas");
      small.width = fieldWidth;
      small.height = fieldHeight;
      const smallContext = small.getContext("2d");
      const image = smallContext.createImageData(fieldWidth, fieldHeight);
      for (let index = 0; index < field.length; index++) {
        const value = field[index];
        if (value < 0.03) continue;
        const heat = max > 1 ? Math.min(1, Math.log(Math.max(1, value)) / logMax) : 0;
        const tint = ramp[Math.round(heat * 255)];
        const edge = Math.min(1, value / 0.85);
        image.data[index * 4] = tint[0];
        image.data[index * 4 + 1] = tint[1];
        image.data[index * 4 + 2] = tint[2];
        image.data[index * 4 + 3] = Math.round(225 * edge * edge * (3 - 2 * edge));
      }
      smallContext.putImageData(image, 0, 0);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(small, 0, 0, fieldWidth * factor, fieldHeight * factor);
      context.strokeStyle = colour("--chart-coast");
      context.lineWidth = 0.9;
      for (const path of landPaths) context.stroke(path);
    }

    // Race flags: green start, gold checkpoints, red finish.
    for (const flag of flags) drawFlag(context, x(flag.lon), y(flag.lat), flag.kind, colour(`--flag-${flag.kind}`), colour("--chart-coast"), colour("--chart-sea"));
    context.restore();

    context.strokeStyle = colour("--chart-rule");
    context.lineWidth = 1;
    context.strokeRect(pad.left + 0.5, pad.top + 0.5, width - 1, height - 1);
    context.fillStyle = colour("--chart-label");
    context.font = `${compact ? 9 : 11}px "Architects Daughter", system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "top";
    for (let lon = Math.ceil(view0.minLon / lonStep) * lonStep; lon <= view0.maxLon; lon += lonStep) {
      if (x(lon) > pad.left + 14 && x(lon) < pad.left + width - 14) context.fillText(degreeLabel(lon, "lon", lonStep), x(lon), pad.top + height + 6);
    }
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (let lat = Math.ceil(view0.minLat / latStep) * latStep; lat <= view0.maxLat; lat += latStep) {
      if (y(lat) > pad.top + 8 && y(lat) < pad.top + height - 8) context.fillText(degreeLabel(lat, "lat", latStep), pad.left - 5, y(lat));
    }
    canvas.style.touchAction = view.zoom > 1 || options.onPick ? "none" : "pan-y";
  }

  function schedule() {
    if (!frameRequest) frameRequest = requestAnimationFrame(render);
  }

  // Keeps the chart's centre within the whole chart, so it can't be dragged away.
  function clampView() {
    view.zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom));
    view.lat = Math.min(extent.maxLat, Math.max(extent.minLat, view.lat));
    view.lon = Math.min(extent.maxLon, Math.max(extent.minLon, view.lon));
  }

  // Zooms by factor, keeping the place under (px, py) still, or the middle.
  function zoomBy(factor, px, py) {
    if (!geometry) return;
    const g = geometry;
    const atX = px ?? g.pad.left + g.width / 2;
    const atY = py ?? g.pad.top + g.height / 2;
    const lon = g.lonAt(atX);
    const lat = g.latAt(atY);
    const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom * factor));
    const scale = g.scale / view.zoom * zoom;
    view = { zoom, lon: lon - (atX - g.pad.left - g.width / 2) / scale, lat: lat + (atY - g.pad.top - g.height / 2) / scale };
    clampView();
    schedule();
  }

  function local(event) {
    const bounds = canvas.getBoundingClientRect();
    return { px: (event.clientX - bounds.left) * geometry.cssWidth / bounds.width, py: (event.clientY - bounds.top) * geometry.cssHeight / bounds.height };
  }

  function showTooltip(event) {
    if (!geometry) return;
    const { px, py } = local(event);
    const g = geometry;
    const flag = flags.find((candidate) => Math.hypot(g.x(candidate.lon) - px, g.y(candidate.lat) - 6 - py) < FLAG_HIT_PX);
    let text = flag?.label ?? "";
    if (!text) {
      const lon = g.lonAt(px);
      const lat = g.latAt(py);
      const count = countByCell.get(`${Math.floor(lat / cellDegrees)},${Math.floor(lon / cellDegrees)}`);
      if (count) text = `${count} ${count === 1 ? unit[0] : unit[1]}`;
    }
    tooltip.hidden = !text;
    if (!text) return;
    tooltip.textContent = text;
    tooltip.style.left = `${Math.max(50, Math.min(g.cssWidth - 50, px))}px`;
    tooltip.style.top = `${Math.max(30, py)}px`;
  }

  // The island under a click: on its land, or within a few pixels of one too small to hit, so a click in a bay
  // or a lagoon is still open water.
  function pick(event) {
    const { px, py } = local(event);
    const g = geometry;
    const lat = g.latAt(py);
    const lon = g.lonAt(px);
    const near = 6 / g.scale;
    const hit = (entry) => {
      const { island, lat: at, lon: on } = entry;
      const size = Math.max(island.bounds.maxLon - island.bounds.minLon, island.bounds.maxLat - island.bounds.minLat) * g.scale;
      if (size < 14) return Math.hypot(lat - at, lon - on) <= near + size / g.scale / 2;
      return island.shapes.some((shape) => shape.kind === 0 && insideRings(shape.rings, lon - on, lat - at));
    };
    const island = islands.filter(hit).sort((a, b) => Math.hypot(a.lat - lat, a.lon - lon) - Math.hypot(b.lat - lat, b.lon - lon))[0] ?? null;
    options.onPick({ lat, lon, island });
  }

  let drag = null;
  let hintTimer = 0;
  const listeners = {
    // The page scrolls past the chart until it's clicked; then the wheel zooms. Ctrl and the wheel always zoom.
    wheel: (event) => {
      if (document.activeElement !== canvas && !event.ctrlKey) {
        hint.hidden = false;
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => { hint.hidden = true; }, 1600);
        return;
      }
      event.preventDefault();
      const { px, py } = local(event);
      zoomBy(Math.exp(-event.deltaY * 0.0015), px, py);
    },
    pointerdown: (event) => {
      if (event.button !== 0) return;
      if (event.pointerType === "touch" && view.zoom <= 1 && !options.onPick) { showTooltip(event); return; }
      canvas.focus({ preventScroll: true });
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, lat: view.lat, lon: view.lon };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add("dragging");
    },
    pointermove: (event) => {
      if (drag?.id === event.pointerId) {
        const bounds = canvas.getBoundingClientRect();
        const ratio = geometry.cssWidth / bounds.width;
        view.lon = drag.lon - (event.clientX - drag.x) * ratio / geometry.scale;
        view.lat = drag.lat + (event.clientY - drag.y) * ratio / geometry.scale;
        clampView();
        tooltip.hidden = true;
        schedule();
      } else if (event.pointerType !== "touch") showTooltip(event);
    },
    pointerup: (event) => {
      if (drag?.id !== event.pointerId) return;
      const moved = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
      drag = null;
      canvas.classList.remove("dragging");
      if (options.onPick && event.type === "pointerup" && moved < 5) pick(event);
    },
    pointerleave: () => { tooltip.hidden = true; },
    dblclick: (event) => {
      if (options.onPick) return;
      const { px, py } = local(event);
      zoomBy(2, px, py);
    },
    keydown: (event) => {
      const moves = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [1, 0], ArrowDown: [-1, 0] };
      if (event.key === "+" || event.key === "=") zoomBy(1.6);
      else if (event.key === "-") zoomBy(1 / 1.6);
      else if (moves[event.key]) {
        const step = 60 / geometry.scale;
        view.lat += moves[event.key][0] * step;
        view.lon += moves[event.key][1] * step;
        clampView();
        schedule();
      } else return;
      event.preventDefault();
    }
  };
  canvas.addEventListener("wheel", listeners.wheel, { passive: false });
  for (const name of ["pointerdown", "pointermove", "pointerup", "pointerleave", "dblclick", "keydown"]) canvas.addEventListener(name, listeners[name]);
  canvas.addEventListener("pointercancel", listeners.pointerup);

  const observer = new ResizeObserver(schedule);
  observer.observe(frame);
  // The page's style or light and dark mode changed.
  window.addEventListener("voyages-view", schedule);
  render();

  const dispose = () => {
    if (frameRequest) cancelAnimationFrame(frameRequest);
    clearTimeout(hintTimer);
    observer.disconnect();
    window.removeEventListener("voyages-view", schedule);
  };
  dispose.setFlags = (list) => {
    flags = shownFlags(list);
    schedule();
  };
  return dispose;
}

// Whether a point is on land: inside an odd number of the shape's rings, each [x0, y0, x1, y1, ...].
function insideRings(rings, x, y) {
  let inside = false;
  for (const ring of rings) {
    for (let index = 0, previous = ring.length - 2; index < ring.length; previous = index, index += 2) {
      const [xi, yi, xj, yj] = [ring[index], ring[index + 1], ring[previous], ring[previous + 1]];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// 256 colours from cold to hot through the theme's heat stops, eased so each blends into the next.
function heatRamp(style) {
  const stops = ["--heat-1-rgb", "--heat-2-rgb", "--heat-3-rgb", "--heat-4-rgb"].map((name) => cssRgb(style, name));
  return Array.from({ length: 256 }, (_, index) => {
    const value = index / 255 * (stops.length - 1);
    const step = Math.min(stops.length - 2, Math.floor(value));
    const t = value - step;
    return mix(stops[step], stops[step + 1], t * t * (3 - 2 * t));
  });
}

// The same shapes as Chartroom's race flags, so they differ without colour too: a plain flag starts, a
// pennant marks a checkpoint and a chequered flag finishes.
function drawFlag(context, x, y, kind, fill, ink, paper) {
  context.save();
  context.strokeStyle = ink;
  context.lineWidth = 1.4;
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x, y - 15);
  context.stroke();
  context.fillStyle = fill;
  context.beginPath();
  if (kind === "checkpoint") {
    context.moveTo(x, y - 15);
    context.lineTo(x + 10, y - 11.5);
    context.lineTo(x, y - 8);
    context.closePath();
  } else context.rect(x, y - 15, 10, 7);
  context.fill();
  if (kind === "finish") {
    context.fillStyle = paper;
    for (let column = 0; column < 3; column += 1) {
      for (let row = 0; row < 2; row += 1) if ((column + row) % 2) context.fillRect(x + column * 10 / 3, y - 15 + row * 3.5, 10 / 3, 3.5);
    }
  }
  context.lineWidth = 0.8;
  context.stroke();
  context.fillStyle = ink;
  context.beginPath();
  context.arc(x, y, 1.8, 0, Math.PI * 2);
  context.fill();
  context.restore();
}
