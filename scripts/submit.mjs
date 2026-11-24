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
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .slice(0, 300)
    .replace(/:\/\//g, ":\u200b//")
    .replace(/[\\`*_[\]()<>#|!~]/g, "\\$&")
    .replace(/@/g, "@\u200b");
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

async function subfolders(folder) {
  try {
    return (await readdir(new URL(folder, base()), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function hasAcceptedSubmission(id) {
  for (const root of ["voyages/", "runs/"]) {
    for (const folder of await subfolders(root)) {
      try {
        const names = await readdir(new URL(`${root}${folder}/`, base()));
        if (names.includes(`${id}.json`)) return true;
      } catch {}
    }
  }
  return false;
}

function slug(text) {
  return String(text ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Resolves a course from its id, a board URL, a slugified name (e.g. "Shipyard Tour"), or its exact name.
export function resolveCourse(courses, input) {
  const raw = String(input ?? "").trim();
  let trimmed = raw;
  const fromUrl = /#course\/([^/?#\s)\]]+)/i.exec(raw)?.[1];
  if (fromUrl) {
    try {
      trimmed = decodeURIComponent(fromUrl).trim();
    } catch {
      trimmed = fromUrl.trim();
    }
  }
  if (!trimmed) return { course: null, suggestion: null };
  const lower = trimmed.toLowerCase();
  const exact = courses.find((candidate) => candidate.id.toLowerCase() === lower);
  if (exact) return { course: exact, suggestion: null };
  const asSlug = slug(trimmed);
  if (asSlug) {
    const bySlug = courses.find((candidate) => candidate.id === asSlug);
    if (bySlug) return { course: bySlug, suggestion: null };
  }
  const byName = courses.filter((candidate) => candidate.name.trim().toLowerCase() === lower);
  if (byName.length === 1) return { course: byName[0], suggestion: null };
  const byNameSlug = asSlug ? courses.filter((candidate) => slug(candidate.name) === asSlug) : [];
  if (byNameSlug.length === 1) return { course: byNameSlug[0], suggestion: null };
  const suggestion = asSlug.length >= 3
    ? courses.find((candidate) => candidate.id.includes(asSlug) || asSlug.includes(candidate.id) || slug(candidate.name).includes(asSlug)) ?? null
    : null;
  return { course: null, suggestion };
}

const DEFAULT_ROUTE_TITLES = new Set(["publish a route", "share voyage", "enter race"]);

function fallbackRouteName(title) {
  const cleaned = String(title ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned || DEFAULT_ROUTE_TITLES.has(cleaned.toLowerCase())) return "";
  return cleaned.slice(0, 80);
}

// Optional world declared on the Publish a route form for older recordings that didn't record one.
function declaredWorldFromFields(fields) {
  const choice = (fields["World (for older recordings)"] ?? fields["World"] ?? "").trim();
  const scrambled = (fields["Scrambled Seas world (optional)"] ?? fields["Scrambled Seas world"] ?? "").trim();
  if (/^vanilla\b/i.test(choice)) {
    if (scrambled) throw new Error("Choose either Vanilla Sailwind or a Scrambled Seas world, not both.");
    return { kind: "vanilla" };
  }
  if (/^scrambled seas\b/i.test(choice) || scrambled) {
    if (!scrambled) throw new Error("Paste a World Generator share link or Scrambled Seas XML in the Scrambled Seas world box.");
    return scrambled.startsWith("<") || scrambled.includes("<ScrambledSeasSaveContainer")
      ? worldFromXml(scrambled)
      : worldFromGeneratorLink(scrambled);
  }
  return null;
}

async function shareVoyage(voyage, { id, submitter, submitted, title = "" }, declaredWorld = null) {
  const fileKey = worldKey(voyage.world);
  const declaredKey = declaredWorld ? worldKey(declaredWorld) : null;
  if (fileKey && declaredKey && fileKey !== declaredKey) {
    throw new Error("The route file already says it was sailed in a different world from the one chosen in the form. Leave World on \"From the route file (default)\" to use the file's recorded world.");
  }
  const key = fileKey ?? declaredKey;
  if (!key) {
    throw new Error("This route file doesn't say which world it was sailed in (the site reads the attached file, not comments). Choose a world under World (for older recordings) on the form.");
  }
  const effectiveWorld = fileKey ? voyage.world : declaredWorld;
  const worldDeclared = fileKey ? voyage.worldDeclared === true : Boolean(declaredKey);
  const existing = await readJsonFiles(`voyages/${key}/`);
  if (existing.some((other) => overlaps(other, voyage) || sameUnnamedRun(other, voyage))) {
    throw new Error("This route, or part of it, has already been published.");
  }
  const { worldDeclared: _ignored, ...rest } = voyage;
  const name = rest.name || fallbackRouteName(title);
  await writeJson(`voyages/${key}/${id}.json`, storedVoyage({
    ...rest,
    ...(name && { name }),
    world: worldSettings(effectiveWorld),
    ...(worldDeclared && { worldDeclared: true })
  }, { id, submitter, submitted }));
  return { key, worldDeclared };
}

async function enterRace(voyage, courseId, alsoShare, context) {
  const courses = await readJsonFiles("courses/");
  const { course, suggestion } = resolveCourse(courses, courseId);
  if (!course) {
    const label = courseId.trim().slice(0, 80);
    const hint = suggestion
      ? ` Did you mean "${suggestion.id}" (${suggestion.name})?`
      : " Check the race id on its board or pick a race from the Submit page.";
    throw new Error(`There's no course with the id "${label}".${hint}`);
  }
  // A recording from before Voyage Recorder 0.2.2, or one whose Scrambled Seas save couldn't be read, doesn't name
  // its world; it's taken as the race's, with a note.
  const key = worldKey(voyage.world);
  if (!key && voyage.world.kind !== "unknown") throw new Error("This run doesn't say which world it was sailed in, so it can't be entered.");
  if (key && key !== course.world) throw new Error("This run was sailed in a different world from the race's.");
  const runs = await readJsonFiles(`runs/${course.id}/`);
  if (runs.some((run) => overlaps(run.voyage, voyage) || sameUnnamedRun(run.voyage, voyage))) throw new Error("This run has already been entered.");
  const checked = checkRun(validateCourse(course), voyage);
  if (!checked.ok) throw new Error(checked.reason);
  const worldNotes = !key ? ["world-not-recorded"] : voyage.worldDeclared === true ? ["world-declared"] : [];
  const notes = [...worldNotes, ...(checked.notes ?? [])];
  const result = { ...checked, ...(notes.length && { notes }) };
  const { worldDeclared: _ignored, ...rest } = voyage;
  await writeJson(`runs/${course.id}/${context.id}.json`, {
    id: context.id,
    submitter: context.submitter,
    submitted: context.submitted,
    course: course.id,
    courseVersion: course.version,
    ...result,
    voyage: storedVoyage({
      ...rest,
      world: key ? worldSettings(voyage.world) : { kind: "unknown" },
      ...(key && voyage.worldDeclared === true && { worldDeclared: true })
    }, context)
  });
  // A race entry counts toward the heatmap only when the player asked; one already shared isn't added twice.
  // A run without a recorded world has no world's heatmap to join.
  if (alsoShare && !key) return { ...result, courseId: course.id, notShared: true };
  if (alsoShare) {
    try {
      await shareVoyage(voyage, { ...context, id: `${context.id}-shared`, title: "" });
    } catch {
      // Already shared: the run still stands.
    }
  }
  return { ...result, courseId: course.id };
}

// Recordings from before Voyage Recorder 0.1.9 have no game id, so overlaps can't tell them apart; the same
// file sent again has the same first and last positions.
function sameUnnamedRun(a, b) {
  if (a.game || b.game) return false;
  const ends = (voyage) => [voyage.points[0], voyage.points.at(-1)].flatMap((point) => [point.t, point.lat, point.lon]).join();
  return ends(a) === ends(b);
}

function courseSnapshot(course) {
  return {
    version: course.version ?? 1,
    ...(course.edited && { edited: course.edited }),
    name: course.name,
    description: course.description,
    start: course.start,
    checkpoints: course.checkpoints,
    order: course.order,
    finish: course.finish,
    rules: course.rules
  };
}

async function createCourse(text, { submitter, submitted }) {
  const block = /```(?:json)?\s*([\s\S]*?)```/.exec(text ?? "");
  let value;
  try {
    value = JSON.parse(block ? block[1] : text);
  } catch {
    throw new Error("The race isn't valid JSON. The race builder on the site fills it in for you.");
  }
  const { edited: _edited, history: _history, version: _version, ...clean } = value ?? {};
  const course = validateCourse({ ...clean, author: submitter });
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
  const prior = existing.find((other) => other.id === course.id);
  if (prior) {
    if (!prior.author || prior.author.toLowerCase() !== submitter.toLowerCase()) {
      throw new Error(`A race with the id "${course.id}" already exists. Choose another id, such as ${course.id}-2.`);
    }
    const history = [...(Array.isArray(prior.history) ? prior.history : []), courseSnapshot(prior)].slice(-50);
    const updatedCourse = validateCourse({
      ...course,
      author: prior.author,
      version: (prior.version ?? 1) + 1,
      edited: submitted,
      history
    });
    await writeJson(`courses/${course.id}.json`, updatedCourse);
    return { course: updatedCourse, updated: true };
  }
  await writeJson(`courses/${course.id}.json`, course);
  return { course, updated: false };
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

export async function handle({ number, labels, title = "", body, submitter, site = "" }) {
  const fields = formFields(body);
  const context = { submitter, submitted: new Date().toISOString(), id: `${number}`, title };
  if (labels.includes("accepted") || await hasAcceptedSubmission(context.id)) {
    throw Object.assign(new Error("This submission has already been accepted."), { alreadyAccepted: true });
  }
  if (labels.includes("share-voyage")) {
    const voyage = await voyageFromField(fields["Route file"] ?? fields["Voyage file"]);
    const declaredWorld = declaredWorldFromFields(fields);
    const { key, worldDeclared } = await shareVoyage(voyage, context, declaredWorld);
    const declaredNote = worldDeclared ? " It's marked as using a player-declared world." : "";
    return `Thanks! Your route is now on [its world's page](${site}#world/${key}).${declaredNote}`;
  }
  if (labels.includes("enter-race")) {
    const courseId = fields["Course id"] ?? "";
    const alsoShare = /\[x\]/i.test(fields["Heatmap"] ?? "");
    const result = await enterRace(await voyageFromField(fields["Run file"] ?? fields["Voyage file"]), courseId, alsoShare, context);
    const unshared = result.notShared ? " It wasn't added to the heatmap, because the recording doesn't say which world it was sailed in." : "";
    return `Accepted: ${hours(result.gameHours)} of game time from ${plain(result.startedFrom)}. See [the board](${site}#course/${encodeURIComponent(result.courseId)}).${unshared}`;
  }
  if (labels.includes("create-course")) {
    const { course, updated } = await createCourse(fields["Race"] ?? fields["Course"], context);
    return updated
      ? `Your race has been updated (v${course.version}): [${plain(course.name)}](${site}#course/${course.id}).`
      : `Your race is live: [${plain(course.name)}](${site}#course/${course.id}).`;
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
      title: process.env.ISSUE_TITLE ?? "",
      body: process.env.ISSUE_BODY ?? "",
      submitter: String(process.env.ISSUE_USER ?? "").slice(0, 60),
      site: process.env.SITE_URL ?? ""
    });
    result = { ok: true, message };
  } catch (error) {
    result = error?.alreadyAccepted
      ? { ok: false, alreadyAccepted: true, message: "This submission has already been accepted." }
      : {
          ok: false,
          message: `This submission wasn't accepted: ${plain(error.message)}\n\nYou can fix this by editing your first post above (click \`...\` > \`Edit\`) — it will be checked again automatically without opening a new issue.`
        };
  }
  await writeFile(resultPath, JSON.stringify(result));
  console.log(result.message);
}
