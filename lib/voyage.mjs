// Reads voyage files exported from Sailwind Chartroom (format "sailwind-voyage", version 1). The rules match
// Chartroom's src/voyages.mjs; a file that Chartroom can compare, this reads the same way.

export const VOYAGE_FORMAT = "sailwind-voyage";
export const VOYAGE_VERSION = 1;
const MAX_POINTS = 200000;
const MAX_VISITS = 5000;

export function parseVoyage(value) {
  if (value?.format !== VOYAGE_FORMAT) throw new Error("This isn't a route file. Save one from Chartroom with Voyage > Publish world/route or Save route to file.");
  if (!Number.isInteger(value.version) || value.version < 1) throw new Error("The route file has no readable version.");
  if (value.version > VOYAGE_VERSION) throw new Error("The route file is from a newer Chartroom than this site reads yet.");
  const points = (Array.isArray(value.points) ? value.points : []).slice(0, MAX_POINTS)
    .filter((point) => Number.isFinite(point?.t) && Number.isFinite(point?.lat) && Number.isFinite(point?.lon) && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180)
    .map((point) => ({
      t: Number(point.t),
      lat: Number(point.lat),
      lon: Number(point.lon),
      ...(Number.isFinite(point.utc) && { utc: Number(point.utc) }),
      ...(Number.isFinite(point.knots) && { knots: Number(point.knots) }),
      ...(Number.isFinite(point.course) && { course: Number(point.course) }),
      ...(Number.isFinite(point.windFrom) && { windFrom: Number(point.windFrom) }),
      ...(Number.isFinite(point.windKnots) && { windKnots: Number(point.windKnots) }),
      ...(typeof point.boat === "string" && point.boat && { boat: point.boat.slice(0, 60) }),
      ...(Number.isFinite(point.hull) && { hull: Number(point.hull) })
    }))
    .sort((a, b) => a.t - b.t);
  if (points.length < 2) throw new Error("The route file has fewer than two positions.");
  const visits = (Array.isArray(value.visits) ? value.visits : []).slice(0, MAX_VISITS)
    .filter((visit) => Number.isFinite(visit?.t) && typeof visit?.port === "string")
    .map((visit) => ({
      kind: visit.kind === "depart" ? "depart" : "arrive",
      port: visit.port.slice(0, 100),
      island: Number.isInteger(visit.island) ? visit.island : -1,
      t: Number(visit.t),
      ...(Number.isFinite(visit.utc) && { utc: Number(visit.utc) })
    }))
    .sort((a, b) => a.t - b.t);
  const plugins = Array.isArray(value.plugins)
    ? value.plugins.slice(0, 500).map((plugin) => ({ guid: String(plugin?.guid ?? "").slice(0, 200), name: String(plugin?.name ?? "").slice(0, 200), version: String(plugin?.version ?? "").slice(0, 40) })).filter((plugin) => plugin.guid)
    : null;
  const world = value.world && typeof value.world === "object" && typeof value.world.kind === "string" ? value.world : { kind: "unknown" };
  return {
    name: String(value.name ?? "").trim().slice(0, 80),
    note: String(value.note ?? "").trim().slice(0, 500),
    world,
    ...(value.worldDeclared === true && world.kind !== "unknown" && { worldDeclared: true }),
    game: /^[0-9a-f]{16}$/.test(String(value.game ?? "")) ? value.game : "",
    plugins,
    points,
    visits
  };
}

// What a stored voyage keeps: the parsed file plus who shared it and when. It stays a voyage file, so a
// download opens in Chartroom's Compare voyage.
export function storedVoyage(voyage, { id, submitter, submitted }) {
  return { format: VOYAGE_FORMAT, version: VOYAGE_VERSION, id, submitter, submitted, ...voyage };
}

// Two voyages from the same game whose times overlap are the same trip shared twice.
export function overlaps(a, b) {
  if (!a.game || a.game !== b.game) return false;
  return a.points[0].t <= b.points.at(-1).t && b.points[0].t <= a.points.at(-1).t;
}
