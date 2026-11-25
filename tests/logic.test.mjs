import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findIslands, islandAt, islandById, matchIslandName } from "../lib/islands.mjs";
import { checkRun, checkMods } from "../lib/race.mjs";
import { validateCourse } from "../lib/course.mjs";
import { buildHeatmap } from "../lib/heatmap.mjs";
import { generatorLink, scrambledIslands, worldFromGeneratorLink, worldFromXml, worldKey } from "../lib/world.mjs";
import { overlaps, parseVoyage } from "../lib/voyage.mjs";

const course = async (id) => validateCourse(JSON.parse(await readFile(new URL(`../courses/${id}.json`, import.meta.url), "utf8")));
const at = (id) => islandById(id);

// A voyage that sails from place to place, one reading an hour, with real time ticking 125 s a game hour.
function voyage(stops, { boat = "Brig", plugins = [], hull = 0, wind = 10 } = {}) {
  const points = [];
  let t = 100;
  for (let index = 0; index < stops.length - 1; index++) {
    const from = stops[index];
    const to = stops[index + 1];
    // A reading at each stop, then far out to sea between them, so every stop is a fresh arrival.
    points.push({ t, lat: from.lat, lon: from.lon, boat, hull, windKnots: wind, utc: 1000 + (t - 100) * 125 });
    t += 1;
    points.push({ t, lat: (from.lat + to.lat) / 2 + 0.6, lon: (from.lon + to.lon) / 2, boat, hull, windKnots: wind, utc: 1000 + (t - 100) * 125 });
    t += 1;
  }
  const last = stops.at(-1);
  points.push({ t, lat: last.lat, lon: last.lon, boat, hull, windKnots: wind, utc: 1000 + (t - 100) * 125 });
  return parseVoyage({ format: "sailwind-voyage", version: 1, world: { kind: "vanilla" }, game: "0123456789abcdef", plugins, points });
}

test("the shipyard tour starts at any shipyard and ends at the last one reached", async () => {
  const tour = await course("shipyard-tour");
  const ports = ["firefish/kicia_bay", "alankh/gold_rock_city", "aestrin/fort_aestrin", "emerald/dragon_cliffs"].map(at);
  const run = checkRun(tour, voyage(ports));
  assert.equal(run.ok, true, run.reason);
  assert.equal(run.startedFrom, "Kicia Bay");
  assert.equal(run.gameHours, 5);
  assert.equal(run.irlSeconds, 5 * 125);
  assert.deepEqual(run.splits.map((split) => split.name), ["Gold Rock City", "Fort Aestrin", "Dragon Cliffs"]);
  assert.equal(run.boat, "Brig");
  assert.equal(run.windKnots, 10);
  const short = checkRun(tour, voyage(ports.slice(0, 3)));
  assert.equal(short.ok, false);
  assert.match(short.reason, /Dragon Cliffs/);
});

test("an archipelago tour returns to its capital and leaves out secret islands", async () => {
  const tour = await course("aestrin-tour");
  const capital = at("aestrin/fort_aestrin");
  const islands = tour.checkpoints.map((checkpoint) => at(checkpoint.island));
  const run = checkRun(tour, voyage([capital, ...islands, capital]));
  assert.equal(run.ok, true, run.reason);
  // The clock starts on leaving the capital, an hour after the first reading there.
  assert.equal(run.gameHours, (islands.length + 1) * 2 - 1);
  const noReturn = checkRun(tour, voyage([capital, ...islands]));
  assert.match(noReturn.reason, /finish at Fort Aestrin/);
  assert.ok(tour.checkpoints.every((checkpoint) => !at(checkpoint.island).secret), "secret islands are left to players' own courses");
});

test("a port arrival line counts as reaching its island", async () => {
  const tour = await course("shipyard-tour");
  const run = voyage([at("alankh/gold_rock_city"), at("firefish/kicia_bay"), at("aestrin/fort_aestrin")]);
  run.visits.push({ kind: "arrive", port: "Dragon Cliffs", island: 9, t: run.points.at(-1).t + 3 });
  assert.equal(checkRun(tour, run).ok, true);
});

test("fixed order needs the checkpoints in order", () => {
  const ordered = validateCourse({
    id: "in-order", name: "In order", world: "vanilla", start: { island: "alankh/gold_rock_city" },
    checkpoints: [{ island: "alankh/neverdin" }, { island: "alankh/alnilem" }], order: "fixed", finish: { lastCheckpoint: true }
  });
  const [grc, neverdin, alnilem] = ["alankh/gold_rock_city", "alankh/neverdin", "alankh/alnilem"].map(at);
  assert.equal(checkRun(ordered, voyage([grc, neverdin, alnilem])).ok, true);
  assert.equal(checkRun(ordered, voyage([grc, alnilem, neverdin])).ok, false);
});

test("mod, boat and hull rules are checked from the file", async () => {
  const base = { id: "rules", name: "Rules", world: "vanilla", start: { island: "alankh/gold_rock_city" }, checkpoints: [{ island: "alankh/neverdin" }], finish: { lastCheckpoint: true } };
  const stops = [at("alankh/gold_rock_city"), at("alankh/neverdin")];
  const plugins = [{ guid: "com.skeptic043.sailwind.voyagerecorder", name: "Voyage Recorder", version: "0.2.0" }, { guid: "some.fast.mod", name: "Fast", version: "1" }];
  assert.match(checkRun(validateCourse({ ...base, rules: { mods: { mode: "block", plugins: ["some.fast.mod"] } } }), voyage(stops, { plugins })).reason, /doesn't allow some.fast.mod/);
  assert.match(checkRun(validateCourse({ ...base, rules: { mods: { mode: "only", plugins: [] } } }), voyage(stops, { plugins })).reason, /no other mods/);
  assert.equal(checkRun(validateCourse({ ...base, rules: { mods: { mode: "only", plugins: ["some.fast.mod"] } } }), voyage(stops, { plugins })).ok, true);
  assert.match(checkMods({ mode: "require", plugins: ["x.y"] }, plugins), /needs x.y/);
  // A recording from before Voyage Recorder 0.2.2 lists no mods: the run is accepted with a note.
  assert.equal(checkMods({ mode: "block", plugins: ["x.y"] }, null), "");
  // A recording from before Voyage Recorder 0.2.2 has no world, real time or mod list.
  const untimedPoints = voyage(stops).points.map(({ utc, ...point }) => point);
  const older = { ...voyage(stops), world: { kind: "unknown" }, plugins: null, points: untimedPoints };
  assert.equal(checkRun(validateCourse({ ...base, rules: { mods: { mode: "only", plugins: [] } } }), older).ok, true);
  assert.deepEqual(checkRun(validateCourse({ ...base, rules: { mods: { mode: "only", plugins: [] } } }), older).notes, ["mods-not-recorded"]);
  // Real time without a mod list means the list was removed.
  assert.match(checkRun(validateCourse(base), { ...voyage(stops), plugins: null }).reason, /no mod list/);
  // An unreadable Scrambled Seas save leaves out only the world; a run picked from before an upgrade has no real time.
  assert.equal(checkRun(validateCourse(base), { ...voyage(stops), world: { kind: "unknown" } }).ok, true);
  assert.equal(checkRun(validateCourse(base), { ...voyage(stops), points: untimedPoints }).ok, true);
  assert.match(checkRun(validateCourse({ ...base, rules: { boats: ["Cog"] } }), voyage(stops)).reason, /doesn't allow the Brig/);
  assert.match(checkRun(validateCourse({ ...base, rules: { maxHull: 10 } }), voyage(stops, { hull: 25 })).reason, /over this race's 10%/);
  // A real-time board takes a run without real time too, timed by game time and noted.
  const untimed = checkRun(validateCourse({ ...base, rules: { sortBy: "irl" } }), parseVoyage({ format: "sailwind-voyage", version: 1, points: voyage(stops).points.map(({ utc, ...point }) => point) }));
  assert.equal(untimed.ok, true);
  assert.equal(untimed.irlSeconds, null);
  assert.ok(untimed.gameHours > 0);
  assert.deepEqual(untimed.notes, ["no-real-time"]);
});

test("courses are checked before they're published", () => {
  assert.throws(() => validateCourse({ id: "Bad Id", name: "x", world: "vanilla" }), /lowercase/);
  assert.throws(() => validateCourse({ id: "a", name: "A", world: "vanilla", start: { island: "nowhere" }, checkpoints: [{ island: "alankh/neverdin" }], finish: { lastCheckpoint: true } }), /unknown island/);
  assert.throws(() => validateCourse({ id: "a", name: "A", world: "ss-0123456789abcdef", start: { any: true }, checkpoints: [{ island: "alankh/neverdin" }], finish: { lastCheckpoint: true } }), /use marks/);
  assert.throws(() => validateCourse({ id: "a", name: "A", world: "vanilla", start: { any: true }, order: "fixed", checkpoints: [{ island: "alankh/neverdin" }], finish: { lastCheckpoint: true } }), /any order/);
  const marks = validateCourse({ id: "marks", name: "Marks", world: "ss-0123456789abcdef", start: { lat: 30, lon: 1, radiusNm: 2 }, checkpoints: [{ name: "Buoy", lat: 31, lon: 1, radiusNm: 1 }], finish: { lastCheckpoint: true } });
  assert.equal(marks.checkpoints[0].name, "Buoy");
});

test("worlds have stable keys and World Generator links that rebuild them", async () => {
  assert.equal(worldKey({ kind: "vanilla" }), "vanilla");
  assert.equal(worldKey({ kind: "unknown" }), null);
  const world = { kind: "scrambled", seed: -77, islandSpread: 6500, minArchipelagoSeparation: 45000, minIslandSeparation: 1950, lonMin: -20, lonMax: 40, latMin: 20, latMax: 50, borderExpander: 1, scrambler: 60 };
  assert.match(worldKey(world), /^ss-[0-9a-f]{16}$/);
  assert.notEqual(worldKey(world), worldKey({ ...world, seed: -76 }));
  assert.equal(worldKey(world), worldKey({ ...world, scrambledSeas: "6.0.3", layout: "x" }), "only the settings that shape the map count");
  const link = generatorLink(world);
  assert.ok(link.startsWith("https://skeptic043.github.io/scrambled-seas-world-generator/#v=1&"));
  assert.deepEqual(worldFromGeneratorLink(link), world);
  assert.equal(generatorLink({ ...world, borderExpander: 0 }), null, "the generator always writes Border Expander worlds");
  const xml = `<ScrambledSeasSaveContainer><version>60</version><worldScramblerSeed>-77</worldScramblerSeed><islandSpread>6500</islandSpread><minArchipelagoSeparation>45000</minArchipelagoSeparation><minIslandSeparation>1950</minIslandSeparation><worldLonMin>-20</worldLonMin><worldLonMax>40</worldLonMax><worldLatMin>20</worldLatMin><worldLatMax>50</worldLatMax><borderExpander>1</borderExpander></ScrambledSeasSaveContainer>`;
  assert.deepEqual(worldFromXml(xml), world);
});

test("a Scrambled Seas world's islands are placed where the World Generator puts them", () => {
  const world = { kind: "scrambled", seed: -77, islandSpread: 6500, minArchipelagoSeparation: 45000, minIslandSeparation: 1950, lonMin: -20, lonMax: 40, latMin: 20, latMax: 50 };
  const islands = scrambledIslands(world);
  const byId = new Map(islands.map((island) => [island.id, island]));
  assert.ok(byId.has("chronos/chronos") && byId.has("firefish/fire_fish_islands/west_islet"));
  for (const island of islands) assert.ok(island.lat > world.latMin && island.lat < world.latMax && island.lon > world.lonMin && island.lon < world.lonMax);
  assert.notDeepEqual(byId.get("alankh/gold_rock_city"), { id: "alankh/gold_rock_city", lat: islandById("alankh/gold_rock_city").lat, lon: islandById("alankh/gold_rock_city").lon });
  assert.equal(scrambledIslands({ kind: "vanilla" }), null);
  // A lagoon islet keeps its place beside the numbered island it is part of: the East Islet with Fire Fish Town.
  const spacing = (a, b) => [Math.round((a.lat - b.lat) * 1e4), Math.round((a.lon - b.lon) * 1e4)];
  const islet = "firefish/fire_fish_islands/east_islet", town = "firefish/fire_fish_town";
  assert.deepEqual(spacing(byId.get(islet), byId.get(town)), spacing(islandById(islet), islandById(town)));
});

test("heatmaps count voyages, not positions", () => {
  const idle = { points: Array.from({ length: 50 }, (_, index) => ({ t: index, lat: 30.05, lon: 1.05 })) };
  const passing = { points: [{ t: 0, lat: 30.05, lon: 1.05 }, { t: 1, lat: 30.5, lon: 1.05 }] };
  const [coarse] = buildHeatmap([idle, passing]).levels;
  assert.equal(coarse.cells["150,5"], 2);
  assert.equal(coarse.cells["152,5"], 1);
  assert.equal(coarse.max, 2);
});

test("heatmaps fill the cells between readings and keep nearby lanes apart when zoomed in", () => {
  const west = { points: [{ t: 0, lat: 30.01, lon: 1.01 }, { t: 1, lat: 30.39, lon: 1.01 }] };
  const east = { points: [{ t: 0, lat: 30.01, lon: 1.09 }, { t: 1, lat: 30.39, lon: 1.09 }] };
  const [coarse, fine] = buildHeatmap([west, east]).levels;
  assert.equal(coarse.cells["151,5"], 2);
  assert.ok(fine.cellDegrees < coarse.cellDegrees);
  const row = Math.floor(30.2 / fine.cellDegrees);
  const column = (lon) => Math.floor(lon / fine.cellDegrees);
  assert.equal(fine.cells[`${row},${column(1.01)}`], 1);
  assert.equal(fine.cells[`${row},${column(1.09)}`], 1);
  assert.equal(fine.cells[`${row},${column(1.05)}`], undefined);
  // A long recording gap isn't drawn as a straight lane across it.
  const gap = { points: [{ t: 0, lat: 30.01, lon: 1.01 }, { t: 1, lat: 31.01, lon: 1.01 }] };
  assert.equal(buildHeatmap([gap]).levels[0].cells["152,5"], undefined);
});

test("a voyage file is read safely and the same trip shared twice is noticed", () => {
  assert.throws(() => parseVoyage({ format: "x" }), /isn't a route file/);
  assert.throws(() => parseVoyage({ format: "sailwind-voyage", version: 9 }), /newer Chartroom/);
  const a = parseVoyage({ format: "sailwind-voyage", version: 1, game: "0123456789abcdef", points: [{ t: 1, lat: 30, lon: 1 }, { t: 5, lat: 31, lon: 1 }] });
  const b = parseVoyage({ format: "sailwind-voyage", version: 1, game: "0123456789abcdef", points: [{ t: 4, lat: 30, lon: 1 }, { t: 9, lat: 31, lon: 1 }] });
  const other = parseVoyage({ format: "sailwind-voyage", version: 1, game: "fedcba9876543210", points: b.points });
  assert.equal(overlaps(a, b), true);
  assert.equal(overlaps(a, other), false);
  assert.equal(parseVoyage({ format: "sailwind-voyage", version: 1, game: "not-a-hash", points: a.points }).game, "");
});

test("review fixes: marks ignore port names, real-time boards time by real time, and incomplete worlds have no key", () => {
  const grc = at("alankh/gold_rock_city");
  const neverdin = at("alankh/neverdin");
  const alnilem = at("alankh/alnilem");
  const base = { id: "t", name: "T", world: "vanilla", start: { island: grc.id }, finish: { lastCheckpoint: true } };
  // A mark named after a port, far from it, isn't reached by arriving at that port.
  const decoy = validateCourse({ ...base, checkpoints: [{ name: "Neverdin", lat: 20, lon: 20, radiusNm: 2 }] });
  const sailed = voyage([grc, neverdin]);
  sailed.visits.push({ kind: "arrive", port: "Neverdin", island: neverdin.number, t: 102 });
  assert.equal(checkRun(decoy, sailed).ok, false);
  // A fixed-order course on a real-time board keeps the real time of its last checkpoint.
  const fixed = validateCourse({ ...base, order: "fixed", checkpoints: [{ island: neverdin.id }, { island: alnilem.id }], rules: { sortBy: "irl" } });
  const timed = checkRun(fixed, voyage([grc, neverdin, alnilem]));
  assert.equal(timed.ok, true, timed.reason);
  assert.equal(timed.irlSeconds, 3 * 125);
  // One boat for the run needs to know the boat.
  const oneBoat = validateCourse({ ...base, checkpoints: [{ island: neverdin.id }], rules: { oneBoat: true } });
  const anonymous = voyage([grc, neverdin]);
  for (const point of anonymous.points) delete point.boat;
  assert.match(checkRun(oneBoat, anonymous).reason, /doesn't say which boat/);
  assert.equal(worldKey({ kind: "scrambled", seed: 7 }), null, "a seed alone doesn't identify a map");
  assert.throws(() => worldFromGeneratorLink("https://example.com/#v=1&seed=1"), /isn't a World Generator share link/);
});

test("island search recognizes names, punctuation-free forms, initials, and reach snapping", () => {
  assert.equal(matchIslandName("FFT")?.id, "firefish/fire_fish_town");
  assert.equal(matchIslandName("fire fish town")?.id, "firefish/fire_fish_town");
  assert.equal(matchIslandName("firefishtown")?.id, "firefish/fire_fish_town");
  assert.equal(matchIslandName("senna")?.id, "firefish/senna");
  assert.equal(matchIslandName("onna")?.id, "firefish/onna");
  assert.equal(matchIslandName("GRC")?.id, "alankh/gold_rock_city");
  assert.equal(findIslands("FFT")[0]?.id, "firefish/fire_fish_town");
  assert.equal(findIslands("kicia")[0]?.id, "firefish/kicia_bay");
  const kicia = at("firefish/kicia_bay");
  assert.equal(islandAt(kicia.lat + 0.01, kicia.lon + 0.01)?.id, "firefish/kicia_bay");
  assert.equal(islandAt(0, 0), null);
});

test("race failure messages distinguish islands from marks and never reached from never left", () => {
  const kicia = at("firefish/kicia_bay");
  const onna = at("firefish/onna");
  const grc = at("alankh/gold_rock_city");
  const markStartCourse = validateCourse({
    id: "mark-start", name: "Mark start", world: "vanilla",
    start: { name: "Kicia Bay", lat: kicia.lat, lon: kicia.lon, radiusNm: 0.5 },
    checkpoints: [{ island: onna.id }],
    finish: { lastCheckpoint: true }
  });
  const farRun = voyage([grc, onna]);
  assert.match(checkRun(markStartCourse, farRun).reason, /never comes within 0\.5 nm of the Kicia Bay mark/);
  const stayed = parseVoyage({
    format: "sailwind-voyage", version: 1, world: { kind: "vanilla" }, game: "0123456789abcdef", plugins: [],
    points: [
      { t: 1, lat: kicia.lat, lon: kicia.lon, utc: 100 },
      { t: 2, lat: kicia.lat, lon: kicia.lon, utc: 200 }
    ]
  });
  assert.match(checkRun(markStartCourse, stayed).reason, /enters the Kicia Bay mark \(0\.5 nm\), but never leaves it/);
  const islandStartCourse = validateCourse({
    id: "island-start", name: "Island start", world: "vanilla",
    start: { island: kicia.id },
    checkpoints: [{ name: "Buoy", lat: 10, lon: 10, radiusNm: 1 }],
    finish: { lastCheckpoint: true }
  });
  assert.match(checkRun(islandStartCourse, farRun).reason, /never reaches Kicia Bay/);
  assert.match(checkRun(islandStartCourse, stayed).reason, /reaches Kicia Bay, but never leaves it/);
  assert.match(checkRun(islandStartCourse, voyage([kicia, onna])).reason, /within 1 nm of the Buoy mark/);
});

test("sparse tracks count checkpoints when a sailing leg crosses through a mark or island, but ignore long gaps", () => {
  const courseWithSmallMarks = validateCourse({
    id: "sparse-marks", name: "Sparse marks", world: "vanilla",
    start: { name: "Start Buoy", lat: 28.0, lon: 2.0, radiusNm: 0.5 },
    checkpoints: [{ name: "Mid Buoy", lat: 28.0, lon: 2.1, radiusNm: 0.5 }],
    finish: { name: "Finish Buoy", lat: 28.0, lon: 2.2, radiusNm: 0.5 }
  });
  // Every logged point is ~3.5 nm away from the marks, so no single point lands inside 0.5 nm,
  // but each consecutive leg passes straight through the mark.
  const sparse = parseVoyage({
    format: "sailwind-voyage", version: 1, world: { kind: "vanilla" }, game: "0123456789abcdef", plugins: [],
    points: [
      { t: 10, lat: 28.0, lon: 1.975, utc: 1000 },
      { t: 11, lat: 28.0, lon: 2.025, utc: 1100 },
      { t: 12, lat: 28.0, lon: 2.075, utc: 1200 },
      { t: 13, lat: 28.0, lon: 2.125, utc: 1300 },
      { t: 14, lat: 28.0, lon: 2.175, utc: 1400 },
      { t: 15, lat: 28.0, lon: 2.225, utc: 1500 }
    ]
  });
  const result = checkRun(courseWithSmallMarks, sparse);
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.gameHours > 3.5 && result.gameHours < 4.5, `expected ~4h, got ${result.gameHours}`);

  // A huge recording gap (> 70 nm) jumping across the course must not count as sailing through it.
  const gapped = parseVoyage({
    format: "sailwind-voyage", version: 1, world: { kind: "vanilla" }, game: "0123456789abcdef", plugins: [],
    points: [
      { t: 10, lat: 28.0, lon: 1.5, utc: 1000 },
      { t: 20, lat: 28.0, lon: 2.5, utc: 2000 }
    ]
  });
  assert.equal(checkRun(courseWithSmallMarks, gapped).ok, false);
});
