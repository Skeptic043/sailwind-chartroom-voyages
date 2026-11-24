// Vanilla Sailwind's islands, from Chartroom's island catalog (outlines from the Sailwind Web Map, MIT; see
// THIRD-PARTY-NOTICES.md), with the game's island numbers that Voyage Recorder writes on port visits.
import { ISLAND_CATALOG } from "../vendor/island-catalog.mjs";

// Game island number → catalog id, as in Chartroom's src/scrambled-seas.mjs.
const GAME_ISLANDS = Object.freeze({
  1: "alankh/gold_rock_city", 2: "alankh/alnilem", 3: "alankh/neverdin", 4: "alankh/albacore_town",
  5: "alankh/isle_of_clear_mind", 6: "alankh/lions_fang", 7: "alankh/alchemists_island", 8: "alankh/alankh_academy",
  9: "emerald/dragon_cliffs", 10: "emerald/sanctuary", 11: "emerald/crab_beach", 12: "emerald/new_port",
  13: "emerald/sage_hills", 15: "aestrin/fort_aestrin", 16: "aestrin/sunspire", 17: "aestrin/mount_malefic",
  18: "bay/happy_bay", 19: "aestrin/eastwind", 20: "alankh/oasis", 21: "aestrin/siren_song", 22: "emerald/serpent_isle",
  23: "aestrin/oracle", 25: "chronos/chronos", 26: "firefish/fire_fish_town", 27: "firefish/kicia_bay",
  28: "firefish/senna", 29: "firefish/onna", 30: "aestrin/rock_of_despair",
  31: "firefish/fire_fish_islands/north_sandbar", 32: "alankh/eleann_island", 33: "aestrin/firefly_grotto",
  34: "aestrin/aestra_abbey", 35: "aestrin/fey_valley", 36: "aestrin/bone_isle", 37: "emerald/dead_cove",
  38: "emerald/turtle_island", 39: "emerald/pondering_peak", 40: "alankh/old_ankh_town", 41: "alankh/mirage_mountain",
  42: "alankh/saffron", 67: "better-ports/bottleneck"
});
const NUMBERS = new Map(Object.entries(GAME_ISLANDS).map(([number, id]) => [id, Number(number)]));

// Reaching an island means passing within its outline's reach plus this margin, about three miles.
const REACH_MARGIN_DEG = 0.02;

export const ISLANDS = Object.freeze(ISLAND_CATALOG.map((island) => ({
  id: island.id,
  name: island.name,
  region: island.region,
  secret: island.secret === true,
  number: NUMBERS.get(island.id) ?? null,
  lat: island.sourceCenter.lat,
  lon: island.sourceCenter.lon,
  reachDeg: Math.max(island.bounds.maxLat, -island.bounds.minLat, island.bounds.maxLon, -island.bounds.minLon) + REACH_MARGIN_DEG
})));

export function islandById(id) {
  return ISLANDS.find((island) => island.id === id) ?? null;
}

// Optional community nicknames (normalized compact key -> island id) for future aliases.
export const ISLAND_ALIASES = Object.freeze({});

function compactKey(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function nameWords(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const INDEX = ISLANDS.map((island) => {
  const words = nameWords(island.name);
  const compact = compactKey(island.name);
  const initials = words.length > 1 ? words.map((word) => word[0]).join("") : "";
  const aliases = Object.entries(ISLAND_ALIASES)
    .filter(([, id]) => id === island.id)
    .map(([alias]) => compactKey(alias))
    .filter(Boolean);
  return { island, words, compact, initials, aliases };
});

// Finds vanilla islands matching a query: full/partial name ignoring punctuation and spaces
// ("fire fish town", "firefishtown", "senna"), initials ("FFT", "GRC"), or aliases.
export function findIslands(query, { spoilers = false } = {}) {
  const q = compactKey(query);
  if (!q) return [];
  const scored = [];
  for (const entry of INDEX) {
    if (!spoilers && entry.island.secret) continue;
    let rank = 99;
    if (entry.compact === q || entry.aliases.includes(q)) rank = 0;
    else if (entry.initials && entry.initials === q) rank = 1;
    else if (entry.compact.startsWith(q)) rank = 2;
    else if (entry.words.some((word) => word.startsWith(q))) rank = 3;
    else if (entry.compact.includes(q)) rank = 4;
    else if (entry.initials && entry.initials.startsWith(q)) rank = 5;
    if (rank < 99) scored.push({ island: entry.island, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.island.name.localeCompare(b.island.name));
  return scored.map((item) => item.island);
}

// Returns the single unambiguous island matching text (exact normalized name, alias, or unique initials).
export function matchIslandName(text, { spoilers = true } = {}) {
  const q = compactKey(text);
  if (!q) return null;
  const candidates = INDEX.filter((entry) => spoilers || !entry.island.secret);
  const exact = candidates.filter((entry) => entry.compact === q || entry.aliases.includes(q));
  if (exact.length === 1) return exact[0].island;
  const byInitials = candidates.filter((entry) => entry.initials && entry.initials === q);
  if (byInitials.length === 1) return byInitials[0].island;
  return null;
}

// Closest vanilla island whose reach covers (lat, lon), matching Chartroom's courseFromRoute snapping.
export function islandAt(lat, lon, { spoilers = false } = {}) {
  let best = null;
  for (const island of ISLANDS) {
    if (!spoilers && island.secret) continue;
    const distance = Math.hypot(lat - island.lat, lon - island.lon);
    if (distance <= island.reachDeg && (!best || distance < best.distance)) best = { island, distance };
  }
  return best?.island ?? null;
}

export { ISLAND_CATALOG };
