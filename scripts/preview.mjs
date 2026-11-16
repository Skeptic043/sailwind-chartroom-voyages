// Serves the site on this computer to look at before publishing: node scripts/preview.mjs [--demo] [port].
// --demo serves a temporary copy filled with a few made-up voyages and race runs, so the pages have something
// to show; the repository itself is never changed. Open http://localhost:8765 once it says it's ready.
import { createServer } from "node:http";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const demo = process.argv.includes("--demo");
const port = Number(process.argv.find((argument) => /^\d+$/.test(argument)) ?? 8765);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".md": "text/plain; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".ttf": "font/ttf" };

async function demoCopy() {
  const folder = await mkdtemp(join(tmpdir(), "chartroom-voyages-preview-"));
  await cp(repository, folder, { recursive: true, filter: (source) => !/[\\/](node_modules|\.git|\.local)([\\/]|$)/.test(source) });
  process.env.VOYAGES_ROOT = folder;
  const { handle } = await import("./submit.mjs");
  const { buildData } = await import("./build-data.mjs");
  const { islandById } = await import("../lib/islands.mjs");
  // Hourly readings sailing between the given islands, with real time passing 125 seconds a game hour.
  const voyage = (ids, game, start = 100, knots = 12) => {
    const stops = ids.map(islandById);
    const points = [];
    let t = start;
    for (let index = 0; index < stops.length - 1; index++) {
      const from = stops[index];
      const to = stops[index + 1];
      const steps = Math.max(2, Math.round(Math.hypot(to.lat - from.lat, to.lon - from.lon) * 140 / knots));
      for (let step = 0; step < steps; step++) {
        const share = step / steps;
        points.push({ t, lat: from.lat + (to.lat - from.lat) * share + Math.sin(share * Math.PI) * 0.15, lon: from.lon + (to.lon - from.lon) * share, boat: "Brig", windFrom: 70 + step % 30, windKnots: 8 + step % 5, utc: 1794700000 + t * 125 });
        t += 1;
      }
    }
    const last = stops.at(-1);
    points.push({ t, lat: last.lat, lon: last.lon, boat: "Brig", utc: 1794700000 + t * 125 });
    return { format: "sailwind-voyage", version: 1, name: stops.map((stop) => stop.name).join(" to "), world: { kind: "vanilla" }, game, plugins: [{ guid: "com.skeptic043.sailwind.voyagerecorder", name: "Voyage Recorder", version: "0.2.2" }], points };
  };
  const form = (fields) => Object.entries(fields).map(([label, value]) => `### ${label}\n\n${value}`).join("\n\n");
  const pasted = (file) => "```json\n" + JSON.stringify(file) + "\n```";
  const shipyards = ["firefish/kicia_bay", "alankh/gold_rock_city", "aestrin/fort_aestrin", "emerald/dragon_cliffs"];
  const submissions = [
    { labels: ["share-voyage"], body: form({ "Voyage file": pasted(voyage(["alankh/gold_rock_city", "alankh/neverdin", "alankh/alnilem"], "1111111111111111")) }), submitter: "sailorA" },
    { labels: ["share-voyage"], body: form({ "Voyage file": pasted(voyage(["alankh/gold_rock_city", "aestrin/fort_aestrin"], "2222222222222222")) }), submitter: "sailorB" },
    { labels: ["share-voyage"], body: form({ "Voyage file": pasted(voyage(["aestrin/fort_aestrin", "chronos/chronos"], "5555555555555555")) }), submitter: "explorer" },
    { labels: ["enter-race"], body: form({ "Course id": "shipyard-tour", "Voyage file": pasted(voyage(shipyards, "3333333333333333", 100, 14)), Heatmap: "- [X] Also count this voyage towards the world's heatmap" }), submitter: "racer" },
    { labels: ["enter-race"], body: form({ "Course id": "shipyard-tour", "Voyage file": pasted(voyage(shipyards, "4444444444444444", 300, 10)) }), submitter: "slowboat" }
  ];
  for (const [index, submission] of submissions.entries()) await handle({ number: index + 1, ...submission });
  await buildData();
  return folder;
}

const demoFolder = demo ? await demoCopy() : null;
// The demo's submissions and built data come from its copy; the pages and code always come from the repository,
// so edits show on reload.
const DEMO_DATA = /^(data|voyages|runs|worlds|courses)[\\/]/;
const rootFor = (path) => demoFolder && DEMO_DATA.test(path) ? demoFolder : repository;
createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://localhost").pathname)).replace(/^[\\/]+/, "");
  if (path.startsWith("..")) return response.writeHead(403).end();
  const file = path && !path.endsWith("/") && !path.endsWith("\\") ? path : join(path, "index.html");
  try {
    const body = await readFile(join(rootFor(file), file));
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Chartroom Voyages${demo ? " (demo data)" : ""} is ready at http://localhost:${port}`));
