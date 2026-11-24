// Create or edit a race: pick a world, click the map (or search vanilla islands by name/initials) to place
// the start, checkpoints and finish, set the rules, optionally test a .voyage.json run locally, and Submit
// opens the site's GitHub form with the race filled in.
// Clicking an island (or within its reach) uses the island itself on vanilla; hold Shift to force an
// open-water mark. Scrambled Seas islands move between worlds' versions, so there a click places a mark.
import { drawChart, worldIslands } from "./chart.js";
import { validateCourse } from "./lib/course.mjs";
import { findIslands, islandById, matchIslandName } from "./lib/islands.mjs";
import { checkRun } from "./lib/race.mjs";
import { parseVoyage } from "./lib/voyage.mjs";

const MAX_FORM_URL = 8000;
const ISLAND_MARK_NM = 2;
const WATER_MARK_NM = 3;
const SMALL_MARK_WARNING_NM = 1.5;

const element = (tag, properties = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), properties);
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
};

const field = (label, control, hint) => element("label", { className: "field" }, element("span", { textContent: label }), control, hint ? element("small", { textContent: hint }) : null);

function slug(text) {
  return String(text).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
}

function duration(hours) {
  if (!Number.isFinite(hours)) return "—";
  const minutes = Math.round(hours * 60);
  const days = Math.floor(minutes / 1440);
  const rest = `${Math.floor((minutes % 1440) / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  return days ? `${days}d ${rest}` : rest;
}

function targetFromCourse(target) {
  if (target?.island) {
    const island = islandById(target.island);
    if (!island) return null;
    return { island: island.id, label: island.name, lat: island.lat, lon: island.lon, secret: island.secret };
  }
  if (Number.isFinite(target?.lat) && Number.isFinite(target?.lon)) {
    const label = String(target.name ?? "Mark");
    return { name: label, lat: round(target.lat), lon: round(target.lon), radiusNm: Number(target.radiusNm) || WATER_MARK_NM, label, secret: false };
  }
  return null;
}

function sameTarget(a, b) {
  if (!a || !b) return false;
  return a.island ? a.island === b.island : !b.island && a.lat === b.lat && a.lon === b.lon;
}

// Renders the page into page. worlds: the site's world list; loadWorld(key): that world's data; courses: the
// existing courses, so a taken id is caught here; repository: the site's GitHub repository; editingCourse:
// optional existing course being updated by its author. Returns a function that removes the chart.
export function showRaceBuilder(page, { worlds, loadWorld, courses, repository, firstWorld, editingCourse = null }) {
  const editing = Boolean(editingCourse);
  const state = {
    world: null,
    islands: [],
    placing: editing ? "checkpoint" : "start",
    start: null,
    checkpoints: [],
    finish: null,
    idEdited: editing,
    testVoyage: null,
    testFileName: ""
  };
  let chart = null;

  const worldSelect = element("select", { disabled: editing }, ...worlds.map((world) => new Option(world.name, world.key)));
  const initialWorld = editingCourse?.world || firstWorld;
  if (worlds.some((world) => world.key === initialWorld)) worldSelect.value = initialWorld;
  const spoilers = element("input", { type: "checkbox", checked: editingCourse?.spoiler === true });
  const modeButtons = ["start", "checkpoint", "finish"].map((mode) => {
    const button = element("button", { type: "button", className: `place-${mode}`, textContent: { start: "Start", checkpoint: "Checkpoint", finish: "Finish" }[mode] });
    button.addEventListener("click", () => { state.placing = mode; render(); });
    return [mode, button];
  });
  const startAny = element("input", { type: "checkbox", checked: false });
  const finishLast = element("input", { type: "checkbox", checked: true });
  const order = element("select", {}, new Option("In any order", "any"), new Option("In the order listed", "fixed"));
  const islandSearchInput = element("input", { type: "search", placeholder: "Add island by name or initials (e.g. FFT, Kicia Bay)…", autocomplete: "off" });
  const islandSuggestions = element("div", { className: "island-suggestions", hidden: true });
  const islandSearchWrap = element("div", { className: "island-picker" },
    element("span", { className: "island-picker-label", textContent: "Quick-add island" }),
    islandSearchInput,
    islandSuggestions
  );
  const returnToStart = element("button", { type: "button", className: "secondary-button", textContent: "Return to start", hidden: true });
  const list = element("ol", { className: "builder-list" });
  const frame = element("div", { className: "chart-frame builder-chart" });

  const name = element("input", { maxLength: 80, placeholder: "Round the Emeralds" });
  const id = element("input", { maxLength: 60, placeholder: "round-the-emeralds", readOnly: editing });
  const description = element("textarea", { maxLength: 1000, rows: 3, placeholder: "What the race is about, and anything racers should know." });
  const sortBy = element("select", {}, new Option("Game time", "game"), new Option("Real time", "irl"));
  const mods = element("select", {}, new Option("Any mods", "any"), new Option("No other mods, except those listed", "only"), new Option("These mods are not allowed", "block"), new Option("These mods are required", "require"));
  const plugins = element("textarea", { rows: 2, placeholder: "One plugin id per line, such as com.example.speedmod" });
  const boats = element("input", { placeholder: "Leave empty for any boat, or list them: Dhow, Cog" });
  const oneBoat = element("input", { type: "checkbox" });
  const maxHull = element("input", { type: "number", min: 0, max: 100, step: 1, placeholder: "Any" });
  const honour = element("textarea", { maxLength: 500, rows: 2, placeholder: "Anything else racers agree to, such as no sleeping." });

  const testFileInput = element("input", { type: "file", accept: ".json,application/json" });
  const testResult = element("p", { className: "builder-test-result muted", textContent: "Drop or choose a .voyage.json file to check a run against this draft before submitting." });
  const testBox = element("div", { className: "builder-test" },
    element("h2", { textContent: "Test a run" }),
    element("label", { className: "field" }, element("span", { textContent: "Check a .voyage.json file (optional)" }), testFileInput),
    testResult
  );

  const message = element("p", { className: "builder-message", role: "status" });
  const submit = element("button", { type: "button", className: "action-button", textContent: editing ? "Submit update" : "Submit race" });
  const fallback = element("div", { className: "builder-fallback", hidden: true });

  if (editingCourse) {
    startAny.checked = editingCourse.start?.any === true;
    finishLast.checked = editingCourse.finish?.lastCheckpoint === true;
    state.start = startAny.checked ? null : targetFromCourse(editingCourse.start);
    state.checkpoints = (editingCourse.checkpoints ?? []).map(targetFromCourse).filter(Boolean);
    state.finish = finishLast.checked ? null : targetFromCourse(editingCourse.finish);
    order.value = editingCourse.order === "fixed" ? "fixed" : "any";
    name.value = editingCourse.name ?? "";
    id.value = editingCourse.id ?? "";
    description.value = editingCourse.description ?? "";
    sortBy.value = editingCourse.rules?.sortBy === "irl" ? "irl" : "game";
    mods.value = editingCourse.rules?.mods?.mode ?? "any";
    plugins.value = (editingCourse.rules?.mods?.plugins ?? []).join("\n");
    boats.value = (editingCourse.rules?.boats ?? []).join(", ");
    oneBoat.checked = editingCourse.rules?.oneBoat === true;
    maxHull.value = Number.isFinite(editingCourse.rules?.maxHull) ? String(editingCourse.rules.maxHull) : "";
    honour.value = editingCourse.rules?.honour ?? "";
  }

  name.addEventListener("input", () => { if (!state.idEdited) id.value = slug(name.value); validate(); });
  id.addEventListener("input", () => { if (!editing) { state.idEdited = id.value !== ""; validate(); } });
  for (const control of [description, sortBy, plugins, boats, oneBoat, maxHull, honour]) control.addEventListener("input", validate);
  mods.addEventListener("change", () => { render(); });
  order.addEventListener("change", render);
  // A placed start or finish stays when these are ticked: it becomes one of the checkpoints, so racers can still
  // start or finish there.
  startAny.addEventListener("change", render);
  finishLast.addEventListener("change", render);
  spoilers.addEventListener("change", () => { drawMap(); updateIslandSuggestions(); });
  worldSelect.addEventListener("change", () => {
    state.start = null;
    state.checkpoints = [];
    state.finish = null;
    loadSelectedWorld();
  });
  returnToStart.addEventListener("click", () => {
    if (!state.start) return;
    state.finish = { ...state.start };
    finishLast.checked = false;
    render();
  });
  submit.addEventListener("click", submitRace);

  // Quick-add island search.
  function addIslandTarget(island) {
    placeTarget({ island: island.id, label: island.name, lat: island.lat, lon: island.lon, secret: island.secret });
    islandSearchInput.value = "";
    islandSuggestions.hidden = true;
    islandSuggestions.replaceChildren();
  }

  function updateIslandSuggestions() {
    const query = islandSearchInput.value.trim();
    if (!query || state.world?.key !== "vanilla") {
      islandSuggestions.hidden = true;
      islandSuggestions.replaceChildren();
      return;
    }
    const matches = findIslands(query, { spoilers: spoilers.checked }).slice(0, 6);
    if (!matches.length) {
      islandSuggestions.replaceChildren(element("span", { className: "muted island-no-match", textContent: "No matching island." }));
      islandSuggestions.hidden = false;
      return;
    }
    islandSuggestions.replaceChildren(...matches.map((island) => {
      const btn = element("button", { type: "button", className: "island-suggestion" },
        element("strong", { textContent: island.name }),
        element("small", { textContent: island.region })
      );
      btn.addEventListener("click", () => addIslandTarget(island));
      return btn;
    }));
    islandSuggestions.hidden = false;
  }

  islandSearchInput.addEventListener("input", updateIslandSuggestions);
  islandSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const matches = findIslands(islandSearchInput.value.trim(), { spoilers: spoilers.checked });
    if (matches.length) addIslandTarget(matches[0]);
  });

  // Optional local run check.
  async function loadTestFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      state.testVoyage = parseVoyage(JSON.parse(text));
      state.testFileName = file.name;
    } catch (error) {
      state.testVoyage = null;
      state.testFileName = "";
      testResult.className = "builder-test-result problem";
      testResult.textContent = error.message || "Couldn't read that file as a .voyage.json route.";
      return;
    }
    updateTestResult();
  }

  testFileInput.addEventListener("change", () => loadTestFile(testFileInput.files?.[0]));
  testBox.addEventListener("dragover", (event) => { event.preventDefault(); testBox.classList.add("drag-over"); });
  testBox.addEventListener("dragleave", () => testBox.classList.remove("drag-over"));
  testBox.addEventListener("drop", (event) => {
    event.preventDefault();
    testBox.classList.remove("drag-over");
    loadTestFile(event.dataTransfer?.files?.[0]);
  });

  page.replaceChildren(
    editing ? element("p", {}, element("a", { className: "back-link", href: `#course/${encodeURIComponent(editingCourse.id)}`, textContent: `← Back to ${editingCourse.name}` })) : null,
    element("h1", { textContent: editing ? `Edit ${editingCourse.name}` : "Create a race" }),
    element("p", {
      textContent: editing
        ? "Adjust the stops or rules below, then click Submit update to open the GitHub form. Only the original author can update this race; previous versions stay recorded in the race's edit history."
        : "Pick a world, then click the map (or search vanilla islands by name or initials like FFT) to place the start, checkpoints and finish. Click near an island to use the island itself, or hold Shift for an open-water mark."
    }),
    !editing ? element("p", { className: "muted" }, "You can also plan a route in ", element("a", { href: "https://github.com/Skeptic043/sailwind-chartroom", target: "_blank", rel: "noopener", textContent: "Sailwind Chartroom" }), " and use Publish route as race. Not seeing your Scrambled Seas world? ", element("a", { href: `${repository}/issues/new?template=feature-world.yml`, target: "_blank", rel: "noopener", textContent: "Add it first" }), ".") : null,
    element("div", { className: "builder-bar" },
      field("World", worldSelect),
      element("div", { className: "builder-modes", role: "group", ariaLabel: "What a click places" }, element("span", { textContent: "Click places" }), ...modeButtons.map(([, button]) => button)),
      element("label", { className: "spoiler-toggle" }, spoilers, element("span", { textContent: "Show secret islands (spoilers)" }))
    ),
    frame,
    element("div", { className: "builder-columns" },
      element("section", {},
        element("h2", { textContent: "Course" }),
        islandSearchWrap,
        element("label", { className: "check" }, startAny, element("span", { textContent: "Start at any checkpoint" })),
        element("label", { className: "check" }, finishLast, element("span", { textContent: "Finish at the last checkpoint reached" })),
        element("p", { className: "muted builder-hint", textContent: "With either ticked, a start or finish you placed stays and counts as a checkpoint, so racers can still start or finish there." }),
        element("div", { className: "builder-course-actions" }, field("Checkpoints", order), returnToStart),
        list
      ),
      element("section", {},
        element("h2", { textContent: "Details" }),
        field("Name", name),
        field("Race id", id, editing ? "The race id stays the same when updating an existing race." : "Lowercase letters, numbers and dashes. It can't be changed later."),
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
    testBox,
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

  function placeTarget(target) {
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

  function place(click) {
    if (!state.world) return;
    placeTarget(targetFor(click));
  }

  function replaceSlot(kind, index, nextTarget) {
    if (kind === "start") state.start = nextTarget;
    else if (kind === "finish") state.finish = nextTarget;
    else state.checkpoints[index] = nextTarget;
    render();
  }

  function flags() {
    const fixed = order.value === "fixed";
    const result = [];
    const flagFor = (target, kind, label) => ({
      ...target,
      kind,
      label,
      ...(target.island ? {} : { radiusNm: target.radiusNm })
    });
    if (state.start) result.push(flagFor(state.start, "start", `Start${startAny.checked ? " (or any checkpoint)" : ""}: ${state.start.label}${state.start.island ? " (island)" : ` (${state.start.radiusNm} nm mark)`}`));
    state.checkpoints.forEach((target, index) => {
      const last = finishLast.checked && fixed && !state.finish && index === state.checkpoints.length - 1;
      const suffix = target.island ? " (island)" : ` (${target.radiusNm} nm mark)`;
      result.push(flagFor(target, last ? "finish" : "checkpoint", `${last ? "Finish" : fixed ? `Checkpoint ${index + 1}` : "Checkpoint"}: ${target.label}${suffix}`));
    });
    if (state.finish) result.push(flagFor(state.finish, "finish", `Finish${finishLast.checked ? " (or the last checkpoint)" : ""}: ${state.finish.label}${state.finish.island ? " (island)" : ` (${state.finish.radiusNm} nm mark)`}`));
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
    const badge = element("span", {
      className: `target-badge ${target.island ? "is-island" : "is-mark"}`,
      textContent: target.island ? "Island" : "Mark",
      title: target.island ? "Counts port visits and island reach" : "Open-water circle; port visits do not count"
    });
    const noteWrap = element("div", { className: "row-hints" });

    function refreshRowHints() {
      noteWrap.replaceChildren();
      if (target.island) return;
      if (state.world?.key === "vanilla") {
        const matched = matchIslandName(target.name, { spoilers: true });
        if (matched) {
          const swap = element("button", { type: "button", className: "inline-action", textContent: "Use island" });
          swap.addEventListener("click", () => {
            replaceSlot(kind, index, { island: matched.id, label: matched.name, lat: matched.lat, lon: matched.lon, secret: matched.secret });
          });
          noteWrap.append(element("span", { className: "row-hint" }, `Matches ${matched.name} island. `, swap));
        }
      }
      if (Number(target.radiusNm) < SMALL_MARK_WARNING_NM) {
        noteWrap.append(element("span", { className: "row-hint warning", textContent: `Small radius (${target.radiusNm} nm): sparse tracks may skip past it.` }));
      }
    }

    const radius = target.island ? null : element("input", { type: "number", min: 0.5, max: 50, step: 0.5, value: target.radiusNm, title: "How close counts as reaching it, in nautical miles" });
    radius?.addEventListener("change", () => {
      target.radiusNm = Math.min(50, Math.max(0.5, radius.valueAsNumber || WATER_MARK_NM));
      radius.value = String(target.radiusNm);
      refreshRowHints();
      chart?.setFlags(flags(), { ordered: order.value === "fixed" });
      validate();
    });
    const nameInput = target.island ? null : element("input", { value: target.name, maxLength: 60, title: "Mark name" });
    nameInput?.addEventListener("input", () => {
      target.name = nameInput.value.trim() || target.label;
      target.label = target.name;
      refreshRowHints();
      chart?.setFlags(flags(), { ordered: order.value === "fixed" });
      validate();
    });
    refreshRowHints();

    return element("li", { className: `builder-${kind}` },
      element("div", { className: "row-main" },
        element("strong", { textContent: { start: "Start", checkpoint: "Checkpoint", finish: "Finish" }[kind], title: (kind === "start" && startAny.checked) || (kind === "finish" && finishLast.checked) ? "Also a checkpoint" : "" }),
        badge,
        nameInput ?? element("span", { className: "row-label", textContent: target.label }),
        radius ? element("label", { className: "radius" }, radius, element("span", { textContent: "nm" })) : null,
        element("span", { className: "row-controls" }, ...controls)
      ),
      noteWrap
    );
  }

  function render() {
    for (const [mode, button] of modeButtons) button.setAttribute("aria-pressed", String(state.placing === mode));
    if (startAny.checked && order.value === "fixed") order.value = "any";
    order.disabled = startAny.checked;
    plugins.closest("label").hidden = mods.value === "any";
    islandSearchWrap.hidden = state.world?.key !== "vanilla";
    returnToStart.hidden = !state.start || (!finishLast.checked && sameTarget(state.start, state.finish));
    list.replaceChildren(
      ...(state.start ? [row(state.start, "start")] : []),
      ...state.checkpoints.map((target, index) => row(target, "checkpoint", index)),
      ...(state.finish ? [row(state.finish, "finish")] : [])
    );
    if (!list.children.length) list.append(element("li", { className: "muted", textContent: "Nothing placed yet." }));
    chart?.setFlags(flags(), { ordered: order.value === "fixed" });
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
      version: editingCourse?.version ?? 1,
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
      if (!editing && courses.some((other) => other.id === checked.id)) return `A race with the id "${checked.id}" already exists. Choose another id.`;
    } catch (error) {
      return error.message;
    }
    return null;
  }

  function updateTestResult() {
    if (!state.testVoyage) return;
    const draftProblem = problem();
    if (draftProblem) {
      testResult.className = "builder-test-result muted";
      testResult.textContent = `${state.testFileName}: finish the course above first (${draftProblem})`;
      return;
    }
    const result = checkRun(validateCourse(course()), state.testVoyage);
    if (result.ok) {
      testResult.className = "builder-test-result ready";
      testResult.textContent = `${state.testFileName}: passes! ${duration(result.gameHours)} game time, starting from ${result.startedFrom}.`;
    } else {
      testResult.className = "builder-test-result problem";
      testResult.textContent = `${state.testFileName}: ${result.reason}`;
    }
  }

  // A copied race from Submit race no longer matches once anything changes.
  function clearFallback() {
    fallback.hidden = true;
    fallback.replaceChildren();
  }

  function validate() {
    clearFallback();
    const issue = problem();
    message.textContent = issue ?? (editing ? "Ready to submit update." : "Ready to submit.");
    message.classList.toggle("ready", !issue);
    submit.disabled = Boolean(issue);
    updateTestResult();
  }

  function submitRace() {
    if (problem()) return validate();
    const { author, edited, history, ...submission } = validateCourse(course());
    const json = JSON.stringify(submission, null, 2);
    const url = `${repository}/issues/new?${new URLSearchParams({ template: "create-course.yml", course: json })}`;
    if (url.length <= MAX_FORM_URL) {
      window.open(url, "_blank", "noopener");
      fallback.hidden = true;
      message.textContent = "The form opened in a new tab. Post it there and the race updates in a minute or two.";
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
      ordered: order.value === "fixed",
      unit: ["route", "routes"],
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
