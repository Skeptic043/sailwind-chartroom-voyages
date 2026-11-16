// Create a race: pick a world, click the map to place the start, checkpoints and finish, set the rules, and
// Submit opens the site's GitHub form with the race filled in. The site checks it again when the form is posted.
// Clicking an island uses the island itself on vanilla; Scrambled Seas islands move between worlds' versions,
// so there a click on one places a mark where this world put it.
import { drawChart, worldIslands } from "./chart.js";
import { validateCourse } from "./lib/course.mjs";

const MAX_FORM_URL = 8000;
const ISLAND_MARK_NM = 2;
const WATER_MARK_NM = 3;

const element = (tag, properties = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
};

const field = (label, control, hint) => element("label", { className: "field" }, element("span", { textContent: label }), control, hint ? element("small", { textContent: hint }) : null);

function slug(text) {
  return String(text).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}

// Renders the page into page. worlds: the site's world list; loadWorld(key): that world's data; courses: the
// existing courses, so a taken id is caught here; repository: the site's GitHub repository. Returns a function
// that removes the chart.
export function showRaceBuilder(page, { worlds, loadWorld, courses, repository, firstWorld }) {
  const state = { world: null, islands: [], placing: "start", start: null, checkpoints: [], finish: null, idEdited: false };
  let chart = null;

  const worldSelect = element("select", {}, ...worlds.map((world) => new Option(world.name, world.key)));
  if (worlds.some((world) => world.key === firstWorld)) worldSelect.value = firstWorld;
  const spoilers = element("input", { type: "checkbox" });
  const modeButtons = ["start", "checkpoint", "finish"].map((mode) => {
    const button = element("button", { type: "button", className: `place-${mode}`, textContent: { start: "Start", checkpoint: "Checkpoint", finish: "Finish" }[mode] });
    button.addEventListener("click", () => { state.placing = mode; render(); });
    return [mode, button];
  });
  const startAny = element("input", { type: "checkbox", checked: false });
  const finishLast = element("input", { type: "checkbox", checked: true });
  const order = element("select", {}, new Option("In any order", "any"), new Option("In the order listed", "fixed"));
  const list = element("ol", { className: "builder-list" });
  const frame = element("div", { className: "chart-frame builder-chart" });

  const name = element("input", { maxLength: 80, placeholder: "Round the Emeralds" });
  const id = element("input", { maxLength: 60, placeholder: "round-the-emeralds" });
  const description = element("textarea", { maxLength: 1000, rows: 3, placeholder: "What the race is about, and anything racers should know." });
  const sortBy = element("select", {}, new Option("Game time", "game"), new Option("Real time", "irl"));
  const mods = element("select", {}, new Option("Any mods", "any"), new Option("No other mods, except those listed", "only"), new Option("These mods are not allowed", "block"), new Option("These mods are required", "require"));
  const plugins = element("textarea", { rows: 2, placeholder: "One plugin id per line, such as com.example.speedmod" });
  const boats = element("input", { placeholder: "Leave empty for any boat, or list them: Dhow, Cog" });
  const oneBoat = element("input", { type: "checkbox" });
  const maxHull = element("input", { type: "number", min: 0, max: 100, step: 1, placeholder: "Any" });
  const honour = element("textarea", { maxLength: 500, rows: 2, placeholder: "Anything else racers agree to, such as no sleeping." });
  const message = element("p", { className: "builder-message", role: "status" });
  const submit = element("button", { type: "button", className: "action-button", textContent: "Submit race" });
  const fallback = element("div", { className: "builder-fallback", hidden: true });

  name.addEventListener("input", () => { if (!state.idEdited) id.value = slug(name.value); validate(); });
  id.addEventListener("input", () => { state.idEdited = id.value !== ""; validate(); });
  for (const control of [description, sortBy, plugins, boats, oneBoat, maxHull, honour]) control.addEventListener("input", validate);
  mods.addEventListener("change", () => { render(); });
  order.addEventListener("change", render);
  // A placed start or finish stays when these are ticked: it becomes one of the checkpoints, so racers can still
  // start or finish there.
  startAny.addEventListener("change", render);
  finishLast.addEventListener("change", render);
  spoilers.addEventListener("change", drawMap);
  worldSelect.addEventListener("change", () => {
    state.start = null;
    state.checkpoints = [];
    state.finish = null;
    loadSelectedWorld();
  });
  submit.addEventListener("click", submitRace);

  page.replaceChildren(
    element("h1", { textContent: "Create a race" }),
    element("p", { textContent: "Pick a world, then click the map to place the start, the checkpoints and the finish. Click an island to use it, or open water for a mark. When it's ready, Submit race opens a GitHub form with everything filled in: post it and the race goes live." }),
    element("p", { className: "muted" }, "You can also plan a route in ", element("a", { href: "https://github.com/Skeptic043/sailwind-chartroom", target: "_blank", rel: "noopener", textContent: "Sailwind Chartroom" }), " and use Publish as race. Not seeing your Scrambled Seas world? ", element("a", { href: `${repository}/issues/new?template=feature-world.yml`, target: "_blank", rel: "noopener", textContent: "Add it first" }), "."),
    element("div", { className: "builder-bar" },
      field("World", worldSelect),
      element("div", { className: "builder-modes", role: "group", ariaLabel: "What a click places" }, element("span", { textContent: "Click places" }), ...modeButtons.map(([, button]) => button)),
      element("label", { className: "spoiler-toggle" }, spoilers, element("span", { textContent: "Show secret islands (spoilers)" }))
    ),
    frame,
    element("div", { className: "builder-columns" },
      element("section", {},
        element("h2", { textContent: "Course" }),
        element("label", { className: "check" }, startAny, element("span", { textContent: "Start at any checkpoint" })),
        element("label", { className: "check" }, finishLast, element("span", { textContent: "Finish at the last checkpoint reached" })),
        element("p", { className: "muted builder-hint", textContent: "With either ticked, a start or finish you placed stays and counts as a checkpoint, so racers can still start or finish there." }),
        field("Checkpoints", order),
        list
      ),
      element("section", {},
        element("h2", { textContent: "Details" }),
        field("Name", name),
        field("Race id", id, "Lowercase letters, numbers and dashes. It can't be changed later."),
        field("Description", description),
        element("h2", { textContent: "Rules" }),
        field("Rank runs by", sortBy),
        field("Mods", mods),
        field("Plugin ids", plugins),
        field("Boats", boats),
        element("label", { className: "check" }, oneBoat, element("span", { textContent: "One boat for the whole run" })),
        field("Most hull damage allowed, %", maxHull),
        field("Other rules", honour)
      )
    ),
    message,
    element("p", {}, submit),
    fallback
  );

  // --- Placing --------------------------------------------------------------------------------------

  function targetFor({ lat, lon, island }) {
    if (island) {
      if (state.world.key === "vanilla") return { island: island.island.id, label: island.island.name, lat: island.lat, lon: island.lon, secret: island.secret };
      return { name: island.island.name, lat: round(island.lat), lon: round(island.lon), radiusNm: ISLAND_MARK_NM, label: island.island.name, secret: island.secret };
    }
    const number = [state.start, ...state.checkpoints, state.finish].filter((target) => target && !target.island).length + 1;
    return { name: `Mark ${number}`, lat: round(lat), lon: round(lon), radiusNm: WATER_MARK_NM, label: `Mark ${number}`, secret: false };
  }

  function place(click) {
    if (!state.world) return;
    const target = targetFor(click);
    if (state.placing === "start") {
      state.start = target;
      startAny.checked = false;
      state.placing = "checkpoint";
    } else if (state.placing === "finish") {
      state.finish = target;
      finishLast.checked = false;
      state.placing = "checkpoint";
    } else state.checkpoints.push(target);
    render();
  }

  function flags() {
    const fixed = order.value === "fixed";
    const result = [];
    if (state.start) result.push({ ...state.start, kind: "start", label: `Start${startAny.checked ? " (or any checkpoint)" : ""}: ${state.start.label}` });
    state.checkpoints.forEach((target, index) => {
      const last = finishLast.checked && fixed && !state.finish && index === state.checkpoints.length - 1;
      result.push({ ...target, kind: last ? "finish" : "checkpoint", label: `${last ? "Finish" : fixed ? `Checkpoint ${index + 1}` : "Checkpoint"}: ${target.label}` });
    });
    if (state.finish) result.push({ ...state.finish, kind: "finish", label: `Finish${finishLast.checked ? " (or the last checkpoint)" : ""}: ${state.finish.label}` });
    return result;
  }

  function row(target, kind, index) {
    const remove = element("button", { type: "button", className: "icon", textContent: "×", title: "Remove" });
    remove.addEventListener("click", () => {
      if (kind === "start") state.start = null;
      else if (kind === "finish") state.finish = null;
      else state.checkpoints.splice(index, 1);
      render();
    });
    const controls = [remove];
    if (kind === "checkpoint") {
      for (const [text, step, title] of [["↑", -1, "Move up"], ["↓", 1, "Move down"]]) {
        const move = element("button", { type: "button", className: "icon", textContent: text, title, disabled: index + step < 0 || index + step >= state.checkpoints.length });
        move.addEventListener("click", () => {
          const [moved] = state.checkpoints.splice(index, 1);
          state.checkpoints.splice(index + step, 0, moved);
          render();
        });
        controls.unshift(move);
      }
    }
    const radius = target.island ? null : element("input", { type: "number", min: 0.5, max: 50, step: 0.5, value: target.radiusNm, title: "How close counts as reaching it, in nautical miles" });
    radius?.addEventListener("change", () => { target.radiusNm = Math.min(50, Math.max(0.5, radius.valueAsNumber || WATER_MARK_NM)); validate(); });
    const nameInput = target.island ? null : element("input", { value: target.name, maxLength: 60, title: "Name" });
    nameInput?.addEventListener("input", () => { target.name = nameInput.value.trim() || target.label; target.label = target.name; chart?.setFlags(flags()); validate(); });
    return element("li", { className: `builder-${kind}` },
      element("strong", { textContent: { start: "Start", checkpoint: "Checkpoint", finish: "Finish" }[kind], title: (kind === "start" && startAny.checked) || (kind === "finish" && finishLast.checked) ? "Also a checkpoint" : "" }),
      nameInput ?? element("span", { textContent: target.label }),
      radius ? element("label", { className: "radius" }, radius, element("span", { textContent: "nm" })) : null,
      element("span", { className: "row-controls" }, ...controls));
  }

  function render() {
    for (const [mode, button] of modeButtons) button.setAttribute("aria-pressed", String(state.placing === mode));
    if (startAny.checked && order.value === "fixed") order.value = "any";
    order.disabled = startAny.checked;
    plugins.closest("label").hidden = mods.value === "any";
    list.replaceChildren(
      ...(state.start ? [row(state.start, "start")] : []),
      ...state.checkpoints.map((target, index) => row(target, "checkpoint", index)),
      ...(state.finish ? [row(state.finish, "finish")] : [])
    );
    if (!list.children.length) list.append(element("li", { className: "muted", textContent: "Nothing placed yet." }));
    chart?.setFlags(flags());
    validate();
  }

  // --- The race -------------------------------------------------------------------------------------

  const strip = ({ label, secret, ...target }) => target;

  function course() {
    const targets = [state.start, ...state.checkpoints, state.finish].filter(Boolean);
    const checkpoints = [
      ...(startAny.checked && state.start ? [state.start] : []),
      ...state.checkpoints,
      ...(finishLast.checked && state.finish ? [state.finish] : [])
    ];
    return {
      id: id.value.trim(),
      version: 1,
      name: name.value.trim(),
      description: description.value.trim(),
      world: state.world?.key,
      start: startAny.checked || !state.start ? { any: true } : strip(state.start),
      checkpoints: checkpoints.map(strip),
      order: order.value,
      finish: finishLast.checked || !state.finish ? { lastCheckpoint: true } : strip(state.finish),
      spoiler: targets.some((target) => target.secret),
      rules: {
        sortBy: sortBy.value,
        mods: { mode: mods.value, plugins: mods.value === "any" ? [] : plugins.value.split(/[\s,]+/).map((guid) => guid.trim()).filter(Boolean) },
        boats: boats.value.trim() ? boats.value.split(",").map((boat) => boat.trim()).filter(Boolean) : null,
        oneBoat: oneBoat.checked,
        maxHull: Number.isFinite(maxHull.valueAsNumber) ? maxHull.valueAsNumber : null,
        honour: honour.value.trim()
      }
    };
  }

  // What still stands in the way, or null when the race can be submitted.
  function problem() {
    if (!state.world) return state.loadError ?? "Loading the world…";
    if (!startAny.checked && !state.start) return "Place a start, or tick Start at any checkpoint.";
    if (!finishLast.checked && !state.finish) return "Place a finish, or tick Finish at the last checkpoint reached.";
    if (!state.checkpoints.length && !(startAny.checked && state.start) && !(finishLast.checked && state.finish)) return "Place at least one checkpoint.";
    if (!name.value.trim()) return "Give the race a name.";
    if (maxHull.value !== "" && !(Number.isInteger(maxHull.valueAsNumber) && maxHull.valueAsNumber >= 0 && maxHull.valueAsNumber <= 100)) return "Hull damage is a whole number from 0 to 100.";
    try {
      const checked = validateCourse(course());
      if (courses.some((other) => other.id === checked.id)) return `A race with the id "${checked.id}" already exists. Choose another id.`;
    } catch (error) {
      return error.message;
    }
    return null;
  }

  // A copied race from Submit race no longer matches once anything changes.
  function clearFallback() {
    fallback.hidden = true;
    fallback.replaceChildren();
  }

  function validate() {
    clearFallback();
    const issue = problem();
    message.textContent = issue ?? "Ready to submit.";
    message.classList.toggle("ready", !issue);
    submit.disabled = Boolean(issue);
  }

  function submitRace() {
    if (problem()) return validate();
    const { author, ...submission } = validateCourse(course());
    const json = JSON.stringify(submission, null, 2);
    const url = `${repository}/issues/new?${new URLSearchParams({ template: "create-course.yml", course: json })}`;
    if (url.length <= MAX_FORM_URL) {
      window.open(url, "_blank", "noopener");
      fallback.hidden = true;
      message.textContent = "The form opened in a new tab. Post it there and the race goes live in a minute or two.";
      return;
    }
    // Too long for a link: copy it into the form instead.
    const text = element("textarea", { readOnly: true, rows: 10, value: json });
    const copy = element("button", { type: "button", className: "action-button", textContent: "Copy race" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(json);
        copy.textContent = "Copied";
      } catch {
        text.select();
      }
    });
    fallback.replaceChildren(
      element("p", {}, "This race is too long to fill in by link. Copy it, then paste it into the Race box of ", element("a", { href: `${repository}/issues/new?template=create-course.yml`, target: "_blank", rel: "noopener", textContent: "the Create a race form" }), "."),
      text, element("p", {}, copy));
    fallback.hidden = false;
  }

  // --- The map --------------------------------------------------------------------------------------

  function drawMap() {
    chart?.();
    chart = drawChart(frame, {
      heatmap: state.world.heatmap ?? { cellDegrees: 0.2, cells: {} },
      islands: state.islands,
      bounds: state.world.world?.kind === "scrambled" ? { minLat: state.world.world.latMin, maxLat: state.world.world.latMax, minLon: state.world.world.lonMin, maxLon: state.world.world.lonMax } : null,
      flags: flags(),
      unit: ["voyage", "voyages"],
      spoilers: spoilers.checked,
      onPick: place
    });
  }

  // Nothing can be placed until the chosen world's map has loaded, so no mark lands on another world's map.
  async function loadSelectedWorld() {
    const key = worldSelect.value;
    chart?.();
    chart = null;
    frame.replaceChildren(element("p", { className: "builder-loading", textContent: "Loading the map…" }));
    state.world = null;
    state.loadError = null;
    render();
    let world;
    try {
      world = await loadWorld(key);
    } catch {
      if (worldSelect.value !== key) return;
      state.loadError = "This world's map couldn't be loaded. Reload the page to try again.";
      frame.replaceChildren(element("p", { className: "builder-loading", textContent: state.loadError }));
      render();
      return;
    }
    if (worldSelect.value !== key) return;
    state.world = world;
    state.islands = worldIslands(world);
    drawMap();
    render();
  }

  render();
  requestAnimationFrame(loadSelectedWorld);
  return () => chart?.();
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}
