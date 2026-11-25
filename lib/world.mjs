// Worlds: vanilla Sailwind is one world; a Scrambled Seas world is its seed and the settings that shape it,
// together with the Scrambled Seas world format that placed it. The same seed with other settings is another
// map, so every one of those settings is part of the key.
import { createRequire } from "node:module";
import { SETTINGS, worldKey } from "./world-key.mjs";
import { ISLANDS } from "./islands.mjs";

export { worldKey };

export const GENERATOR_URL = "https://skeptic043.github.io/scrambled-seas-world-generator/";

// The parts of a world worth keeping and showing.
export function worldSettings(world) {
  if (world?.kind !== "scrambled") return { kind: "vanilla" };
  return Object.fromEntries([["kind", "scrambled"], ...SETTINGS.filter((key) => Number.isInteger(world[key])).map((key) => [key, world[key]]),
    ...(typeof world.scrambledSeas === "string" ? [["scrambledSeas", world.scrambledSeas.slice(0, 40)]] : [])]);
}

// A World Generator link that rebuilds this world, or null when the generator can't express it (it always
// writes Border Expander worlds, and limits some spacings). The generator's own checks decide, using its copy
// in vendor/.
let generator = null;
function loadGenerator() {
  generator ??= createRequire(import.meta.url)("../vendor/generator.cjs");
  return generator;
}

export function generatorLink(world) {
  if (world?.kind !== "scrambled" || world.borderExpander !== 1) return null;
  const G = loadGenerator();
  if (Number.isInteger(world.scrambler) && world.scrambler !== G.FORMAT_VERSION) return null;
  const input = {
    lonMin: world.lonMin, lonMax: world.lonMax, latMin: world.latMin, latMax: world.latMax,
    centerLon: (world.lonMin + world.lonMax) / 2, centerLat: (world.latMin + world.latMax) / 2,
    islandScale: round(world.islandSpread / G.DEFAULT_ISLAND_SPREAD),
    islandSpacing: round(world.minIslandSeparation / G.DEFAULT_ISLAND_SEPARATION),
    archSpacing: round(world.minArchipelagoSeparation / G.DEFAULT_ARCHIPELAGO_SEPARATION),
    seed: world.seed
  };
  input.worldScale = G.ceilTenth(G.maxWorldScale(world.lonMax - world.lonMin, world.latMax - world.latMin, input.aspect));
  const link = G.toLink(input);
  const result = G.validate(G.fromLink(`#${link}`).input);
  if (!result.ok) return null;
  const preset = result.preset;
  const same = preset.worldScramblerSeed === world.seed && preset.islandSpread === world.islandSpread
    && preset.minArchipelagoSeparation === world.minArchipelagoSeparation && preset.minIslandSeparation === world.minIslandSeparation
    && preset.worldLonMin === world.lonMin && preset.worldLonMax === world.lonMax && preset.worldLatMin === world.latMin && preset.worldLatMax === world.latMax;
  return same ? `${GENERATOR_URL}#${link}` : null;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

// Where a Scrambled Seas world puts the game's islands, as the World Generator places them: [{ id, lat, lon }],
// or null for vanilla or a world the generator can't place. The Fire Fish Lagoon islets without a number of their
// own are parts of numbered lagoon islands in the game, and move with them, as in Chartroom.
const LAGOON_PIECES = {
  // The whole group, a race checkpoint, stays with Kicia Bay, the island nearest its centre.
  "firefish/fire_fish_islands": 27,
  "firefish/fire_fish_islands/west_islet": 28,
  "firefish/fire_fish_islands/south_spike_east": 27, "firefish/fire_fish_islands/south_spike_west": 27,
  "firefish/fire_fish_islands/south_island": 26, "firefish/fire_fish_islands/southeast_island": 26,
  "firefish/fire_fish_islands/central_island": 26, "firefish/fire_fish_islands/east_island": 26,
  "firefish/fire_fish_islands/east_islet": 26
};

export function scrambledIslands(world) {
  if (world?.kind !== "scrambled") return null;
  const G = loadGenerator();
  const placed = G.placeWorld({
    worldScramblerSeed: world.seed, worldLonMin: world.lonMin, worldLonMax: world.lonMax, worldLatMin: world.latMin, worldLatMax: world.latMax,
    islandSpread: world.islandSpread, minArchipelagoSeparation: world.minArchipelagoSeparation, minIslandSeparation: world.minIslandSeparation
  });
  if (!placed) return null;
  const byNumber = new Map();
  for (const [archipelago, { islands }] of Object.entries(G.ARCHIPELAGO_ISLANDS)) {
    islands.forEach((number, index) => byNumber.set(number, placed.islands[archipelago][index]));
  }
  const moves = new Map();
  for (const island of ISLANDS) {
    const number = island.number ?? LAGOON_PIECES[island.id];
    const where = number && byNumber.get(number);
    const home = island.number ? island : ISLANDS.find((other) => other.number === number);
    if (where && home) moves.set(island.id, { lat: where.lat - home.lat, lon: where.lon - home.lon });
  }
  const positions = [];
  for (const island of ISLANDS) {
    const move = moves.get(island.id);
    if (move) positions.push({ id: island.id, lat: round(island.lat + move.lat), lon: round(island.lon + move.lon) });
  }
  return positions;
}

// A Scrambled Seas save file's settings (the XML the World Generator writes), as a world.
export function worldFromXml(xml) {
  const read = (tag) => {
    const match = new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`).exec(String(xml));
    return match ? Number(match[1]) : null;
  };
  const world = {
    kind: "scrambled", seed: read("worldScramblerSeed"), islandSpread: read("islandSpread"), minArchipelagoSeparation: read("minArchipelagoSeparation"),
    minIslandSeparation: read("minIslandSeparation"), lonMin: read("worldLonMin"), lonMax: read("worldLonMax"), latMin: read("worldLatMin"),
    latMax: read("worldLatMax"), borderExpander: read("borderExpander"), scrambler: read("version")
  };
  if (!Number.isInteger(world.seed)) throw new Error("The world settings have no seed.");
  for (const key of SETTINGS) if (!Number.isInteger(world[key])) throw new Error(`The world settings are missing ${key}.`);
  return world;
}

// A World Generator share link, as the world it makes.
export function worldFromGeneratorLink(url) {
  const G = loadGenerator();
  let link;
  try {
    link = new URL(String(url ?? "").trim());
  } catch {
    throw new Error("That isn't a World Generator share link.");
  }
  if (link.origin + link.pathname !== GENERATOR_URL) throw new Error("That isn't a World Generator share link.");
  const hash = link.hash;
  const shared = G.fromLink(hash);
  if (!shared) throw new Error("That isn't a World Generator share link.");
  const result = G.validate(shared.input);
  if (!result.ok) throw new Error(`The World Generator can't build that world: ${result.errors.join(" ")}`);
  const preset = result.preset;
  return {
    kind: "scrambled", seed: preset.worldScramblerSeed, islandSpread: preset.islandSpread, minArchipelagoSeparation: preset.minArchipelagoSeparation,
    minIslandSeparation: preset.minIslandSeparation, lonMin: preset.worldLonMin, lonMax: preset.worldLonMax, latMin: preset.worldLatMin,
    latMax: preset.worldLatMax, borderExpander: preset.borderExpander, scrambler: preset.version
  };
}
