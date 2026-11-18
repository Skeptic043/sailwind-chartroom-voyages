// Chartroom Voyages: reads the JSON the submission Action builds in data/ and shows worlds, heatmaps, shared
// routes (voyage files), races and race boards. Pages: #, #world/<key>, #courses, #course/<id>, #create[/<world key>].
import { ISLAND_CATALOG } from "./vendor/island-catalog.mjs";
import { drawChart, worldIslands } from "./chart.js";
import { showRaceBuilder } from "./builder.js";

const REPOSITORY = "https://github.com/Skeptic043/sailwind-chartroom-voyages";
const page = document.getElementById("page");
const cache = new Map();
let disposeHeatmap = () => {};

document.getElementById("share-link").href = `${REPOSITORY}/issues/new/choose`;

// --- Style and mode -----------------------------------------------------------------------------------
// Sailwind (paper, wood and the game's title type) or Chartroom (the app's chart look), each light or dark.
// Until a mode is picked, it follows the system. Kept in this browser only.
const root = document.documentElement;
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
const ICONS = {
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  compass: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 4.5l2 7.5-2 7.5-2-7.5z" fill="currentColor"/></svg>',
  scroll: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6.5a2 2 0 0 1 1-2zM9 9h7M9 12.5h7M9 16h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
};

function savedView() {
  try {
    return JSON.parse(localStorage.getItem("voyages-view") || "{}");
  } catch {
    return {};
  }
}

function saveView(change) {
  try {
    localStorage.setItem("voyages-view", JSON.stringify({ ...savedView(), ...change }));
  } catch {}
}

const isDark = () => root.dataset.mode ? root.dataset.mode === "dark" : darkScheme.matches;

function renderViewToggles() {
  const chartroom = root.dataset.style === "chartroom";
  const styleButton = document.getElementById("style-toggle");
  styleButton.innerHTML = `${chartroom ? ICONS.compass : ICONS.scroll}<span>${chartroom ? "Chartroom" : "Sailwind"}</span>`;
  styleButton.setAttribute("aria-label", `Style: ${chartroom ? "Chartroom" : "Sailwind"}. Switch style`);
  const modeButton = document.getElementById("mode-toggle");
  modeButton.innerHTML = `${isDark() ? ICONS.moon : ICONS.sun}<span>${isDark() ? "Dark" : "Light"}</span>`;
  modeButton.setAttribute("aria-label", `${isDark() ? "Dark" : "Light"} mode. Switch to ${isDark() ? "light" : "dark"}`);
}

// Charts redraw in the new colours.
function viewChanged() {
  renderViewToggles();
  window.dispatchEvent(new Event("voyages-view"));
}

document.getElementById("style-toggle").addEventListener("click", () => {
  const style = root.dataset.style === "chartroom" ? "sailwind" : "chartroom";
  if (style === "chartroom") root.dataset.style = "chartroom"; else delete root.dataset.style;
  saveView({ style });
  viewChanged();
});
document.getElementById("mode-toggle").addEventListener("click", () => {
  const mode = isDark() ? "light" : "dark";
  root.dataset.mode = mode;
  saveView({ mode });
  viewChanged();
});
darkScheme.addEventListener("change", viewChanged);
renderViewToggles();

async function data(path) {
  // GitHub Pages lets browsers keep files for ten minutes; asking each time shows a new submission at once.
  if (!cache.has(path)) cache.set(path, fetch(path, { cache: "no-cache" }).then((response) => {
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  }));
  return cache.get(path);
}

function element(tag, properties = {}, ...children) {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

const link = (href, text, external = false) => element("a", {
  href,
  textContent: text,
  ...(external && { target: "_blank", rel: "noopener" })
});

function duration(hours) {
  if (!Number.isFinite(hours)) return "—";
  const minutes = Math.round(hours * 60);
  const days = Math.floor(minutes / 1440);
  const rest = `${Math.floor((minutes % 1440) / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  return days ? `${days}d ${rest}` : rest;
}

function realTime(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
}

function setCurrentNavigation(kind) {
  for (const item of document.querySelectorAll(".top nav a")) item.removeAttribute("aria-current");
  const selector = kind === "courses" || kind === "course" || kind === "create" ? 'a[href="#courses"]' : 'a[href="#"]';
  document.querySelector(`.top nav ${selector}`)?.setAttribute("aria-current", "page");
}

// Counts navigations, so a page whose data arrives after the reader moved on is dropped.
let routeToken = 0;
const StalePage = Symbol("stale page");

function stillCurrent(token) {
  if (token !== routeToken) throw StalePage;
}

async function route() {
  const token = ++routeToken;
  disposeHeatmap();
  disposeHeatmap = () => {};

  const [kind, ...rest] = location.hash.replace(/^#/, "").split("/");
  const id = decodeURIComponent(rest.join("/"));

  try {
    if (kind === "world" && id) await showWorld(id, token);
    else if (kind === "course" && id) await showCourse(id, token);
    else if (kind === "create") await showCreate(id, token);
    else if (kind === "courses") await showCourses(token);
    else await showWorlds(token);
  } catch (error) {
    if (error === StalePage || token !== routeToken) return;
    page.replaceChildren(
      element("h1", { textContent: "Not found" }),
      element("p", {
        className: "muted",
        textContent: "This page does not exist, or nothing has been shared here yet."
      })
    );
    console.error(error);
  }

  setCurrentNavigation(kind);
  window.scrollTo(0, 0);
}

function worldDetail(world) {
  if (!world.world || world.world.kind === "vanilla") return "The standard Sailwind world.";
  const w = world.world;
  return `Scrambled Seas seed ${w.seed}, spanning ${w.lonMin}° to ${w.lonMax}° longitude and ${w.latMin}° to ${w.latMax}° latitude${w.scrambledSeas ? `, played with Scrambled Seas ${w.scrambledSeas}` : ""}.`;
}

async function showWorlds(token) {
  const worlds = await data("data/worlds.json");
  stillCurrent(token);
  page.replaceChildren(
    element("h1", { textContent: "Worlds" }),
    element("p", {
      className: "muted",
      textContent: "Maps are ranked by popularity with the vanilla map always being first."
    }),
    element("ul", { className: "cards" }, ...worlds.map((world) => element("li", {},
      link(`#world/${world.key}`, world.name),
      element("span", {
        className: "muted card-meta",
        textContent: ` ${world.voyages} route${world.voyages === 1 ? "" : "s"} · ${world.courses.length} race${world.courses.length === 1 ? "" : "s"}`
      }),
      element("p", { textContent: world.description || worldDetail(world) })
    ))),
    element("p", {},
      Object.assign(
        link(`${REPOSITORY}/issues/new?template=feature-world.yml`, "Add a world", true),
        { className: "action-link" }
      )
    )
  );
}

async function showWorld(key, token) {
  const [world, boards] = await Promise.all([
    data(`data/worlds/${key}.json`),
    data("data/courses.json")
  ]);
  stillCurrent(token);

  const chart = element("div", { className: "chart-frame" });
  const back = link("#", "← Worlds");
  back.className = "back-link";

  page.replaceChildren(
    element("p", {}, back),
    element("h1", { textContent: world.name }),
    element("p", { textContent: world.description || worldDetail(world) }),
    world.featuredBy
      ? element("p", { className: "muted", textContent: `Featured by ${world.featuredBy}` })
      : "",
    world.generatorLink
      ? element("p", {}, link(world.generatorLink, "Open in World Generator", true))
      : "",
    element("h2", { textContent: "Heatmap" }),
    ...heatmapSection(chart, (spoilers) => ({
      heatmap: world.heatmap,
      islands: worldIslands(world),
      bounds: scrambledBounds(world),
      unit: ["route", "routes"],
      spoilers
    })),
    element("h2", { textContent: "Races" }),
    boards.some((board) => board.world === key)
      ? element("ul", { className: "course-list" },
          ...boards.filter((board) => board.world === key).map((board) => element("li", {},
            link(`#course/${board.id}`, board.name),
            element("span", {
              className: "muted",
              textContent: ` ${board.runs} run${board.runs === 1 ? "" : "s"}`
            })
          )))
      : element("p", { className: "muted", textContent: "There are no races here yet." }),
    element("p", {}, Object.assign(link(`#create/${encodeURIComponent(key)}`, "Create a race here"), { className: "action-link" })),
    element("h2", { textContent: "Shared routes" }),
    world.voyageList.length
      ? voyageTable(world.voyageList)
      : element("p", { className: "muted", textContent: "No routes have been shared here yet." }),
    element("p", {
      className: "muted",
      textContent: "Download a route, then open it in Chartroom with Voyage > Compare a route."
    })
  );

}

// A Scrambled Seas world's edges, which its chart shows whole.
function scrambledBounds(world) {
  const w = world?.world;
  return w?.kind === "scrambled" ? { minLat: w.latMin, maxLat: w.latMax, minLon: w.lonMin, maxLon: w.lonMax } : null;
}

// The spoiler switch and the chart. Secret islands and voyages toward them stay hidden until it's on.
function heatmapSection(chart, options) {
  const toggle = element("input", { type: "checkbox" });
  const draw = () => {
    disposeHeatmap();
    disposeHeatmap = drawChart(chart, options(toggle.checked));
  };
  toggle.addEventListener("change", draw);
  // Drawn once the chart is on the page, so it knows its width.
  requestAnimationFrame(draw);
  return [
    element("label", { className: "spoiler-toggle" }, toggle, element("span", { textContent: "Show secret islands (spoilers)" })),
    chart
  ];
}

function tableFrame(table, label) {
  const frame = element("div", { className: "table-wrap", tabIndex: 0 }, table);
  frame.setAttribute("role", "region");
  frame.setAttribute("aria-label", label);
  return frame;
}

function voyageTable(voyages) {
  const table = element("table", {},
    element("thead", {},
      element("tr", {},
        ...["Route", "Shared by", "Distance", "At sea", "Boat", ""].map((text) =>
          element("th", { textContent: text, scope: "col" })
        )
      )
    ),
    element("tbody", {},
      ...voyages.map((voyage) => element("tr", {},
        element("td", { textContent: voyage.name || "Untitled", title: voyage.note }),
        element("td", { textContent: voyage.submitter }),
        element("td", { textContent: `${voyage.distanceNm} nm` }),
        element("td", { textContent: duration(voyage.hours) }),
        element("td", { textContent: voyage.boats.join(", ") }),
        element("td", {},
          element("a", {
            href: voyage.file,
            download: `${voyage.id}.voyage.json`,
            textContent: "Download"
          })
        )
      ))
    )
  );

  return tableFrame(table, "Shared routes");
}

async function showCreate(worldKey, token) {
  const [worlds, courses] = await Promise.all([data("data/worlds.json"), data("data/courses.json")]);
  stillCurrent(token);
  disposeHeatmap = showRaceBuilder(page, {
    worlds,
    courses,
    firstWorld: worldKey || "vanilla",
    loadWorld: (key) => data(`data/worlds/${key}.json`),
    repository: REPOSITORY
  });
}

async function showCourses(token) {
  const [boards, worlds] = await Promise.all([
    data("data/courses.json"),
    data("data/worlds.json")
  ]);
  stillCurrent(token);
  const worldName = (key) => worlds.find((world) => world.key === key)?.name ?? key;

  page.replaceChildren(
    element("h1", { textContent: "Races" }),
    element("ul", { className: "cards" }, ...boards.map((board) => element("li", {},
      link(`#course/${board.id}`, board.name),
      element("span", {
        className: "muted card-meta",
        textContent: ` ${worldName(board.world)} · ${board.runs} run${board.runs === 1 ? "" : "s"}`
      })
    ))),
    element("p", {},
      Object.assign(
        link("#create", "Create a race"),
        { className: "action-link" }
      )
    )
  );
}

function targetName(target) {
  if (!target.island) return target.name;
  return ISLAND_CATALOG.find((island) => island.id === target.island)?.name
    ?? target.island.split("/").at(-1).replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// A spoiler course's rules don't name a secret island it starts or finishes at.
function ruleTargetName(course, target) {
  const secret = course.spoiler && ISLAND_CATALOG.find((island) => island.id === target.island)?.secret;
  return secret ? "a secret island (see the checkpoints)" : targetName(target);
}

function rulesList(course) {
  const rules = course.rules;
  const list = (names) => names.join(", ");
  const lines = [
    course.start.any ? "Start at any checkpoint." : `Start at ${ruleTargetName(course, course.start)}.`,
    course.order === "fixed" ? "Visit the checkpoints in the order listed." : "Visit the checkpoints in any order.",
    course.finish.lastCheckpoint ? "Finish at the last checkpoint you reach." : `Finish at ${ruleTargetName(course, course.finish)}.`
  ];
  if (rules.mods.mode === "block") lines.push(`Not allowed: ${list(rules.mods.plugins)}.`);
  if (rules.mods.mode === "require") lines.push(`Required: ${list(rules.mods.plugins)}.`);
  if (rules.mods.mode === "only") lines.push(`No other mods${rules.mods.plugins.length ? ` except ${list(rules.mods.plugins)}` : ""}. Voyage Recorder and Configuration Manager are always allowed.`);
  if (rules.boats?.length) lines.push(`Boats: ${list(rules.boats)}.`);
  if (rules.oneBoat) lines.push("Use one boat for the whole run.");
  if (Number.isFinite(rules.maxHull)) lines.push(`Hull damage must not exceed ${rules.maxHull}%.`);
  if (rules.honour) lines.push(rules.honour);
  return lines;
}

// The course's flags: where it starts, each checkpoint, and where it finishes. Islands are flagged where the
// world puts them.
function courseFlags(course, islands) {
  const place = (target) => {
    if (!target.island) return { lat: target.lat, lon: target.lon, secret: false };
    const entry = islands.find((candidate) => candidate.island.id === target.island);
    return entry ? { lat: entry.lat, lon: entry.lon, secret: entry.secret } : null;
  };
  const flags = [];
  const add = (target, kind, label) => {
    const at = place(target);
    if (at) flags.push({ ...at, kind, label });
  };
  if (!course.start.any) add(course.start, "start", `Start: ${targetName(course.start)}`);
  course.checkpoints.forEach((target, index) => {
    const last = course.finish.lastCheckpoint && course.order === "fixed" && index === course.checkpoints.length - 1;
    add(target, last ? "finish" : "checkpoint", `${last ? "Finish" : course.order === "fixed" ? `Checkpoint ${index + 1}` : "Checkpoint"}: ${targetName(target)}`);
  });
  if (!course.finish.lastCheckpoint) add(course.finish, "finish", `Finish: ${targetName(course.finish)}`);
  return flags;
}

function checkpointList(course) {
  return element(course.order === "fixed" ? "ol" : "ul", {},
    ...course.checkpoints.map((target) => element("li", { textContent: targetName(target) }))
  );
}

async function showCourse(id, token) {
  const { course, runs, heatmap } = await data(`data/boards/${id}.json`);
  const world = await data(`data/worlds/${course.world}.json`).catch(() => ({ key: course.world }));
  stillCurrent(token);
  const checkpoints = course.spoiler
    ? element("details", {},
        element("summary", {
          textContent: "Show checkpoints (spoilers: includes secret islands)"
        }),
        checkpointList(course)
      )
    : checkpointList(course);

  const back = link("#courses", "← Races");
  back.className = "back-link";

  const enter = link(
    `${REPOSITORY}/issues/new?template=enter-race.yml&course=${encodeURIComponent(course.id)}`,
    "Upload a run",
    true
  );
  enter.className = "action-link";

  const board = runs.length
    ? tableFrame(
        element("table", { className: "rank-table" },
          element("thead", {},
            element("tr", {},
              ...["#", "Player", "Game time", "Real time", "Boat", "Wind", ""].map((text) =>
                element("th", { textContent: text, scope: "col" })
              )
            )
          ),
          element("tbody", {},
            ...runs.map((run) => element("tr", {},
              element("th", { textContent: String(run.rank), scope: "row" }),
              element("td", { textContent: run.submitter }),
              element("td", {
                textContent: duration(run.gameHours),
                title: run.splits.map((split) => `${split.name}: ${duration(split.hours)}`).join("\n")
              }),
              element("td", { textContent: realTime(run.irlSeconds) }),
              element("td", { textContent: run.boat }),
              element("td", {
                textContent: Number.isFinite(run.windKnots) ? `${run.windKnots} kn` : "—"
              }),
              element("td", {},
                element("a", {
                  href: run.file,
                  download: `${course.id}-${run.id}.voyage.json`,
                  textContent: "Download"
                })
              )
            ))
          )
        ),
        "Race board"
      )
    : element("p", {
        className: "muted",
        textContent: "No runs have been entered yet. Be the first."
      });

  page.replaceChildren(
    element("p", {}, back),
    element("h1", { textContent: course.name }),
    course.author ? element("p", { className: "byline", textContent: `Created by ${course.author}` }) : "",
    element("p", { textContent: course.description }),
    element("h2", { textContent: "Rules" }),
    element("ul", { className: "rules" },
      ...rulesList(course).map((line) => element("li", { textContent: line }))
    ),
    element("h2", { textContent: "Checkpoints" }),
    checkpoints,
    element("h2", { textContent: "Course map" }),
    ...heatmapSection(element("div", { className: "chart-frame" }), (spoilers) => {
      const islands = worldIslands(world);
      return {
        heatmap: heatmap ?? { cellDegrees: 0.2, cells: {} },
        islands,
        bounds: scrambledBounds(world),
        flags: courseFlags(course, islands),
        unit: ["run", "runs"],
        spoilers
      };
    }),
    element("p", {}, enter),
    element("h2", { textContent: "Board" }),
    board,
    runs.length
      ? element("p", {
          className: "muted",
          textContent: "Download a run and open it in Chartroom with Voyage > Compare a route to sail against it."
        })
      : ""
  );
}

window.addEventListener("hashchange", route);
route();
