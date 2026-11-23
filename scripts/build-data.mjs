// Rebuilds data/ from the stored voyages, runs, courses and featured worlds: the world list ranked by how many
// voyages each has, each world's heatmap, islands and voyage list, and each course's board and heatmap.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildHeatmap } from "../lib/heatmap.mjs";
import { generatorLink, scrambledIslands } from "../lib/world.mjs";

const base = () => process.env.VOYAGES_ROOT ? pathToFileURL(`${process.env.VOYAGES_ROOT}/`) : new URL("../", import.meta.url);
const NM_PER_DEGREE = 140;

async function folders(path) {
  try {
    return (await readdir(new URL(path, base()), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function jsonFiles(path) {
  let names = [];
  try {
    names = (await readdir(new URL(path, base()))).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(new URL(`${path}${name}`, base()), "utf8"))));
}

async function write(path, value) {
  const url = new URL(path, base());
  await mkdir(new URL(".", url), { recursive: true });
  await writeFile(url, `${JSON.stringify(value)}\n`);
}

// Distance along a track, taking the short way across the chart's east and west edges.
function distanceNm(points) {
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    const dLon = ((points[index].lon - points[index - 1].lon + 540) % 360) - 180;
    total += Math.hypot(points[index].lat - points[index - 1].lat, dLon) * NM_PER_DEGREE;
  }
  return Math.round(total * 10) / 10;
}

function voyageSummary(voyage, key) {
  return {
    id: voyage.id,
    name: voyage.name,
    note: voyage.note,
    submitter: voyage.submitter,
    submitted: voyage.submitted,
    distanceNm: distanceNm(voyage.points),
    hours: Math.round((voyage.points.at(-1).t - voyage.points[0].t) * 100) / 100,
    boats: [...new Set(voyage.points.map((point) => point.boat).filter(Boolean))],
    ...(voyage.worldDeclared === true && { notes: ["world-declared"] }),
    file: `voyages/${key}/${voyage.id}.json`
  };
}

export async function buildData() {
  await rm(new URL("data/", base()), { recursive: true, force: true });
  const courses = await jsonFiles("courses/");
  const featured = await jsonFiles("worlds/");
  const keys = new Set([...await folders("voyages/"), ...featured.map((world) => world.key), ...courses.map((course) => course.world)]);
  const worlds = [];
  for (const key of keys) {
    const voyages = await jsonFiles(`voyages/${key}/`);
    const feature = featured.find((world) => world.key === key);
    const settings = feature?.world ?? voyages[0]?.world ?? (key === "vanilla" ? { kind: "vanilla" } : null);
    const entry = {
      key,
      name: key === "vanilla" ? "Vanilla Sailwind" : feature?.name ?? `Scrambled Seas seed ${settings?.seed ?? "?"}`,
      description: feature?.description ?? "",
      featuredBy: feature?.author ?? "",
      world: settings,
      voyages: voyages.length,
      courses: courses.filter((course) => course.world === key).map((course) => course.id),
      generatorLink: settings ? generatorLink(settings) : null
    };
    worlds.push(entry);
    await write(`data/worlds/${key}.json`, {
      ...entry,
      heatmap: buildHeatmap(voyages),
      // A Scrambled Seas world's islands, where it put them; vanilla uses the island catalog.
      islands: settings?.kind === "scrambled" ? scrambledIslands(settings) : null,
      voyageList: voyages.map((voyage) => voyageSummary(voyage, key)).sort((a, b) => b.submitted.localeCompare(a.submitted))
    });
  }
  // Vanilla first, then the most sailed worlds.
  worlds.sort((a, b) => (a.key === "vanilla" ? -1 : b.key === "vanilla" ? 1 : b.voyages - a.voyages || a.name.localeCompare(b.name)));
  await write("data/worlds.json", worlds);
  const boards = [];
  for (const course of courses) {
    const runs = await jsonFiles(`runs/${course.id}/`);
    const sortBy = course.rules?.sortBy === "irl" ? "irlSeconds" : "gameHours";
    // Runs without the board's time (a real-time board's runs from older recordings) follow the ranked ones.
    const ranked = runs.filter((run) => Number.isFinite(run[sortBy])).sort((a, b) => a[sortBy] - b[sortBy]);
    const unranked = runs.filter((run) => !Number.isFinite(run[sortBy]) && Number.isFinite(run.gameHours)).sort((a, b) => a.gameHours - b.gameHours);
    const entries = [...ranked, ...unranked].map((run, index) => ({
      rank: index < ranked.length ? index + 1 : null,
      id: run.id,
      submitter: run.submitter,
      submitted: run.submitted,
      gameHours: run.gameHours,
      irlSeconds: run.irlSeconds,
      boat: run.boat,
      windKnots: run.windKnots,
      startedFrom: run.startedFrom,
      ...(Array.isArray(run.notes) && run.notes.length && { notes: run.notes }),
      splits: run.splits.map((split) => ({ name: split.name, hours: Math.round((split.t - run.start) * 100) / 100 })),
      file: `runs/${course.id}/${run.id}.json`
    }));
    boards.push({ id: course.id, name: course.name, world: course.world, runs: entries.length, spoiler: course.spoiler === true });
    // Where the runs went, drawn under the course's flags.
    await write(`data/boards/${course.id}.json`, { course, runs: entries, heatmap: buildHeatmap(runs.map((run) => run.voyage).filter((voyage) => voyage?.points?.length)) });
  }
  boards.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
  await write("data/courses.json", boards);
  return { worlds: worlds.length, courses: boards.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await buildData());
}
