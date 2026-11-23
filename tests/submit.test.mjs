import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formFields, handle, voyageFromField } from "../scripts/submit.mjs";
import { buildData } from "../scripts/build-data.mjs";
import { islandById } from "../lib/islands.mjs";

const courses = fileURLToPath(new URL("../courses/", import.meta.url));

async function scratch() {
  const folder = await mkdtemp(join(tmpdir(), "chartroom-voyages-"));
  await cp(courses, join(folder, "courses"), { recursive: true });
  process.env.VOYAGES_ROOT = folder;
  return folder;
}

function voyageFile(stops, { game = "0123456789abcdef", world = { kind: "vanilla" }, start = 100 } = {}) {
  const points = [];
  let t = start;
  stops.forEach((stop, index) => {
    points.push({ t, lat: stop.lat, lon: stop.lon, boat: "Brig", windKnots: 9, utc: 5000 + t * 125 });
    t += 1;
    if (index < stops.length - 1) {
      points.push({ t, lat: (stop.lat + stops[index + 1].lat) / 2 + 0.6, lon: (stop.lon + stops[index + 1].lon) / 2, boat: "Brig", utc: 5000 + t * 125 });
      t += 1;
    }
  });
  return { format: "sailwind-voyage", version: 1, name: "Test", world, game, plugins: [{ guid: "com.skeptic043.sailwind.voyagerecorder", name: "Voyage Recorder", version: "0.2.0" }], points };
}

const form = (fields) => Object.entries(fields).map(([label, value]) => `### ${label}\n\n${value}`).join("\n\n");
const pasted = (file) => `\`\`\`json\n${JSON.stringify(file)}\n\`\`\``;

test("issue form fields are read, and attachments are only fetched from GitHub's links", async () => {
  assert.deepEqual(formFields("### Course id\n\nshipyard-tour\n\n### Heatmap\n\n_No response_"), { "Course id": "shipyard-tour", Heatmap: "" });
  const file = voyageFile([islandById("alankh/gold_rock_city"), islandById("alankh/neverdin")]);
  let fetched = "";
  const voyage = await voyageFromField("[my.voyage.json](https://github.com/user-attachments/files/123/my.voyage.json)", { fetchFile: async (url) => { fetched = url; return JSON.stringify(file); } });
  assert.equal(fetched, "https://github.com/user-attachments/files/123/my.voyage.json");
  assert.equal(voyage.points.length, 3);
  await assert.rejects(voyageFromField("https://example.com/files/1/x.json", { fetchFile: async () => { throw new Error("should not fetch"); } }), /valid JSON/);
  await assert.rejects(voyageFromField(""), /No file was attached/);
});

test("a shared voyage joins its world, once", async () => {
  const folder = await scratch();
  try {
    const file = voyageFile([islandById("alankh/gold_rock_city"), islandById("alankh/neverdin")]);
    const message = await handle({ number: 7, labels: ["share-voyage"], body: form({ "Voyage file": pasted(file) }), submitter: "sailor" });
    assert.match(message, /#world\/vanilla/);
    assert.deepEqual(await readdir(join(folder, "voyages", "vanilla")), ["7.json"]);
    // A stored voyage is still a voyage file, so its download opens in Chartroom.
    const stored = JSON.parse(await readFile(join(folder, "voyages", "vanilla", "7.json"), "utf8"));
    assert.deepEqual([stored.format, stored.version, stored.submitter], ["sailwind-voyage", 1, "sailor"]);
    await assert.rejects(handle({ number: 8, labels: ["share-voyage"], body: form({ "Voyage file": pasted(file) }), submitter: "sailor" }), /already been published/);
    await assert.rejects(handle({ number: 9, labels: ["share-voyage"], body: form({ "Voyage file": pasted({ ...file, world: { kind: "unknown" }, game: "fedcba9876543210" }) }), submitter: "sailor" }), /which world/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("race entries are checked against the course and ranked on its board", async () => {
  const folder = await scratch();
  try {
    const ports = ["firefish/kicia_bay", "alankh/gold_rock_city", "aestrin/fort_aestrin", "emerald/dragon_cliffs"].map(islandById);
    const fast = voyageFile(ports, { game: "1111111111111111" });
    // A detour out to sea between Fort Aestrin and Dragon Cliffs adds two hours.
    const slow = voyageFile([ports[0], ports[1], ports[2], { lat: 20, lon: -20 }, ports[3]], { game: "2222222222222222" });
    const entry = (number, file, heatmap = "") => handle({ number, labels: ["enter-race"], body: form({ "Course id": "shipyard-tour", "Voyage file": pasted(file), Heatmap: heatmap }), submitter: `p${number}` });
    assert.match(await entry(10, slow), /Accepted/);
    assert.match(await entry(11, fast, "- [x] Also count toward the world's heatmap"), /Accepted: 5h 00m/);
    await assert.rejects(entry(12, voyageFile(ports.slice(0, 2), { game: "3333333333333333" })), /doesn't reach/);
    await assert.rejects(handle({ number: 13, labels: ["enter-race"], body: form({ "Course id": "nope", "Voyage file": pasted(fast) }), submitter: "x" }), /no course/);
    await buildData();
    const board = JSON.parse(await readFile(join(folder, "data", "boards", "shipyard-tour.json"), "utf8"));
    assert.deepEqual(board.runs.map((run) => run.submitter), ["p11", "p10"]);
    assert.equal(board.runs[0].rank, 1);
    // The course map shows where both runs went.
    assert.equal(board.heatmap.voyages, 2);
    const run = JSON.parse(await readFile(join(folder, "runs", "shipyard-tour", "11.json"), "utf8"));
    assert.equal(run.voyage.format, "sailwind-voyage");
    const worlds = JSON.parse(await readFile(join(folder, "data", "worlds.json"), "utf8"));
    assert.equal(worlds[0].key, "vanilla");
    assert.equal(worlds[0].voyages, 1, "only the entry that asked counts toward the heatmap");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("players create courses and feature worlds", async () => {
  const folder = await scratch();
  try {
    const course = { id: "neverdin-dash", name: "Neverdin dash", world: "vanilla", start: { island: "alankh/gold_rock_city" }, checkpoints: [{ island: "alankh/neverdin" }], finish: { lastCheckpoint: true }, rules: { mods: { mode: "only" } } };
    assert.match(await handle({ number: 20, labels: ["create-course"], body: form({ Race: pasted(course) }), submitter: "maker" }), /race is live/);
    const saved = JSON.parse(await readFile(join(folder, "courses", "neverdin-dash.json"), "utf8"));
    assert.equal(saved.author, "maker");
    await assert.rejects(handle({ number: 21, labels: ["create-course"], body: form({ Course: pasted(course) }), submitter: "maker" }), /already exists/);
    const link = "https://skeptic043.github.io/scrambled-seas-world-generator/#v=1&lo1=-20&lo2=40&la1=20&la2=50&ws=1.4&cx=10&cy=35&as=1.5&is=1.3&isp=1.3&seed=-77";
    assert.match(await handle({ number: 22, labels: ["feature-world"], body: form({ Name: "Wide sea", Description: "Lots of room", World: link }), submitter: "maker" }), /now published/);
    await buildData();
    const worlds = JSON.parse(await readFile(join(folder, "data", "worlds.json"), "utf8"));
    const wide = worlds.find((world) => world.name === "Wide sea");
    assert.ok(wide.generatorLink.endsWith("seed=-77"));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("bot replies show submitted text as plain text, and courses need a known world", async () => {
  const { plain } = await import("../scripts/submit.mjs");
  assert.equal(plain("Legit](https://evil.example) [click @user\nnow"), "Legit\\]\\(https://evil.example\\) \\[click @​user now");
  const folder = await scratch();
  try {
    const course = { id: "far-away", name: "Far away", world: "ss-0123456789abcdef", start: { lat: 1, lon: 1, radiusNm: 2 }, checkpoints: [{ lat: 2, lon: 2, radiusNm: 2 }], finish: { lastCheckpoint: true } };
    await assert.rejects(handle({ number: 20, labels: ["create-course"], body: form({ Course: pasted(course) }), submitter: "x" }), /isn't on the site yet/);
    // A race from Chartroom carries its world's settings, and its world is published with it.
    const { worldKey } = await import("../lib/world.mjs");
    const settings = { kind: "scrambled", seed: -77, islandSpread: 6500, minArchipelagoSeparation: 45000, minIslandSeparation: 1950, lonMin: -20, lonMax: 40, latMin: 20, latMax: 50, borderExpander: 1, scrambler: 60 };
    const withWorld = { ...course, id: "new-world-race", world: worldKey(settings), worldSettings: settings };
    assert.match(await handle({ number: 21, labels: ["create-course"], body: form({ Race: pasted(withWorld) }), submitter: "x" }), /race is live/);
    const published = JSON.parse(await readFile(join(folder, "worlds", `${worldKey(settings)}.json`), "utf8"));
    assert.equal(published.name, "Scrambled Seas seed -77");
    assert.equal(JSON.parse(await readFile(join(folder, "courses", "new-world-race.json"), "utf8")).worldSettings, undefined);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("runs from older recordings are entered with notes and listed after the real-time ranking", async () => {
  const folder = await scratch();
  try {
    const ports = ["firefish/kicia_bay", "alankh/gold_rock_city", "aestrin/fort_aestrin", "emerald/dragon_cliffs"].map(islandById);
    // Voyage Recorder before 0.2.2: no world, no real time and no mod list.
    const { plugins, world, ...old } = voyageFile(ports, { game: "" });
    old.points = old.points.map(({ utc, ...point }) => point);
    const timed = voyageFile(ports, { game: "4444444444444444", start: 400 });
    const course = { id: "timed-tour", name: "Timed tour", world: "vanilla", start: { any: true }, checkpoints: ports.map((port) => ({ island: port.id })), finish: { lastCheckpoint: true }, rules: { sortBy: "irl", mods: { mode: "only", plugins: [] } } };
    await handle({ number: 20, labels: ["create-course"], body: form({ Course: pasted(course) }), submitter: "host" });
    const entry = (number, file) => handle({ number, labels: ["enter-race"], body: form({ "Course id": "timed-tour", "Voyage file": pasted(file) }), submitter: `p${number}` });
    assert.match(await handle({ number: 21, labels: ["enter-race"], body: form({ "Course id": "timed-tour", "Voyage file": pasted(old), Heatmap: "- [x] Also count toward the world's heatmap" }), submitter: "p21" }), /Accepted.*wasn't added to the heatmap/);
    // Without a game id, the same file sent again is still caught.
    await assert.rejects(entry(24, old), /already been entered/);
    assert.match(await entry(22, timed), /Accepted/);
    await assert.rejects(entry(23, voyageFile(ports, { game: "5555555555555555", world: { kind: "scrambled", seed: 1, islandSpread: 10000, minArchipelagoSeparation: 30000, minIslandSeparation: 2000, lonMin: -12, lonMax: 32, latMin: 26, latMax: 46, borderExpander: 0, scrambler: 60 } })), /different world/);
    const run = JSON.parse(await readFile(join(folder, "runs", "timed-tour", "21.json"), "utf8"));
    assert.deepEqual(run.notes, ["world-not-recorded", "mods-not-recorded", "no-real-time"]);
    assert.equal(run.voyage.world.kind, "unknown");
    await buildData();
    const board = JSON.parse(await readFile(join(folder, "data", "boards", "timed-tour.json"), "utf8"));
    assert.deepEqual(board.runs.map((entry) => [entry.submitter, entry.rank]), [["p22", 1], ["p21", null]]);
    assert.deepEqual(board.runs[1].notes, ["world-not-recorded", "mods-not-recorded", "no-real-time"]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
