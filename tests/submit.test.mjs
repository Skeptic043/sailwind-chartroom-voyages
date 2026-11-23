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
  assert.equal(plain("Legit](https://evil.example) [click @user\nnow"), "Legit\\]\\(https:\u200b//evil.example\\) \\[click @\u200buser now");
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

test("course matching accepts display names and board URLs, and suggests close ids", async () => {
  const { resolveCourse } = await import("../scripts/submit.mjs");
  const folder = await scratch();
  try {
    const ports = ["firefish/kicia_bay", "alankh/gold_rock_city", "aestrin/fort_aestrin", "emerald/dragon_cliffs"].map(islandById);
    const runA = voyageFile(ports, { game: "aaaaaaaaaaaaaaaa" });
    const runB = voyageFile(ports, { game: "bbbbbbbbbbbbbbbb" });
    const replyA = await handle({
      number: 30,
      labels: ["enter-race"],
      body: form({ "Course id": "Shipyard Tour", "Run file": pasted(runA) }),
      submitter: "captain"
    });
    assert.match(replyA, /Accepted:.*#course\/shipyard-tour\)/);
    // Re-submitting an accepted race entry issue number is blocked with alreadyAccepted.
    await assert.rejects(
      handle({ number: 30, labels: ["enter-race"], body: form({ "Course id": "shipyard-tour", "Run file": pasted(runB) }), submitter: "captain" }),
      (error) => error.alreadyAccepted === true && /already been accepted/.test(error.message)
    );
    const replyB = await handle({
      number: 31,
      labels: ["enter-race"],
      body: form({ "Course id": "https://skeptic043.github.io/sailwind-chartroom-voyages/#course/shipyard-tour", "Run file": pasted(runB) }),
      submitter: "mate"
    });
    assert.match(replyB, /Accepted:.*#course\/shipyard-tour\)/);
    await assert.rejects(
      handle({ number: 32, labels: ["enter-race"], body: form({ "Course id": "shipyard", "Run file": pasted(runB) }), submitter: "mate" }),
      /Did you mean "shipyard-tour"/
    );
    // Display names whose slug differs from id, malformed URL segments, 1-char input, and ambiguous names.
    const list = [
      { id: "a", name: "Short" },
      { id: "alankh-tour", name: "Al'Ankh tour" },
      { id: "emerald-tour", name: "Emerald Archipelago tour" },
      { id: "dup-1", name: "Same Name" },
      { id: "dup-2", name: "Same Name" }
    ];
    assert.equal(resolveCourse(list, "Al’Ankh tour").course?.id, "alankh-tour");
    assert.equal(resolveCourse(list, "Al Ankh tour").course?.id, "alankh-tour");
    assert.equal(resolveCourse(list, "Emerald Archipelago tour").course?.id, "emerald-tour");
    assert.equal(resolveCourse(list, "https://example.test/#course/a_b").course, null);
    assert.equal(resolveCourse(list, "x").suggestion, null);
    assert.equal(resolveCourse(list, "Same Name").course, null);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("older routes can declare their world on the form or in the file and count toward the heatmap", async () => {
  const folder = await scratch();
  try {
    const ports = [islandById("alankh/gold_rock_city"), islandById("alankh/neverdin")];
    const legacy = voyageFile(ports, { game: "", world: { kind: "unknown" } });
    legacy.name = "";
    // First attempt without declaring a world fails, then editing the same issue (#40) to declare Vanilla succeeds.
    await assert.rejects(
      handle({ number: 40, labels: ["share-voyage"], title: "Vanilla Capitals with trade winds", body: form({ "Route file": pasted(legacy) }), submitter: "beaver" }),
      /World \(for older recordings\)/
    );
    const accepted = await handle({
      number: 40,
      labels: ["share-voyage"],
      title: "Vanilla Capitals with trade winds",
      body: form({ "Route file": pasted(legacy), "World (for older recordings)": "Vanilla Sailwind" }),
      submitter: "beaver"
    });
    assert.match(accepted, /#world\/vanilla.*player-declared world/);
    // Re-running the same accepted issue number or an accepted-labeled issue is rejected with alreadyAccepted.
    await assert.rejects(
      handle({ number: 40, labels: ["share-voyage"], title: "Edited again", body: form({ "Route file": pasted(legacy), "World (for older recordings)": "Vanilla Sailwind" }), submitter: "beaver" }),
      (error) => error.alreadyAccepted === true && /already been accepted/.test(error.message)
    );
    await assert.rejects(
      handle({ number: 41, labels: ["share-voyage", "accepted"], body: form({ "Route file": pasted(legacy), "World (for older recordings)": "Vanilla Sailwind" }), submitter: "beaver" }),
      (error) => error.alreadyAccepted === true && /already been accepted/.test(error.message)
    );
    // Submitting the same unnamed legacy file under a new issue number is still caught as a duplicate.
    await assert.rejects(
      handle({ number: 42, labels: ["share-voyage"], body: form({ "Route file": pasted(legacy), "World (for older recordings)": "Vanilla Sailwind" }), submitter: "beaver" }),
      /already been published/
    );
    // Declaring a Scrambled Seas world via World Generator link works; unnamed route with default title stays unnamed.
    const link = "https://skeptic043.github.io/scrambled-seas-world-generator/#v=1&lo1=-20&lo2=40&la1=20&la2=50&ws=1.4&cx=10&cy=35&as=1.5&is=1.3&isp=1.3&seed=-77";
    const legacyScrambled = { ...voyageFile(ports, { game: "cccccccccccccccc", world: { kind: "unknown" } }), name: "" };
    const scrambledReply = await handle({
      number: 43,
      labels: ["share-voyage"],
      title: "Publish a route",
      body: form({
        "Route file": pasted(legacyScrambled),
        "World (for older recordings)": "Scrambled Seas (paste link or XML below)",
        "Scrambled Seas world (optional)": link
      }),
      submitter: "explorer"
    });
    assert.match(scrambledReply, /#world\/ss-[0-9a-f]{16}/);
    // Pasting Scrambled Seas XML even with dropdown left on default is accepted.
    const xml = `<ScrambledSeasSaveContainer><version>60</version><worldScramblerSeed>-88</worldScramblerSeed><islandSpread>6500</islandSpread><minArchipelagoSeparation>45000</minArchipelagoSeparation><minIslandSeparation>1950</minIslandSeparation><worldLonMin>-20</worldLonMin><worldLonMax>40</worldLonMax><worldLatMin>20</worldLatMin><worldLatMax>50</worldLatMax><borderExpander>1</borderExpander></ScrambledSeasSaveContainer>`;
    const xmlRoute = voyageFile(ports, { game: "c1c1c1c1c1c1c1c1", world: { kind: "unknown" } });
    assert.match(
      await handle({
        number: 48,
        labels: ["share-voyage"],
        title: "Custom issue title ignored when file has name",
        body: form({ "Route file": pasted(xmlRoute), "World (for older recordings)": "From the route file (default)", "Scrambled Seas world (optional)": xml }),
        submitter: "xmlSailor"
      }),
      /#world\/ss-[0-9a-f]{16}/
    );
    // Form validation errors: choosing both Vanilla and Scrambled Seas, or Scrambled Seas with empty box.
    const extraLegacy = voyageFile(ports, { game: "c2c2c2c2c2c2c2c2", world: { kind: "unknown" } });
    await assert.rejects(
      handle({ number: 49, labels: ["share-voyage"], body: form({ "Route file": pasted(extraLegacy), "World (for older recordings)": "Vanilla Sailwind", "Scrambled Seas world (optional)": link }), submitter: "x" }),
      /not both/
    );
    await assert.rejects(
      handle({ number: 50, labels: ["share-voyage"], body: form({ "Route file": pasted(extraLegacy), "World (for older recordings)": "Scrambled Seas (paste link or XML below)" }), submitter: "x" }),
      /Paste a World Generator share link/
    );
    // A file that already recorded Vanilla cannot be overridden with a different world, and selecting Vanilla on it does not mark it declared.
    const recordedVanilla = voyageFile(ports, { game: "dddddddddddddddd", world: { kind: "vanilla" }, start: 300 });
    await assert.rejects(
      handle({
        number: 44,
        labels: ["share-voyage"],
        body: form({
          "Route file": pasted(recordedVanilla),
          "World (for older recordings)": "Scrambled Seas (paste link or XML below)",
          "Scrambled Seas world (optional)": link
        }),
        submitter: "explorer"
      }),
      /already says it was sailed in a different world/
    );
    const sameWorldReply = await handle({
      number: 46,
      labels: ["share-voyage"],
      body: form({ "Route file": pasted(recordedVanilla), "World (for older recordings)": "Vanilla Sailwind" }),
      submitter: "recordedUser"
    });
    assert.doesNotMatch(sameWorldReply, /player-declared/);
    // A route whose JSON itself carries worldDeclared: true (from Chartroom) is accepted and noted, and works in races with heatmap opt-in without leaking "Enter race" as its route name.
    const racePorts = ["firefish/kicia_bay", "alankh/gold_rock_city", "aestrin/fort_aestrin", "emerald/dragon_cliffs"].map(islandById);
    const chartroomDeclared = { ...voyageFile(racePorts, { game: "eeeeeeeeeeeeeeee", world: { kind: "vanilla" }, start: 500 }), name: "", worldDeclared: true };
    assert.match(
      await handle({
        number: 45,
        labels: ["enter-race"],
        title: "Enter race",
        body: form({ "Course id": "Shipyard Tour", "Run file": pasted(chartroomDeclared), Heatmap: "- [x] Also count this run towards the world's heatmap" }),
        submitter: "chartroomUser"
      }),
      /Accepted:.*#course\/shipyard-tour\)/
    );
    await buildData();
    const vanilla = JSON.parse(await readFile(join(folder, "data", "worlds", "vanilla.json"), "utf8"));
    assert.equal(vanilla.voyages, 3);
    assert.equal(vanilla.heatmap.voyages, 3, "declared-world routes count toward the heatmap");
    const beaverRoute = vanilla.voyageList.find((entry) => entry.submitter === "beaver");
    assert.equal(beaverRoute.name, "Vanilla Capitals with trade winds");
    assert.deepEqual(beaverRoute.notes, ["world-declared"]);
    const recordedRoute = vanilla.voyageList.find((entry) => entry.submitter === "recordedUser");
    assert.equal(recordedRoute.notes, undefined);
    const chartroomRoute = vanilla.voyageList.find((entry) => entry.submitter === "chartroomUser");
    assert.equal(chartroomRoute.name, "", "Enter race default title does not leak onto shared routes");
    assert.deepEqual(chartroomRoute.notes, ["world-declared"]);
    const board = JSON.parse(await readFile(join(folder, "data", "boards", "shipyard-tour.json"), "utf8"));
    assert.deepEqual(board.runs[0].notes, ["world-declared"]);
    const scrambledWorlds = JSON.parse(await readFile(join(folder, "data", "worlds.json"), "utf8"));
    const seed77 = scrambledWorlds.find((world) => world.world?.seed === -77);
    const seed77Data = JSON.parse(await readFile(join(folder, "data", "worlds", `${seed77.key}.json`), "utf8"));
    assert.equal(seed77Data.voyageList[0].name, "", "Publish a route default title stays unnamed");
    const seed88 = scrambledWorlds.find((world) => world.world?.seed === -88);
    const seed88Data = JSON.parse(await readFile(join(folder, "data", "worlds", `${seed88.key}.json`), "utf8"));
    assert.equal(seed88Data.voyageList[0].name, "Test", "file name wins over GitHub issue title");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
