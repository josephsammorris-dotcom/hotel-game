// Where every 3D piece sits on the 1986 board, in the same 800 x 600 photo coordinates as board-1986.js.
// Measured from gridded crops of the reference photo. rot is degrees, clockwise as seen from above.
// Each hotel's `pieces` are in stage order: pieces[0] appears when the main building is built, and so on.
// `grounds` is the leisure-facilities package: everything in it appears together when facilities are bought.
// Pools are sized to the hotel: the grander and pricier the hotel, and the more spare land it has, the bigger.
// `land` is the hotel's plot: painted in its colour and ringed with a rope fence (edges under the road are hidden by it).
// `sign` is the hotel's name board, in a spot nothing else may use, facing the table-view camera.
// Sizes: w/d/h in photo px unless noted; building heights (h on pieces) are world units (1 unit = 50 px).
const SCENERY_1986 = {
  boardRect: [30, 18, 770, 588],
  roadPx: 52,

  hotels: {
    boomerang: { // resort lagoon: freeform pool, beach bar, palms, tennis inside the crescent
      land: [[538, 453], [563, 460], [616, 460], [666, 437], [700, 390], [703, 366], [757, 366], [757, 575], [500, 575], [500, 478]],
      pieces: [ { style: 'crescent', cx: 640, cy: 450, r0: 88, r1: 118, a0: 10, a1: 88 } ],
      sign: { x: 532, y: 567, w: 60 },
      grounds: [
        { type: 'pool', shape: 'lagoon', x: 559, y: 540, w: 82, h: 36, rot: -4 },
        { type: 'tennis', x: 677, y: 500, rot: -40 },
        { type: 'bar', x: 622, y: 553, rot: -20, roof: 'thatch' },
        { type: 'palms', pts: [[510, 497], [614, 530], [598, 570], [702, 472]] },
        { type: 'parasols', pts: [[604, 514], [512, 534]], colour: 'yellow' },
        { type: 'loungers', x: 562, y: 512, rot: 0, n: 4 }
      ]
    },
    fujiyama: { // Japanese garden: koi pond with red bridge, stone lanterns, cloud-pruned pines, round pool
      land: [[486, 442], [513, 447], [563, 460], [616, 460], [666, 437], [700, 390], [706, 343], [687, 318], [660, 300], [600, 294], [552, 294], [530, 306], [510, 332], [500, 368], [492, 410]],
      pieces: [
        { style: 'hex', x: 552, y: 326, r: 20, h: 2.3 },
        { style: 'hex', x: 594, y: 320, r: 20, h: 1.95 },
        { style: 'hex', x: 576, y: 364, r: 20, h: 1.6 }
      ],
      sign: { x: 599, y: 406, w: 46 },
      grounds: [
        { type: 'pool', shape: 'koi', x: 530, y: 382, w: 42, h: 22, rot: -8, deck: 4 },
        { type: 'bridge', x: 530, y: 382, rot: 84, len: 28 },
        { type: 'lanterns', pts: [[558, 402], [508, 366]] },
        { type: 'bonsai', pts: [[528, 350], [618, 350]] },
        { type: 'pool', shape: 'round', x: 626, y: 380, w: 26, h: 26, rot: 0 },
        { type: 'parasols', pts: [[636, 352]], colour: 'red' }
      ]
    },
    taj: { // Mughal water garden: long reflecting pool with jets, cross channel, rows of cypress
      land: [[294, 31], [505, 31], [505, 74], [474, 82], [465, 108], [456, 133], [447, 186], [408, 212], [353, 207], [327, 200], [300, 150]],
      pieces: [
        { style: 'tajMain', x: 368, y: 54, w: 46, d: 38, h: 0.75 },
        { style: 'tajSide', x: 331, y: 88, w: 28, d: 28, h: 0.62 },
        { style: 'tajSide', x: 401, y: 84, w: 28, d: 28, h: 0.62 }
      ],
      sign: { x: 360, y: 150, w: 50 },
      grounds: [
        { type: 'plate', colour: '#eadfc8', poly: [[314, 101], [406, 101], [406, 141], [314, 141]] },
        { type: 'pool', shape: 'rect', x: 360, y: 121, w: 84, h: 12, rot: 0, deck: 3 },
        { type: 'pool', shape: 'rect', x: 360, y: 121, w: 12, h: 30, rot: 0, deck: 3 },
        { type: 'pool', shape: 'rect', x: 360, y: 121, w: 20, h: 20, rot: 0, deck: 3 },
        { type: 'jets', pts: [[326, 121], [340, 121], [380, 121], [394, 121], [360, 121]] },
        { type: 'flowers', beds: [[334, 108, 24, 10], [386, 108, 24, 10], [334, 134, 24, 10], [386, 134, 24, 10]] },
        { type: 'cypress', pts: [[312, 106], [406, 104], [312, 136], [402, 134]] }
      ]
    },
    safari: { // watering-hole pool among rocks, thatched shades, tennis court, palms
      land: [[505, 31], [757, 31], [757, 198], [648, 198], [643, 275], [618, 258], [586, 217], [583, 163], [580, 110], [536, 66], [505, 74]],
      pieces: [
        { style: 'lodge', x: 678, y: 56, w: 80, d: 36, rot: 0 },
        { style: 'lodge', x: 716, y: 117, w: 34, d: 52, rot: 0 },
        { style: 'lodge', x: 716, y: 174, w: 34, d: 52, rot: 0 }
      ],
      sign: { x: 612, y: 42, w: 48 },
      grounds: [
        { type: 'tennis', x: 656, y: 100, rot: 0 },
        { type: 'pool', shape: 'kidney', x: 665, y: 156, w: 54, h: 40, rot: 8 },
        { type: 'rocks', pts: [[633, 141], [633, 176], [694, 176]] },
        { type: 'bar', x: 684, y: 188, rot: 0, roof: 'thatch' },
        { type: 'parasols', pts: [[652, 190], [632, 158]], colour: 'thatch' },
        { type: 'palms', pts: [[632, 195], [633, 120]] }
      ]
    },
    royal: { // formal hotel garden: pool with sun terrace, tennis, clipped topiary, the two lamp-posts
      land: [[327, 200], [302, 194], [253, 180], [200, 172], [150, 184], [110, 223], [100, 277], [125, 324], [167, 352], [220, 362], [276, 377], [301, 388], [310, 300]],
      pieces: [
        { style: 'royal', x: 222, y: 250, w: 32, d: 26, h: 2.0, rot: -6 },
        { style: 'royal', x: 186, y: 252, w: 32, d: 26, h: 1.75, rot: -6 },
        { style: 'royal', x: 224, y: 282, w: 32, d: 26, h: 1.5, rot: -6 },
        { style: 'royal', x: 188, y: 284, w: 32, d: 26, h: 1.25, rot: -6 }
      ],
      sign: { x: 206, y: 306, w: 44 },
      grounds: [
        { type: 'pool', shape: 'rect', x: 270, y: 262, w: 50, h: 18, rot: 84 },
        { type: 'topiary', pts: [[250, 232], [250, 296], [158, 268]] },
        { type: 'loungers', x: 252, y: 264, rot: 84, n: 4 },
        { type: 'parasols', pts: [[287, 243], [290, 284]], colour: 'blue' }
      ]
    },
    waikiki: { // beach club: lagoon pool, palms, thatched beach bar, sunbeds on the sand
      land: [[118, 31], [294, 31], [300, 150], [327, 200], [302, 194], [253, 180], [200, 172], [150, 184], [110, 223], [105, 250], [43, 250], [43, 110], [70, 88], [96, 60]],
      pieces: [
        { style: 'hut', x: 250, y: 66, w: 88, d: 34, rot: 90 },
        { style: 'hut', x: 192, y: 47, w: 60, d: 25, rot: 30 },
        { style: 'hut', x: 150, y: 71, w: 60, d: 25, rot: 30 },
        { style: 'hut', x: 126, y: 99, w: 60, d: 25, rot: 30 },
        { style: 'hut', x: 101, y: 123, w: 60, d: 25, rot: 30 }
      ],
      sign: { x: 66, y: 152, w: 40 },
      grounds: [
        { type: 'pool', shape: 'lagoon', x: 200, y: 108, w: 48, h: 30, rot: -8 },
        { type: 'bar', x: 276, y: 131, rot: -10, roof: 'thatch' },
        { type: 'palms', pts: [[242, 128], [158, 124], [284, 62]] },
        { type: 'parasols', pts: [[236, 118], [185, 88]], colour: 'red' },
        { type: 'loungers', x: 282, y: 90, rot: 90, n: 3 }
      ]
    },
    etoile: { // formal terrace: pool, tennis, topiary round the plaza, flower beds round the fountain
      land: [[327, 200], [353, 207], [408, 212], [447, 186], [452, 175], [575, 175], [583, 163], [586, 217], [602, 238], [600, 262], [552, 264], [512, 278], [488, 314], [474, 360], [464, 410], [486, 442], [459, 437], [416, 453], [363, 443], [326, 400], [301, 388], [310, 300]],
      ring: { x: 407, y: 322, r0: 42, r1: 66 },
      pieces: [
        { style: 'wing', a: 90, span: 50, h: 0.72 },
        { style: 'wing', a: 18, span: 50, h: 0.72 },
        { style: 'wing', a: 162, span: 50, h: 0.72 },
        { style: 'wing', a: -54, span: 50, h: 0.72 },
        { style: 'wing', a: -126, span: 50, h: 0.72 }
      ],
      sign: { x: 407, y: 292, w: 40 },
      grounds: [
        { type: 'pool', shape: 'lozenge', x: 516, y: 224, w: 40, h: 16, rot: -4 },
        { type: 'tennis', x: 515, y: 250, rot: 0 },
        { type: 'topiary', pts: [[324, 322], [340, 350], [330, 280], [487, 276], [372, 261]] },
        { type: 'flowers', beds: [[382, 308, 10, 20], [432, 308, 10, 20], [382, 338, 10, 20], [432, 338, 10, 20]] },
        { type: 'parasols', pts: [[480, 238], [544, 248]], colour: 'red' }
      ]
    },
    president: { // country club: the biggest pool, golf green with bunkers, tennis, pavilion
      land: [[43, 250], [105, 250], [100, 277], [125, 324], [167, 352], [220, 362], [276, 377], [326, 400], [345, 422], [385, 478], [390, 575], [43, 575]],
      pieces: [
        { style: 'glass', x: 145, y: 475, w: 38, d: 38, h: 3.2, rot: 0 },
        { style: 'glass', x: 75, y: 475, w: 38, d: 38, h: 2.75, rot: 90 },
        { style: 'glass', x: 145, y: 545, w: 38, d: 38, h: 2.35, rot: -90 },
        { style: 'glass', x: 75, y: 545, w: 38, d: 38, h: 2.0, rot: 180 }
      ],
      sign: { x: 206, y: 428, w: 60 },
      grounds: [
        { type: 'plate', colour: '#e9e1cf', poly: [[182, 444], [296, 442], [298, 494], [184, 496]] },
        { type: 'pool', shape: 'rect', x: 238, y: 468, w: 100, h: 38, rot: 0 },
        { type: 'golf', fairway: [[250, 540], [300, 508], [352, 500], [370, 530], [340, 562], [270, 566]], green: [336, 522, 26, 16], flag: [340, 520], bunkers: [[300, 546, 8], [364, 512, 6], [312, 510, 6]] },
        { type: 'tennis', x: 216, y: 548, rot: 0 },
        { type: 'bar', x: 314, y: 471, rot: 0, roof: 'white' },
        { type: 'trees', pts: [[180, 508], [258, 508], [192, 574], [372, 568], [284, 500]] },
        { type: 'parasols', pts: [[196, 492], [282, 492], [262, 446]], colour: 'blue' },
        { type: 'loungers', x: 238, y: 492, rot: 0, n: 6 }
      ]
    }
  },

  landmarks: {
    bank: { x: 452, y: 530, w: 72, d: 38, rot: 180 },
    townHall: { x: 523, y: 134, w: 36, d: 36, rot: 0 }
  },

  carPark: { poly: [[650, 200], [757, 200], [757, 290], [700, 294], [650, 280]], bays: [[664, 236], [687, 236], [710, 236], [733, 236]] },
  // Each hotel's colour: its land tint and the road edge beside every space where it may place an entrance.
  landColours: { boomerang: '#f07c1e', fujiyama: '#d0342c', taj: '#e3c23a', safari: '#8b5a2b', royal: '#2458b8', waikiki: '#1f9a55', etoile: '#8a44c4', president: '#0f8f9c' },
  playerColours: ['#f2c417', '#3fa34d', '#2f79c9', '#d0342c'],

  // Starts clear of the road/car park ring near START (which used to sit at x>=655) and runs south into open ground.
  // The coastline the bay belongs to, in the same px coordinates (it runs off the board in both directions; the sea is to the north-west).
  coast: [[-4600, 2760], [-3000, 1800], [-1500, 900], [-700, 520], [-300, 330], [-120, 210], [-20, 150], [30, 112], [66, 90], [90, 62], [118, 46], [140, 18], [180, -30], [260, -120], [420, -300], [700, -700], [1200, -1500], [2300, -2900], [3700, -4600]],

  river: { width: 28, path: [[600, 278], [552, 278], [522, 292], [500, 322], [488, 362], [478, 410]] },

  ground: [
    // [colour, polygon] painted in order over the base grass.
    ['#4ea3d8', [[30, 18], [140, 18], [118, 46], [90, 62], [66, 90], [30, 112]]], // Waikiki bay: opens on to the sea beyond the play area
    ['#f0deaa', [[30, 112], [66, 90], [90, 62], [118, 46], [140, 18], [284, 18], [292, 80], [300, 146], [240, 152], [150, 160], [92, 176], [62, 212], [30, 232]]],
    ['#8a6a55', [[292, 31], [472, 31], [468, 64], [292, 64]]],
    ['#5ea54a', [[292, 62], [468, 62], [462, 112], [440, 158], [408, 176], [330, 176], [306, 150]]],
    ['#6fae4c', [[556, 31], [616, 31], [632, 80], [612, 130], [630, 200], [606, 204], [590, 140], [574, 80]]],
    ['#efe2c0', [[612, 31], [757, 31], [757, 200], [630, 200], [614, 130], [632, 80]]],
    ['#cfd6d9', [[650, 200], [757, 200], [757, 290], [700, 294], [650, 280]]],
    ['#b9c7cf', [[496, 100], [552, 100], [556, 166], [498, 168]]],
    ['#5ea54a', [[470, 196], [560, 188], [566, 244], [520, 262], [468, 258]]],
    ['#d98c7a', [[514, 304], [682, 300], [684, 362], [670, 392], [620, 404], [560, 410], [514, 392]]],
    ['#5ea54a', [[540, 386], [664, 374], [668, 418], [560, 432]]],
    ['#c9683d', [[496, 478], [612, 482], [700, 470], [757, 456], [757, 575], [496, 575]]],
    ['#f0dc9a', [[612, 494], [700, 480], [757, 470], [757, 575], [612, 575]]],
    ['#c9ced1', [[392, 480], [500, 480], [500, 575], [392, 575]]],
    ['#a9bccb', [[52, 448], [170, 448], [172, 575], [52, 575]]],
    ['#d9cfbf', 'circle', 407, 322, 104],
    ['#e8e0d2', 'circle', 407, 322, 44]
  ],

  parking: []
};

if (typeof module !== 'undefined') module.exports = SCENERY_1986;
