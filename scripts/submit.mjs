// Handles one submission issue for the GitHub Action: reads the issue form, fetches the voyage file, checks it,
// and writes the accepted file into the repository. Writes { ok, message } to RESULT_PATH for the workflow's
// comment. Everything from the issue is untrusted: it arrives through environment variables, attachments are
// only fetched from GitHub's own attachment hosts, and sizes are capped.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseVoyage, overlaps, storedVoyage } from "../lib/voyage.mjs";
import { worldFromGeneratorLink, worldFromXml, worldKey, worldSettings } from "../lib/world.mjs";
import { validateCourse } from "../lib/course.mjs";
import { checkRun } from "../lib/race.mjs";

// The repository folder; tests point VOYAGES_ROOT at a scratch copy.
const base = () => process.env.VOYAGES_ROOT ? pathToFileURL(`${process.env.VOYAGES_ROOT.replace(/[\/]$/, "")}/`) : new URL("../", import.meta.url);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ATTACHMENT = /https:\/\/github\.com\/(?:user-attachments\/files\/\d+\/[^\s)\]]+|[\w.-]+\/[\w.-]+\/files\/\d+\/[^\s)\]]+)/;

// Issue forms write each field as "### Label" followed by its value; an empty field is "_No response_".
export function formFields(body) {
  const fields = {};
  const parts = String(body ?? "").split(/^### /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const label = part.slice(0, newline < 0 ? undefined : newline).trim();
    const value = newline < 0 ? "" : part.slice(newline + 1).trim();
    fields[label] = value === "_No response_" ? "" : value;
  }
  return fields;
}

// The voyage file from a field: an attached file, or JSON pasted in a code block or as is.
export async function voyageFromField(text, { fetchFile = fetchAttachment } = {}) {
  const attachment = ATTACHMENT.exec(text ?? "");
  let raw;
  if (attachment) raw = await fetchFile(attachment[0]);
  else {
    const block = /```(?:json)?\s*([\s\S]*?)```/.exec(text ?? "");
    raw = block ? block[1] : String(text ?? "").trim();
  }
  if (!raw) throw new Error("No file was attached. Attach the .voyage.json file Chartroom saved, or paste its contents.");
  if (raw.length > MAX_FILE_BYTES) throw new Error("The file is larger than 10 MB.");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The file isn't valid JSON. Attach the file Chartroom saved without changing it.");
  }
  return parseVoyage(value);
}

async function fetchAttachment(url) {
  const response = await fetch(url, { headers: process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}, redirect: "follow" });
  const host = new URL(response.url).hostname;
  if (!(host === "github.com" || host.endsWith(".githubusercontent.com"))) throw new Error("The attachment didn't come from GitHub.");
  if (!response.ok) throw new Error(`The attached file couldn't be downloaded (${response.status}).`);
  if (Number(response.headers.get("content-length")) > MAX_FILE_BYTES) throw new Error("The file is larger than 10 MB.");
  // Counted as it arrives, so a file without an honest length still stops at the limit.
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_FILE_BYTES) {
      await response.body.cancel?.().catch(() => {});
      throw new Error("The file is larger than 10 MB.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Text from a submission, made safe to show in the bot's Markdown reply: no links, formatting or mentions.
export function plain(text) {
  return String(text ?? "").replace(/\s+/g, " ").replace(/[\\`*_[\]()<>#|!~]/g, "\\$&").replace(/@/g, "@\u200b").slice(0, 300);
}

async function readJsonFiles(folder) {
  let names = [];
  try {
    names = (await readdir(new URL(folder, base()))).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(new URL(`${folder}${name}`, base()), "utf8"))));
}

async function writeJson(path, value) {
  const url = new URL(path, base());
  await mkdir(new URL(".", url), { recursive: true });
  await writeFile(url, `${JSON.stringify(value)}\n`);
}

async function shareVoyage(voyage, { id, submitter, submitted }) {
  const key = worldKey(voyage.world);
  if (!key) throw new Error("This route doesn't say which world it was sailed in.");
  const existing = await readJsonFiles(`voyages/${key}/`);
  if (existing.some((other) => overlaps(other, voyage))) throw new Error("This route, or part of it, has already been published.");
  await writeJson(`voyages/${key}/${id}.json`, storedVoyage({ ...voyage, world: worldSettings(voyage.world) }, { id, submitter, submitted }));
  return { key };
}

async function enterRace(voyage, courseId, alsoShare, context) {
  const courses = await readJsonFiles("courses/");
  const course = courses.find((candidate) => candidate.id === courseId.trim());
  if (!course) throw new Error(`There's no course with the id "${courseId.trim()}". Copy it from the course's board.`);
  const key = worldKey(voyage.world);
  if (key !== course.world) throw new Error(key ? "This run was sailed in a different world from the race's." : "This run doesn't say which world it was sailed in, so it can't be entered.");
  const runs = await readJsonFiles(`runs/${course.id}/`);
  if (runs.some((run) => overlaps(run.voyage, voyage))) throw new Error("This run has already been entered.");
  const result = checkRun(validateCourse(course), voyage);
  if (!result.ok) throw new Error(result.reason);
  await writeJson(`runs/${course.id}/${context.id}.json`, { id: context.id, submitter: context.submitter, submitted: context.submitted, course: course.id, courseVersion: course.version, ...result, voyage: storedVoyage({ ...voyage, world: worldSettings(voyage.world) }, context) });
  // A race entry counts toward the heatmap only when the player asked; one already shared isn't added twice.
  if (alsoShare) {
    try {
      await shareVoyage(voyage, { ...context, id: `${context.id}-shared` });
    } catch {
      // Already shared: the run still stands.
    }
  }
  return result;
}

async function createCourse(text, { submitter, submitted }) {
  const block = /```(?:json)?\s*([\s\S]*?)```/.exec(text ?? "");
  let value;
  try {
    value = JSON.parse(block ? block[1] : text);
  } catch {
    throw new Error("The race isn't valid JSON. The race builder on the site fills it in for you.");
  }
  const course = validateCourse({ ...value, author: submitter });
  // A Scrambled Seas race needs a world the site knows, so its page can show and rebuild it. A race from
  // Chartroom carries its world's settings, and publishes the world with it when the site doesn't have it yet.
  if (course.world !== "vanilla" && !(await readJsonFiles("worlds/")).some((world) => world.key === course.world) && !(await readJsonFiles(`voyages/${course.world}/`)).length) {
    const settings = value.worldSettings ? worldSettings(value.worldSettings) : null;
    if (!settings || worldKey(settings) !== course.world) {
      throw new Error("This race's world isn't on the site yet. Publish the race from Sailwind Chartroom, or publish a route or the world first.");
    }
    await writeJson(`worlds/${course.world}.json`, { key: course.world, name: `Scrambled Seas seed ${settings.seed}`, description: "", author: submitter, submitted, world: settings });
  }
  const existing = await readJsonFiles("courses/");
  if (existing.some((other) => other.id === course.id)) throw new Error(`A race with the id "${course.id}" already exists. Choose another id, such as ${course.id}-2.`);
  await writeJson(`courses/${course.id}.json`, course);
  return course;
}

async function featureWorld(fields, { submitter, submitted }) {
  const source = fields["World"] ?? "";
  const world = source.trim().startsWith("<") || source.includes("<ScrambledSeasSaveContainer") ? worldFromXml(source) : worldFromGeneratorLink(source.trim());
  const key = worldKey(world);
  const existing = await readJsonFiles("worlds/");
  if (existing.some((other) => other.key === key)) throw new Error("This world has already been published.");
  const name = (fields["Name"] ?? "").trim().slice(0, 80);
  if (!name) throw new Error("A published world needs a name.");
  await writeJson(`worlds/${key}.json`, { key, name, description: (fields["Description"] ?? "").trim().slice(0, 1000), author: submitter, submitted, world: worldSettings(world) });
  return { key, name };
}

const hours = (value) => `${Math.floor(value)}h ${String(Math.round((value % 1) * 60)).padStart(2, "0")}m`;

export async function handle({ number, labels, body, submitter, site = "" }) {
  const fields = formFields(body);
  const context = { submitter, submitted: new Date().toISOString(), id: `${number}` };
  if (labels.includes("share-voyage")) {
    const { key } = await shareVoyage(await voyageFromField(fields["Route file"] ?? fields["Voyage file"]), context);
    return `Thanks! Your route is now on [its world's page](${site}#world/${key}).`;
  }
  if (labels.includes("enter-race")) {
    const courseId = fields["Course id"] ?? "";
    const alsoShare = /\[x\]/i.test(fields["Heatmap"] ?? "");
    const result = await enterRace(await voyageFromField(fields["Run file"] ?? fields["Voyage file"]), courseId, alsoShare, context);
    return `Accepted: ${hours(result.gameHours)} of game time from ${plain(result.startedFrom)}. See [the board](${site}#course/${encodeURIComponent(courseId.trim())}).`;
  }
  if (labels.includes("create-course")) {
    const course = await createCourse(fields["Race"] ?? fields["Course"], context);
    return `Your race is live: [${plain(course.name)}](${site}#course/${course.id}).`;
  }
  if (labels.includes("feature-world")) {
    const { key, name } = await featureWorld(fields, context);
    return `${plain(name)} is now published: [its page](${site}#world/${key}).`;
  }
  throw new Error("This issue isn't one of the submission forms.");
}

// Run by the workflow.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const resultPath = process.env.RESULT_PATH ?? "result.json";
  let result;
  try {
    const message = await handle({
      number: Number(process.env.ISSUE_NUMBER),
      labels: JSON.parse(process.env.ISSUE_LABELS ?? "[]"),
      body: process.env.ISSUE_BODY ?? "",
      submitter: String(process.env.ISSUE_USER ?? "").slice(0, 60),
      site: process.env.SITE_URL ?? ""
    });
    result = { ok: true, message };
  } catch (error) {
    result = { ok: false, message: `This submission wasn't accepted: ${plain(error.message)}` };
  }
  await writeFile(resultPath, JSON.stringify(result));
  console.log(result.message);
}
