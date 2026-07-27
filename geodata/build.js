// Regenerates the inlined map data in geography-star.html from the public-
// domain Census boundaries packaged as npm us-atlas@3. Run once whenever the
// map paths or capital coordinates need to change. See build-notes.md.
//
// Setup (not committed -- installed fresh when this script is run):
//   npm install us-atlas@3 topojson-client topojson-simplify d3-geo
//
// Usage:
//   node geodata/build.js
//
// Prints two things to stdout:
//   1. geodata/states.json (human-reviewable source of truth) -- write this
//      file yourself from the printed JSON.
//   2. A paste-ready JS block (STATE_PATHS, STATE_NAMES, CAPITALS,
//      SMALL_STATE_CENTROID, STATE_REGION) -- paste this into the
//      "GENERATED MAP DATA" section of geography-star.html.
const topojson = require("topojson-client");
const { presimplify, simplify } = require("topojson-simplify");
const { geoPath, geoAlbersUsa } = require("d3-geo");

const us = require("us-atlas/states-albers-10m.json");

// Standard FIPS -> USPS postal code mapping (public domain facts).
const FIPS_TO_USPS = {
  "01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT","10":"DE",
  "11":"DC","12":"FL","13":"GA","15":"HI","16":"ID","17":"IL","18":"IN","19":"IA",
  "20":"KS","21":"KY","22":"LA","23":"ME","24":"MD","25":"MA","26":"MI","27":"MN",
  "28":"MS","29":"MO","30":"MT","31":"NE","32":"NV","33":"NH","34":"NJ","35":"NM",
  "36":"NY","37":"NC","38":"ND","39":"OH","40":"OK","41":"OR","42":"PA","44":"RI",
  "45":"SC","46":"SD","47":"TN","48":"TX","49":"UT","50":"VT","51":"VA","53":"WA",
  "54":"WV","55":"WI","56":"WY",
};

// Region progression buckets (spec §6).
const REGION = {
  "New England": ["ME","NH","VT","MA","RI","CT"],
  "Mid-Atlantic": ["NY","NJ","PA","DE","MD","DC"],
  "Southeast": ["VA","WV","NC","SC","GA","FL","KY","TN","AL","MS","AR","LA"],
  "Midwest": ["OH","IN","IL","MI","WI","MN","IA","MO"],
  "Great Plains": ["ND","SD","NE","KS","OK"],
  "Southwest": ["TX","NM","AZ"],
  "Mountain West": ["MT","WY","CO","UT","ID","NV"],
  "Pacific": ["WA","OR","CA"],
  "Non-contiguous": ["AK","HI"],
};
const codeToRegion = {};
for (const [region, codes] of Object.entries(REGION)) for (const c of codes) codeToRegion[c] = region;

// Capital city + lat/long, authored from general geographic knowledge
// (well-documented, stable facts). DC has no separate capital -- it IS the
// capital -- so it's excluded from Mode 3 (Click the Capital).
const CAPITALS = {
  AL: ["Montgomery", 32.3792, -86.3077], AK: ["Juneau", 58.3019, -134.4197],
  AZ: ["Phoenix", 33.4484, -112.0740], AR: ["Little Rock", 34.7465, -92.2896],
  CA: ["Sacramento", 38.5816, -121.4944], CO: ["Denver", 39.7392, -104.9903],
  CT: ["Hartford", 41.7658, -72.6734], DE: ["Dover", 39.1582, -75.5244],
  DC: [null, null, null],
  FL: ["Tallahassee", 30.4383, -84.2807], GA: ["Atlanta", 33.7490, -84.3880],
  HI: ["Honolulu", 21.3069, -157.8583], ID: ["Boise", 43.6150, -116.2023],
  IL: ["Springfield", 39.7817, -89.6501], IN: ["Indianapolis", 39.7684, -86.1581],
  IA: ["Des Moines", 41.5868, -93.6250], KS: ["Topeka", 39.0473, -95.6752],
  KY: ["Frankfort", 38.2009, -84.8733], LA: ["Baton Rouge", 30.4515, -91.1871],
  ME: ["Augusta", 44.3106, -69.7795], MD: ["Annapolis", 38.9784, -76.4922],
  MA: ["Boston", 42.3601, -71.0589], MI: ["Lansing", 42.7325, -84.5555],
  MN: ["Saint Paul", 44.9537, -93.0900], MS: ["Jackson", 32.2988, -90.1848],
  MO: ["Jefferson City", 38.5767, -92.1735], MT: ["Helena", 46.5891, -112.0391],
  NE: ["Lincoln", 40.8136, -96.7026], NV: ["Carson City", 39.1638, -119.7674],
  NH: ["Concord", 43.2081, -71.5376], NJ: ["Trenton", 40.2206, -74.7597],
  NM: ["Santa Fe", 35.6870, -105.9378], NY: ["Albany", 42.6526, -73.7562],
  NC: ["Raleigh", 35.7796, -78.6382], ND: ["Bismarck", 46.8083, -100.7837],
  OH: ["Columbus", 39.9612, -82.9988], OK: ["Oklahoma City", 35.4676, -97.5164],
  OR: ["Salem", 44.9429, -123.0351], PA: ["Harrisburg", 40.2732, -76.8867],
  RI: ["Providence", 41.8240, -71.4128], SC: ["Columbia", 34.0007, -81.0348],
  SD: ["Pierre", 44.3683, -100.3510], TN: ["Nashville", 36.1627, -86.7816],
  TX: ["Austin", 30.2672, -97.7431], UT: ["Salt Lake City", 40.7608, -111.8910],
  VT: ["Montpelier", 44.2601, -72.5754], VA: ["Richmond", 37.5407, -77.4360],
  WA: ["Olympia", 47.0379, -122.9007], WV: ["Charleston", 38.3498, -81.6326],
  WI: ["Madison", 43.0731, -89.4012], WY: ["Cheyenne", 41.1400, -104.8202],
};

// Small states that need a transparent min-radius tap circle over their path
// (real shapes are too small/thin to reliably tap on a tablet) -- spec §4.
const SMALL_STATES = ["RI","DE","CT","NJ","NH","VT","MA","MD","DC"];

// minWeight=2 chosen empirically: keeps Michigan's mitten, Florida's
// panhandle, and Cape Cod recognizable while landing at ~37KB for all 51
// states (spec budget: 30-40KB). Verified visually -- see build-notes.md.
const pre = presimplify(us);
const simplified = simplify(pre, 2);
const path = geoPath(); // no projection: states-albers-10m is pre-projected pixel space
function round1(n) { return Math.round(n * 10) / 10; }
function round1Path(str) { return str.replace(/-?\d+\.?\d*/g, (n) => String(round1(parseFloat(n)))); }

const geo = topojson.feature(simplified, simplified.objects.states);
// Standard 975x610 Albers USA fit (spec §4), used to bake capitalXY.
const projection = geoAlbersUsa().scale(1300).translate([487.5, 305]);

const states = {};
for (const feature of geo.features) {
  const code = FIPS_TO_USPS[feature.id];
  if (!code) { console.error("no USPS code for FIPS", feature.id); continue; }
  const [capName, lat, lon] = CAPITALS[code];
  let capitalXY = null;
  if (lat !== null) {
    const xy = projection([lon, lat]);
    if (!xy) console.error("projection failed for", code, capName);
    else capitalXY = [round1(xy[0]), round1(xy[1])];
  }
  const entry = {
    code, name: feature.properties.name, fips: feature.id,
    region: codeToRegion[code] || null,
    capital: capName, capitalXY,
  };
  if (SMALL_STATES.includes(code)) {
    const c = path.centroid(feature);
    entry.centroid = [round1(c[0]), round1(c[1])];
  }
  entry._path = round1Path(path(feature)); // rendering data, not part of states.json
  states[code] = entry;
}

const codes = Object.keys(states).sort();
console.log("// ---- geodata/states.json (human-reviewable source of truth) ----");
const statesJson = {};
for (const c of codes) {
  const { _path, ...rest } = states[c];
  statesJson[c] = rest;
}
console.log(JSON.stringify(statesJson, null, 2));

console.log("\n// ---- paste into geography-star.html GENERATED MAP DATA block ----");
const paths = {}, names = {}, capitals = {}, centroids = {}, regions = {};
for (const c of codes) {
  paths[c] = states[c]._path;
  names[c] = states[c].name;
  if (states[c].capital) capitals[c] = [states[c].capital, states[c].capitalXY[0], states[c].capitalXY[1]];
  if (states[c].centroid) centroids[c] = states[c].centroid;
  regions[c] = states[c].region;
}
let out = "";
out += "const STATE_PATHS = " + JSON.stringify(paths) + ";\n";
out += "const STATE_NAMES = " + JSON.stringify(names) + ";\n";
out += "// capital: [cityName, x, y] in the 975x610 Albers-USA viewBox; DC omitted (no separate capital)\n";
out += "const CAPITALS = " + JSON.stringify(capitals) + ";\n";
out += "// hit-target + label anchor centroids for the cramped Northeast/small states\n";
out += "const SMALL_STATE_CENTROID = " + JSON.stringify(centroids) + ";\n";
out += "const STATE_REGION = " + JSON.stringify(regions) + ";\n";
console.log(out);
console.log(`// states emitted: ${codes.length} (expect 51)`);
console.log(`// STATE_PATHS size: ${(Buffer.byteLength(JSON.stringify(paths)) / 1024).toFixed(1)} KB`);
