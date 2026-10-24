// Hotel (MB, 1986 UK edition) — board layout data.
// Coordinates are in the 800 x 600 space of the reference photo (x right, y down).
// The 3D board maps these to world units later; the road is a smooth curve through the space centres.
//
// Space types:  start | buy | build (planning permission) | freeEntrance | freeBuild
// Sides:        "inner" = inside the road loop, "outer" = outside it. Value = hotel id or null.
// Travel is clockwise: index 0 -> 1 -> ... -> 30 -> 0.

const BOARD_1986 = {
  edition: "MB Hotel, 1986 UK",
  image: { width: 800, height: 600 },
  roadWidth: 34,

  spaces: [
    { i: 0,  x: 668, y: 292, type: "start",        inner: null,        outer: null },
    { i: 1,  x: 706, y: 343, type: "build",        inner: "fujiyama",  outer: null },
    { i: 2,  x: 700, y: 390, type: "buy",          inner: "fujiyama",  outer: "boomerang" },
    { i: 3,  x: 666, y: 437, type: "build",        inner: "fujiyama",  outer: "boomerang" },
    { i: 4,  x: 616, y: 460, type: "buy",          inner: "fujiyama",  outer: "boomerang" },
    { i: 5,  x: 563, y: 460, type: "build",        inner: "fujiyama",  outer: "boomerang" },
    { i: 6,  x: 513, y: 447, type: "freeEntrance", inner: "fujiyama",  outer: null },
    { i: 7,  x: 459, y: 437, type: "build",        inner: "etoile",    outer: null },
    { i: 8,  x: 416, y: 453, type: "buy",          inner: "etoile",    outer: null },
    { i: 9,  x: 363, y: 443, type: "buy",          inner: "etoile",    outer: "president" },
    { i: 10, x: 326, y: 400, type: "freeBuild",    inner: "etoile",    outer: "president" },
    { i: 11, x: 276, y: 377, type: "buy",          inner: "royal",     outer: "president" },
    { i: 12, x: 220, y: 362, type: "build",        inner: "royal",     outer: "president" },
    { i: 13, x: 167, y: 352, type: "buy",          inner: "royal",     outer: "president" },
    { i: 14, x: 125, y: 324, type: "build",        inner: "royal",     outer: "president" },
    { i: 15, x: 100, y: 277, type: "buy",          inner: "royal",     outer: "president" },
    { i: 16, x: 110, y: 223, type: "build",        inner: "royal",     outer: "waikiki" },
    { i: 17, x: 150, y: 184, type: "buy",          inner: "royal",     outer: "waikiki" },
    { i: 18, x: 200, y: 172, type: "freeEntrance", inner: "royal",     outer: "waikiki" },
    { i: 19, x: 253, y: 180, type: "build",        inner: "royal",     outer: "waikiki" },
    { i: 20, x: 302, y: 194, type: "buy",          inner: "royal",     outer: "waikiki" },
    { i: 21, x: 353, y: 207, type: "buy",          inner: "etoile",    outer: "taj" },
    { i: 22, x: 408, y: 212, type: "build",        inner: "etoile",    outer: "taj" },
    { i: 23, x: 447, y: 186, type: "buy",          inner: "etoile",    outer: "taj" },
    { i: 24, x: 456, y: 133, type: "freeBuild",    inner: "etoile",    outer: "taj" },
    { i: 25, x: 474, y: 82,  type: "build",        inner: null,        outer: "taj" },
    { i: 26, x: 536, y: 66,  type: "build",        inner: null,        outer: "safari" },
    { i: 27, x: 580, y: 110, type: "build",        inner: null,        outer: "safari" },
    { i: 28, x: 583, y: 163, type: "buy",          inner: "etoile",    outer: "safari" },
    { i: 29, x: 586, y: 217, type: "freeEntrance", inner: "etoile",    outer: "safari" },
    { i: 30, x: 618, y: 258, type: "build",        inner: null,        outer: "safari" }
  ],

  // Crossing lines sit on the boundary between two spaces.
  lines: [
    { id: "bank",     between: [6, 7],   label: "Bank — collect 2000" },
    { id: "townHall", between: [25, 26], label: "Town Hall — buy entrances" }
  ],

  // Rough plot outlines, traced from the photo. Used for the preview and to place buildings in 3D.
  plots: {
    waikiki:   [[22,40],[255,34],[292,62],[300,148],[240,156],[140,160],[70,190],[22,212]],
    taj:       [[285,34],[440,34],[440,90],[420,150],[400,170],[332,174],[312,156],[296,108]],
    safari:    [[600,34],[730,34],[730,190],[652,194],[620,130],[606,70]],
    royal:     [[142,252],[166,218],[298,226],[304,266],[288,330],[250,344],[162,338],[140,300]],
    etoile:    [[316,246],[430,236],[476,232],[560,206],[566,248],[512,298],[488,364],[416,392],[336,370],[312,300]],
    fujiyama:  [[510,304],[640,294],[680,306],[682,414],[566,428],[520,420],[498,364]],
    boomerang: [[570,492],[680,484],[736,470],[738,592],[512,592],[506,494]],
    president: [[22,392],[120,404],[262,420],[350,466],[372,592],[22,592]]
  },

  landmarks: {
    bank:     { x: 434, y: 535, poly: [[384,482],[484,482],[484,592],[384,592]] },
    townHall: { x: 525, y: 120, poly: [[494,84],[560,84],[560,158],[494,158]] },
    carPark:  { x: 722, y: 240, poly: [[700,196],[744,196],[744,296],[716,300],[700,280]] }
  },

  hotels: {
    boomerang: { name: "Boomerang", colour: "#e8d9b5", land: 500,  compulsory: 250,  entrance: 100,
      stages: [ ["Main building", 1800, 400], ["Facilities", 250, 600] ] },
    fujiyama:  { name: "Fujiyama",  colour: "#3a3f45", land: 1000, compulsory: 500,  entrance: 100,
      stages: [ ["Main building", 2200, 100], ["Extension 1", 1400, 100], ["Extension 2", 1400, 200], ["Facilities", 500, 400] ] },
    taj:       { name: "Taj Mahal", colour: "#efe6d2", land: 1500, compulsory: 750,  entrance: 100,
      stages: [ ["Main building", 2400, 100], ["Extension 1", 1000, 100], ["Extension 2", 500, 200], ["Facilities", 1000, 300] ] },
    safari:    { name: "Safari",    colour: "#5a3a2a", land: 2000, compulsory: 1000, entrance: 150,
      stages: [ ["Main building", 2600, 100], ["Extension 1", 1200, 100], ["Extension 2", 1200, 250], ["Facilities", 2000, 500] ] },
    royal:     { name: "Royal",     colour: "#efe3c4", land: 2500, compulsory: 1250, entrance: 200,
      stages: [ ["Main building", 3600, 150], ["Extension 1", 2600, 300], ["Extension 2", 1800, 300], ["Extension 3", 1800, 450], ["Facilities", 3000, 600] ] },
    waikiki:   { name: "Waikiki",   colour: "#4a3226", land: 2500, compulsory: 1250, entrance: 200,
      stages: [ ["Main building", 3500, 200], ["Extension 1", 2500, 350], ["Extension 2", 2500, 500], ["Extension 3", 1750, 500], ["Annexe", 1750, 650], ["Facilities", 2500, 1000] ] },
    etoile:    { name: "L'Etoile",  colour: "#2f3438", land: 3000, compulsory: 1500, entrance: 250,
      stages: [ ["Main building", 3300, 150], ["Extension 1", 2200, 300], ["Extension 2", 1800, 300], ["Extension 3", 1800, 300], ["Annexe", 1800, 450], ["Facilities", 4000, 750] ] },
    president: { name: "President", colour: "#7d98ad", land: 3500, compulsory: 1750, entrance: 250,
      stages: [ ["Main building", 5000, 200], ["Extension 1", 3000, 400], ["Extension 2", 2250, 600], ["Extension 3", 1750, 800], ["Facilities", 5000, 1100] ] }
  }
};

if (typeof module !== "undefined") module.exports = BOARD_1986;
