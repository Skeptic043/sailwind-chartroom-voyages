// Writes the starter courses for vanilla Sailwind into courses/. Run again after the island list changes.
import { mkdir, writeFile } from "node:fs/promises";
import { ISLANDS } from "../lib/islands.mjs";
import { validateCourse } from "../lib/course.mjs";

const SHIPYARDS = ["alankh/gold_rock_city", "firefish/kicia_bay", "emerald/dragon_cliffs", "aestrin/fort_aestrin"];
const ARCHIPELAGOS = [
  { id: "alankh", region: "Al’Ankh", name: "Al'Ankh", capital: "alankh/gold_rock_city" },
  { id: "emerald", region: "Emerald Archipelago", name: "Emerald Archipelago", capital: "emerald/dragon_cliffs" },
  { id: "aestrin", region: "Aestrin", name: "Aestrin", capital: "aestrin/fort_aestrin" },
  { id: "fire-fish-lagoon", region: "Fire Fish Lagoon", name: "Fire Fish Lagoon", capital: "firefish/kicia_bay" }
];

const courses = [validateCourse({
  id: "shipyard-tour",
  name: "Shipyard tour",
  author: "Chartroom Voyages",
  description: "Start at any of the four shipyard ports, then visit the other three in any order. The clock stops when you reach the last one.",
  world: "vanilla",
  start: { any: true },
  checkpoints: SHIPYARDS.map((island) => ({ island })),
  order: "any",
  finish: { lastCheckpoint: true },
  rules: { sortBy: "game" }
})];

// Each archipelago's charted islands; secret islands are left to players' own courses.
for (const archipelago of ARCHIPELAGOS) {
  const capital = ISLANDS.find((island) => island.id === archipelago.capital);
  const islands = ISLANDS.filter((island) => island.region === archipelago.region && island.id !== archipelago.capital && !island.secret);
  courses.push(validateCourse({
    id: `${archipelago.id}-tour`,
    name: `${archipelago.name} tour`,
    author: "Chartroom Voyages",
    description: `Leave ${capital.name}, visit every charted island in ${archipelago.name} in any order, then return to ${capital.name}.`,
    world: "vanilla",
    start: { island: capital.id },
    checkpoints: islands.map((island) => ({ island: island.id })),
    order: "any",
    finish: { island: capital.id },
    rules: { sortBy: "game" }
  }));
}

const folder = new URL("../courses/", import.meta.url);
await mkdir(folder, { recursive: true });
for (const course of courses) await writeFile(new URL(`${course.id}.json`, folder), `${JSON.stringify(course, null, 2)}\n`);
console.log(courses.map((course) => `${course.id}: ${course.checkpoints.length} checkpoints`).join("\n"));
