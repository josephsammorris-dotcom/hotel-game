/* Hotel — 3D board. A miniature diorama of the 1986 MB board in three.js.
 *
 * createBoard3D(deps, container, board, scenery, opts) → api
 *   deps: { THREE, OrbitControls, EffectComposer, RenderPass, ShaderPass, OutputPass, RoomEnvironment, mergeGeometries }
 *   api.setHotel(id, built, facilities, animate)   show a hotel at a given stage (built = buildings standing)
 *   api.setEntrance(space, hotelId|null, animate)  put or remove an entrance on a road space
 *   api.moveCar(i, toSpace, animate)                move a car (toSpace -1 = its car park bay); returns a Promise
 *   api.setCar(i, visible)                          show or hide a player's car
 *   api.flyTo(hotelId|'home'|'top')                 move the camera
 *   api.setTiltShift(on)                            miniature blur on/off
 *   api.onPick(fn)                                  fn(hotelId) when a building is clicked
 *   api.entranceSide(space, hotelId)                which side of the road a hotel is on
 * Board coordinates are the 800 x 600 photo pixels; 50 px = 1 world unit.
 */
function createBoard3D(deps, container, board, scenery, opts) {
  'use strict';
  opts = opts || {};
  const { THREE, OrbitControls, EffectComposer, RenderPass, ShaderPass, OutputPass, RoomEnvironment, mergeGeometries, UnrealBloomPass, toCreasedNormals, GTAOPass } = deps;
  const U = 50, CX = 400, CY = 300;
  const wx = x => (x - CX) / U, wz = y => (y - CY) / U;
  const deg = d => d * Math.PI / 180;
  const ROAD_Y = 0.045, ROAD_W = scenery.roadPx / U;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- renderer, scene, camera
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  const SMALL = Math.min(window.innerWidth, window.innerHeight) < 700;
  let liteProfile = false; // the lighter look for older devices (see applyProfile)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false; // redrawn only when something that casts a shadow moves (see the governor)
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.touchAction = 'none';
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#2b2724');
  scene.fog = new THREE.Fog('#2b2724', 34, 70);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  const HOME_WIDE = { pos: new THREE.Vector3(0.3, 17.2, 16.4), target: new THREE.Vector3(0, 0, 0.45) };
  const HOME_TALL = { pos: new THREE.Vector3(15.5, 20.5, 0.2), target: new THREE.Vector3(-1.1, 0, 0.1) };
  const portrait = () => (container.clientWidth || 1) / (container.clientHeight || 1) < 0.85;
  let HOME = portrait() ? HOME_TALL : HOME_WIDE;
  camera.position.copy(HOME.pos);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(HOME.target);
  // A floating, map-like camera: drag glides across the board, right-drag (or two fingers) turns,
  // the wheel / pinch zooms towards whatever is under the pointer.
  controls.enableDamping = true; controls.dampingFactor = 0.055;
  controls.minDistance = 2.2; controls.maxDistance = 42;
  controls.maxPolarAngle = deg(84); controls.screenSpacePanning = false;
  controls.zoomToCursor = true; controls.zoomSpeed = 1.15; controls.panSpeed = 1.1; controls.rotateSpeed = 0.7;
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.update();
  let lastUserMove = -1e9; // when the player last steered the camera (performance.now ms)
  controls.addEventListener('start', () => { lastUserMove = performance.now(); cancelFly(); });
  controls.addEventListener('change', () => { if (controls._dragging) lastUserMove = performance.now(); });
  renderer.domElement.addEventListener('pointerdown', () => { controls._dragging = true; });
  window.addEventListener('pointerup', () => { controls._dragging = false; });
  renderer.domElement.addEventListener('wheel', () => { lastUserMove = performance.now(); cancelFly(); }, { passive: true });

  // ---------------------------------------------------------------- lights
  // All of these are re-tuned every frame by the day/night + weather system (see "environment" below).
  const hemi = new THREE.HemisphereLight('#e4ecff', '#5b4a3a', 0.55); scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffeed6', 2.3);
  sun.position.set(-7, 15, 8);
  sun.castShadow = true;
  const SHADOW_FULL = Math.min(window.innerWidth, window.innerHeight) < 700 ? 2048 : 4096;
  sun.shadow.mapSize.setScalar(SHADOW_FULL);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 50 });
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.025; sun.shadow.radius = 4;
  scene.add(sun, sun.target);
  const moon = new THREE.DirectionalLight('#a8bcff', 0); moon.position.set(8, 14, -6); scene.add(moon);
  const fill = new THREE.DirectionalLight('#c9dcff', 0.5);
  fill.position.set(9, 6, -6); scene.add(fill);
  const nightMats = []; // [material, peak emissive intensity] — lights that come on after dark
  let envClockRef = () => 0;
  const wetMats = [];   // [material, dry roughness] — surfaces that shine when it rains
  const tileSheets = []; // the road artwork canvases (used to show an enlarged picture of a space)

  // ---------------------------------------------------------------- helpers
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function tex(c, repeat) {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso;
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
    return t;
  }
  function plastic(color, o) {
    return new THREE.MeshPhysicalMaterial(Object.assign({ color, roughness: 0.38, clearcoat: 0.55, clearcoatRoughness: 0.3 }, o || {}));
  }
  const matte = (color, o) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.85 }, o || {}));
  function shadowed(obj) { obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); return obj; }
  let seed = 12345;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  function smoothPoly(ctx, pts) {
    const n = pts.length; ctx.beginPath();
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let m = mid(pts[n - 1], pts[0]); ctx.moveTo(m[0], m[1]);
    for (let i = 0; i < n; i++) { const p = pts[i], q = mid(p, pts[(i + 1) % n]); ctx.quadraticCurveTo(p[0], p[1], q[0], q[1]); }
    ctx.closePath();
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
  const FONT = '"Barlow Condensed", "Arial Narrow", Arial, sans-serif';
  const LAND = scenery.landColours;

  // Rescale a BoxGeometry's UVs so a facade texture (one bay × one floor per tile) repeats in whole bays.
  function facadeBox(w, h, d, cellW, cellH) {
    const g = new THREE.BoxGeometry(w, h, d);
    const uv = g.attributes.uv, floors = Math.max(1, Math.round(h / cellH));
    const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      const bays = Math.max(1, Math.round(faces[f][0] / cellW)), fl = f === 2 || f === 3 ? 1 : floors;
      for (let v = f * 4; v < f * 4 + 4; v++) uv.setXY(v, uv.getX(v) * bays, uv.getY(v) * fl);
    }
    return g;
  }
  function facadeCylinder(rTop, rBot, h, sides, cellW, cellH, thetaStart, thetaLen, open) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, sides, 1, !!open, thetaStart, thetaLen === undefined ? Math.PI * 2 : thetaLen);
    const len = (thetaLen === undefined ? Math.PI * 2 : thetaLen) * rBot;
    const perFace = sides <= 8 ? Math.max(1, Math.round(2 * rBot * Math.sin(Math.PI / sides) / cellW)) : 0;
    const bays = perFace ? perFace * sides : Math.max(1, Math.round(len / cellW));
    const floors = Math.max(1, Math.round(h / cellH));
    const uv = g.attributes.uv;
    // Side vertices come first: (heightSegments+1)*(radialSegments+1)
    const nSide = 2 * (sides + 1);
    for (let v = 0; v < nSide; v++) uv.setXY(v, uv.getX(v) * bays, uv.getY(v) * floors);
    return g;
  }
  function flip(g) {
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i]; idx[i] = idx[i + 2]; idx[i + 2] = t; }
    const n = g.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
    return g;
  }
  function quad(p0, p1, p2, p3, outward, uvScale) {
    const g = new THREE.BufferGeometry();
    let pts = [p0, p1, p2, p0, p2, p3];
    const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0)).normalize();
    if (n.dot(outward) < 0) { pts = [p0, p2, p1, p0, p3, p2]; n.negate(); }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap(p => [p.x, p.y, p.z]), 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(pts.flatMap(() => [n.x, n.y, n.z]), 3));
    const su = uvScale ? uvScale[0] : 1, sv = uvScale ? uvScale[1] : 1;
    const uvOf = p => p === p0 ? [0, 0] : p === p1 ? [su, 0] : p === p2 ? [su, sv] : [0, sv];
    g.setAttribute('uv', new THREE.Float32BufferAttribute(pts.flatMap(uvOf), 2));
    return g;
  }
  // A curved block between radii r0..r1 and angles a0..a1 (radians, clockwise from east as seen from above).
  // inset > 0 slopes the walls inward towards the top (a mansard).
  function sector(r0, r1, a0, a1, h, inset, cellW, cellH) {
    inset = inset || 0;
    const segs = Math.max(6, Math.round((a1 - a0) * 24));
    const tStart = Math.PI / 2 - a1, tLen = a1 - a0;
    const outer = facadeCylinder(r1 - inset, r1, h, segs, cellW, cellH, tStart, tLen, true);
    const inner = flip(facadeCylinder(r0 + inset, r0, h, segs, cellW, cellH, tStart, tLen, true));
    [outer, inner].forEach(g => g.translate(0, h / 2, 0));
    const top = new THREE.RingGeometry(r0 + inset, r1 - inset, segs, 1, -a1, tLen);
    top.rotateX(-Math.PI / 2); top.translate(0, h, 0);
    const P = (r, a, y) => new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a));
    const endUV = [Math.max(1, Math.round((r1 - r0) / cellW)), Math.max(1, Math.round(h / cellH))];
    const e0 = quad(P(r0, a0, 0), P(r1, a0, 0), P(r1 - inset, a0, h), P(r0 + inset, a0, h), new THREE.Vector3(Math.sin(a0), 0, -Math.cos(a0)), endUV);
    const e1 = quad(P(r0, a1, 0), P(r1, a1, 0), P(r1 - inset, a1, h), P(r0 + inset, a1, h), new THREE.Vector3(-Math.sin(a1), 0, Math.cos(a1)), endUV);
    const nonIdx = g => g.index ? g.toNonIndexed() : g;
    const walls = mergeGeometries([nonIdx(outer), nonIdx(inner), e0, e1]);
    return { walls, top: nonIdx(top) };
  }

  // ---------------------------------------------------------------- facade textures (one tile = one bay × one floor)
  // `lit` draws the windows (white on black): it becomes the emissive map, so windows glow after dark.
  function facade(draw, w = 128, h = 128, lit) {
    const c = canvas(w, h); draw(c.getContext('2d'), w, h); const t = tex(c, true);
    if (lit) { const m = canvas(w, h), g = m.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; lit(g, w, h); t.userData.lit = tex(m, true); }
    return t;
  }
  const FAC = {
    royal: facade((g, w, h) => { g.fillStyle = '#efe2c2'; g.fillRect(0, 0, w, h); g.fillStyle = '#e2d2ac'; g.fillRect(0, h - 10, w, 10); g.fillStyle = '#7a5a36'; g.fillRect(34, 26, 60, 64); g.fillStyle = '#c99a4e'; g.fillRect(40, 32, 22, 52); g.fillRect(66, 32, 22, 52); g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(40, 32, 6, 52); }, 128, 128, (g) => { g.fillRect(40, 32, 22, 52); g.fillRect(66, 32, 22, 52); }),
    glass: facade((g, w, h) => { const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#9cc6e6'); gr.addColorStop(.5, '#6f9fc9'); gr.addColorStop(1, '#8fbde0'); g.fillStyle = gr; g.fillRect(0, 0, w, h); g.fillStyle = '#e9f2f8'; g.fillRect(0, 0, w, 7); g.fillRect(0, 0, 6, h); g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.moveTo(20, h); g.lineTo(60, 0); g.lineTo(80, 0); g.lineTo(40, h); g.fill(); g.fillStyle = 'rgba(40,70,110,.25)'; g.fillRect(6, 64, w - 6, 3); }, 128, 128, (g, w, h) => { g.globalAlpha = 0.85; g.fillRect(6, 7, w - 6, 57); g.globalAlpha = 0.45; g.fillRect(6, 67, w - 6, h - 67); }),
    fuji: facade((g, w, h) => { g.fillStyle = '#3b4046'; g.fillRect(0, 0, w, h); g.fillStyle = '#e6b24c'; g.fillRect(18, 14, 36, 96); g.fillRect(74, 14, 36, 96); g.fillStyle = '#f6d88a'; g.fillRect(18, 14, 10, 96); g.fillRect(74, 14, 10, 96); g.fillStyle = '#2c3035'; g.fillRect(0, 118, w, 10); }, 128, 128, (g) => { g.fillRect(18, 14, 36, 96); g.fillRect(74, 14, 36, 96); }),
    brick: facade((g, w, h) => { g.fillStyle = '#b9573c'; g.fillRect(0, 0, w, h); g.strokeStyle = 'rgba(80,30,20,.25)'; g.lineWidth = 1; for (let y = 0; y < h; y += 8) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); } g.fillStyle = '#f3ede2'; g.fillRect(36, 28, 56, 74); g.beginPath(); g.arc(64, 30, 28, Math.PI, 0); g.fill(); g.fillStyle = '#35507a'; g.fillRect(42, 34, 44, 64); g.beginPath(); g.arc(64, 34, 22, Math.PI, 0); g.fill(); g.fillStyle = '#f3ede2'; g.fillRect(62, 20, 4, 80); g.fillRect(42, 62, 44, 4); g.fillStyle = '#e8dccb'; g.fillRect(0, 118, w, 10); }, 128, 128, (g) => { g.fillRect(42, 34, 44, 64); g.beginPath(); g.arc(64, 34, 22, Math.PI, 0); g.fill(); }),
    taj: facade((g, w, h) => { g.fillStyle = '#f3ead8'; g.fillRect(0, 0, w, h); g.fillStyle = '#d9ccb2'; g.fillRect(0, 0, 6, h); g.fillStyle = '#6b5846'; g.beginPath(); g.moveTo(40, 110); g.lineTo(40, 50); g.quadraticCurveTo(64, 10, 88, 50); g.lineTo(88, 110); g.fill(); g.fillStyle = '#c94f5a'; g.fillRect(40, 96, 48, 14); }, 128, 128, (g) => { g.beginPath(); g.moveTo(40, 110); g.lineTo(40, 50); g.quadraticCurveTo(64, 10, 88, 50); g.lineTo(88, 110); g.fill(); }),
    wood: facade((g, w, h) => { g.fillStyle = '#b27d4d'; g.fillRect(0, 0, w, h); g.strokeStyle = 'rgba(60,35,15,.35)'; for (let x = 0; x < w; x += 12) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); } g.fillStyle = '#3d2a1c'; g.fillRect(40, 34, 48, 44); g.fillStyle = '#f0d9a0'; g.fillRect(46, 40, 16, 32); g.fillRect(66, 40, 16, 32); }, 128, 128, (g) => { g.fillRect(46, 40, 16, 32); g.fillRect(66, 40, 16, 32); }),
    boom: facade((g, w, h) => { g.fillStyle = '#f1e8d2'; g.fillRect(0, 0, w, h); g.fillStyle = '#6a7f86'; g.fillRect(0, 30, w, 50); g.fillStyle = '#a9c4cc'; g.fillRect(0, 30, w, 14); g.strokeStyle = '#fbf7ee'; g.lineWidth = 4; for (let x = 4; x < w; x += 12) { g.beginPath(); g.moveTo(x, 80); g.lineTo(x, 104); g.stroke(); } g.fillStyle = '#fbf7ee'; g.fillRect(0, 78, w, 6); }, 128, 128, (g, w) => { g.fillRect(0, 44, w, 34); }),
    slate: facade((g, w, h) => { g.fillStyle = '#5c646a'; g.fillRect(0, 0, w, h); g.fillStyle = '#39414a'; g.fillRect(40, 30, 48, 70); g.fillStyle = '#8fa4b2'; g.fillRect(46, 36, 36, 58); }, 128, 128, (g) => { g.fillRect(46, 36, 36, 58); }),
    hutWall: facade((g, w, h) => { g.fillStyle = '#d7b98a'; g.fillRect(0, 0, w, h); g.fillStyle = '#5b3f2a'; g.fillRect(30, 20, 26, 80); g.fillRect(74, 30, 30, 40); }, 128, 128, (g) => { g.fillRect(74, 30, 30, 40); })
  };
  const M = {
    royal: [plastic('#fff', { map: FAC.royal }), plastic('#d7c498')],
    glass: plastic('#ffffff', { map: FAC.glass, roughness: 0.12, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.4 }),
    glassFrame: plastic('#6d7a86', { roughness: 0.3 }),
    glassRoof: plastic('#58626d'),
    fuji: plastic('#fff', { map: FAC.fuji }), fujiRoof: plastic('#30353b'),
    brick: plastic('#fff', { map: FAC.brick, clearcoat: 0.2 }), mansard: plastic('#3a4047'), mansardTop: plastic('#2f343a'),
    taj: plastic('#fff', { map: FAC.taj }), tajPlain: plastic('#f3ead8'), tajTrim: plastic('#e2d4ba'), gold: plastic('#d8b25a', { metalness: 0.6, roughness: 0.3 }),
    wood: plastic('#fff', { map: FAC.wood, clearcoat: 0.1 }), lodgeRoof: plastic('#4a3226', { roughness: 0.45 }),
    hutRoof: plastic('#fff', { roughness: 0.32, map: facade((g, w, h) => { g.fillStyle = '#56392b'; g.fillRect(0, 0, w, h); g.fillStyle = '#462e22'; for (let y = 0; y < h; y += 8) g.fillRect(0, y, w, 3); }, 64, 64) }), hutWall: plastic('#fff', { map: FAC.hutWall }),
    boom: plastic('#fff', { map: FAC.boom }), boomRoof: plastic('#f7f0e0'),
    slate: plastic('#fff', { map: FAC.slate }), slateDark: plastic('#3b4146'), stone: plastic('#cfd2cc'),
    entrance: plastic('#d3322b', { roughness: 0.3, clearcoat: 0.8 }),
    white: plastic('#f7f5ef'), trunk: matte('#7a5236'), leaf: plastic('#3f8f3a', { roughness: 0.55, clearcoat: 0.2 }), leaf2: plastic('#5aa63f', { roughness: 0.55, clearcoat: 0.2 }),
    lamp: plastic('#2c3136'), bulb: new THREE.MeshStandardMaterial({ color: '#fff7d6', emissive: '#ffe7a3', emissiveIntensity: 0.6 })
  };
  // Any material whose facade has a window mask lights up at night.
  for (const k in M) for (const mat of [].concat(M[k])) {
    const lit = mat.map && mat.map.userData && mat.map.userData.lit;
    if (lit) { mat.emissive = new THREE.Color('#ffc477'); mat.emissiveMap = lit; mat.emissiveIntensity = 0; nightMats.push([mat, k === 'glass' ? 0.55 : 1.15]); }
  }
  nightMats.push([M.bulb, 2.4]);

  // ---------------------------------------------------------------- the land around the board: fields running out to the horizon
  const GRASS = '#63a444';
  // Waikiki's beach, spilling past the board's edges (board pixels); feathered into the grass on and off the board alike
  const SAND_SPILL = [[30, 112], [66, 90], [90, 62], [118, 46], [140, 18], [210, -40], [262, -70], [300, -40], [298, 18], [292, 80], [300, 146], [240, 152], [150, 160], [92, 176], [62, 212], [30, 240], [-30, 262], [-80, 250], [-100, 215], [-60, 170]], SAND_FEATHER = 15.5;
  {
    const S = 1024, c = canvas(S, S), g = c.getContext('2d'), bc = canvas(S, S), bg = bc.getContext('2d');
    g.fillStyle = GRASS; g.fillRect(0, 0, S, S); bg.fillStyle = '#808080'; bg.fillRect(0, 0, S, S);
    // soft clumps of lighter and darker turf
    for (let i = 0; i < 260; i++) { const x = rnd() * S, y = rnd() * S, r = 20 + rnd() * 60, gr = g.createRadialGradient(x, y, 0, x, y, r); const dark = rnd() > 0.5; gr.addColorStop(0, dark ? 'rgba(38,92,30,.22)' : 'rgba(150,205,95,.20)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) { g.save(); g.translate(ox, oy); g.fillRect(x - r, y - r, r * 2, r * 2); g.restore(); } }
    // blades: short strokes, light tips over dark roots (and the same strokes, raised, in the bump map)
    for (let i = 0; i < 26000; i++) {
      const x = rnd() * S, y = rnd() * S, len = 3 + rnd() * 6, a = -Math.PI / 2 + (rnd() - 0.5) * 0.9, hue = 85 + rnd() * 30, l = 26 + rnd() * 22;
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      g.strokeStyle = `hsla(${hue},55%,${l}%,.55)`; g.lineWidth = 0.8 + rnd() * 0.8; g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
      bg.strokeStyle = `rgba(255,255,255,${0.25 + rnd() * 0.35})`; bg.lineWidth = 1; bg.beginPath(); bg.moveTo(x, y); bg.lineTo(x2, y2); bg.stroke();
    }
    // the odd daisy and clover
    for (let i = 0; i < 160; i++) { g.fillStyle = rnd() > 0.7 ? 'rgba(255,240,140,.85)' : 'rgba(255,255,255,.8)'; g.beginPath(); g.arc(rnd() * S, rnd() * S, 0.9 + rnd() * 0.9, 0, 7); g.fill(); }
    const t = tex(c, true); t.repeat.set(30, 30);
    const bump = new THREE.CanvasTexture(bc); bump.wrapS = bump.wrapT = THREE.RepeatWrapping; bump.repeat.set(30, 30); bump.anisotropy = maxAniso;
    // large-scale tint: drifts of sun-bleached and lush grass across the whole landscape
    const mc = canvas(256, 256), mg = mc.getContext('2d'); mg.fillStyle = '#808080'; mg.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 90; i++) { const x = rnd() * 256, y = rnd() * 256, r = 10 + rnd() * 40, gr = mg.createRadialGradient(x, y, 0, x, y, r); const v = rnd() > 0.5; gr.addColorStop(0, v ? 'rgba(200,190,120,.35)' : 'rgba(40,90,40,.35)'); gr.addColorStop(1, 'rgba(128,128,128,0)'); mg.fillStyle = gr; mg.fillRect(x - r, y - r, r * 2, r * 2); }
    const macro = new THREE.CanvasTexture(mc); macro.colorSpace = THREE.NoColorSpace;
    const gm = new THREE.MeshStandardMaterial({ map: t, bumpMap: bump, bumpScale: 1.2, roughness: 1 });
    gm.onBeforeCompile = sh => {
      sh.uniforms.macroMap = { value: macro };
      sh.fragmentShader = 'uniform sampler2D macroMap;\n' + sh.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n diffuseColor.rgb *= texture2D(macroMap, vMapUv / 30.0).rgb * 2.0;');
    };
    const ground = new THREE.Mesh(new THREE.CircleGeometry(95, 64), gm);
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.004; ground.receiveShadow = true; scene.add(ground);
    wetMats.push([ground.material, 1]);
  }

  // ---------------------------------------------------------------- the printed board
  const [bx0, by0, bx1, by1] = scenery.boardRect;
  const BW = (bx1 - bx0) / U, BD = (by1 - by0) / U, BCX = wx((bx0 + bx1) / 2), BCZ = wz((by0 + by1) / 2);
  {
    const S = 4096 / (bx1 - bx0);
    const c = canvas(4096, Math.round((by1 - by0) * S)), g = c.getContext('2d');
    const rc = canvas(1024, Math.round(1024 * c.height / c.width)), rg = rc.getContext('2d'); // roughness map
    g.setTransform(S, 0, 0, S, -bx0 * S, -by0 * S);
    const rs = rc.width / (bx1 - bx0); rg.setTransform(rs, 0, 0, rs, -bx0 * rs, -by0 * rs);
    rg.fillStyle = '#d8d8d8'; rg.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
    // no printed frame: the board's edge is just more countryside
    const ix0 = bx0, iy0 = by0, ix1 = bx1, iy1 = by1;
    g.save(); g.beginPath(); g.rect(ix0, iy0, ix1 - ix0, iy1 - iy0); g.clip();
    g.fillStyle = GRASS; g.fillRect(ix0, iy0, ix1 - ix0, iy1 - iy0);
    // grass speckle
    for (let i = 0; i < 9000; i++) { g.fillStyle = rnd() > 0.5 ? 'rgba(40,90,30,.10)' : 'rgba(170,220,120,.10)'; g.beginPath(); g.arc(ix0 + rnd() * (ix1 - ix0), iy0 + rnd() * (iy1 - iy0), 0.4 + rnd() * 1.4, 0, 7); g.fill(); }
    for (const item of scenery.ground) {
      const col = item[0];
      g.fillStyle = col;
      if (item[1] === 'circle') { g.beginPath(); g.arc(item[2], item[3], item[4], 0, Math.PI * 2); g.fill(); }
      else {
        const beachSand = col === '#f0deaa' && item[1][0][0] === 30 && item[1][0][1] === 112;
        if (!beachSand || !scenery.coast) { smoothPoly(g, item[1]); g.fill(); } // Waikiki's beach is laid as one sheet over board and land (below)
      }
      const water = col === '#4ea3d8' || col === '#7fb7d9';
      if (water) {
        rg.fillStyle = '#262626'; smoothPoly(rg, item[1]); rg.fill();
        g.save(); smoothPoly(g, item[1]); g.clip(); g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1.2;
        for (let y = iy0; y < iy1; y += 9) { g.beginPath(); for (let x = ix0; x < ix1; x += 6) g.lineTo(x, y + Math.sin(x / 9 + y) * 1.5); g.stroke(); }
        g.restore();
      }
    }
    // L'Etoile plaza detailing
    { const R = scenery.hotels.etoile.ring; g.strokeStyle = '#bfb29d'; g.lineWidth = 2; for (const r of [52, 86, 100]) { g.beginPath(); g.arc(R.x, R.y, r, 0, 7); g.stroke(); } g.fillStyle = '#c7baa3'; for (let a = 0; a < 24; a++) { const t = a / 24 * Math.PI * 2; g.beginPath(); g.arc(R.x + Math.cos(t) * 93, R.y + Math.sin(t) * 93, 2, 0, 7); g.fill(); } }
    // river
    { const rv = scenery.river; const line = (w, col) => { g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath(); rv.path.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke(); };
      line(rv.width + 8, '#3d8b3a'); line(rv.width + 3, '#2e86c1'); line(rv.width, '#6fc0e8'); line(rv.width * 0.45, '#a7dcf3');
      rg.strokeStyle = '#262626'; rg.lineWidth = rv.width; rg.lineCap = 'round'; rg.lineJoin = 'round'; rg.beginPath(); rv.path.forEach((p, i) => i ? rg.lineTo(p[0], p[1]) : rg.moveTo(p[0], p[1])); rg.stroke(); }
    for (const [x, y, w, h] of scenery.parking) { g.fillStyle = '#8f9ba4'; g.fillRect(x, y, w, h); g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 1; const vert = h > w; for (let k = 4; k < (vert ? h : w); k += 9) { g.beginPath(); if (vert) { g.moveTo(x + 3, y + k); g.lineTo(x + w * 0.45, y + k); g.moveTo(x + w * 0.55, y + k); g.lineTo(x + w - 3, y + k); } else { g.moveTo(x + k, y + 3); g.lineTo(x + k, y + h * 0.45); g.moveTo(x + k, y + h * 0.55); g.lineTo(x + k, y + h - 3); } g.stroke(); } }
    // start car park bays
    { const cp = scenery.carPark; g.fillStyle = '#16191b'; g.font = `700 13px ${FONT}`; g.textAlign = 'center'; g.fillText('START', 700, 213);
      cp.bays.forEach(([x, y], i) => { g.fillStyle = '#f5f3ee'; g.fillRect(x - 10, y - 16, 20, 32); g.fillStyle = scenery.playerColours[i]; g.fillRect(x - 8, y - 14, 16, 28); });
    }
    // Town Hall and Bank labels
    g.fillStyle = '#39414a'; g.font = `700 11px ${FONT}`; g.textAlign = 'center';
    g.fillText('TOWN HALL', 526, 164); g.fillText('BANK', 452, 566);
    g.restore();
    const top = new THREE.Mesh(new THREE.PlaneGeometry(BW, BD), new THREE.MeshStandardMaterial({ map: tex(c), roughnessMap: new THREE.CanvasTexture(rc), roughness: 1, metalness: 0 }));
    wetMats.push([top.material, 1]);
    top.rotation.x = -Math.PI / 2; top.position.set(BCX, 0.001, BCZ); top.receiveShadow = true; scene.add(top);
  }

  // ---------------------------------------------------------------- the road
  const S = board.spaces, N = S.length;
  const curve = new THREE.CatmullRomCurve3(S.map(s => new THREE.Vector3(wx(s.x), 0, wz(s.y))), true, 'catmullrom', 0.5);
  const loop2D = S.map(s => [wx(s.x), wz(s.y)]);
  function inside(x, z) { let c = false; for (let i = 0, j = N - 1; i < N; j = i++) { const [xi, zi] = loop2D[i], [xj, zj] = loop2D[j]; if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) c = !c; } return c; }
  function frameAt(t) {
    t = ((t % 1) + 1) % 1;
    const p = curve.getPoint(t), tg = curve.getTangent(t); tg.y = 0; tg.normalize();
    const side = new THREE.Vector3(-tg.z, 0, tg.x);
    const probe = p.clone().addScaledVector(side, 0.9);
    const innerSide = inside(probe.x, probe.z) ? side.clone() : side.clone().negate();
    return { p, tg, side, innerSide };
  }
  const spaceFrame = i => frameAt(i / N);
  {
    const TILE = 256, PER = 16;
    const ICON = {};
    const lineIds = {}; board.lines.forEach(l => lineIds[l.between[0]] = l);
    const sheets = [];
    for (let sh = 0; sh < 2; sh++) {
      const c = canvas(TILE * PER, TILE), g = c.getContext('2d');
      for (let k = 0; k < PER; k++) {
        const i = sh * PER + k; if (i >= N) break;
        g.save(); g.translate(k * TILE, 0);
        g.fillStyle = '#39a6d6'; g.fillRect(0, 0, TILE, TILE);
        g.fillStyle = '#1b2124'; g.fillRect(0, 8, TILE, TILE - 16);
        roadEdges(g, S[i], i);
        g.fillStyle = '#f6f4ee'; g.fillRect(0, 62, TILE, 132);
        drawSpace(g, S[i], i);
        g.fillStyle = '#c8322b'; g.fillRect(0, 60, 4, 136); g.fillRect(TILE - 4, 60, 4, 136);
        const after = lineIds[i], before = lineIds[(i - 1 + N) % N];
        if (after) yellowBar(g, TILE - 22, after, true);
        if (before) yellowBar(g, 0, before, false);
        g.restore();
      }
      const t = tex(c); t.wrapS = THREE.ClampToEdgeWrapping; sheets.push(t); tileSheets.push(c);
    }
    // The black edge on each side of a space turns the colour of the hotel that may put an entrance there.
    // Side a of the ribbon is the bottom band of the tile (y 194-248), side b the top band (y 8-62).
    function roadEdges(g, sp, i) {
      const f = spaceFrame(i), innerIsA = f.innerSide.dot(f.side) > 0;
      const bands = { inner: innerIsA ? 194 : 8, outer: innerIsA ? 8 : 194 };
      for (const side of ['inner', 'outer']) {
        const y = bands[side], id = sp[side];
        if (id) {
          g.fillStyle = LAND[id]; g.fillRect(0, y, TILE, 54);
          g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, side === 'inner' ? (innerIsA ? y + 48 : y) : (innerIsA ? y : y + 48), TILE, 6);
          g.save(); g.fillStyle = 'rgba(255,255,255,.92)'; g.font = `700 22px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.translate(TILE / 2, y + 27); if (y < 100) g.rotate(Math.PI);
          g.fillText(board.hotels[id].name.toUpperCase(), 0, 1); g.restore();
        } else if (sp.type === 'start' && side === 'inner') {
          g.save(); g.beginPath(); g.rect(0, y, TILE, 54); g.clip();
          for (let k = 0, x = -60; x < TILE + 60; x += 24, k++) { g.fillStyle = k % 2 ? '#f7f5ef' : '#c8322b'; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 12, y); g.lineTo(x + 12 + 54, y + 54); g.lineTo(x + 54, y + 54); g.fill(); }
          g.fillStyle = '#1b2124'; g.fillRect(TILE / 2 - 72, y + 12, 144, 30);
          g.fillStyle = '#fff'; g.font = `700 20px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.translate(TILE / 2, y + 27); if (y < 100) g.rotate(Math.PI); g.fillText('NO ENTRANCE', 0, 1); g.restore();
        }
      }
    }
    function yellowBar(g, x, line, left) {
      g.fillStyle = '#f2c417'; g.fillRect(x, 10, 22, TILE - 20);
      g.save(); g.translate(x + 11, TILE / 2); g.rotate(-Math.PI / 2); g.fillStyle = '#1b2124'; g.font = `700 15px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(line.id === 'bank' ? (left ? 'COLLECT 2000' : 'BANK') : 'BUY ENTRANCES', 0, 1); g.restore();
    }
    function drawSpace(g, sp, i) {
      g.save(); g.translate(TILE / 2, 128);
      g.fillStyle = '#7d878c'; g.strokeStyle = '#4d5559'; g.lineWidth = 3; g.lineJoin = 'round';
      if (sp.type === 'buy') {
        // three little houses: buying land
        for (const [x, y, s] of [[-30, 12, 1], [0, -10, 1.15], [30, 12, 1]]) {
          g.save(); g.translate(x, y); g.scale(s, s);
          g.fillStyle = '#e9ecee'; g.beginPath(); g.moveTo(-16, 16); g.lineTo(-16, -4); g.lineTo(0, -18); g.lineTo(16, -4); g.lineTo(16, 16); g.closePath(); g.fill(); g.stroke();
          g.fillStyle = '#8a969c'; g.fillRect(-5, 4, 10, 12); g.restore();
        }
        g.fillStyle = '#2f9b45'; g.font = `700 22px ${FONT}`; g.textAlign = 'center'; g.fillText('BUY', 0, 58);
      } else if (sp.type === 'build') {
        // tower crane: planning permission
        g.strokeStyle = '#4d5559'; g.lineWidth = 4;
        g.beginPath(); g.moveTo(-20, 44); g.lineTo(-20, -44); g.lineTo(46, -44); g.moveTo(-40, -44); g.lineTo(-20, -44); g.moveTo(-20, -60); g.lineTo(-20, -44); g.stroke();
        g.lineWidth = 2; for (let y = 40; y > -44; y -= 12) { g.beginPath(); g.moveTo(-26, y); g.lineTo(-14, y - 12); g.stroke(); }
        g.beginPath(); g.moveTo(-20, -60); g.lineTo(40, -44); g.moveTo(-20, -60); g.lineTo(-40, -44); g.moveTo(34, -44); g.lineTo(34, 0); g.stroke();
        g.fillStyle = '#e08a1e'; g.fillRect(24, 0, 20, 14); g.fillStyle = '#4d5559'; g.fillRect(-46, -50, 12, 12);
        g.fillStyle = '#e08a1e'; g.font = `700 20px ${FONT}`; g.textAlign = 'center'; g.fillText('PERMISSION', 30, 58);
      } else if (sp.type === 'freeEntrance' || sp.type === 'freeBuild' || sp.type === 'start') {
        const txt = { freeEntrance: ['One free', 'entrance'], freeBuild: ['Build one', 'phase free'], start: ['START', ''] }[sp.type];
        g.fillStyle = '#1b2124'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.font = `600 ${sp.type === 'start' ? 44 : 30}px ${FONT}`; g.fillText(txt[0], 0, txt[1] ? -16 : 0); if (txt[1]) g.fillText(txt[1], 0, 18);
        if (sp.type !== 'start') { g.fillStyle = '#2b8fc9'; g.beginPath(); g.moveTo(-8, -50); g.lineTo(8, -50); g.lineTo(8, -40); g.lineTo(16, -40); g.lineTo(0, -30); g.lineTo(-16, -40); g.lineTo(-8, -40); g.fill(); }
      }
      g.restore();
    }
    // ribbon per space
    const mats = sheets.map(t => new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 }));
    const edgeMat = plastic('#1b2124', { roughness: 0.6, clearcoat: 0.1 });
    mats.forEach(m => wetMats.push([m, 0.7]));
    const SEG = 18;
    for (let i = 0; i < N; i++) {
      const sh = Math.floor(i / PER), k = i % PER;
      const pos = [], uv = [], idx = [], edge = [], eIdx = [];
      for (let s = 0; s <= SEG; s++) {
        const f = s / SEG, { p, side } = frameAt((i - 0.5 + f) / N);
        const a = p.clone().addScaledVector(side, ROAD_W / 2), b = p.clone().addScaledVector(side, -ROAD_W / 2);
        pos.push(a.x, ROAD_Y, a.z, b.x, ROAD_Y, b.z);
        const u = (k + 0.004 + f * 0.992) / PER; uv.push(u, 0, u, 1);
        edge.push(a.x, ROAD_Y, a.z, a.x, 0, a.z, b.x, ROAD_Y, b.z, b.x, 0, b.z);
        if (s < SEG) { const o = s * 2; idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3); const e = s * 4; eIdx.push(e, e + 1, e + 4, e + 1, e + 5, e + 4, e + 2, e + 6, e + 3, e + 3, e + 6, e + 7); }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx); geo.computeVertexNormals();
      if (geo.attributes.normal.getY(0) < 0) { const ia = geo.index.array; for (let q = 0; q < ia.length; q += 3) { const t = ia[q]; ia[q] = ia[q + 2]; ia[q + 2] = t; } geo.computeVertexNormals(); }
      const m = new THREE.Mesh(geo, mats[sh]); m.receiveShadow = true; scene.add(m);
      const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3)); eg.setIndex(eIdx); eg.computeVertexNormals();
      const em = new THREE.Mesh(eg, edgeMat); em.material.side = THREE.DoubleSide; scene.add(em);
    }
  }

  // ---------------------------------------------------------------- scenery: trees, fountain, lamps
  const footprints = []; // [x, y, radius] in px, to keep trees clear
  const swayers = []; // trees that lean in the wind
  const at = (obj, x, y, rotDeg) => { obj.position.set(wx(x), 0, wz(y)); obj.rotation.y = -deg(rotDeg || 0); return obj; };
  // Trees are drawn as instanced meshes: one draw call per part type instead of one per trunk/leaf (there are ~400
  // parts). Each tree is still a Group in the scene (so placement, visibility, swaying and scaling work as before)
  // but its parts are empty slots whose world matrices are copied into the instanced meshes every frame.
  // soft painted shadows for the Low tier (used instead of the real-time shadow map)
  const blobTex = (() => { const c = canvas(64, 64), g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.5)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.28)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const treeParts = (() => {
    const leafG = new THREE.ConeGeometry(0.05, 0.36, 4); leafG.translate(0, 0.18, 0);
    const defs = { palmTrunk: [new THREE.CylinderGeometry(0.025, 0.04, 0.55, 6), M.trunk], palmLeaf: [leafG, M.leaf2], trunk: [new THREE.CylinderGeometry(0.03, 0.04, 0.2, 6), M.trunk],
      blob: [blobGeo, blobMat], bigA: [new THREE.IcosahedronGeometry(0.17, 1), M.leaf], bigB: [new THREE.IcosahedronGeometry(0.17, 1), M.leaf2], smallA: [new THREE.IcosahedronGeometry(0.12, 1), M.leaf], smallB: [new THREE.IcosahedronGeometry(0.12, 1), M.leaf2] };
    const out = {}; for (const k in defs) out[k] = { geo: defs[k][0], mat: defs[k][1], slots: [], mesh: null };
    return out;
  })();
  const treeGroups = [];
  function treeSlot(gp, part, setup) { const o = new THREE.Object3D(); setup(o); o.updateMatrix(); o.matrixAutoUpdate = false; gp.add(o); treeParts[part].slots.push(o); o.userData.tree = gp; return o; }
  function buildTreeInstances() {
    for (const k in treeParts) {
      const tp = treeParts[k]; if (!tp.slots.length || (tp.mesh && tp.mesh.instanceMatrix.count >= tp.slots.length)) continue;
      if (tp.mesh) { scene.remove(tp.mesh); tp.mesh.dispose(); }
      const m = new THREE.InstancedMesh(tp.geo, tp.mat, tp.slots.length + 16);
      m.castShadow = k !== 'blob'; m.receiveShadow = k !== 'blob'; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (k === 'blob') { m.visible = !!(typeof opt !== 'undefined' && opt.blobs); m.renderOrder = 1; }
      tp.mesh = m; scene.add(m);
    }
  }
  const _treeVis = new Map();
  function updateTreeInstances() {
    for (const k in treeParts) { const tp = treeParts[k]; if (tp.slots.length && (!tp.mesh || tp.mesh.instanceMatrix.count < tp.slots.length)) { buildTreeInstances(); break; } }
    _treeVis.clear();
    for (const gp of treeGroups) {
      let v = gp.visible && !!gp.parent; if (v) gp.traverseAncestors(a => { if (!a.visible) v = false; });
      _treeVis.set(gp, v); if (v) gp.updateWorldMatrix(true, true);
    }
    for (const k in treeParts) {
      const tp = treeParts[k]; if (!tp.mesh) continue; let n = 0;
      for (const o of tp.slots) { if (!_treeVis.get(o.userData.tree)) continue; tp.mesh.setMatrixAt(n++, o.matrixWorld); }
      tp.mesh.count = n; tp.mesh.instanceMatrix.needsUpdate = true;
    }
  }
  function tree(scale, kind) {
    const gp = new THREE.Group();
    treeSlot(gp, 'blob', o => { o.position.set(0.05, 0.008, 0.04); o.scale.setScalar(kind === 'palm' ? 0.42 : 0.5); });
    if (kind === 'palm') {
      treeSlot(gp, 'palmTrunk', o => { o.position.y = 0.27; o.rotation.z = 0.12; });
      for (let k = 0; k < 6; k++) treeSlot(gp, 'palmLeaf', o => { o.position.set(0.03, 0.56, 0); o.rotation.set(0, k / 6 * Math.PI * 2, 1.9); });
    } else {
      treeSlot(gp, 'trunk', o => { o.position.y = 0.1; });
      const A = rnd() > 0.5;
      treeSlot(gp, A ? 'bigA' : 'bigB', o => { o.position.y = 0.3; });
      treeSlot(gp, A ? 'smallA' : 'smallB', o => { o.position.set(0.08, 0.4, 0.04); });
    }
    gp.scale.setScalar(scale); gp.userData.sway = { ph: rnd() * 6.28, k: kind === 'palm' ? 1.6 : 1 }; swayers.push(gp); treeGroups.push(gp); return gp;
  }
  function fountain(x, y) {
    const gp = new THREE.Group();
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 0.09, 40), M.stone); basin.position.y = 0.045; gp.add(basin);
    const water = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.37, 0.02, 40), waterMat); water.position.y = 0.085; gp.add(water);
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.28, 16), M.stone); col.position.y = 0.2; gp.add(col);
    const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.14, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), M.stone); bowl.position.y = 0.36; gp.add(bowl);
    return at(shadowed(gp), x, y);
  }
  // animated water
  const waterNormal = (() => {
    const n = 256, c = canvas(n, n), g = c.getContext('2d'), img = g.createImageData(n, n), hgt = new Float32Array(n * n);
    for (let k = 0; k < 40; k++) { const fx = 1 + Math.floor(rnd() * 6), fy = 1 + Math.floor(rnd() * 6), ph = rnd() * 7, amp = 1 / (fx + fy); for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) hgt[y * n + x] += amp * Math.sin((x * fx + y * fy) / n * Math.PI * 2 + ph); }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const dx = hgt[y * n + (x + 1) % n] - hgt[y * n + (x - 1 + n) % n], dy = hgt[((y + 1) % n) * n + x] - hgt[((y - 1 + n) % n) * n + x]; const v = new THREE.Vector3(-dx * 2.5, -dy * 2.5, 1).normalize(); const o = (y * n + x) * 4; img.data[o] = (v.x * .5 + .5) * 255; img.data[o + 1] = (v.y * .5 + .5) * 255; img.data[o + 2] = (v.z * .5 + .5) * 255; img.data[o + 3] = 255; }
    g.putImageData(img, 0, 0); const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 2); return t;
  })();
  const waterMat = new THREE.MeshPhysicalMaterial({ color: '#39b3e6', roughness: 0.06, metalness: 0, clearcoat: 1, normalMap: waterNormal, normalScale: new THREE.Vector2(0.6, 0.6), envMapIntensity: 1.3 });
  const seaMat = waterMat.clone(); // the sea and river don't glow; pools do
  waterMat.emissive = new THREE.Color('#0b8fc4'); waterMat.emissiveIntensity = 0; nightMats.push([waterMat, 0.55]); // pools are lit from below at night

  // ---------------------------------------------------------------- the sea and the river use the same animated water as the pools
  {
    const WY = 0.006;
    for (const item of scenery.ground) {
      if (scenery.coast || item[0] !== '#4ea3d8' || !Array.isArray(item[1])) continue; // the open sea (below) covers the bay
      const pts = item[1].map(([x, y]) => new THREE.Vector2(wx(x), wz(y)));
      const sh = new THREE.Shape(); sh.moveTo(pts[0].x, pts[0].y); sh.splineThru(pts.slice(1).concat([pts[0]]));
      const g = new THREE.ShapeGeometry(sh, 24); g.rotateX(Math.PI / 2); g.translate(0, WY, 0);
      const n = g.attributes.normal; for (let k = 0; k < n.count; k++) n.setXYZ(k, 0, 1, 0);
      const idx = g.index.array; for (let k = 0; k < idx.length; k += 3) { const t = idx[k]; idx[k] = idx[k + 2]; idx[k + 2] = t; }
      const m = new THREE.Mesh(g, seaMat); m.receiveShadow = true; scene.add(m);
    }
    const rv = scenery.river, rc = new THREE.CatmullRomCurve3(rv.path.map(([x, y]) => new THREE.Vector3(wx(x), 0, wz(y))), false, 'catmullrom', 0.5);
    const M_ = 80, half = rv.width / U / 2, pos = [], uv = [], idx = [];
    for (let k = 0; k <= M_; k++) {
      const p = rc.getPoint(k / M_), t = rc.getTangent(k / M_); const sx = -t.z, sz = t.x, L = Math.hypot(sx, sz);
      for (const s of [1, -1]) { const x = p.x + sx / L * half * s, z = p.z + sz / L * half * s; pos.push(x, WY, z); uv.push(x, z); }
      if (k < M_) { const o = k * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    if (g.attributes.normal.getY(0) < 0) { const a = g.index.array; for (let k = 0; k < a.length; k += 3) { const t = a[k]; a[k] = a[k + 2]; a[k + 2] = t; } g.computeVertexNormals(); }
    const m = new THREE.Mesh(g, seaMat); m.receiveShadow = true; scene.add(m);
  }

  // ---------------------------------------------------------------- hotel building styles
  const px = v => v / U;
  const STYLE = {
    royal(p) {
      const w = px(p.w), d = px(p.d), h = p.h, gp = new THREE.Group();
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.06, d + 0.08), M.royal[1]); plinth.position.y = 0.03; gp.add(plinth);
      const body = new THREE.Mesh(facadeBox(w, h, d, 0.2, 0.2), [M.royal[0], M.royal[0], M.royal[1], M.royal[1], M.royal[0], M.royal[0]]); body.position.y = h / 2 + 0.06; gp.add(body);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.05, 0.05, d + 0.05), M.royal[1]); cap.position.y = h + 0.085; gp.add(cap);
      const cren = new THREE.BoxGeometry(0.06, 0.07, 0.06), top = h + 0.14;
      for (let x = -w / 2; x <= w / 2 + 1e-6; x += w / Math.round(w / 0.11)) for (const z of [-d / 2, d / 2]) { const m = new THREE.Mesh(cren, M.royal[0]); m.position.set(x, top, z); gp.add(m); }
      for (let z = -d / 2; z <= d / 2 + 1e-6; z += d / Math.round(d / 0.11)) for (const x of [-w / 2, w / 2]) { const m = new THREE.Mesh(cren, M.royal[0]); m.position.set(x, top, z); gp.add(m); }
      const lift = new THREE.Mesh(new THREE.BoxGeometry(w * 0.35, 0.12, d * 0.35), M.royal[1]); lift.position.y = h + 0.16; gp.add(lift);
      return gp;
    },
    glass(p) {
      const w = px(p.w), d = px(p.d), h = p.h, gp = new THREE.Group();
      const body = new THREE.Mesh(facadeBox(w, h, d, 0.16, 0.16), [M.glass, M.glass, M.glassRoof, M.glassRoof, M.glass, M.glass]); body.position.y = h / 2; gp.add(body);
      for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.05, h, 0.05), M.glassFrame); f.position.set(x * w / 2, h / 2, z * d / 2); gp.add(f); }
      // sloping roof wedge
      const sh = new THREE.Shape(); sh.moveTo(-w / 2 - 0.02, 0); sh.lineTo(w / 2 + 0.02, 0); sh.lineTo(-w / 2 - 0.02, w * 0.7); sh.closePath();
      const wedge = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: d + 0.04, bevelEnabled: false }), M.glassRoof); wedge.position.set(0, h, -d / 2 - 0.02); gp.add(wedge);
      const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.08, d + 0.1), M.glassFrame); base.position.y = 0.04; gp.add(base);
      return gp;
    },
    hex(p) {
      const r = px(p.r), h = p.h, gp = new THREE.Group();
      const body = new THREE.Mesh(facadeCylinder(r, r, h, 6, 0.14, 0.16), [M.fuji, M.fujiRoof, M.fujiRoof]); body.position.y = h / 2; gp.add(body);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.08, r * 1.08, 0.1, 6), M.fujiRoof); cap.position.y = h + 0.05; gp.add(cap);
      const cap2 = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.72, r * 0.9, 0.14, 6), M.fujiRoof); cap2.position.y = h + 0.17; gp.add(cap2);
      const plinth = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.1, r * 1.12, 0.06, 6), M.fujiRoof); plinth.position.y = 0.03; gp.add(plinth);
      gp.rotation.y = Math.PI / 6; return gp;
    },
    tajMain(p) {
      const w = px(p.w), d = px(p.d), h = p.h, gp = new THREE.Group();
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, 0.08, d + 0.16), M.tajTrim); plinth.position.y = 0.04; gp.add(plinth);
      const body = new THREE.Mesh(facadeBox(w, h, d, 0.22, 0.26), [M.taj, M.taj, M.tajPlain, M.tajPlain, M.taj, M.taj]); body.position.y = 0.08 + h / 2; gp.add(body);
      const par = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.06, d + 0.04), M.tajTrim); par.position.y = 0.08 + h + 0.03; gp.add(par);
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.2, 32), M.tajPlain); drum.position.y = 0.08 + h + 0.16; gp.add(drum);
      const dome = onion(0.34, 0.5); dome.position.y = 0.08 + h + 0.26; gp.add(dome);
      for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const mn = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, h + 0.3, 12), M.tajPlain); mn.position.set(x * (w / 2 + 0.02), 0.08 + (h + 0.3) / 2, z * (d / 2 + 0.02)); gp.add(mn); const cd = onion(0.06, 0.09); cd.position.set(mn.position.x, 0.08 + h + 0.3, mn.position.z); gp.add(cd); }
      return gp;
    },
    tajSide(p) {
      const w = px(p.w), d = px(p.d), h = p.h, gp = new THREE.Group();
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.06, d + 0.1), M.tajTrim); plinth.position.y = 0.03; gp.add(plinth);
      const body = new THREE.Mesh(facadeBox(w, h, d, 0.22, 0.26), [M.taj, M.taj, M.tajPlain, M.tajPlain, M.taj, M.taj]); body.position.y = 0.06 + h / 2; gp.add(body);
      const dome = onion(0.21, 0.3); dome.position.y = 0.06 + h; gp.add(dome);
      return gp;
    },
    lodge(p) {
      const w = px(p.w), d = px(p.d), gp = new THREE.Group(), h = 0.32;
      const body = new THREE.Mesh(facadeBox(w * 0.9, h, d * 0.9, 0.18, 0.32), M.wood); body.position.y = h / 2; gp.add(body);
      const cone = new THREE.ConeGeometry(1, 0.4, 4); cone.rotateY(Math.PI / 4);
      const roof = new THREE.Mesh(cone, M.lodgeRoof); const k = 1 / Math.SQRT2;
      roof.scale.set((w / 2 + 0.06) / k, 1, (d / 2 + 0.06) / k); roof.position.y = h + 0.2; gp.add(roof);
      const deck = new THREE.Mesh(new THREE.BoxGeometry(w * 0.3, 0.05, 0.14), M.lodgeRoof); deck.position.set(0, 0.025, -d / 2 - 0.02); gp.add(deck);
      return gp;
    },
    hut(p) {
      const w = px(p.w), d = px(p.d), gp = new THREE.Group();
      const wall = new THREE.Mesh(facadeBox(w * 0.86, 0.24, d * 0.74, 0.2, 0.24), M.hutWall); wall.position.y = 0.12; gp.add(wall);
      const cap = new THREE.CapsuleGeometry(d / 2, w - d, 6, 20); cap.rotateZ(Math.PI / 2);
      const roof = new THREE.Mesh(cap, M.hutRoof); roof.scale.set(1.04, 0.62, 1.12); roof.position.y = 0.24; gp.add(roof);
      const ridge = new THREE.Mesh(new THREE.BoxGeometry(w - d * 0.9, 0.03, 0.05), M.hutRoof); ridge.position.y = 0.24 + d * 0.31; gp.add(ridge);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 0.14), M.hutRoof); post.position.set(w / 2 + 0.02, 0.07, 0); gp.add(post);
      return gp;
    },
    crescent(p) {
      const gp = new THREE.Group();
      const tiers = [[p.r0, p.r1, 0.55], [p.r0 + 4, p.r1 - 5, 0.85], [p.r0 + 9, p.r1 - 11, 1.12]];
      tiers.forEach(([a, b, h], i) => {
        const trim = i * 3; const s = sector(px(a), px(b), deg(p.a0 + trim), deg(p.a1 - trim), h, 0, 0.18, 0.2);
        gp.add(new THREE.Mesh(s.walls, M.boom), new THREE.Mesh(s.top, M.boomRoof));
      });
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.1, 32), M.boomRoof);
      const a = deg(p.a0 + 6), r = px((p.r0 + p.r1) / 2); disc.position.set(Math.cos(a) * r, 1.17, Math.sin(a) * r); gp.add(disc);
      return gp;
    },
    wing(p, ring) {
      const gp = new THREE.Group(), a0 = deg(p.a - p.span / 2), a1 = deg(p.a + p.span / 2);
      const s = sector(px(ring.r0), px(ring.r1), a0, a1, p.h, 0, 0.2, 0.24);
      gp.add(new THREE.Mesh(s.walls, M.brick), new THREE.Mesh(s.top, M.mansard));
      const m = sector(px(ring.r0) - 0.02, px(ring.r1) + 0.02, a0 - 0.01, a1 + 0.01, 0.34, 0.12, 0.2, 0.2);
      const mw = new THREE.Mesh(m.walls, M.mansard), mt = new THREE.Mesh(m.top, M.mansardTop); mw.position.y = mt.position.y = p.h; gp.add(mw, mt);
      const cornice = sector(px(ring.r0) - 0.03, px(ring.r1) + 0.03, a0 - 0.012, a1 + 0.012, 0.04, 0, 1, 1);
      const cw = new THREE.Mesh(cornice.walls, M.white), ct = new THREE.Mesh(cornice.top, M.white); cw.position.y = ct.position.y = p.h - 0.02; gp.add(cw, ct);
      const rOut = px(ring.r1) - 0.02, nD = 4;
      for (let k = 0; k < nD; k++) { const a = a0 + (a1 - a0) * (k + 0.5) / nD; const dm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.09), M.white); dm.position.set(Math.cos(a) * (rOut - 0.04), p.h + 0.12, Math.sin(a) * (rOut - 0.04)); dm.rotation.y = -a + Math.PI / 2; gp.add(dm); }
      const ch = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.1), M.brick); const ac = (a0 + a1) / 2, rc = px((ring.r0 + ring.r1) / 2); ch.position.set(Math.cos(ac) * rc, p.h + 0.4, Math.sin(ac) * rc); gp.add(ch);
      return gp;
    }
  };
  function onion(r, hgt) {
    const pts = [];
    for (let i = 0; i <= 16; i++) { const t = i / 16; const y = t * hgt; const rad = r * Math.sin(Math.PI * Math.pow(t, 0.8)) * (1 + 0.25 * Math.sin(Math.PI * t)) * (t < 0.1 ? 0.9 + t : 1); pts.push(new THREE.Vector2(Math.max(0.001, rad), y)); }
    pts.push(new THREE.Vector2(0.001, hgt));
    const gp = new THREE.Group();
    gp.add(new THREE.Mesh(new THREE.LatheGeometry(pts, 32), M.tajPlain));
    const fin = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.012, hgt * 0.35, 6), M.gold); fin.position.y = hgt + hgt * 0.15; gp.add(fin);
    return gp;
  }

  // ---------------------------------------------------------------- leisure facilities: each hotel's grounds
  const FM = {
    straw: plastic('#d8b263', { roughness: 0.7, clearcoat: 0.1 }), wood: plastic('#9a6a3f', { roughness: 0.6 }), darkWood: plastic('#5b3b24'),
    court: null, cushion: [plastic('#f2c417'), plastic('#2f79c9'), plastic('#d0342c'), plastic('#3fa34d')],
    lacquer: plastic('#c8322b', { clearcoat: 0.9 }), rock: matte('#8d8a84', { roughness: 0.9 }), rock2: matte('#a8a39a', { roughness: 0.9 }),
    cypress: plastic('#2f6b34', { roughness: 0.6, clearcoat: 0.2 }), topiary: plastic('#3d8a3a', { roughness: 0.55, clearcoat: 0.25 }), pine: plastic('#2e5d3a', { roughness: 0.6 }),
    planter: plastic('#e9e2d4'), jet: new THREE.MeshPhysicalMaterial({ color: '#eaf8ff', transparent: true, opacity: 0.75, roughness: 0.1, clearcoat: 1 }),
    tile: plastic('#bfe6f5', { roughness: 0.3 }), coping: plastic('#f4f1ea')
  };
  function paving(base, line, lawn) {
    const c = canvas(256, 256), g = c.getContext('2d'); g.fillStyle = base; g.fillRect(0, 0, 256, 256);
    if (lawn) { g.fillStyle = line; for (let k = 0; k < 4; k++) g.fillRect(k * 64, 0, 32, 256); }
    else { g.strokeStyle = line; g.lineWidth = 3; for (let k = 0; k <= 256; k += 32) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k, 256); g.moveTo(0, k); g.lineTo(256, k); g.stroke(); } }
    const t = tex(c, true); t.repeat.set(1.4, 1.4); return t;
  }
  const koiWater = waterMat.clone(); koiWater.color.set('#2c8a86');
  const toShape = (pts, smooth) => { const v = pts.map(([x, y]) => new THREE.Vector2(wx(x), wz(y))); const s = new THREE.Shape(); s.moveTo(v[0].x, v[0].y); if (smooth) s.splineThru(v.slice(1).concat([v[0]])); else { v.slice(1).forEach(p => s.lineTo(p.x, p.y)); s.closePath(); } return s; };
  function flatMesh(shape, depth, mats, y) {
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 24 });
    g.rotateX(Math.PI / 2); g.translate(0, (y || 0) + depth, 0);
    g.computeBoundingBox(); const c = g.boundingBox.getCenter(new THREE.Vector3()); g.translate(-c.x, 0, -c.z);
    const m = new THREE.Mesh(g, mats); m.position.set(c.x, 0, c.z); return m;
  }
  function poolPath(kind, w, h) {
    const s = new THREE.Shape(), W = w / 2, H = h / 2;
    if (kind === 'round') s.absellipse(0, 0, W, H, 0, Math.PI * 2);
    else if (kind === 'octagon') { for (let k = 0; k < 8; k++) { const a = (k + 0.5) / 8 * Math.PI * 2; const x = Math.cos(a) * W * 1.08, y = Math.sin(a) * H * 1.08; k ? s.lineTo(x, y) : s.moveTo(x, y); } s.closePath(); }
    else if (kind === 'kidney') { s.moveTo(-W, 0); s.bezierCurveTo(-W, H * 1.3, W * 0.2, H * 1.2, W * 0.3, H * 0.4); s.bezierCurveTo(W * 0.45, H * 0.1, W, H * 0.6, W, 0); s.bezierCurveTo(W, -H * 1.2, -W, -H * 1.3, -W, 0); }
    else if (kind === 'lozenge') { s.moveTo(-W, 0); s.quadraticCurveTo(-W, H, 0, H); s.quadraticCurveTo(W, H, W, 0); s.quadraticCurveTo(W, -H, 0, -H); s.quadraticCurveTo(-W, -H, -W, 0); }
    else if (kind === 'lagoon' || kind === 'koi') {
      const pts = [[-1, 0.1], [-0.8, 0.8], [-0.2, 0.95], [0.25, 0.55], [0.7, 0.95], [1, 0.3], [0.85, -0.6], [0.3, -0.95], [-0.25, -0.55], [-0.75, -0.85]];
      s.moveTo(pts[0][0] * W, pts[0][1] * H); s.splineThru(pts.slice(1).concat([pts[0]]).map(([x, y]) => new THREE.Vector2(x * W, y * H)));
    } else { const r = Math.min(W, H) * 0.18; s.moveTo(-W + r, -H); s.lineTo(W - r, -H); s.quadraticCurveTo(W, -H, W, -H + r); s.lineTo(W, H - r); s.quadraticCurveTo(W, H, W - r, H); s.lineTo(-W + r, H); s.quadraticCurveTo(-W, H, -W, H - r); s.lineTo(-W, -H + r); s.quadraticCurveTo(-W, -H, -W + r, -H); }
    return s;
  }
  const deckTex = paving('#efe6d2', '#d9ccb0'), plateTex = {};
  function poolItem(it) {
    const gp = new THREE.Group(), w = px(it.w), h = px(it.h), deck = px(it.deck === undefined ? 5 : it.deck);
    const natural = it.shape === 'koi' || it.shape === 'lagoon';
    const scaleOut = (w + deck * 2) / w;
    const outer = poolPath(it.shape, w + deck * 2, h + deck * 2 * (natural ? scaleOut : 1));
    const inner = poolPath(it.shape, w, h); outer.holes.push(new THREE.Path(inner.getPoints(48).reverse()));
    const deckMat = natural ? FM.rock2 : plastic('#fff', { map: deckTex, roughness: 0.7, clearcoat: 0.1 });
    const d = new THREE.ExtrudeGeometry(outer, { depth: 0.04, bevelEnabled: false, curveSegments: 32 }); d.rotateX(Math.PI / 2); d.translate(0, 0.04, 0);
    gp.add(new THREE.Mesh(d, [deckMat, FM.tile]));
    const wg = new THREE.ExtrudeGeometry(inner, { depth: 0.004, bevelEnabled: false, curveSegments: 32 }); wg.rotateX(Math.PI / 2); wg.translate(0, 0.026, 0);
    gp.add(new THREE.Mesh(wg, it.shape === 'koi' ? koiWater : waterMat));
    if (!natural && w > 0.6) { for (const z of [-0.035, 0.035]) { const rail = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.005, 6, 12, Math.PI), FM.coping); rail.position.set(-w / 2 + 0.05, 0.05, z); rail.rotation.y = Math.PI / 2; gp.add(rail); } }
    if (it.shape === 'koi') for (let k = 0; k < 5; k++) { const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.03, 3, 6).rotateZ(Math.PI / 2), plastic(k % 2 ? '#ff8a2a' : '#f7f5ef')); f.position.set((rnd() - .5) * w * 0.6, 0.03, (rnd() - .5) * h * 0.5); f.rotation.y = rnd() * 6; gp.add(f); }
    return at(gp, it.x, it.y, it.rot);
  }
  const courtTex = (() => { const c = canvas(512, 290), g = c.getContext('2d'); g.fillStyle = '#3f8f5a'; g.fillRect(0, 0, 512, 290); g.fillStyle = '#2f6fa0'; g.fillRect(56, 40, 400, 210); g.strokeStyle = '#fff'; g.lineWidth = 5; g.strokeRect(56, 40, 400, 210); g.strokeRect(56, 66, 400, 158); g.beginPath(); g.moveTo(256, 40); g.lineTo(256, 250); g.moveTo(150, 66); g.lineTo(150, 224); g.moveTo(362, 66); g.lineTo(362, 224); g.moveTo(150, 145); g.lineTo(362, 145); g.stroke(); return tex(c); })();
  function tennisItem(it) {
    const gp = new THREE.Group(), W = px(46), D = px(26);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(W, 0.02, D), [FM.coping, FM.coping, plastic('#fff', { map: courtTex, roughness: 0.8, clearcoat: 0 }), FM.coping, FM.coping, FM.coping]); slab.position.y = 0.01; gp.add(slab);
    const net = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.045, D * 0.84), new THREE.MeshStandardMaterial({ color: '#1d2426', transparent: true, opacity: 0.7 })); net.position.y = 0.043; gp.add(net);
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.008, D * 0.84), FM.coping); band.position.y = 0.068; gp.add(band);
    for (const z of [-1, 1]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.07, 6), M.lamp); p.position.set(0, 0.055, z * D * 0.43); gp.add(p); }
    const fence = plastic('#2f5a3a'); const fh = 0.12;
    for (const [x, z, len, alongX] of [[0, -D / 2, W, true], [0, D / 2, W, true], [-W / 2, 0, D, false], [W / 2, 0, D, false]]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : 0.01, 0.01, alongX ? 0.01 : len), fence); rail.position.set(x, fh, z); gp.add(rail);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(len, fh), new THREE.MeshStandardMaterial({ color: '#2f5a3a', transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
      mesh.position.set(x, fh / 2 + 0.02, z); if (!alongX) mesh.rotation.y = Math.PI / 2; mesh.castShadow = false; gp.add(mesh);
    }
    for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, fh, 6), fence); p.position.set(x * W / 2, fh / 2, z * D / 2); gp.add(p); }
    return at(gp, it.x, it.y, it.rot);
  }
  function barItem(it) {
    const gp = new THREE.Group();
    if (it.roof === 'white') {
      const body = new THREE.Mesh(facadeBox(0.42, 0.2, 0.26, 0.14, 0.2), [M.white, M.white, M.white, M.white, plastic('#fff', { map: FAC.boom }), M.white]); body.position.y = 0.1; gp.add(body);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.34), M.white); roof.position.y = 0.22; gp.add(roof);
      const awn = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.012, 0.12), plastic('#fff', { map: parasolTex3 })); awn.position.set(0, 0.17, 0.18); awn.rotation.x = 0.35; gp.add(awn);
    } else {
      const counter = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 20), FM.wood); counter.position.y = 0.04; gp.add(counter);
      for (let k = 0; k < 4; k++) { const a = k / 4 * Math.PI * 2 + 0.78; const p = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.2, 6), FM.darkWood); p.position.set(Math.cos(a) * 0.12, 0.1, Math.sin(a) * 0.12); gp.add(p); }
      const roof = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.14, 12), plastic('#fff', { map: strawTex, roughness: 0.8, clearcoat: 0 })); roof.position.y = 0.26; gp.add(roof);
      for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2; const st = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 8), FM.lacquer); st.position.set(Math.cos(a) * 0.19, 0.025, Math.sin(a) * 0.19); gp.add(st); }
    }
    return at(gp, it.x, it.y, it.rot);
  }
  const strawTex = (() => { const c = canvas(128, 64), g = c.getContext('2d'); g.fillStyle = '#d8b263'; g.fillRect(0, 0, 128, 64); for (let k = 0; k < 200; k++) { g.strokeStyle = rnd() > .5 ? 'rgba(120,80,30,.35)' : 'rgba(255,240,190,.4)'; const x = rnd() * 128; g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (rnd() - .5) * 6, 64); g.stroke(); } return tex(c, true); })();
  const parasolTex = (() => { const c = canvas(128, 128), g = c.getContext('2d'); for (let k = 0; k < 8; k++) { g.fillStyle = k % 2 ? '#f7f5ef' : '#d0342c'; g.fillRect(k * 16, 0, 16, 128); } return tex(c); })();
  const parasolTex2 = (() => { const c = canvas(128, 128), g = c.getContext('2d'); for (let k = 0; k < 8; k++) { g.fillStyle = k % 2 ? '#f7f5ef' : '#f2c417'; g.fillRect(k * 16, 0, 16, 128); } return tex(c); })();
  const parasolTex3 = (() => { const c = canvas(128, 128), g = c.getContext('2d'); for (let k = 0; k < 8; k++) { g.fillStyle = k % 2 ? '#f7f5ef' : '#2f79c9'; g.fillRect(k * 16, 0, 16, 128); } return tex(c); })();
  function parasol(colour) {
    const gp = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.26, 6), colour === 'thatch' ? FM.darkWood : M.white); pole.position.y = 0.13; gp.add(pole);
    const map = colour === 'yellow' ? parasolTex2 : colour === 'blue' ? parasolTex3 : colour === 'thatch' ? strawTex : parasolTex;
    const top = new THREE.Mesh(new THREE.ConeGeometry(colour === 'thatch' ? 0.15 : 0.13, colour === 'thatch' ? 0.09 : 0.06, 16, 1, true), plastic('#fff', { map, side: THREE.DoubleSide })); top.position.y = 0.27; gp.add(top);
    const table = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.008, 12), M.white); table.position.y = 0.07; gp.add(table);
    return gp;
  }
  function loungersItem(it) {
    const gp = new THREE.Group(), n = it.n || 4, gap = 0.1;
    for (let k = 0; k < n; k++) {
      const l = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, 0.17), M.white); frame.position.y = 0.03; l.add(frame);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.012, 0.07), M.white); back.position.set(0, 0.055, -0.07); back.rotation.x = -0.6; l.add(back);
      const towel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.006, 0.12), FM.cushion[k % 4]); towel.position.set(0, 0.043, 0.02); l.add(towel);
      l.position.x = (k - (n - 1) / 2) * gap; gp.add(l);
    }
    return at(gp, it.x, it.y, it.rot);
  }
  function plant(kind, s) {
    const gp = new THREE.Group(); s = s || 1;
    if (kind === 'palm' || kind === 'tree') return tree(kind === 'palm' ? 0.8 * s : 0.9 * s, kind);
    if (kind === 'cypress') { const t = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.06, 6), M.trunk); t.position.y = 0.03; gp.add(t); const c = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), FM.cypress); c.scale.set(1, 4.2, 1); c.position.y = 0.3; gp.add(c); }
    else if (kind === 'topiary') { const p = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.08), FM.planter); p.position.y = 0.03; gp.add(p); const st = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.08, 6), M.trunk); st.position.y = 0.1; gp.add(st); const b = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), FM.topiary); b.position.y = 0.18; gp.add(b); const b2 = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), FM.topiary); b2.position.y = 0.27; gp.add(b2); }
    else if (kind === 'bonsai') { const t = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.03, 0.26, 6), M.trunk); t.position.set(0.02, 0.13, 0); t.rotation.z = -0.25; gp.add(t);
      for (const [x, y, r] of [[0.07, 0.26, 0.11], [-0.05, 0.2, 0.09], [0.0, 0.34, 0.08]]) { const c = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), FM.pine); c.scale.y = 0.38; c.position.set(x, y, 0); gp.add(c); } }
    else if (kind === 'lantern') { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.03, 6), FM.rock2); b.position.y = 0.015; gp.add(b); const s1 = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.09, 6), FM.rock2); s1.position.y = 0.075; gp.add(s1); const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.05), M.bulb); lamp.position.y = 0.14; gp.add(lamp); const cap = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.04, 6), FM.rock); cap.position.y = 0.18; gp.add(cap); }
    else if (kind === 'rocks') { for (let k = 0; k < 3; k++) { const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.035 + rnd() * 0.03, 0), k % 2 ? FM.rock : FM.rock2); r.position.set((rnd() - .5) * 0.1, 0.02, (rnd() - .5) * 0.1); r.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3); r.scale.y = 0.7; gp.add(r); } }
    else if (kind === 'jet') { const j = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.16, 8, 1, true), FM.jet); j.position.y = 0.1; j.rotation.x = Math.PI; gp.add(j); const sp = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), FM.jet); sp.position.y = 0.18; gp.add(sp); }
    return gp;
  }
  function bridgeItem(it) {
    const gp = new THREE.Group(), L = px(it.len), n = 9;
    for (let k = 0; k < n; k++) { const t = k / (n - 1), x = (t - 0.5) * L, y = 0.04 + Math.sin(t * Math.PI) * 0.07; const p = new THREE.Mesh(new THREE.BoxGeometry(L / n + 0.01, 0.015, 0.1), FM.lacquer); p.position.set(x, y, 0); p.rotation.z = -Math.cos(t * Math.PI) * 0.45; gp.add(p);
      for (const z of [-0.05, 0.05]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.06, 0.01), FM.lacquer); post.position.set(x, y + 0.035, z); gp.add(post); } }
    for (const z of [-0.05, 0.05]) { const pts = []; for (let k = 0; k <= 12; k++) { const t = k / 12; pts.push(new THREE.Vector3((t - 0.5) * L, 0.1 + Math.sin(t * Math.PI) * 0.07, z)); } gp.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.007, 5), FM.lacquer)); }
    return at(gp, it.x, it.y, it.rot);
  }
  function flowerBed(x, y, w, h) {
    const c = canvas(128, 128), g = c.getContext('2d'); g.fillStyle = '#4b7f34'; g.fillRect(0, 0, 128, 128);
    const cols = ['#e84a6f', '#f2c417', '#f7f5ef', '#b04ad0', '#ff8a2a']; for (let k = 0; k < 140; k++) { g.fillStyle = cols[k % cols.length]; g.beginPath(); g.arc(rnd() * 128, rnd() * 128, 3 + rnd() * 3, 0, 7); g.fill(); }
    const b = new THREE.Mesh(new THREE.BoxGeometry(px(w), 0.03, px(h)), [FM.planter, FM.planter, plastic('#fff', { map: tex(c), roughness: 0.8, clearcoat: 0 }), FM.planter, FM.planter, FM.planter]);
    b.position.y = 0.015; const gp = new THREE.Group(); gp.add(b); return at(gp, x, y, 0);
  }
  function golfItem(it) {
    const out = [];
    const lawn = paving('#7cc45a', '#6db24d', true); lawn.repeat.set(2.2, 2.2);
    out.push(flatMesh(toShape(it.fairway, true), 0.012, [plastic('#fff', { map: lawn, roughness: 0.8, clearcoat: 0 }), M.leaf2]));
    const [gx, gy, rx, ry] = it.green; const gs = new THREE.Shape(); gs.absellipse(wx(gx), wz(gy), px(rx), px(ry), 0, Math.PI * 2);
    out.push(flatMesh(gs, 0.018, [plastic('#8fd86a', { roughness: 0.5, clearcoat: 0.2 }), M.leaf2]));
    for (const [bx, by, r] of it.bunkers) { const bs = new THREE.Shape(); bs.absellipse(wx(bx), wz(by), px(r) * 1.3, px(r), 0, Math.PI * 2); out.push(flatMesh(bs, 0.016, [matte('#f0dfa8'), matte('#e2cf95')])); }
    const flag = new THREE.Group(); const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.34, 6), M.white); pole.position.y = 0.17; flag.add(pole);
    const cloth = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.12, -0.035, 0), new THREE.Vector3(0, -0.075, 0)]), new THREE.MeshStandardMaterial({ color: '#d0342c', side: THREE.DoubleSide })); cloth.geometry.computeVertexNormals(); cloth.position.y = 0.34; flag.add(cloth);
    out.push(at(flag, it.flag[0], it.flag[1], 0));
    return out;
  }
  function facilityGrounds(id, items) {
    const gp = new THREE.Group(), parts = [];
    const add = (o, order) => { o.userData.order = order; parts.push(o); gp.add(o); };
    for (const it of items) {
      if (it.type === 'plate') { if (!plateTex[it.colour]) plateTex[it.colour] = paving(it.colour, 'rgba(0,0,0,.08)'); add(flatMesh(toShape(it.poly, false), 0.012, [plastic('#fff', { map: plateTex[it.colour], roughness: 0.75, clearcoat: 0.05 }), plastic(it.colour)]), 0); }
      else if (it.type === 'pool') add(poolItem(it), 1);
      else if (it.type === 'tennis') add(tennisItem(it), 1);
      else if (it.type === 'golf') golfItem(it).forEach(o => add(o, 1));
      else if (it.type === 'bar') add(barItem(it), 2);
      else if (it.type === 'bridge') add(bridgeItem(it), 2);
      else if (it.type === 'loungers') add(loungersItem(it), 3);
      else if (it.type === 'flowers') it.beds.forEach(([x, y, w, h]) => add(flowerBed(x, y, w, h), 2));
      else if (it.type === 'parasols') it.pts.forEach(([x, y]) => add(at(parasol(it.colour), x, y, 0), 3));
      else if (it.type === 'jets') it.pts.forEach(([x, y]) => add(at(plant('jet'), x, y, 0), 3));
      else {
        const kind = { palms: 'palm', trees: 'tree', cypress: 'cypress', topiary: 'topiary', bonsai: 'bonsai', lanterns: 'lantern', rocks: 'rocks' }[it.type];
        if (kind) it.pts.forEach(([x, y]) => add(at(plant(kind, 0.9 + rnd() * 0.25), x, y, rnd() * 360), 4));
      }
    }
    parts.forEach(o => { o.userData.home = o.position.clone(); });
    return { group: shadowed(gp), parts };
  }

  // ---------------------------------------------------------------- hotel name signs (always visible, never covered)
  const BRAND = { boomerang: ['#f3c43b', '#7b3b16'], fujiyama: ['#fff', '#c8322b'], taj: ['#f2d25c', '#7b3b16'], safari: ['#1d2426', '#f2c417'], royal: ['#1f4f9a', '#fff'], waikiki: ['#fff', '#2f9b45'], etoile: ['#1d2426', '#f3e7c8'], president: ['#f3e7c8', '#1d2426'] };
  function signBoard(id, s) {
    const [bg, fg] = BRAND[id], w = px(s.w), h = 0.2, gp = new THREE.Group();
    const c = canvas(512, Math.round(512 * h / w)), g = c.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); g.strokeStyle = fg; g.lineWidth = Math.max(3, c.height * 0.05); g.strokeRect(c.height * 0.1, c.height * 0.1, c.width - c.height * 0.2, c.height * 0.8);
    const label = board.hotels[id].name.toUpperCase(); let fs = c.height * 0.62; g.font = `700 ${fs}px ${FONT}`; const tw = g.measureText(label).width; if (tw > c.width * 0.84) { fs *= c.width * 0.84 / tw; g.font = `700 ${fs}px ${FONT}`; }
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, c.width / 2, c.height * 0.54);
    const face = plastic('#fff', { map: tex(c), clearcoat: 0.7, clearcoatRoughness: 0.15 }), edge = plastic(fg === '#fff' ? '#d9d4ca' : fg);
    // An A-frame: two boards leaning together, one reading from each side of the table.
    for (const turn of [0, Math.PI]) {
      const side = new THREE.Group(); side.rotation.y = turn;
      const holder = new THREE.Group(); holder.position.set(0, 0.07, 0.1); holder.rotation.x = -0.5;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.02), [edge, edge, edge, edge, face, edge]); panel.position.y = h / 2;
      holder.add(panel); side.add(holder); gp.add(side);
    }
    const base = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, 0.07, 0.24), M.stone); base.position.y = 0.035; gp.add(base);
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(w * 1.02, 0.03, 0.04), edge); ridge.position.y = 0.07 + Math.cos(0.5) * h + 0.005; gp.add(ridge);
    gp.traverse(o => { if (o.isMesh) { o.userData.hotel = id; pickables.push(o); } });
    return at(shadowed(gp), s.x, s.y, 0);
  }

  // ---------------------------------------------------------------- landmarks: Bank and Town Hall
  function bank(l) {
    const w = px(l.w), d = px(l.d), gp = new THREE.Group();
    const steps = new THREE.Mesh(new THREE.BoxGeometry(w + 0.16, 0.08, d + 0.16), M.stone); steps.position.y = 0.04; gp.add(steps);
    const body = new THREE.Mesh(facadeBox(w * 0.92, 0.5, d * 0.7, 0.2, 0.25), [M.slate, M.slate, M.slateDark, M.slateDark, M.slate, M.slate]); body.position.set(0, 0.33, -d * 0.12); gp.add(body);
    const cols = 6; for (let k = 0; k < cols; k++) { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.5, 12), M.stone); c.position.set(-w * 0.42 + k * (w * 0.84 / (cols - 1)), 0.33, d * 0.32); gp.add(c); }
    const ent = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.07, d + 0.04), M.stone); ent.position.y = 0.615; gp.add(ent);
    const sh = new THREE.Shape(); sh.moveTo(-w / 2 - 0.02, 0); sh.lineTo(w / 2 + 0.02, 0); sh.lineTo(0, 0.22); sh.closePath();
    const ped = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: d + 0.04, bevelEnabled: false }), M.slateDark); ped.position.set(0, 0.65, -d / 2 - 0.02); gp.add(ped);
    return at(shadowed(gp), l.x, l.y, l.rot);
  }
  function townHall(l) {
    const w = px(l.w), d = px(l.d), gp = new THREE.Group();
    const steps = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.06, d + 0.12), M.stone); steps.position.y = 0.03; gp.add(steps);
    const body = new THREE.Mesh(facadeBox(w, 0.52, d, 0.18, 0.26), [M.slate, M.slate, M.slateDark, M.slateDark, M.slate, M.slate]); body.position.y = 0.32; gp.add(body);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.05, 0.06, d + 0.05), M.slateDark); cap.position.y = 0.61; gp.add(cap);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.32, w * 0.34, 0.1, 32), M.slateDark); drum.position.y = 0.69; gp.add(drum);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(w * 0.32, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), M.slateDark); dome.position.y = 0.74; gp.add(dome);
    const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.3, 6), M.white); flagPole.position.y = 1.1; gp.add(flagPole);
    return at(shadowed(gp), l.x, l.y, l.rot);
  }
  scene.add(bank(scenery.landmarks.bank), townHall(scenery.landmarks.townHall));
  { const lm = scenery.landmarks; footprints.push([lm.bank.x, lm.bank.y, 50], [lm.townHall.x, lm.townHall.y, 34]); }
  { const R = scenery.hotels.etoile.ring; scene.add(fountain(R.x, R.y)); footprints.push([R.x, R.y, R.r1 + 26]); }
  for (const id in scenery.hotels) for (const [x, y] of scenery.hotels[id].lamps || []) {
    const gp = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.025, 0.7, 8), M.lamp); pole.position.y = 0.35; gp.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 0.02), M.lamp); arm.position.set(0.06, 0.7, 0); gp.add(arm);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), M.bulb); bulb.position.set(0.13, 0.67, 0); gp.add(bulb);
    scene.add(at(shadowed(gp), x, y, 0)); footprints.push([x, y, 10]);
  }

  // ---------------------------------------------------------------- street lamps along the road, with pools of light after dark
  const glowTex = (() => { const c = canvas(128, 128), g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
  const glowMats = []; // additive light pools, faded in with the night
  function glowMat(colour, peak) { const m = new THREE.MeshBasicMaterial({ map: glowTex, color: colour, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }); glowMats.push([m, peak]); return m; }
  const lampPoolMat = glowMat('#ffc982', 0.75);
  const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  function streetLamp(pos, faceDir) {
    const gp = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.5, 8), M.lamp); pole.position.y = 0.25; gp.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.014, 0.014), M.lamp); arm.position.set(0.05, 0.5, 0); gp.add(arm);
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.03, 10), M.lamp); hood.position.set(0.1, 0.5, 0); gp.add(hood);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), M.bulb); bulb.position.set(0.1, 0.483, 0); gp.add(bulb);
    shadowed(gp); bulb.castShadow = false;
    gp.position.copy(pos); gp.rotation.y = Math.atan2(-faceDir.z, faceDir.x); scene.add(gp);
    const pool = new THREE.Mesh(poolGeo, lampPoolMat); pool.scale.setScalar(1.15); pool.position.copy(pos).addScaledVector(faceDir, 0.12); pool.position.y = ROAD_Y + 0.004; pool.renderOrder = 2; scene.add(pool);
  }
  for (let i = 1; i < N; i += 3) {
    const f = frameAt((i + 0.5) / N), out = f.innerSide.clone().negate();
    streetLamp(f.p.clone().addScaledVector(out, ROAD_W / 2 + 0.07).setY(0), f.innerSide);
  }
  { const b = scenery.carPark.bays; streetLamp(new THREE.Vector3(wx(b[0][0] - 16), 0, wz(b[0][1] - 26)), new THREE.Vector3(0.6, 0, 0.8).normalize()); streetLamp(new THREE.Vector3(wx(b[3][0] + 16), 0, wz(b[3][1] - 26)), new THREE.Vector3(-0.6, 0, 0.8).normalize()); }

  // ---------------------------------------------------------------- the sea: Waikiki's bay opens on to it; a beach, shallows and waves rolling in
  const coastPts = (() => { const c = new THREE.CatmullRomCurve3(scenery.coast.map(([x, y]) => new THREE.Vector3(wx(x), 0, wz(y))), false, 'catmullrom', 0.5); return c.getSpacedPoints(2000); })();
  const oceanPoly = coastPts.map(p => [p.x, p.z]).concat([[-120, -120]]);
  function inOcean(x, z) { let c = false; const P = oceanPoly; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) c = !c; } return c; }
  // seaward normal at every coast point
  const coastN0 = coastPts.map((p, i) => { const a = coastPts[Math.max(0, i - 1)], b = coastPts[Math.min(coastPts.length - 1, i + 1)]; const n = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize(); if (!inOcean(p.x + n.x * 0.4, p.z + n.z * 0.4)) n.negate(); return n; });
  // smooth the normals along the shore so the bands that follow it never fan out at a bend
  const coastN = coastN0.map((_, i) => { const v = new THREE.Vector3(); for (let k = -24; k <= 24; k++) { const j = Math.max(0, Math.min(coastN0.length - 1, i + k)); v.addScaledVector(coastN0[j], 1 - Math.abs(k) / 25); } return v.normalize(); });
  const SEA_Y = 0.007;
  const inPlay = (x, z, m) => x > wx(bx0) - (m || 0) && x < wx(bx1) + (m || 0) && z > wz(by0) - (m || 0) && z < wz(by1) + (m || 0);
  // a strip that follows the coast: per point, from offset a to offset b along the seaward normal (negative = inland)
  function coastStrip(idx, offA, offB, y, colA, colB) {
    const pos = [], col = [], ind = []; const ca = new THREE.Color(), cb = new THREE.Color();
    idx.forEach((i, k) => {
      const p = coastPts[i], n = coastN[i], a = typeof offA === 'function' ? offA(i) : offA, b = typeof offB === 'function' ? offB(i) : offB;
      pos.push(p.x + n.x * a, y, p.z + n.z * a, p.x + n.x * b, y, p.z + n.z * b);
      if (colA) { ca.set(colA[0]); cb.set(colB[0]); col.push(ca.r, ca.g, ca.b, colA[1], cb.r, cb.g, cb.b, colB[1]); }
      if (k < idx.length - 1 && idx[k + 1] === i + 1) { const o = k * 2; ind.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
    });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const uv = []; for (let k = 0; k < pos.length; k += 3) uv.push(pos[k] * 0.5, pos[k + 2] * 0.5); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (colA) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4)); g.setIndex(ind); g.computeVertexNormals();
    if (g.attributes.normal.count && g.attributes.normal.getY(0) < 0) { const a = g.index.array; for (let k = 0; k < a.length; k += 3) { const t = a[k]; a[k] = a[k + 2]; a[k + 2] = t; } g.computeVertexNormals(); }
    return g;
  }
  {
    // open water out to the horizon
    const sh = new THREE.Shape(); oceanPoly.forEach(([x, z], i) => i ? sh.lineTo(x, -z) : sh.moveTo(x, -z));
    const g = new THREE.ShapeGeometry(sh, 1); g.rotateX(-Math.PI / 2); g.translate(0, SEA_Y, 0);
    const oceanMat = seaMat.clone(); oceanMat.color.set('#2286c2'); oceanMat.normalMap = waterNormal;
    const ocean = new THREE.Mesh(g, oceanMat); ocean.receiveShadow = true; scene.add(ocean);
    // shallows: turquoise near the shore, fading into deep blue
    const all = coastPts.map((_, i) => i);
    const shallow = new THREE.Mesh(coastStrip(all, -0.05, 2.2, SEA_Y + 0.001, ['#7ad9d6', 0.85], ['#2286c2', 0]), new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, roughness: 0.12, metalness: 0, depthWrite: false }));
    shallow.renderOrder = 1; scene.add(shallow);
    // the beach, outside the play area (inside it, Waikiki's sand is already printed on the ground)
    const beachIdx = all.filter(i => !inPlay(coastPts[i].x, coastPts[i].z, -0.05));
    // the beach widens either side of Waikiki so its sand runs on past the edge of the play area
    const wk = new THREE.Vector3(wx(110), 0, wz(110)), extra = i => 0; // Waikiki's wide beach is the continuous sand sheet below
    const beachIn = i => -0.75 - extra(i), duneA = i => -0.74 - extra(i), duneB = i => -1.25 - extra(i) * 1.15;
    // the same pale sand as Waikiki's on the board: a wet band at the water's edge, then dry sand with a fine grain, lit the same way
    const grain = (() => { const c = canvas(256, 256), g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256); for (let i = 0; i < 2600; i++) { g.fillStyle = rnd() > 0.5 ? 'rgba(150,120,70,.22)' : 'rgba(255,255,255,1)'; g.fillRect(rnd() * 256, rnd() * 256, 1, 1); } const t = tex(c, true); return t; })();
    const sandM = new THREE.MeshStandardMaterial({ vertexColors: true, map: grain, roughness: 0.86, metalness: 0 });
    const beach = new THREE.Mesh(coastStrip(beachIdx, 0.12, -0.62, -0.0015, ['#cbb27a', 1], ['#f0deaa', 1]), sandM);
    const dry = new THREE.Mesh(coastStrip(beachIdx, -0.6, beachIn, -0.0016, ['#f0deaa', 1], ['#f0deaa', 1]), sandM);
    beach.receiveShadow = dry.receiveShadow = true; scene.add(beach, dry); wetMats.push([sandM, 0.86]);
    // One continuous beach around Waikiki: a single sand surface laid over the board and the land beyond alike, so there is
    // no join anywhere — same colour, same grain, same wet band at the water — feathering into the grass inland.
    {
      const CXp = 120, CYp = 100, SPAN = 2400, R = 2048, k = R / SPAN, c = canvas(R, R), g = c.getContext('2d');
      const X0 = CXp - SPAN / 2, Y0 = CYp - SPAN / 2, P = (x, y) => [(x - X0) * k, (y - Y0) * k];
      const cc = new THREE.CatmullRomCurve3(scenery.coast.map(([x, y]) => new THREE.Vector3(x, y, 0)), false, 'catmullrom', 0.5).getSpacedPoints(2000);
      const coastPath = () => { g.beginPath(); cc.forEach((q, n) => { const [x, y] = P(q.x, q.y); n ? g.lineTo(x, y) : g.moveTo(x, y); }); };
      g.lineJoin = g.lineCap = 'round';
      // dry sand: a band all along the shore plus Waikiki's beach, softly feathered at the grass
      // shape first (crisp, on a scratch canvas), then laid down once with a soft blur
      const sc = canvas(R, R), sg = sc.getContext('2d'); sg.fillStyle = '#f0deaa';
      for (const q of cc) { const d2 = (q.x - 120) ** 2 + (q.y - 100) ** 2, w = 0.95 * U + 95 * Math.exp(-d2 / (2 * 330 * 330)); const [x, y] = P(q.x, q.y); sg.beginPath(); sg.arc(x, y, w * k, 0, Math.PI * 2); sg.fill(); }
      sg.beginPath(); SAND_SPILL.forEach(([x, y], n) => { const [a, b] = P(x, y); n ? sg.lineTo(a, b) : sg.moveTo(a, b); }); sg.closePath(); sg.fill();
      g.filter = `blur(${SAND_FEATHER * k}px)`; g.drawImage(sc, 0, 0); g.filter = 'none';
      // wet sand at the water's edge, darkest right at the waterline
      g.globalCompositeOperation = 'source-atop';
      for (let n = 10; n >= 1; n--) { coastPath(); g.lineWidth = n * 0.15 * U * k; g.strokeStyle = 'rgba(203,178,122,.12)'; g.stroke(); }
      // grain, everywhere the same
      for (let n = 0; n < 160000; n++) { g.fillStyle = rnd() > 0.5 ? 'rgba(150,120,70,.16)' : 'rgba(255,250,235,.25)'; g.fillRect(rnd() * R, rnd() * R, 1.3, 1.3); }
      // fade the whole sheet out towards its far edges, where the strips of beach beyond take over in the haze
      g.globalCompositeOperation = 'destination-in';
      const rg = g.createRadialGradient(R / 2, R / 2, R * 0.36, R / 2, R / 2, R * 0.5); rg.addColorStop(0, 'rgba(0,0,0,1)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.fillRect(0, 0, R, R);
      const t = tex(c);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(SPAN / U, SPAN / U).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.86, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      m.position.set(wx(CXp), 0.0016, wz(CYp)); m.receiveShadow = true; m.renderOrder = 0; scene.add(m);
      wetMats.push([m.material, 0.86]);
    }
    // a strip of sand fading into the grass behind the beach
    const dune = new THREE.Mesh(coastStrip(beachIdx, duneA, duneB, -0.002, ['#f0deaa', 1], [GRASS, 0]), new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, roughness: 1, depthWrite: false }));
    dune.receiveShadow = true; scene.add(dune);
  }
  // waves: lines of foam that roll in, break on the sand and wash back
  const waveIdx = coastPts.map((p, i) => i).filter(i => coastPts[i].distanceTo(new THREE.Vector3(BCX, 0, BCZ)) < 26);
  const foamMat = new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, roughness: 0.7, depthWrite: false });
  const waves = [0, 1, 2, 3].map(k => { const m = new THREE.Mesh(coastStrip(waveIdx, 0, 0.1, SEA_Y + 0.003), foamMat.clone()); m.renderOrder = 2; m.userData.ph = k / 4; scene.add(m); return m; });
  const shoreFoam = new THREE.Mesh(coastStrip(waveIdx, -0.04, 0.05, SEA_Y + 0.002), new THREE.MeshStandardMaterial({ color: '#f4fbff', transparent: true, opacity: 0.55, depthWrite: false })); shoreFoam.renderOrder = 2; scene.add(shoreFoam);
  let waveClock = 0;
  function stepWaves(dt, wind) {
    waveClock += dt * (0.18 + wind * 0.12);
    for (const w of waves) {
      const ph = (waveClock + w.userData.ph) % 1, pos = w.geometry.attributes.position;
      // far out (2 units) -> breaking at the shore -> washing a little up the sand
      const off = ph < 0.85 ? 2.0 * (1 - ph / 0.85) : -0.18 * Math.sin((ph - 0.85) / 0.15 * Math.PI);
      const width = ph < 0.85 ? 0.015 + 0.04 * (ph / 0.85) : 0.07;
      w.material.opacity = ph < 0.15 ? ph / 0.15 * 0.55 : ph < 0.85 ? 0.35 + 0.3 * (ph / 0.85) : 0.65 * (1 - (ph - 0.85) / 0.15);
      waveIdx.forEach((i, k) => { const p = coastPts[i], n = coastN[i], wob = Math.sin(i * 0.37 + waveClock * 9) * 0.04; const a = off + wob, b = a + width; pos.setXYZ(k * 2, p.x + n.x * a, SEA_Y + 0.003, p.z + n.z * a); pos.setXYZ(k * 2 + 1, p.x + n.x * b, SEA_Y + 0.003, p.z + n.z * b); });
      pos.needsUpdate = true;
    }
    shoreFoam.material.opacity = 0.4 + 0.15 * Math.sin(waveClock * 6.28);
    for (const b of buoys) b.position.y = b.userData.y0 + Math.sin(envClockRef() * 1.7 + b.userData.ph) * 0.015;
  }

  // ---------------------------------------------------------------- the edge of the play area: a white fence on a gravel path; buoys across the water
  const buoys = [];
  {
    const OUT = 8 / U; // the path and fence sit just outside the edge of the play area
    const x0 = wx(bx0) - OUT, x1 = wx(bx1) + OUT, z0 = wz(by0) - OUT, z1 = wz(by1) + OUT;
    // where the coast crosses the left and top edges
    const leftCoastZ = wz(240), topCoastX = wx(292); // the fence stops where Waikiki's beach begins
    const runs = [[[topCoastX, z0], [x1, z0]], [[x1, z0], [x1, z1]], [[x1, z1], [x0, z1]], [[x0, z1], [x0, leftCoastZ]]];
    const gravelM = new THREE.MeshStandardMaterial({ color: '#d9cfb6', roughness: 1 }), railM = plastic('#f6f4ee', { roughness: 0.4 }), postM = plastic('#fbfaf6', { roughness: 0.4 });
    const posts = [];
    for (const [[ax, az], [bx, bz]] of runs) {
      const len = Math.hypot(bx - ax, bz - az), ang = Math.atan2(-(bz - az), bx - ax), cx = (ax + bx) / 2, cz = (az + bz) / 2;
      const path = new THREE.Mesh(new THREE.PlaneGeometry(len + 0.3, 0.3).rotateX(-Math.PI / 2), gravelM); path.position.set(cx, -0.001, cz); path.rotation.y = ang; path.receiveShadow = true; scene.add(path);
      for (const h of [0.075, 0.15]) { const r = new THREE.Mesh(new THREE.BoxGeometry(len, 0.018, 0.012), railM); r.position.set(cx, h, cz); r.rotation.y = ang; r.castShadow = true; r.receiveShadow = true; scene.add(r); }
      const n = Math.max(1, Math.round(len / 0.36)); for (let k = 0; k <= n; k++) posts.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
    }
    const pm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, 0.2, 0.03).translate(0, 0.1, 0), postM, posts.length), o = new THREE.Object3D();
    posts.forEach(([x, z], k) => { o.position.set(x, 0, z); o.updateMatrix(); pm.setMatrixAt(k, o.matrix); }); pm.castShadow = true; pm.receiveShadow = true; scene.add(pm);
    // buoys mark the boundary across the bay
    const bG = new THREE.SphereGeometry(0.06, 14, 10), red = plastic('#d0342c', { roughness: 0.3 }), white = plastic('#f6f4ee', { roughness: 0.3 });
    const pts = [];
    for (const line of []) for (let s = 0; s < line.length - 1; s++) { const [ax, az] = line[s], [bx, bz] = line[s + 1], n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 0.32)); for (let k = (s ? 1 : 0); k <= n; k++) pts.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]); }
    // (no buoys: the open bay simply runs out to sea)
  }

  // ---------------------------------------------------------------- the countryside: trees round the edge, hills in the distance
  {
    const inBoard = (x, z) => x > wx(bx0) - 0.6 && x < wx(bx1) + 0.6 && z > wz(by0) - 0.6 && z < wz(by1) + 0.6;
    let n = 0, guard = 0;
    while (n < 110 && guard++ < 2000) {
      const a = rnd() * Math.PI * 2, r = 9 + rnd() * 16, x = Math.cos(a) * r * 1.2, z = Math.sin(a) * r;
      if (inBoard(x, z) || inOcean(x, z) || coastPts.some(p => Math.abs(p.x - x) + Math.abs(p.z - z) < 2.2)) continue;
      const t = tree(1.6 + rnd() * 1.6, rnd() < 0.15 ? 'palm' : 'tree'); t.position.set(x, 0, z); t.rotation.y = rnd() * 6.28; scene.add(t); n++;
    }
    const hillM = [matte('#5c9a45'), matte('#6aa84f'), matte('#548e3f')];
    for (let k = 0; k < 16; k++) {
      const a = k / 16 * Math.PI * 2 + rnd() * 0.3, r = 58 + rnd() * 18; if (inOcean(Math.cos(a) * r, Math.sin(a) * r) || inOcean(Math.cos(a) * (r - 12), Math.sin(a) * (r - 12))) continue;
      const h = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), hillM[k % 3]);
      h.scale.set(10 + rnd() * 10, 1.4 + rnd() * 2.2, 7 + rnd() * 6); h.position.set(Math.cos(a) * r, -0.05, Math.sin(a) * r); h.rotation.y = rnd() * 3; h.receiveShadow = true; scene.add(h);
    }
  }

  // ---------------------------------------------------------------- hotels: build every piece once, show as built
  const hotels = {};
  const pickables = [];
  for (const id in scenery.hotels) {
    const def = scenery.hotels[id];
    const h = hotels[id] = { pieces: [], grounds: null, built: 0, facilities: false };
    def.pieces.forEach((p, k) => {
      let obj;
      if (p.style === 'wing') { obj = STYLE.wing(p, def.ring); at(obj, def.ring.x, def.ring.y, 0); footprints.push([def.ring.x + Math.cos(deg(p.a)) * 61, def.ring.y + Math.sin(deg(p.a)) * 61, 34]); }
      else if (p.style === 'crescent') { obj = STYLE.crescent(p); at(obj, p.cx, p.cy, 0); for (let a = p.a0; a <= p.a1; a += 10) footprints.push([p.cx + Math.cos(deg(a)) * (p.r0 + p.r1) / 2, p.cy + Math.sin(deg(a)) * (p.r0 + p.r1) / 2, (p.r1 - p.r0) / 2 + 10]); }
      else { obj = STYLE[p.style](p); const keepRot = obj.rotation.y; at(obj, p.x, p.y, p.rot || 0); obj.rotation.y += keepRot; footprints.push([p.x, p.y, Math.max(p.w || 0, p.d || 0, (p.r || 0) * 2) / 2 + 12]); }
      shadowed(obj); obj.visible = false; obj.userData = { hotel: id, stage: k, home: obj.position.clone() };
      obj.traverse(o => { if (o.isMesh) { o.userData.hotel = id; pickables.push(o); } });
      scene.add(obj); h.pieces.push(obj);
    });
    h.grounds = facilityGrounds(id, def.grounds); h.grounds.group.visible = false;
    h.grounds.group.traverse(o => { if (o.isMesh) { o.userData.hotel = id; pickables.push(o); } });
    scene.add(h.grounds.group);
  }
  for (const id in scenery.hotels) scene.add(signBoard(id, scenery.hotels[id].sign));


  // ---------------------------------------------------------------- entrances
  const entranceGeo = (() => { const parts = []; for (let k = 0; k < 3; k++) { const b = new THREE.BoxGeometry(0.24, 0.045 * (k + 1), 0.07); b.translate(0, 0.0225 * (k + 1), -0.07 + k * 0.07); parts.push(b); } return mergeGeometries(parts); })();
  const entrances = {};
  function entranceSide(space, hotelId) {
    const sp = S[space];
    return sp.inner === hotelId ? 'inner' : sp.outer === hotelId ? 'outer' : null;
  }
  function setEntrance(space, hotelId, animate) {
    if (entrances[space]) { scene.remove(entrances[space]); delete entrances[space]; }
    if (!hotelId) return null;
    const side = entranceSide(space, hotelId); if (!side) return null;
    const f = spaceFrame(space), dir = side === 'inner' ? f.innerSide : f.innerSide.clone().negate();
    const m = new THREE.Mesh(entranceGeo, M.entrance); m.castShadow = m.receiveShadow = true;
    m.position.copy(f.p).addScaledVector(dir, ROAD_W / 2 + 0.13); m.position.y = 0;
    m.rotation.y = Math.atan2(dir.x, dir.z);
    m.userData.home = m.position.clone();
    scene.add(m); entrances[space] = m;
    m.updateMatrixWorld(true); const box = new THREE.Box3().setFromObject(m).expandByPoint(f.p.clone().setY(0.1)); // the entrance plus its bit of road
    if (animate) drop(m, 0.8);
    return box;
  }

  // ---------------------------------------------------------------- entrance picking: click a highlighted space
  const choiceGeo = new THREE.CylinderGeometry(0.17, 0.21, 0.05, 24);
  let choices = [];
  function clearEntranceChoices() {
    for (const m of choices) { scene.remove(m); const idx = pickables.indexOf(m); if (idx >= 0) pickables.splice(idx, 1); m.material.dispose(); }
    choices = [];
  }
  function showEntranceChoices(list) { // list: [{space, hotel}]
    clearEntranceChoices();
    for (const { space, hotel } of list) {
      const side = entranceSide(space, hotel); if (!side) continue;
      const mat = new THREE.MeshStandardMaterial({ color: '#f2c417', emissive: '#f2c417', emissiveIntensity: 0.6, transparent: true, opacity: 0.88, roughness: 0.35 });
      const f = spaceFrame(space), dir = side === 'inner' ? f.innerSide : f.innerSide.clone().negate();
      const m = new THREE.Mesh(choiceGeo, mat);
      m.position.copy(f.p).addScaledVector(dir, ROAD_W / 2 + 0.13); m.position.y = 0.03;
      m.userData = { space, hotel, isChoice: true, home: m.position.clone() };
      scene.add(m); pickables.push(m); choices.push(m);
      if (!reduceMotion) drop(m, 0.55);
    }
  }

  // ---------------------------------------------------------------- cars
  // Local axes: +x forward, +y up, +z to the driver's right. root sits on the road; body rolls and pitches on its springs.
  const WHEEL_R = 0.05;
  // UK-style number plates: white at the front, yellow at the back
  const plateCache = {};
  function numberPlateTex(front, colour) {
    const key = front + colour; if (plateCache[key]) return plateCache[key];
    const c = canvas(256, 80), g = c.getContext('2d');
    g.fillStyle = front ? '#f7f6f0' : '#f2c417'; g.fillRect(0, 0, 256, 80); g.strokeStyle = '#1b1712'; g.lineWidth = 4; g.strokeRect(4, 4, 248, 72);
    g.fillStyle = '#1b1712'; g.font = `700 50px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText({ '#f2c417': 'HTL 1', '#3fa34d': 'HTL 2', '#2f79c9': 'HTL 3', '#d0342c': 'HTL 4' }[colour] || 'HOTEL', 128, 43);
    return (plateCache[key] = tex(c));
  }
  // Combine the meshes of a rigid assembly (a car body, a wheel) that share a material into one mesh each, in the
  // assembly's own space, so it draws in a handful of calls instead of dozens. The originals are discarded.
  function mergeRigid(container, include) {
    container.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(container.matrixWorld).invert(), groups = new Map(), victims = [];
    container.traverse(o => {
      if (!o.isMesh || o === container || Array.isArray(o.material) || o.material.transparent || (include && !include(o))) return;
      const g = o.geometry; if (!g.attributes.position || !g.attributes.normal) return;
      const key = o.material.uuid + '|' + o.renderOrder; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(o);
    });
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const geos = list.map(o => { let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone(); for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
        if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)); return g; });
      const mg = mergeGeometries(geos, false); geos.forEach(g => g.dispose()); if (!mg) continue;
      const m = new THREE.Mesh(mg, list[0].material); m.renderOrder = list[0].renderOrder; container.add(m);
      list.forEach(o => victims.push(o));
    }
    victims.forEach(o => o.parent && o.parent.remove(o));
  }
  function carMesh(colour) {
    const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
    const paint = plastic(colour, { roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 });
    const glassM = new THREE.MeshPhysicalMaterial({ color: '#142030', roughness: 0.04, metalness: 0.3, clearcoat: 1, envMapIntensity: 1.6 });
    const chrome = plastic('#e3e6ea', { metalness: 0.9, roughness: 0.18 }), black = matte('#16181a', { roughness: 0.6 });
    // rounded, smooth-shaded panels: lots of bevel segments, then normals smoothed except across sharp creases
    const extrude = (draw, depth, bevel) => { const sh = new THREE.Shape(); draw(sh); let g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 8, curveSegments: 24 }); g.translate(0, 0, -depth / 2); if (toCreasedNormals) g = toCreasedNormals(g, deg(50)); return g; };
    // lower body: rounded bumpers, bonnet and boot
    body.add(new THREE.Mesh(extrude(sh => { sh.moveTo(-0.27, 0.042); sh.lineTo(0.262, 0.042); sh.bezierCurveTo(0.292, 0.044, 0.298, 0.07, 0.294, 0.09); sh.bezierCurveTo(0.29, 0.11, 0.27, 0.116, 0.24, 0.119); sh.lineTo(0.12, 0.128); sh.bezierCurveTo(0.0, 0.133, -0.12, 0.134, -0.2, 0.133); sh.bezierCurveTo(-0.262, 0.132, -0.284, 0.122, -0.29, 0.104); sh.bezierCurveTo(-0.296, 0.082, -0.294, 0.055, -0.27, 0.042); }, 0.176, 0.026), paint));
    // cabin: one painted shell (roof, pillars and body all of a piece), with glass set into it
    const cabFront = new THREE.CubicBezierCurve(new THREE.Vector2(0.118, 0.124), new THREE.Vector2(0.09, 0.15), new THREE.Vector2(0.06, 0.18), new THREE.Vector2(0.03, 0.188));
    const cabBack = new THREE.CubicBezierCurve(new THREE.Vector2(-0.112, 0.19), new THREE.Vector2(-0.15, 0.186), new THREE.Vector2(-0.18, 0.16), new THREE.Vector2(-0.2, 0.126));
    body.add(new THREE.Mesh(extrude(sh => { sh.moveTo(0.118, 0.124); sh.bezierCurveTo(0.09, 0.15, 0.06, 0.18, 0.03, 0.188); sh.lineTo(-0.112, 0.19); sh.bezierCurveTo(-0.15, 0.186, -0.18, 0.16, -0.2, 0.126); sh.closePath(); }, 0.172, 0.014), paint));
    // windscreen and rear screen: curved glass strips lying just proud of the shell
    const screen = (curve, t0, t1, width) => {
      const pts = [], inner = [];
      for (let k = 0; k <= 16; k++) {
        const t = t0 + (t1 - t0) * k / 16, p = curve.getPoint(t), d = curve.getTangent(t);
        let nx = -d.y, ny = d.x; if (nx * (p.x + 0.04) + ny * (p.y - 0.12) < 0) { nx = -nx; ny = -ny; }
        pts.push(new THREE.Vector2(p.x + nx * 0.0035, p.y + ny * 0.0035)); inner.push(new THREE.Vector2(p.x - nx * 0.001, p.y - ny * 0.001));
      }
      const sh = new THREE.Shape([...pts, ...inner.reverse()]);
      const g = new THREE.ExtrudeGeometry(sh, { depth: width, bevelEnabled: false, curveSegments: 4 }); g.translate(0, 0, -width / 2); return new THREE.Mesh(g, glassM);
    };
    body.add(screen(cabFront, 0.1, 0.86, 0.15), screen(cabBack, 0.16, 0.9, 0.15));
    // side windows, split by the centre pillar
    const sideWin = poly => { const sh = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y))); return new THREE.ShapeGeometry(sh); };
    const winFront = sideWin([[0.07, 0.142], [0.032, 0.17], [-0.036, 0.17], [-0.036, 0.142]]), winBack = sideWin([[-0.056, 0.142], [-0.056, 0.17], [-0.098, 0.17], [-0.155, 0.142]]);
    for (const zs of [1, -1]) for (const wg of [winFront, winBack]) {
      const w = new THREE.Mesh(wg, glassM); w.position.z = zs * 0.1008; if (zs < 0) w.rotation.y = Math.PI, w.scale.x = -1; body.add(w);
    }
    // trim: bumpers, plates, mirrors, sills, exhaust
    for (const [x, front] of [[0.3, true], [-0.302, false]]) {
      // curved chrome bumper wrapping round the corners
      const bump = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.19, 6, 16).rotateX(Math.PI / 2), chrome); bump.position.set(x, 0.052, 0); body.add(bump);
      for (const z of [0.098, -0.098]) { const c = new THREE.Mesh(new THREE.SphereGeometry(0.011, 12, 8), chrome); c.position.set(x - Math.sign(x) * 0.012, 0.052, z); body.add(c); }
      const pl = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.022, 0.07), [black, black, black, black, black, black]);
      pl.material = [black, black, black, black, black, black].map((m, k) => k === (front ? 0 : 1) ? new THREE.MeshStandardMaterial({ map: numberPlateTex(front, colour), roughness: 0.4 }) : m);
      pl.position.set(x + Math.sign(x) * 0.004, 0.074, 0); body.add(pl);
    }
    for (const z of [0.108, -0.108]) {
      const mir = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.016, 0.022), paint); mir.position.set(0.085, 0.142, z + Math.sign(z) * 0.012); body.add(mir);
      const sill = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.012, 0.006), black); sill.position.set(-0.01, 0.05, z + Math.sign(z) * 0.011); body.add(sill);
    }
    for (const z of [0.05, 0.068]) { const exh = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.03, 14, 1, true).rotateZ(Math.PI / 2), chrome); exh.material.side = THREE.DoubleSide; exh.position.set(-0.296, 0.038, z); body.add(exh); }
    // lights: headlights glow brighter after dark, tail-lights are always a little lit
    const headM = new THREE.MeshStandardMaterial({ color: '#fffbe8', emissive: '#fff3c6', emissiveIntensity: 0.3 }); nightMats.push([headM, 3]);
    const tailM = new THREE.MeshStandardMaterial({ color: '#7a0d0d', emissive: '#ff2a1a', emissiveIntensity: 0.35 }); nightMats.push([tailM, 1.8]);
    const revM = new THREE.MeshPhysicalMaterial({ color: '#f4f4f4', roughness: 0.1, clearcoat: 1 });
    for (const z of [0.066, -0.066]) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.008, 16).rotateZ(Math.PI / 2), chrome); ring.position.set(0.292, 0.088, z); body.add(ring);
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.01, 16).rotateZ(Math.PI / 2), headM); h.position.set(0.296, 0.088, z); body.add(h);
      // tail-light cluster: chrome bezel, red lens, small white reversing light
      const bez = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.03, 0.052), chrome); bez.position.set(-0.294, 0.093, z); body.add(bez);
      const t = new THREE.Mesh(new THREE.CapsuleGeometry(0.011, 0.026, 4, 12).rotateX(Math.PI / 2), tailM); t.scale.set(0.6, 1, 1); t.position.set(-0.298, 0.094, z); body.add(t);
      const rev = new THREE.Mesh(new THREE.SphereGeometry(0.006, 10, 8), revM); rev.position.set(-0.298, 0.08, z * 0.6); body.add(rev);
    }
    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.024, 0.07), black); grille.position.set(0.297, 0.072, 0); body.add(grille);
    // wheels: front ones on steering pivots; dark arches over each
    const tyreG = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.042, 24).rotateX(Math.PI / 2), tyreM = matte('#151515', { roughness: 0.9 });
    const hubG = new THREE.CylinderGeometry(0.027, 0.027, 0.046, 16).rotateX(Math.PI / 2);
    const archG = new THREE.TorusGeometry(WHEEL_R + 0.007, 0.007, 8, 24, Math.PI), wellG = new THREE.CircleGeometry(WHEEL_R + 0.007, 24, 0, Math.PI);
    const wheels = [], steer = [];
    for (const [x, z] of [[0.17, 0.104], [0.17, -0.104], [-0.17, 0.104], [-0.17, -0.104]]) {
      const pivot = new THREE.Group(); pivot.position.set(x, WHEEL_R, z); root.add(pivot);
      const w = new THREE.Group(); pivot.add(w);
      w.add(new THREE.Mesh(tyreG, tyreM)); w.add(new THREE.Mesh(hubG, chrome));
      for (const r of [0, Math.PI / 3, -Math.PI / 3]) { const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.006, 0.048), black); spoke.rotation.z = r; w.add(spoke); }
      wheels.push(w); if (x > 0) steer.push(pivot);
      const arch = new THREE.Mesh(archG, black); arch.position.set(x, WHEEL_R - 0.012, z + Math.sign(z) * 0.01); body.add(arch);
      const well = new THREE.Mesh(wellG, black); well.position.set(x, WHEEL_R - 0.012, Math.sign(z) * 0.1148); if (z < 0) well.rotation.y = Math.PI; body.add(well);
    }
    // a pool of headlight on the road ahead, faded in at night
    const beam = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55).rotateX(-Math.PI / 2), glowMat('#fff1cc', 0.55)); beam.position.set(0.72, 0.006, 0); beam.renderOrder = 2; root.add(beam);
    mergeRigid(body); wheels.forEach(w => mergeRigid(w));
    shadowed(root); beam.castShadow = false;
    body.position.y = 0.012;
    root.userData = { body, wheels, steer, spin: 0, roll: 0, rollV: 0, pitch: 0, pitchV: 0, rollT: 0, pitchT: 0, steerA: 0 };
    return root;
  }
  const cars = scenery.playerColours.map((c, i) => { const m = carMesh(c); Object.assign(m.userData, { space: -1, i }); scene.add(m); placeCar(m, -1); return m; });
  function carPose(i, space) {
    if (space < 0) { const [x, y] = scenery.carPark.bays[i]; return { pos: new THREE.Vector3(wx(x), 0, wz(y)), yaw: -Math.PI / 2 }; }
    const f = spaceFrame(space); return { pos: new THREE.Vector3(f.p.x, ROAD_Y, f.p.z), yaw: Math.atan2(-f.tg.z, f.tg.x) };
  }
  function placeCar(m, space) { const q = carPose(m.userData.i, space); m.position.copy(q.pos); m.rotation.y = q.yaw; m.userData.space = space; }
  // The point `lane` units to the driver's left of the road centre (Britain: we keep left).
  function roadPoint(t, lane) { const f = frameAt(t); return f.p.clone().add(new THREE.Vector3(f.tg.z, 0, -f.tg.x).multiplyScalar(lane)).setY(ROAD_Y); }
  const OVERTAKE = 0.3; // how far a car swings out to pass a parked car
  // Dense centre-line samples for the whole trip: out of the car park if need be, then along the road.
  function routeFor(i, from, to) {
    const pts = [];
    let t0 = from / N;
    if (from < 0) {
      const bay = carPose(i, -1).pos, fwd = new THREE.Vector3(0, 0, 1), f0 = frameAt(0);
      const p3 = f0.p.clone().setY(ROAD_Y), p2 = p3.clone().addScaledVector(f0.tg, -0.6), p1 = bay.clone().addScaledVector(fwd, 0.55);
      const bz = new THREE.CubicBezierCurve3(bay.clone().setY(ROAD_Y * 0.5), p1.setY(ROAD_Y), p2, p3);
      for (let k = 0; k < 24; k++) pts.push(bz.getPoint(k / 24));
      t0 = 0;
    }
    const steps = from < 0 ? to : ((to - from) % N + N) % N;
    const n = Math.max(1, steps * 14);
    // Drive down the middle; pull out to the right only to overtake another player's car, then tuck back in.
    const parked = cars.filter(c => c !== cars[i] && c.visible && c.userData.space >= 0).map(c => c.userData.space);
    const offsetAt = d => { // d = distance travelled, in spaces from the starting point
      let o = 0;
      for (const sp of parked) {
        const rel = ((sp - t0 * N) % N + N) % N; if (rel < 0.5 || rel > steps - 0.5) continue; // not on our way
        const x = Math.abs(d - rel); o = Math.max(o, x < 0.3 ? 1 : x > 1.05 ? 0 : 1 - (x - 0.3) / 0.75);
      }
      return -OVERTAKE * o * o * (3 - 2 * o);
    };
    for (let k = 0; k <= n; k++) { const u = k / n; pts.push(roadPoint(t0 + steps * u / N, offsetAt(steps * u))); }
    return pts;
  }
  let driveSpeed = 1;
  function moveCar(i, to, animate) {
    const m = cars[i]; if (!m) return Promise.resolve();
    const from = m.userData.space;
    if (!animate || reduceMotion || to === from || to < 0) { if (animate && to < 0 && from >= 0) dust(m.position.clone(), 0.3); placeCar(m, to); return Promise.resolve(); }
    const pts = routeFor(i, from, to), cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + pts[k].distanceTo(pts[k - 1]));
    const L = cum[cum.length - 1], vmax = 2.5 * driveSpeed, acc = 3.0 * driveSpeed * driveSpeed;
    let ta = vmax / acc, da = 0.5 * acc * ta * ta, tc, vpk;
    if (2 * da > L) { ta = Math.sqrt(L / acc); vpk = acc * ta; tc = 0; da = 0.5 * acc * ta * ta; } else { vpk = vmax; tc = (L - 2 * da) / vmax; }
    return new Promise(res => { anims.push({ kind: 'drive', m, pts, cum, L, ta, tc, da, vpk, acc, T: 2 * ta + tc, t: 0, to, res, prevYaw: m.rotation.y, prevS: 0, prevV: 0 }); });
  }
  function samplePath(a, s) {
    const c = a.cum; s = Math.max(0, Math.min(a.L, s));
    let lo = 0, hi = c.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= s) lo = mid; else hi = mid; }
    const f = c[hi] > c[lo] ? (s - c[lo]) / (c[hi] - c[lo]) : 0;
    return a.pts[lo].clone().lerp(a.pts[hi], f);
  }
  const springStep = (u, x, v, target, k, d, dt) => { const acc = k * (target - x) - d * v; v += acc * dt; x += v * dt; u[0] = x; u[1] = v; };
  // body roll/pitch springs and wheel steering for every car, every frame
  function stepCars(dt) {
    const u = [0, 0];
    for (const m of cars) {
      const d = m.userData;
      springStep(u, d.roll, d.rollV, d.rollT, 70, 7, dt); d.roll = u[0]; d.rollV = u[1];
      springStep(u, d.pitch, d.pitchV, d.pitchT, 80, 6.5, dt); d.pitch = u[0]; d.pitchV = u[1];
      d.body.rotation.x = d.roll; d.body.rotation.z = d.pitch;
      d.steer.forEach(p => { p.rotation.y += (d.steerA - p.rotation.y) * Math.min(1, dt * 10); });
      d.wheels.forEach(w => { w.rotation.z = -d.spin / WHEEL_R; });
      if (!d.driving) { d.rollT = 0; d.pitchT = 0; d.steerA *= Math.max(0, 1 - dt * 4); }
    }
  }

  // ---------------------------------------------------------------- ownership flags and the estate agent's SOLD board
  const flags = {};
  const FLAG_W = 0.24, FLAG_H = 0.15, POLE_H = 0.62;
  for (const id in scenery.hotels) {
    const sg = scenery.hotels[id].sign, gp = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.012, POLE_H, 8), plastic('#e8e6e1', { metalness: 0.5, roughness: 0.3 })); pole.position.y = POLE_H / 2; gp.add(pole);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 8), M.gold); knob.position.y = POLE_H + 0.01; gp.add(knob);
    const geo = new THREE.PlaneGeometry(FLAG_W, FLAG_H, 10, 4); geo.translate(FLAG_W / 2, -FLAG_H / 2, 0);
    const cloth = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#ffffff', side: THREE.DoubleSide, roughness: 0.8 })); cloth.position.set(0.008, POLE_H - 0.01, 0); gp.add(cloth);
    shadowed(gp); at(gp, sg.x + sg.w / 2 + 9, sg.y + 2, 0); gp.visible = false; scene.add(gp);
    flags[id] = { gp, cloth, base: geo.attributes.position.array.slice(), owner: null, ph: rnd() * 6 };
  }
  function setOwner(id, colour, animate) {
    const f = flags[id]; if (!f || f.owner === colour) return;
    const prev = f.owner; f.owner = colour;
    for (let i = anims.length - 1; i >= 0; i--) if (anims[i].kind === 'flag' && anims[i].f === f) anims.splice(i, 1);
    if (!colour) { if (animate && f.gp.visible) smoke(f.gp, false); f.gp.visible = false; return; }
    if (!animate || reduceMotion) { f.cloth.material.color.set(colour); f.cloth.position.y = POLE_H - 0.01; f.gp.visible = true; f.gp.scale.setScalar(1); return; }
    if (!prev || !f.gp.visible) { f.cloth.material.color.set(colour); f.gp.visible = true; f.cloth.position.y = 0.17; anims.push({ kind: 'flag', f, t: 0, stage: 'raise', colour }); }
    else anims.push({ kind: 'flag', f, t: 0, stage: 'lower', colour });
  }
  const soldTex = (() => { const c = canvas(256, 160), g = c.getContext('2d'); g.fillStyle = '#fbf8f1'; g.fillRect(0, 0, 256, 160); g.fillStyle = '#c8322b'; g.fillRect(0, 0, 256, 28); g.fillRect(0, 132, 256, 28); g.fillStyle = '#fff'; g.font = `700 20px ${FONT}`; g.textAlign = 'center'; g.fillText('HOTEL ESTATES', 128, 21); g.fillText('COMPULSORY PURCHASE', 128, 153); g.fillStyle = '#c8322b'; g.font = `700 86px ${FONT}`; g.fillText('SOLD', 128, 112); return tex(c); })();
  function saleSign(id, colour) {
    const sg = scenery.hotels[id].sign, gp = new THREE.Group(), post = plastic('#f3efe6');
    const upright = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.62, 0.03), post); upright.position.y = 0.31; gp.add(upright);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.025, 0.025), post); arm.position.set(0.15, 0.6, 0); gp.add(arm);
    const hang = new THREE.Group(); hang.position.set(0.17, 0.59, 0); gp.add(hang);
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.19, 0.012), [post, post, post, post, plastic('#fff', { map: soldTex }), plastic('#fff', { map: soldTex })]); board.position.y = -0.11; hang.add(board);
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.025, 0.016), plastic(colour)); band.position.y = -0.215; hang.add(band);
    shadowed(gp); at(gp, sg.x - sg.w / 2 - 14, sg.y + 6, 15); gp.userData.home = gp.position.clone(); scene.add(gp);
    drop(gp, 1.6); anims.push({ kind: 'sold', gp, hang, t: 0 });
  }

  // ---------------------------------------------------------------- animation: drop-in pieces and dust
  const anims = [];
  const dustGeo = new THREE.SphereGeometry(0.05, 8, 6);
  function drop(obj, height) {
    if (reduceMotion) return;
    obj.position.y = (obj.userData.home ? obj.userData.home.y : 0) + (height || 2.2);
    obj.scale.set(1, 1, 1);
    anims.push({ kind: 'drop', obj, t: 0, h: height || 2.2 });
  }
  function dust(pos, size) {
    for (let k = 0; k < 14; k++) {
      const m = new THREE.Mesh(dustGeo, new THREE.MeshStandardMaterial({ color: '#efe6d6', transparent: true, opacity: 0.8, roughness: 1 }));
      const a = rnd() * Math.PI * 2, r = size * (0.6 + rnd() * 0.5);
      m.position.set(pos.x + Math.cos(a) * r * 0.5, 0.05, pos.z + Math.sin(a) * r * 0.5); scene.add(m);
      anims.push({ kind: 'dust', m, t: 0, v: new THREE.Vector3(Math.cos(a) * r * 1.4, 0.6 + rnd() * 0.5, Math.sin(a) * r * 1.4) });
    }
  }
  const easeOutBounce = x => { const n1 = 7.5625, d1 = 2.75; if (x < 1 / d1) return n1 * x * x; if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75; if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375; return n1 * (x -= 2.625 / d1) * x + 0.984375; };
  // ---------------------------------------------------------------- construction: crane, scaffolding, workers, then a puff of smoke
  const CM = {
    crane: (() => { const c = canvas(64, 64), g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 64, 64); g.strokeStyle = '#fff'; g.lineWidth = 7; g.strokeRect(0, 0, 64, 64); g.beginPath(); g.moveTo(0, 0); g.lineTo(64, 64); g.moveTo(64, 0); g.lineTo(0, 64); g.stroke(); const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return plastic('#f2b90f', { alphaMap: t, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.45 }); })(),
    solid: plastic('#f2b90f', { roughness: 0.45 }), dark: plastic('#3a3f45'), scaff: plastic('#c98a3a', { roughness: 0.5, metalness: 0.25 }),
    plank: plastic('#b58a57', { roughness: 0.7 }), hivis: plastic('#ff7a1a'), skin: plastic('#f1c6a0'), hat: plastic('#ffd21f', { clearcoat: 1 }), jeans: plastic('#35507a'),
    net: new THREE.MeshStandardMaterial({ color: '#3f7f52', transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false })
  };
  function lattice(w, h, d) { const g = new THREE.BoxGeometry(w, h, d); const uv = g.attributes.uv; const long = Math.max(w, h, d) / Math.min(w, h, d); for (let i = 0; i < uv.count; i++) { const f = Math.floor(i / 4); const vert = h >= w && h >= d; uv.setXY(i, uv.getX(i) * (vert || f === 2 || f === 3 ? 1 : long), uv.getY(i) * (vert && f !== 2 && f !== 3 ? long : 1)); } return new THREE.Mesh(g, CM.crane); }
  // Objects that can't move (hidden hotel stages, merged scenery) skip three.js's per-frame matrix rebuild.
  function freeze(obj) { obj.traverse(o => { o.updateMatrix(); o.matrixAutoUpdate = false; }); obj.updateMatrixWorld(true); }
  function thaw(obj) { obj.traverse(o => { o.matrixAutoUpdate = true; }); obj.updateMatrixWorld(true); }
  function localBox(obj) {
    const p = obj.position.clone(), r = obj.rotation.y, s = obj.scale.clone(), v = obj.visible;
    obj.position.set(0, 0, 0); obj.rotation.y = 0; obj.scale.set(1, 1, 1); obj.visible = true; obj.updateMatrix(); obj.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(obj);
    obj.position.copy(p); obj.rotation.y = r; obj.scale.copy(s); obj.visible = v; obj.updateMatrix(); obj.updateMatrixWorld(true);
    return b;
  }
  function buildSite(obj) {
    const b = localBox(obj), size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const site = new THREE.Group(); site.position.copy(obj.userData.home); site.rotation.y = obj.rotation.y;
    // scaffolding hugging the footprint
    const w = size.x + 0.1, d = size.z + 0.1, h = size.y + 0.06, pole = 0.016, parts = [], planks = [];
    const nx = Math.max(2, Math.round(w / 0.26)), nz = Math.max(2, Math.round(d / 0.26)), lv = Math.max(2, Math.round(h / 0.2));
    const P = (x, z) => { const g = new THREE.BoxGeometry(pole, h, pole); g.translate(x, h / 2, z); parts.push(g); };
    for (let i = 0; i <= nx; i++) { const x = -w / 2 + w * i / nx; P(x, -d / 2); P(x, d / 2); }
    for (let i = 1; i < nz; i++) { const z = -d / 2 + d * i / nz; P(-w / 2, z); P(w / 2, z); }
    for (let l = 1; l <= lv; l++) { const y = h * l / lv;
      for (const z of [-d / 2, d / 2]) { const g = new THREE.BoxGeometry(w, pole, pole); g.translate(0, y, z); parts.push(g); const pk = new THREE.BoxGeometry(w, 0.008, 0.05); pk.translate(0, y - 0.004, z + (z > 0 ? 0.03 : -0.03)); planks.push(pk); }
      for (const x of [-w / 2, w / 2]) { const g = new THREE.BoxGeometry(pole, pole, d); g.translate(x, y, 0); parts.push(g); } }
    const scaff = new THREE.Group(); scaff.add(new THREE.Mesh(mergeGeometries(parts), CM.scaff), new THREE.Mesh(mergeGeometries(planks), CM.plank));
    const netB = new THREE.Mesh(new THREE.PlaneGeometry(w, h), CM.net); netB.position.set(0, h / 2, -d / 2 - 0.004); scaff.add(netB);
    scaff.position.set(c.x, 0, c.z); site.add(scaff);
    // tower crane behind the building, jib swinging over it
    const H = size.y + 0.5, crane = new THREE.Group(), cx = c.x + w / 2 + 0.22, cz = c.z - d / 2 - 0.18;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.22), CM.dark); foot.position.y = 0.025; crane.add(foot);
    const mast = lattice(0.07, H, 0.07); mast.position.y = H / 2 + 0.05; crane.add(mast);
    const slew = new THREE.Group(); slew.position.y = H + 0.05; crane.add(slew);
    const reach = Math.hypot(c.x - cx, c.z - cz) + 0.2;
    const jib = lattice(reach + 0.1, 0.06, 0.06); jib.position.set((reach + 0.1) / 2 - 0.05, 0.05, 0); slew.add(jib);
    const cjib = lattice(0.34, 0.05, 0.06); cjib.position.set(-0.2, 0.05, 0); slew.add(cjib);
    const weight = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.09), CM.dark); weight.position.set(-0.32, 0.02, 0); slew.add(weight);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.07, 0.07), CM.solid); cab.position.set(0.02, -0.02, 0.07); slew.add(cab);
    const apex = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 4), CM.solid); apex.position.set(0, 0.17, 0); slew.add(apex);
    const trolley = new THREE.Group(); trolley.position.set(reach * 0.7, 0.02, 0); slew.add(trolley);
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, 1, 4), CM.dark); trolley.add(cable);
    const hook = new THREE.Group(); const hb = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.03, 0.02), CM.solid); hook.add(hb);
    const load = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.05), CM.plank); load.position.y = -0.04; hook.add(load); trolley.add(hook);
    crane.position.set(cx, 0, cz); crane.userData = { slew, trolley, cable, hook, base: Math.atan2(-(c.z - cz), c.x - cx), reach, H };
    site.add(crane);
    // hard-hat workers along the front
    const workers = [];
    for (let k = 0; k < 3; k++) {
      const wk = new THREE.Group();
      const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.02, 0.05, 8), CM.jeans); legs.position.y = 0.025; wk.add(legs);
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.024, 0.03, 4, 8), CM.hivis); body.position.y = 0.075; wk.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), CM.skin); head.position.y = 0.125; wk.add(head);
      const hat = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), CM.hat); hat.position.y = 0.13; wk.add(hat);
      if (k === 1) { const brick = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.025), FM.lacquer); brick.position.set(0, 0.1, 0.03); wk.add(brick); }
      wk.position.set(c.x + (k - 1) * Math.min(0.3, w / 3), 0, c.z + d / 2 + 0.1 + (k % 2) * 0.05);
      wk.userData = { x0: wk.position.x, ph: rnd() * 6 };
      site.add(wk); workers.push(wk);
    }
    shadowed(site); netB.castShadow = false;
    site.scale.setScalar(0.001); scene.add(site);
    return { site, scaff, crane, workers, size, c };
  }
  function disposeSite(s) { scene.remove(s.site); }
  function smoke(obj, big) {
    const b = new THREE.Box3().setFromObject(obj), c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
    const n = big ? 34 : 16, geo = dustGeo;
    for (let k = 0; k < n; k++) {
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: rnd() > 0.4 ? '#f4f1ea' : '#d6d0c4', transparent: true, opacity: 0.9, roughness: 1, depthWrite: false }));
      const a = rnd() * Math.PI * 2, r = Math.max(sz.x, sz.z) * 0.5 * (0.5 + rnd() * 0.6);
      m.position.set(c.x + Math.cos(a) * r, 0.05 + rnd() * sz.y * (big ? 0.9 : 0.4), c.z + Math.sin(a) * r);
      m.scale.setScalar(big ? 1.6 + rnd() : 1); scene.add(m);
      anims.push({ kind: 'smoke', m, t: 0, life: big ? 1.1 + rnd() * 0.4 : 0.7, s0: m.scale.x, v: new THREE.Vector3(Math.cos(a) * (0.6 + rnd() * 0.6), 0.25 + rnd() * 0.5, Math.sin(a) * (0.6 + rnd() * 0.6)) });
    }
  }
  function construct(obj) {
    cancel(obj);
    obj.visible = true; obj.position.copy(obj.userData.home); obj.scale.set(1, 0.001, 1);
    const s = buildSite(obj);
    anims.push({ kind: 'build', obj, s, t: 0 }); sfx('buildStart', obj.getWorldPosition(new THREE.Vector3()));
  }
  function cancel(obj) {
    for (let i = anims.length - 1; i >= 0; i--) { const a = anims[i]; if (a.obj === obj) { if (a.s) disposeSite(a.s); anims.splice(i, 1); } }
    obj.scale.set(1, 1, 1); obj.position.copy(obj.userData.home || obj.position);
  }
  function sprout(grounds) {
    const T0 = { 0: 0, 1: 0.25, 2: 0.55, 3: 0.8, 4: 0.8 };
    grounds.parts.forEach((o, k) => { o.scale.setScalar(0.001); anims.push({ kind: 'sprout', obj: o, t: -(T0[o.userData.order] + (k % 7) * 0.06) }); });
  }
  // ---- sound hooks: the game's audio listens for these, with where on screen (pan) and how far away each one is
  let soundCb = null;
  const _sp = new THREE.Vector3();
  function where(pos) { _sp.copy(pos).project(camera); return { pan: Math.max(-1, Math.min(1, _sp.x)), dist: camera.position.distanceTo(pos), onScreen: Math.abs(_sp.x) < 1.1 && Math.abs(_sp.y) < 1.1 && _sp.z < 1 }; }
  function sfx(name, pos, extra) { if (!soundCb) return; try { soundCb(name, Object.assign(pos ? where(pos) : {}, extra || {})); } catch (e) { console.error(e); } }
  const easeOutBack = x => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
  function stepAnims(dt) {
    for (let i = anims.length - 1; i >= 0; i--) {
      const a = anims[i]; a.t += dt;
      if (a.kind === 'drop') {
        const T = 0.7, x = Math.min(1, a.t / T), home = a.obj.userData.home ? a.obj.userData.home.y : 0;
        a.obj.position.y = home + a.h * (1 - easeOutBounce(x));
        const squash = x > 0.36 && x < 0.55 ? 1 - Math.sin((x - 0.36) / 0.19 * Math.PI) * 0.12 : 1;
        a.obj.scale.set(2 - squash, squash, 2 - squash);
        if (!a.dusted && x > 0.36) { a.dusted = true; sfx('drop', a.obj.getWorldPosition(new THREE.Vector3()), { h: a.h }); const b = new THREE.Box3().setFromObject(a.obj); const c = b.getCenter(new THREE.Vector3()); dust(new THREE.Vector3(c.x, 0, c.z), Math.max(0.3, (b.max.x - b.min.x) * 0.5)); }
        if (x >= 1) { a.obj.position.y = home; a.obj.scale.set(1, 1, 1); anims.splice(i, 1); }
      } else if (a.kind === 'dust') {
        a.m.position.addScaledVector(a.v, dt); a.v.multiplyScalar(0.9); a.m.scale.setScalar(1 + a.t * 3); a.m.material.opacity = Math.max(0, 0.8 - a.t * 1.3);
        if (a.t > 0.62) { scene.remove(a.m); a.m.material.dispose(); anims.splice(i, 1); }
      } else if (a.kind === 'drive') {
        const m = a.m, d = m.userData, t = Math.min(a.t, a.T);
        const s = t < a.ta ? 0.5 * a.acc * t * t : t < a.ta + a.tc ? a.da + a.vpk * (t - a.ta) : a.L - 0.5 * a.acc * Math.pow(a.T - t, 2);
        const v = t < a.ta ? a.acc * t : t < a.ta + a.tc ? a.vpk : a.acc * (a.T - t);
        const p = samplePath(a, s), ahead = samplePath(a, Math.min(a.L, s + 0.09)), back = samplePath(a, Math.max(0, s - 0.05));
        m.position.copy(p); m.position.y += Math.sin(s * 23) * 0.0025 * Math.min(1, v);
        const dir = ahead.sub(back); let yaw = dir.lengthSq() > 1e-6 ? Math.atan2(-dir.z, dir.x) : m.rotation.y;
        let dy = yaw - a.prevYaw; while (dy > Math.PI) { dy -= 2 * Math.PI; yaw -= 2 * Math.PI; } while (dy < -Math.PI) { dy += 2 * Math.PI; yaw += 2 * Math.PI; }
        m.rotation.y = yaw; const yawRate = dt > 0 ? dy / dt : 0; a.prevYaw = yaw;
        const accel = dt > 0 ? (v - a.prevV) / dt : 0; a.prevV = v;
        d.driving = true; d.spin = (d.spin || 0) + (s - a.prevS); a.prevS = s;
        d.rollT = Math.max(-0.13, Math.min(0.13, yawRate * v * 0.05)); // lean out of the bend
        d.pitchT = Math.max(-0.07, Math.min(0.07, accel * 0.014)); // squat on the throttle, dive on the brakes
        d.steerA = Math.max(-0.5, Math.min(0.5, Math.atan(yawRate / Math.max(v, 0.25) * 0.34)));
        a.car = m;
        sfx(a.snd ? 'car' : 'carStart', m.position, { i: m.userData.i, v, vmax: 2.5 * driveSpeed, accel, yawRate, phase: t < a.ta ? 'accel' : t < a.ta + a.tc ? 'cruise' : 'brake', left: a.T - t, driver: !!(driver && driver.i === m.userData.i) }); a.snd = true;
        if (a.t >= a.T) { sfx('carStop', m.position, { i: m.userData.i }); d.driving = false; d.pitchT = 0; d.rollT = 0; placeCar(m, a.to); m.userData.space = a.to; anims.splice(i, 1); a.res(); }
      } else if (a.kind === 'build') {
        const T_IN = 0.3, T_BUILD = 1.8, T_END = 2.3, st = a.s;
        st.site.scale.setScalar(a.t < T_IN ? Math.max(0.001, easeOutBack(a.t / T_IN)) : 1);
        const p = Math.min(1, Math.max(0, (a.t - T_IN) / (T_BUILD - T_IN))), floors = 7, q = Math.ceil(p * floors) / floors;
        if (a.t < T_BUILD) { a.obj.scale.set(1, Math.max(0.001, q * (0.85 + 0.15 * p)), 1); st.scaff.scale.y = Math.min(1, 0.25 + p); }
        const cu = st.crane.userData; cu.slew.rotation.y = cu.base + Math.sin(a.t * 2.4) * 0.45; cu.trolley.position.x = cu.reach * (0.55 + 0.3 * Math.sin(a.t * 1.7));
        const dropLen = 0.25 + (Math.sin(a.t * 3.1) * 0.5 + 0.5) * (cu.H - 0.3) * 0.6; cu.cable.scale.y = dropLen; cu.cable.position.y = -dropLen / 2; cu.hook.position.y = -dropLen;
        st.workers.forEach(w => { const u = w.userData; w.position.y = Math.abs(Math.sin(a.t * 11 + u.ph)) * 0.035; w.position.x = u.x0 + Math.sin(a.t * 2 + u.ph) * 0.06; w.rotation.y = Math.sin(a.t * 3 + u.ph) * 1.2; });
        if (!a.puffed && a.t >= T_BUILD) { a.puffed = true; sfx('buildDone', a.obj.getWorldPosition(new THREE.Vector3())); a.obj.scale.set(1, 1, 1); smoke(a.obj, true); disposeSite(st); }
        if (a.t >= T_BUILD) { const x = Math.min(1, (a.t - T_BUILD) / (T_END - T_BUILD)), k = 1 + Math.sin(x * Math.PI) * 0.07; a.obj.scale.set(k, 1 + (k - 1) * 1.4, k); }
        if (a.t >= T_END) { a.obj.scale.set(1, 1, 1); anims.splice(i, 1); }
      } else if (a.kind === 'smoke') {
        a.m.position.addScaledVector(a.v, dt); a.v.multiplyScalar(0.93); const x = Math.min(1, a.t / a.life);
        a.m.scale.setScalar(a.s0 * (1 + x * 2.2)); a.m.material.opacity = 0.9 * (1 - x);
        if (x >= 1) { scene.remove(a.m); a.m.material.dispose(); anims.splice(i, 1); }
      } else if (a.kind === 'sprout') {
        if (a.t < 0) continue;
        const x = Math.min(1, a.t / 0.45); a.obj.scale.setScalar(Math.max(0.001, easeOutBack(x)));
        if (!a.puffed) { a.puffed = true; if (a.obj.userData.order <= 1) smoke(a.obj, false); }
        if (x >= 1) { a.obj.scale.setScalar(1); anims.splice(i, 1); }
      } else if (a.kind === 'flag') {
        const f = a.f, top = POLE_H - 0.01, low = 0.17;
        if (a.stage === 'lower') { const x = Math.min(1, a.t / 0.55); f.cloth.position.y = top + (low - top) * x * x; if (x >= 1) { f.cloth.material.color.set(a.colour); a.stage = 'raise'; a.t = -0.12; } }
        else if (a.t >= 0) { const x = Math.min(1, a.t / 0.75); f.cloth.position.y = low + (top - low) * (1 - Math.pow(1 - x, 3)); if (x >= 1) anims.splice(i, 1); }
      } else if (a.kind === 'sold') {
        a.hang.rotation.x = Math.sin(a.t * 7) * 0.35 * Math.exp(-a.t * 0.9) * (a.t > 0.45 ? 1 : 0);
        if (a.t > 4.2) { smoke(a.gp, false); scene.remove(a.gp); anims.splice(i, 1); }
      } else if (a.kind === 'orbit') {
        // 0..0.9s swoop in, then circle ~110 degrees, then the last 0.9s swoop back out
        const T = a.T, inT = 0.9, outT = 0.9, x = a.t;
        const az = a.az0 + deg(110) * Math.min(1, Math.max(0, (x - inT * 0.5) / (T - outT - inT * 0.5)));
        const orbitPos = new THREE.Vector3(a.look.x + Math.sin(az) * Math.cos(a.el) * a.r, a.look.y + Math.sin(a.el) * a.r, a.look.z + Math.cos(az) * Math.cos(a.el) * a.r);
        const ease = u => u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
        if (x < inT) { const e = ease(x / inT); camera.position.lerpVectors(a.p0, orbitPos, e); controls.target.lerpVectors(a.t0, a.look, e); }
        else if (x < T - outT) { camera.position.copy(orbitPos); controls.target.copy(a.look); }
        else { const e = ease(Math.min(1, (x - (T - outT)) / outT)); camera.position.lerpVectors(orbitPos, a.p0, e); controls.target.lerpVectors(a.look, a.t0, e); }
        if (x >= T) { camera.position.copy(a.p0); controls.target.copy(a.t0); anims.splice(i, 1); a.res(); }
      } else if (a.kind === 'fly') {
        const x = Math.min(1, a.t / 1.1), e = 1 - Math.pow(1 - x, 3);
        camera.position.lerpVectors(a.p0, a.p1, e); controls.target.lerpVectors(a.t0, a.t1, e);
        if (x >= 1) anims.splice(i, 1);
      }
    }
  }

  // Returns the box around whatever was newly built, so the camera can go and watch it go up.
  function setHotel(id, built, facilities, animate) {
    const h = hotels[id]; if (!h) return null;
    if (h.built !== built || h.facilities !== !!facilities) { if (hotelBatches && hotelBatches[id]) unmergeHotel(id); if (hotelDirty) hotelDirty.add(id); }
    const anim = animate && !reduceMotion, box = new THREE.Box3(); let grew = false;
    h.pieces.forEach((obj, k) => {
      const show = k < built;
      if (show && !obj.visible) { cancel(obj); obj.visible = true; thaw(obj); box.expandByObject(obj); grew = true; if (anim) construct(obj); }
      if (!show && obj.visible) { if (anim) smoke(obj, false); cancel(obj); obj.visible = false; freeze(obj); }
    });
    const g = h.grounds;
    if (facilities && !g.group.visible) { g.group.visible = true; thaw(g.group); box.expandByObject(g.group); grew = true; if (anim) sprout(g); }
    if (!facilities && g.group.visible) { if (anim) smoke(g.group, false); g.parts.forEach(o => cancel(o)); g.group.visible = false; freeze(g.group); }
    h.built = built; h.facilities = !!facilities;
    return grew ? box : null;
  }
  // Swoop in on a new building and circle it while it goes up, then go back to where the camera was.
  function showcase(box, secs, minR) {
    if (!box || reduceMotion) return Promise.resolve();
    cancelFly();
    // from the driver's seat this is a cutaway: leave the car, watch, then cut back
    let t0 = controls.target.clone();
    if (driver) { cutaway = true; t0 = camLook.clone(); }
    const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
    const r = Math.max(minR || 2.6, Math.max(sz.x, sz.z) * 1.7 + sz.y * 1.3);
    const off = camera.position.clone().sub(controls.target); const az0 = Math.atan2(off.x, off.z);
    const look = new THREE.Vector3(c.x, Math.max(0.2, box.min.y + sz.y * 0.45), c.z);
    return new Promise(res => anims.push({ kind: 'orbit', t: 0, T: secs || 4.6, look, r, az0, el: deg(28), p0: camera.position.clone(), t0, res: () => { cutaway = false; res(); } }));
  }

  // ---------------------------------------------------------------- camera moves and picking
  function hotelCentre(id) {
    const def = scenery.hotels[id], pts = [];
    def.pieces.forEach(p => { if (p.style === 'wing') pts.push([def.ring.x, def.ring.y]); else if (p.style === 'crescent') pts.push([p.cx + 50, p.cy + 60]); else pts.push([p.x, p.y]); });
    pts.push([def.sign.x, def.sign.y]);
    const x = pts.reduce((a, p) => a + p[0], 0) / pts.length, y = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    return new THREE.Vector3(wx(x), 0.4, wz(y));
  }

  // ---------------------------------------------------------------- fireworks: rockets that climb and burst; bigger shows for better news
  const FW_MAX = 9000;
  const fwPos = new Float32Array(FW_MAX * 3), fwCol = new Float32Array(FW_MAX * 3), fwSize = new Float32Array(FW_MAX), fwAlpha = new Float32Array(FW_MAX);
  const fwVel = new Float32Array(FW_MAX * 3), fwLife = new Float32Array(FW_MAX), fwAge = new Float32Array(FW_MAX), fwKind = new Uint8Array(FW_MAX), fwBase = new Float32Array(FW_MAX * 3), fwSz0 = new Float32Array(FW_MAX);
  const fwGeo = new THREE.BufferGeometry();
  fwGeo.setAttribute('position', new THREE.BufferAttribute(fwPos, 3).setUsage(THREE.DynamicDrawUsage));
  fwGeo.setAttribute('col', new THREE.BufferAttribute(fwCol, 3).setUsage(THREE.DynamicDrawUsage));
  fwGeo.setAttribute('size', new THREE.BufferAttribute(fwSize, 1).setUsage(THREE.DynamicDrawUsage));
  fwGeo.setAttribute('alpha', new THREE.BufferAttribute(fwAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  const fwMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: glowTex }, scale: { value: 300 } },
    vertexShader: 'attribute vec3 col; attribute float size; attribute float alpha; varying vec3 vC; varying float vA; uniform float scale; void main(){ vC = col; vA = alpha; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = size * scale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform sampler2D map; varying vec3 vC; varying float vA; void main(){ vec4 t = texture2D(map, gl_PointCoord); float a = t.a * vA; if (a < 0.004) discard; gl_FragColor = vec4(vC * (1.2 + 4.0 * t.r * t.r) * a, a); }',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  });
  const fwPoints = new THREE.Points(fwGeo, fwMat); fwPoints.frustumCulled = false; fwPoints.renderOrder = 10; scene.add(fwPoints);
  let fwLive = 0, fwNext = 0, fwScale = 1; const fwQueue = [];
  const FW_COLS = ['#ff4d4d', '#ffd23f', '#3fd1ff', '#7dff6a', '#ff6ad5', '#ffffff', '#ff9a3c', '#b18cff'].map(c => new THREE.Color(c));
  function fwSpawn(kind, x, y, z, vx, vy, vz, life, size, col) {
    for (let n = 0; n < FW_MAX; n++) {
      const i = (fwNext + n) % FW_MAX; if (fwKind[i]) continue;
      fwNext = (i + 1) % FW_MAX; fwKind[i] = kind; fwLive++;
      fwPos[i * 3] = x; fwPos[i * 3 + 1] = y; fwPos[i * 3 + 2] = z; fwVel[i * 3] = vx; fwVel[i * 3 + 1] = vy; fwVel[i * 3 + 2] = vz;
      fwLife[i] = life; fwAge[i] = 0; fwSz0[i] = size; fwSize[i] = size; fwAlpha[i] = 1; fwCol[i * 3] = col.r; fwCol[i * 3 + 1] = col.g; fwCol[i * 3 + 2] = col.b;
      return i;
    }
    return -1;
  }
  function fwBurst(x, y, z, level, style) {
    const n = Math.round((70 + level * 30) * (liteProfile ? 0.55 : 1)), sp = (0.62 + level * 0.12) * (fwScale || 1), c1 = FW_COLS[Math.floor(rnd() * FW_COLS.length)], c2 = rnd() > 0.5 ? FW_COLS[Math.floor(rnd() * FW_COLS.length)] : c1;
    for (let k = 0; k < n; k++) {
      // even directions over a sphere (rings for some shells)
      let dx, dy, dz;
      if (style === 'ring') { const a = k / n * Math.PI * 2; dx = Math.cos(a); dy = 0.15 * (rnd() - 0.5); dz = Math.sin(a); }
      else { const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u); dx = r * Math.cos(a); dy = u; dz = r * Math.sin(a); }
      const v = sp * (style === 'ring' ? 1 : 0.75 + rnd() * 0.3);
      fwSpawn(style === 'willow' ? 4 : 2, x, y, z, dx * v, dy * v, dz * v, (style === 'willow' ? 2.4 : 1.4) + rnd() * 0.6, 0.05 + level * 0.006, k % 2 ? c1 : c2);
    }
    // a white flash at the heart of the burst
    fwSpawn(3, x, y, z, 0, 0, 0, 0.22, 0.6 + level * 0.1, FW_COLS[5]);
  }
  function fwLaunch(base, level, delay, h) { fwQueue.push({ at: delay, base: base.clone(), level, h }); }
  function fireworks(where, level) {
    level = Math.max(1, Math.min(4, level | 0)); if (reduceMotion) level = 1;
    let base, top = 0, hh = null, delay0 = 0, spreadK = null;
    if (where === 'board' || where === undefined) { base = new THREE.Vector3(BCX, 0, BCZ); }
    else if (where && where.isBox3) { // a new building: wait for the dust to settle, then burst just above it so the close-up camera sees it
      base = where.getCenter(new THREE.Vector3()); top = where.max.y; const sz = where.getSize(new THREE.Vector3());
      hh = Math.max(0.45, sz.y * 0.45); spreadK = Math.max(sz.x, sz.z) * 0.7; delay0 = 1.1;
    }
    else if (typeof where === 'string') { base = hotelCentre(where); top = 0.6; }
    else if (where && where.space !== undefined) { base = spaceFrame(where.space).p.clone(); }
    else base = where.clone();
    base.y = top;
    const rockets = [0, 2, 5, 10, 18][level], span = [0, 0.6, 1.8, 3.4, 5.5][level], spread = where === 'board' ? 6 : spreadK !== null ? spreadK + level * 0.1 : 0.5 + level * 0.35;
    for (let r = 0; r < rockets; r++) {
      const finale = level >= 3 && r >= rockets * 0.7, t = finale ? span * 0.85 + rnd() * 0.4 : (r / rockets) * span * 0.85 + rnd() * 0.25;
      const b = base.clone(); b.x += (rnd() - 0.5) * spread; b.z += (rnd() - 0.5) * spread;
      fwLaunch(b, level, delay0 + t, hh !== null ? hh + level * 0.12 + rnd() * 0.35 : null);
    }
  }
  const _fwc = new THREE.Color();
  function stepFireworks(dt) {
    for (let q = fwQueue.length - 1; q >= 0; q--) {
      const L = fwQueue[q]; L.at -= dt; if (L.at > 0) continue; fwQueue.splice(q, 1);
      const h = L.h || 0.9 + L.level * 0.25 + rnd() * 0.5, vy = Math.sqrt(2 * 4 * h);
      const i = fwSpawn(1, L.base.x, L.base.y + 0.05, L.base.z, (rnd() - 0.5) * 0.5, vy, (rnd() - 0.5) * 0.5, 9, 0.12, FW_COLS[6]);
      sfx('fwLaunch', L.base, { level: L.level });
      if (i >= 0) { fwBase[i * 3] = L.level; fwBase[i * 3 + 1] = rnd(); fwBase[i * 3 + 2] = L.h ? 0.6 : 1; }
    }
    if (!fwLive && !fwQueue.length) { fwPoints.visible = false; return; }
    fwPoints.visible = true;
    for (let i = 0; i < FW_MAX; i++) {
      const k = fwKind[i]; if (!k) continue;
      fwAge[i] += dt; const age = fwAge[i], life = fwLife[i], j = i * 3;
      if (k === 1) { // rocket: climbs under gravity, leaves sparks, bursts as it slows
        fwVel[j + 1] -= 4 * dt;
        fwPos[j] += fwVel[j] * dt; fwPos[j + 1] += fwVel[j + 1] * dt; fwPos[j + 2] += fwVel[j + 2] * dt;
        if (rnd() < 0.8) fwSpawn(5, fwPos[j], fwPos[j + 1], fwPos[j + 2], (rnd() - 0.5) * 0.2, -0.3, (rnd() - 0.5) * 0.2, 0.35 + rnd() * 0.25, 0.05, _fwc.setRGB(1, 0.65, 0.3));
        if (fwVel[j + 1] < 0.6) {
          const lvl = fwBase[j], pick = fwBase[j + 1];
          sfx('fwBurst', new THREE.Vector3(fwPos[j], fwPos[j + 1], fwPos[j + 2]), { level: fwBase[j] });
          fwScale = fwBase[j + 2] || 1; fwBurst(fwPos[j], fwPos[j + 1], fwPos[j + 2], lvl, lvl >= 3 && pick > 0.75 ? 'ring' : lvl >= 2 && pick < 0.25 ? 'willow' : 'peony');
          fwKind[i] = 0; fwLive--; fwAlpha[i] = 0; fwSize[i] = 0; continue;
        }
      } else {
        const drag = k === 4 ? 1.1 : k === 5 ? 3 : 1.8, grav = k === 4 ? 0.6 : 0.35;
        const f = Math.exp(-drag * dt); fwVel[j] *= f; fwVel[j + 1] = fwVel[j + 1] * f - grav * dt; fwVel[j + 2] *= f;
        fwPos[j] += fwVel[j] * dt; fwPos[j + 1] += fwVel[j + 1] * dt; fwPos[j + 2] += fwVel[j + 2] * dt;
        const x = age / life;
        fwAlpha[i] = k === 3 ? 1 - x : (1 - x * x) * (k === 2 && x > 0.6 ? 0.6 + 0.4 * Math.sin(age * 40 + i) : 1);
        fwSize[i] = fwSz0[i] * (k === 3 ? 1 + x : 1 - 0.5 * x);
        if (k === 4 && rnd() < 0.08) fwSpawn(5, fwPos[j], fwPos[j + 1], fwPos[j + 2], 0, -0.1, 0, 0.5, 0.035, _fwc.setRGB(fwCol[j], fwCol[j + 1], fwCol[j + 2]));
        if (age >= life || fwPos[j + 1] < 0) { fwKind[i] = 0; fwLive--; fwAlpha[i] = 0; fwSize[i] = 0; }
      }
    }
    for (const a of ['position', 'col', 'size', 'alpha']) fwGeo.attributes[a].needsUpdate = true;
    fwMat.uniforms.scale.value = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
  }
  // ---- whole-board framing: find the camera distance (and nudge the aim) so all four board corners
  // land inside the part of the screen the game's panels leave free.
  let safe = { top: 0, right: 0, bottom: 0, left: 0 };
  const boardCorners = [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]].map(([x, y]) => new THREE.Vector3(wx(x), 0, wz(y)));
  function fitView(elev, azim, pts, centre) {
    pts = pts || boardCorners;
    const w = container.clientWidth || 800, h = container.clientHeight || 600;
    const nx0 = -1 + 2 * safe.left / w, nx1 = 1 - 2 * safe.right / w, ny0 = -1 + 2 * safe.bottom / h, ny1 = 1 - 2 * safe.top / h;
    const dir = new THREE.Vector3(Math.sin(azim) * Math.cos(elev), Math.sin(elev), Math.cos(azim) * Math.cos(elev));
    const cam = camera.clone(); cam.fov = camera.fov; cam.aspect = camera.aspect; if (camera.view) cam.view = Object.assign({}, camera.view); cam.updateProjectionMatrix();
    const target = centre ? centre.clone() : new THREE.Vector3(BCX, 0, BCZ), q = new THREE.Vector3();
    const rightG = new THREE.Vector3(Math.cos(azim), 0, -Math.sin(azim)), fwdG = new THREE.Vector3(-Math.sin(azim), 0, -Math.cos(azim));
    const bbox = d => { cam.position.copy(target).addScaledVector(dir, d); cam.lookAt(target); cam.updateMatrixWorld(); let x0 = 9, x1 = -9, y0 = 9, y1 = -9; for (const c of pts) { q.copy(c).project(cam); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); } return { x0, x1, y0, y1 }; };
    let dist = 20;
    for (let it = 0; it < 4; it++) {
      let lo = 3, hi = 90;
      for (let k = 0; k < 28; k++) { const mid = (lo + hi) / 2, b = bbox(mid); if (b.x0 >= nx0 + 0.015 && b.x1 <= nx1 - 0.015 && b.y0 >= ny0 + 0.015 && b.y1 <= ny1 - 0.015) hi = mid; else lo = mid; }
      dist = hi;
      const b = bbox(dist), dx = (b.x0 + b.x1) / 2 - (nx0 + nx1) / 2, dy = (b.y0 + b.y1) / 2 - (ny0 + ny1) / 2;
      const half = dist * Math.tan(deg(cam.fov) / 2);
      target.addScaledVector(rightG, dx * half * (w / h) * 0.9).addScaledVector(fwdG, dy * half / Math.max(0.3, Math.sin(elev)) * 0.9);
    }
    return { pos: target.clone().addScaledVector(dir, dist), target };
  }
  const homeView = () => portrait() ? fitView(deg(60), Math.PI / 2) : fitView(deg(50), 0);
  function cancelFly() { for (let i = anims.length - 1; i >= 0; i--) { const a = anims[i]; if (a.kind === 'fly' || a.kind === 'orbit') { anims.splice(i, 1); if (a.res) a.res(); } } }
  function flyTo(where) {
    if (driver) return;
    let t1, p1;
    if (where === 'home') { const v = homeView(); t1 = v.target; p1 = v.pos; controls.maxDistance = Math.max(42, p1.distanceTo(t1) + 4); }
    else if (where === 'finale') {
      // a pulled-back, lower view of the whole board sitting in the lower part of the screen, with open sky above for the fireworks
      const keep = safe; const h = container.clientHeight || 600;
      safe = Object.assign({}, safe, { top: Math.max(safe.top, h * (portrait() ? 0.4 : 0.32)), left: Math.max(safe.left, 16), right: Math.max(safe.right, 16), bottom: Math.max(safe.bottom, 30) });
      const v = fitView(deg(portrait() ? 38 : 32), 0.6); safe = keep; // looking across the board from a corner
      t1 = v.target; p1 = v.pos; controls.maxDistance = Math.max(controls.maxDistance, p1.distanceTo(t1) + 4);
    }
    else if (where === 'top') { const v = fitView(deg(89.5), portrait() ? Math.PI / 2 : 0); t1 = v.target; p1 = v.pos; controls.maxDistance = Math.max(42, p1.distanceTo(t1) + 4); }
    else if (typeof where === 'object' && where.fit) {
      // frame a set of spaces (and a hotel): keep the current heading, look down fairly steeply, fit them all in the free part of the screen
      const pts = where.fit.map(i => spaceFrame(i).p.clone().setY(0.05)); if (where.hotel) pts.push(hotelCentre(where.hotel).setY(0.3));
      const pad = []; for (const p of pts) for (const [dx, dz] of [[0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45]]) pad.push(p.clone().add(new THREE.Vector3(dx, 0, dz)));
      const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length).setY(0);
      const off = camera.position.clone().sub(controls.target), azim = Math.atan2(off.x, off.z), elev = Math.min(deg(72), Math.max(deg(50), Math.asin(Math.min(1, off.y / Math.max(0.01, off.length())))));
      const v = fitView(elev, azim, pad, c); t1 = v.target; p1 = v.pos;
      if (p1.distanceTo(t1) < 4) p1 = t1.clone().add(p1.clone().sub(t1).setLength(4));
    }
    else if (typeof where === 'object' && where.space !== undefined) {
      const f = spaceFrame(where.space); t1 = f.p.clone().setY(0.2);
      const off = camera.position.clone().sub(controls.target); const len = Math.min(17, Math.max(11, off.length())); off.setLength(len); off.y = Math.max(off.y, 6); p1 = t1.clone().add(off);
    }
    else { t1 = hotelCentre(where); const off = camera.position.clone().sub(controls.target).setLength(11.5); off.y = Math.max(off.y, 6.5); p1 = t1.clone().add(off); }
    cancelFly();
    anims.push({ kind: 'fly', t: 0, p0: camera.position.clone(), p1, t0: controls.target.clone(), t1 });
  }
  // Swoop in on a double-clicked spot of the board.
  renderer.domElement.addEventListener('dblclick', e => {
    if (driver) return;
    const r = renderer.domElement.getBoundingClientRect(), v = new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    const rc = new THREE.Raycaster(); rc.setFromCamera(v, camera);
    const hit = new THREE.Vector3(); if (!rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return;
    const off = camera.position.clone().sub(controls.target); off.setLength(Math.max(4.5, off.length() * 0.55));
    cancelFly(); anims.push({ kind: 'fly', t: 0, p0: camera.position.clone(), p1: hit.clone().add(off), t0: controls.target.clone(), t1: hit });
    lastUserMove = performance.now();
  });
  function zoomBy(k) { // on-screen +/- buttons
    if (driver) { chase = Math.min(2.6, Math.max(0.55, chase * k)); return; }
    const off = camera.position.clone().sub(controls.target); const len = Math.min(controls.maxDistance, Math.max(controls.minDistance, off.length() * k));
    cancelFly(); anims.push({ kind: 'fly', t: 0, p0: camera.position.clone(), p1: controls.target.clone().add(off.setLength(len)), t0: controls.target.clone(), t1: controls.target.clone() });
  }

  // ---- driver's view: a chase camera on the current player's car; drag to look around, wheel to pull back
  let driver = null, chase = 1, lookYaw = 0, lookPitch = 0, savedTilt = true, cutaway = false;
  function setShadowSpan(r) { Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r }); sun.shadow.camera.updateProjectionMatrix(); }
  const camLook = new THREE.Vector3();
  function setDriverView(i) {
    if (i === null || i === undefined) {
      if (!driver) return;
      driver = null; controls.enabled = true; resize(); setTiltShift(savedTilt); setShadowSpan(12); setBloom(false);
      controls.target.copy(camLook).setY(0.2); controls.update(); flyTo('home'); return;
    }
    if (!driver) { savedTilt = tilt; setTiltShift(false); cancelFly(); camLook.copy(controls.target); }
    driver = { i }; controls.enabled = false; lookYaw = 0; lookPitch = 0; resize(); setShadowSpan(4.5); setBloom(true);
  }
  let dragLook = null;
  renderer.domElement.addEventListener('pointerdown', e => { if (driver) dragLook = [e.clientX, e.clientY]; });
  window.addEventListener('pointermove', e => { if (!driver || !dragLook) return; lookYaw -= (e.clientX - dragLook[0]) * 0.006; lookPitch = Math.max(-0.12, Math.min(0.9, lookPitch + (e.clientY - dragLook[1]) * 0.003)); dragLook = [e.clientX, e.clientY]; });
  window.addEventListener('pointerup', () => { dragLook = null; });
  renderer.domElement.addEventListener('wheel', e => { if (driver) { chase = Math.min(2.6, Math.max(0.55, chase * (e.deltaY > 0 ? 1.1 : 0.9))); e.preventDefault(); } }, { passive: false });
  const _v = new THREE.Vector3();
  function stepDriverCam(dt) {
    const car = cars[driver.i]; if (!car) return;
    const moving = car.userData.driving;
    if (moving && !dragLook) { lookYaw *= Math.exp(-dt * 1.4); lookPitch *= Math.exp(-dt * 1.4); }
    const cy = Math.cos(lookYaw), sy = Math.sin(lookYaw), back = 1.0 * chase;
    const want = car.localToWorld(_v.set(-back * cy, 0.3 + 0.12 * chase + lookPitch * back, -back * sy)).clone();
    const look = car.localToWorld(_v.set(1.7 * cy, 0.16, 1.7 * sy)).clone();
    const k = 1 - Math.exp(-dt * (moving ? 7 : 5));
    camera.position.lerp(want, k); camLook.lerp(look, k); camera.lookAt(camLook);
  }
  // ---- while a car drives, the table camera drifts along with it (unless the player is steering the camera)
  function stepFollow(dt) {
    if (performance.now() - lastUserMove < 2500 || anims.some(a => a.kind === 'fly' || a.kind === 'orbit')) return;
    const d = anims.find(a => a.kind === 'drive'); if (!d) return;
    const want = d.m.position.clone().setY(Math.min(controls.target.y, 0.3));
    const move = want.sub(controls.target).multiplyScalar(Math.min(1, dt * 1.6));
    controls.target.add(move); camera.position.add(move);
  }

  // ---------------------------------------------------------------- environment: time of day and weather
  const WEATHER = {
    sunny:  { cover: 0.06, dim: 0,    rain: 0, wind: 0.15, mist: 0,    label: 'Sunny' },
    fair:   { cover: 0.42, dim: 0.14, rain: 0, wind: 0.3,  mist: 0,    label: 'Sunny spells' },
    cloudy: { cover: 0.92, dim: 0.55, rain: 0, wind: 0.35, mist: 0.12, label: 'Cloudy' },
    rain:   { cover: 1,    dim: 0.68, rain: 1, wind: 0.45, mist: 0.3,  label: 'Rain' },
    windy:  { cover: 0.55, dim: 0.2,  rain: 0, wind: 1,    mist: 0,    label: 'Windy' },
    mist:   { cover: 0.45, dim: 0.38, rain: 0, wind: 0.05, mist: 1,    label: 'Misty' }
  };
  const env = { hour: opts.hour !== undefined ? opts.hour : 9.5, timeMode: 'auto', rate: 24 / 600, weather: 'sunny', weatherMode: 'auto', nextChange: 120 + rnd() * 90, lastHour: -1, listeners: [] };
  const wcur = Object.assign({}, WEATHER.sunny);
  const C = (h) => new THREE.Color(h);
  const COL = { sunLow: C('#ff9a55'), sunHigh: C('#fff2dc'), skyDay: C('#e4ecff'), skyNight: C('#25325a'), skyGrey: C('#b9c0c9'), gndDay: C('#5b4a3a'), gndNight: C('#16120f'), bgDay: C('#2b2724'), bgNight: C('#0b0e16'), bgDusk: C('#4a2f35'), bgGrey: C('#34363a'), mist: C('#8f969c'), cloud: C('#ffffff'), cloudRain: C('#8d96a1'), skyDayD: C('#a9d2f2'), skyNightD: C('#0d1426'), skyDusk: C('#e9926a'), skyGreyD: C('#a3abb4') };
  const smooth = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
  function pickWeather() {
    const h = env.hour, w = { sunny: 3, fair: 3, cloudy: 2, rain: 1.6, windy: 1.5, mist: h > 4 && h < 10 ? 2.5 : 0.4 };
    delete w[env.weather];
    let tot = 0; for (const k in w) tot += w[k]; let r = rnd() * tot; for (const k in w) { r -= w[k]; if (r <= 0) return k; } return 'fair';
  }
  function emitEnv() { const e = getEnv(); env.listeners.forEach(fn => { try { fn(e); } catch (err) { console.error(err); } }); }
  function getEnv() {
    const h = env.hour, temp = Math.round(15 + 6 * Math.sin((h - 9) / 24 * Math.PI * 2) - wcur.cover * 3 - wcur.rain * 2 - wcur.wind * 1.5);
    return { hour: h, weather: env.weather, label: WEATHER[env.weather].label, temp, night: 1 - smooth(-0.05, 0.28, Math.sin((h - 6) / 12 * Math.PI)), timeMode: env.timeMode, weatherMode: env.weatherMode, rain: wcur.rain, wind: wcur.wind };
  }
  function setTimeMode(m) { env.timeMode = m; const fixed = { day: 12.5, dusk: 19.4, night: 23.5, dawn: 6.2 }[m]; if (fixed !== undefined) env.target = fixed; else env.target = undefined; emitEnv(); }
  // multi-screen play: the TV's sky is the one everybody sees. envState() is what the TV sends; followEnv() makes a
  // phone match it (it stops picking its own weather; the clock keeps running at the same rate and is nudged back in line).
  function envState() { return { hour: env.hour, timeMode: env.timeMode, target: env.target, weather: env.weather }; }
  function followEnv(e) {
    if (!e || !WEATHER[e.weather]) return;
    const changed = env.weather !== e.weather || env.timeMode !== e.timeMode;
    env.weatherMode = 'remote'; env.weather = e.weather; env.timeMode = e.timeMode; env.target = e.target;
    let d = e.hour - env.hour; if (d > 12) d -= 24; if (d < -12) d += 24;
    if (Math.abs(d) > 0.02) env.hour = ((e.hour % 24) + 24) % 24;
    if (changed) emitEnv();
  }
  function setWeather(k) { if (k === 'auto') { env.weatherMode = 'auto'; env.nextChange = 90 + rnd() * 90; } else if (WEATHER[k]) { env.weatherMode = 'fixed'; env.weather = k; } emitEnv(); }

  // clouds: soft puffs high over the board; their shadows drift across it
  const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, transparent: true, opacity: 0, depthWrite: false });
  const clouds = [];
  const cloudShadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  for (let k = 0; k < 40; k++) {
    const parts = [], n = 4 + Math.floor(rnd() * 4);
    for (let j = 0; j < n; j++) { const r = 0.35 + rnd() * 0.45, g = new THREE.IcosahedronGeometry(r, 3); g.translate((j - n / 2) * 0.42 + rnd() * 0.2, rnd() * 0.18, (rnd() - 0.5) * 0.5); parts.push(g); }
    const m = new THREE.Mesh(mergeGeometries(parts), cloudMat.clone()); m.scale.set(1.4, 0.55, 1.1);
    m.position.set(-40 + rnd() * 80, 3.6 + rnd() * 1.6, -32 + rnd() * 64); m.userData = { p: 0, order: rnd(), sp: 0.6 + rnd() * 0.6, sz: 1 + rnd() * 0.9 };
    // its shadow: a soft dark patch on the ground, offset away from the sun (works anywhere on the map)
    const sh = new THREE.Mesh(cloudShadowGeo, new THREE.MeshBasicMaterial({ map: glowTex, color: '#000000', transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6 }));
    sh.renderOrder = 3; scene.add(sh); m.userData.shadow = sh;
    m.visible = false; scene.add(m); clouds.push(m);
  }
  // rain: falling streaks
  // rain falls everywhere: the drops live in a box that travels with whatever you're looking at
  const RAIN_LITE = 900, RAIN_N = 2600, RAIN_R = 1, rainPos = new Float32Array(RAIN_N * 6), rainSeed = new Float32Array(RAIN_N * 3);
  for (let k = 0; k < RAIN_N; k++) { rainSeed[k * 3] = rnd() * 2 - 1; rainSeed[k * 3 + 1] = rnd() * 6; rainSeed[k * 3 + 2] = rnd() * 2 - 1; }
  const rainCentre = new THREE.Vector3();
  const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rainMat = new THREE.LineBasicMaterial({ color: '#d4e4f7', transparent: true, opacity: 0, depthWrite: false });
  const rain = new THREE.LineSegments(rainGeo, rainMat); rain.frustumCulled = false; rain.visible = false; scene.add(rain);
  // sky dome for the driver's view: gradient to a hazy horizon that matches the fog, plus a sun (or moon) disc
  const skyU = { top: { value: new THREE.Color('#5c9ee0') }, horizon: { value: new THREE.Color('#cfe4f5') }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color('#fff4d6') }, sunAmt: { value: 1 } };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 16), new THREE.ShaderMaterial({ uniforms: skyU, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunCol; uniform float sunAmt; varying vec3 vDir;
      void main(){ float h = max(vDir.y, 0.0); vec3 c = mix(horizon, top, pow(h, 0.55)); if (vDir.y < 0.0) c = horizon;
        float d = max(dot(normalize(vDir), normalize(sunDir)), 0.0); c += sunCol * (pow(d, 900.0) * 3.0 + pow(d, 12.0) * 0.35) * sunAmt;
        gl_FragColor = vec4(c, 1.0); }` }));
  sky.visible = false; sky.renderOrder = -1; sky.frustumCulled = false; scene.add(sky);
  const SKYC = { topDay: C('#4f8fd6'), topNight: C('#060a18'), topGrey: C('#7f8994'), horDay: C('#cde3f3'), horNight: C('#1a2440'), horDusk: C('#f2a477'), horGrey: C('#b5bcc4') };
  let envClock = 0;
  envClockRef = () => envClock;
  const _sd = new THREE.Vector3(), _origin = new THREE.Vector3();
  function stepEnv(dt) {
    envClock += dt;
    // time of day
    if (env.timeMode === 'auto') env.hour = (env.hour + dt * env.rate) % 24;
    else if (env.target !== undefined) { let d = env.target - env.hour; if (d > 12) d -= 24; if (d < -12) d += 24; env.hour = (env.hour + d * Math.min(1, dt * 1.2) + 24) % 24; }
    if (Math.floor(env.hour * 4) !== env.lastHour) { env.lastHour = Math.floor(env.hour * 4); emitEnv(); }
    // weather schedule and blending
    if (env.weatherMode === 'auto') { env.nextChange -= dt; if (env.nextChange <= 0) { env.weather = pickWeather(); env.nextChange = 110 + rnd() * 120; emitEnv(); } }
    const W = WEATHER[env.weather], kb = Math.min(1, dt * 0.35);
    for (const k of ['cover', 'dim', 'rain', 'wind', 'mist']) wcur[k] += (W[k] - wcur[k]) * kb;
    // sun & moon
    const a = (env.hour - 6) / 12 * Math.PI, sinE = Math.sin(a), day = smooth(-0.08, 0.22, sinE);
    _sd.set(Math.cos(a), Math.max(sinE, 0.06) * 1.6, 0.55).normalize();
    // in the driver's seat the shadow map hugs the car, so nearby shadows stay crisp
    const focus = driver && cars[driver.i] ? cars[driver.i].position : _origin;
    sun.position.copy(_sd).multiplyScalar(22).add(focus); sun.target.position.copy(focus); sun.target.updateMatrixWorld();
    sun.intensity = 2.5 * day * (1 - wcur.dim) * (0.5 + 0.5 * smooth(0, 0.5, sinE));
    sun.color.copy(COL.sunLow).lerp(COL.sunHigh, smooth(0.02, 0.5, sinE));
    sun.castShadow = sun.intensity > 0.05;
    moon.position.set(-Math.cos(a) * 10, Math.max(-sinE, 0.35) * 16, -6);
    moon.intensity = 0.5 * (1 - day) * (1 - wcur.dim * 0.7);
    hemi.color.copy(COL.skyNight).lerp(COL.skyDay, day).lerp(COL.skyGrey, wcur.cover * 0.35 * day);
    hemi.groundColor.copy(COL.gndNight).lerp(COL.gndDay, day);
    hemi.intensity = (0.34 + 0.21 * day) * (1 + wcur.cover * 0.3);
    fill.intensity = 0.07 + 0.43 * day * (1 - wcur.dim * 0.5);
    scene.environmentIntensity = 0.12 + 0.33 * day;
    const dusk = Math.exp(-Math.pow((sinE - 0.03) / 0.13, 2)) * 0.55 * (1 - wcur.cover * 0.6);
    // around the table it's the room; from the driver's seat it's the sky
    const bg = scene.background; // the horizon colour: sky meets the fog
    bg.copy(COL.skyNightD).lerp(COL.skyDayD, day).lerp(COL.skyDusk, dusk * 1.4).lerp(COL.skyGreyD, wcur.cover * 0.55 * day);
    bg.lerp(COL.mist.clone().multiplyScalar(0.25 + 0.75 * day), wcur.mist * 0.55);
    scene.fog.color.copy(bg);
    sky.visible = true;
    {
      sky.position.copy(camera.position);
      skyU.top.value.copy(SKYC.topNight).lerp(SKYC.topDay, day).lerp(SKYC.topGrey, wcur.cover * 0.6 * day);
      skyU.horizon.value.copy(bg);
      const moonUp = day < 0.5; skyU.sunDir.value.copy(moonUp ? moon.position : _sd).normalize();
      skyU.sunCol.value.copy(moonUp ? C('#dfe6ff') : sun.color); skyU.sunAmt.value = (moonUp ? 0.5 : 1) * (1 - wcur.cover * 0.85);
    }
    const camD = camera.position.distanceTo(controls.target); scene.fog.near = driver ? 7 - 4 * wcur.mist : Math.max(6, camD + 12 - 10 * wcur.mist); scene.fog.far = driver ? 26 - 10 * wcur.mist : camD + 55 - 25 * wcur.mist;
    renderer.toneMappingExposure = 0.92 + 0.12 * (1 - day);
    // lights after dark (and a few windows on a gloomy day)
    const night = Math.min(1, 1 - smooth(-0.05, 0.28, sinE) + wcur.dim * 0.25 * day);
    for (const [m, peak] of nightMats) m.emissiveIntensity = peak * night;
    if (bloom && bloom.enabled) { bloom.strength = 0.08 + 0.42 * night; bloom.threshold = 0.97 - 0.3 * night; }
    for (const [m, peak] of glowMats) m.opacity = peak * Math.min(1, night * 1.15);
    // wet surfaces
    for (const [m, r] of wetMats) m.roughness = r * (1 - 0.5 * wcur.rain);
    // clouds
    const wind = wcur.wind, cloudCol = COL.cloud.clone().lerp(COL.cloudRain, wcur.rain * 0.8);
    const above = camera.position.y > 4.2, sunUp = Math.min(1, sun.intensity / 2), shOff = _sd.y > 0.05 ? 1 / _sd.y : 0;
    const overPlay = (x, z) => x > wx(bx0) - 2.5 && x < wx(bx1) + 2.5 && z > wz(by0) - 2.5 && z < wz(by1) + 2.5;
    for (const m of clouds) {
      const u = m.userData, want = u.order < wcur.cover ? 1 : 0; u.p += (want - u.p) * Math.min(1, dt * 0.5);
      m.visible = u.p > 0.02 && !(liteProfile && u.liteSkip) && !opt.noOverlays; u.shadow.visible = m.visible; if (!m.visible) continue;
      const sz = u.sz || 1; m.scale.set(1.4 * u.p * sz, 0.55 * u.p * sz, 1.1 * u.p * sz);
      // from above, clouds over the play area are see-through so they never hide the game; elsewhere they're solid
      m.material.color.copy(cloudCol); const near = THREE.MathUtils.smoothstep(camera.position.distanceTo(m.position), 5 * sz, 11 * sz); // fade clouds close to the lens so they never fill the screen
      m.material.opacity = above && overPlay(m.position.x, m.position.z) ? 0 : 0.85 * Math.min(1, u.p * 1.5) * near;
      u.shadow.position.set(m.position.x - _sd.x * shOff * m.position.y, 0.06, m.position.z - _sd.z * shOff * m.position.y);
      u.shadow.scale.set(4.2 * sz * u.p, 1, 3.2 * sz * u.p); u.shadow.material.opacity = 0.32 * sunUp * u.p;
      m.position.x += dt * (0.12 + wind * 0.9) * u.sp; m.position.z += dt * 0.05 * u.sp;
      if (m.position.x > 40) { m.position.x = -40; m.position.z = -32 + rnd() * 64; } if (m.position.z > 32) m.position.z = -32;
    }
    // rain
    rain.visible = wcur.rain > 0.02 && !opt.noOverlays; rainMat.opacity = (driver ? 0.38 : 0.2) * wcur.rain;
    if (rain.visible) {
      const fall = 8.5, sx = 0.08 + wind * 0.35, len = 0.3, hs = driver ? 1 : 0.32; // from above, keep the rain low so it doesn't fog the view
      const R = driver ? 9 : Math.min(28, 8 + camera.position.distanceTo(controls.target) * 0.75);
      rainCentre.copy(driver && cars[driver.i] ? cars[driver.i].position : controls.target);
      for (let k = 0, rn = liteProfile ? RAIN_LITE : RAIN_N; k < rn; k++) {
        let y = rainSeed[k * 3 + 1] - dt * fall; let u = rainSeed[k * 3] + dt * fall * sx / R;
        if (y < 0) { y += 6; u = rnd() * 2 - 1; rainSeed[k * 3 + 2] = rnd() * 2 - 1; } if (u > 1) u -= 2;
        rainSeed[k * 3] = u; rainSeed[k * 3 + 1] = y; const x = rainCentre.x + u * R, z = rainCentre.z + rainSeed[k * 3 + 2] * R, o = k * 6, yy = y * hs;
        rainPos[o] = x; rainPos[o + 1] = yy; rainPos[o + 2] = z; rainPos[o + 3] = x - sx * len; rainPos[o + 4] = yy + len * (driver ? 1 : 0.6); rainPos[o + 5] = z;
      }
      rainGeo.attributes.position.needsUpdate = true;
    }
    stepWaves(dt, wind);
    // wind: trees lean and sway, flags stream out
    const amp = 0.012 + wind * 0.085, fr = 1.2 + wind * 1.8;
    for (const t of swayers) { const u = t.userData.sway; t.rotation.z = (Math.sin(envClock * fr + u.ph) * 0.6 - 0.4 * wind) * amp * u.k; t.rotation.x = Math.cos(envClock * fr * 0.8 + u.ph) * amp * 0.5 * u.k; }
    updateTreeInstances();
    for (const id in flags) {
      const f = flags[id]; if (!f.gp.visible) continue;
      const pos = f.cloth.geometry.attributes.position, b = f.base, wv = 0.25 + wind * 0.75;
      for (let k = 0; k < pos.count; k++) { const x = b[k * 3], tip = x / FLAG_W; pos.array[k * 3 + 2] = Math.sin(x * 26 - envClock * (5 + wind * 9) + f.ph) * (0.006 + 0.02 * wv) * tip; pos.array[k * 3 + 1] = b[k * 3 + 1] - (1 - wv) * tip * tip * 0.09; pos.array[k * 3] = x * (0.82 + 0.18 * wv); }
      pos.needsUpdate = true; f.cloth.geometry.computeVertexNormals();
    }
  }
  // An enlarged picture of one road space, cut from the road artwork.
  // Returns a canvas (asCanvas) or a PNG data URL. The game uses the canvas and encodes it with toBlob, which runs
  // off the main thread: toDataURL froze slow devices for 1-2 s on every landing.
  function spaceImage(i, size, asCanvas) {
    const per = 16, c = tileSheets[Math.floor(i / per)]; if (!c) return null;
    const k = i % per, T = c.height, out = canvas(size || T, size || T), g = out.getContext('2d');
    g.drawImage(c, k * T, 0, T, T, 0, 0, out.width, out.height);
    // the road prints the far-side hotel name upside down; redraw both hotel bands reading upright
    const sc = out.width / T, sp = S[i], f = spaceFrame(i), innerIsA = f.innerSide.dot(f.side) > 0;
    for (const side of ['inner', 'outer']) {
      const id = sp[side]; if (!id) continue;
      const y = (side === 'inner') === innerIsA ? 194 : 8;
      g.fillStyle = LAND[id]; g.fillRect(0, y * sc, out.width, 54 * sc);
      g.fillStyle = 'rgba(255,255,255,.95)'; g.font = `700 ${Math.round(26 * sc)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(board.hotels[id].name.toUpperCase(), out.width / 2, (y + 28) * sc);
    }
    return asCanvas ? out : out.toDataURL();
  }

  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2(); ray.layers.enableAll(); // merged originals live on a hidden layer
  let pickFn = null, pickSpaceFn = null, downAt = null;
  renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5 || (!pickFn && !pickSpaceFn)) return;
    const r = renderer.domElement.getBoundingClientRect(); ptr.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    scene.updateMatrixWorld();
    ray.setFromCamera(ptr, camera);
    const cands = pickables.filter(o => { let v = true; o.traverseAncestors(a => { if (a.visible === false) v = false; }); return v && o.visible; });
    const hit = ray.intersectObjects(cands, false)[0];
    if (!hit) return;
    if (hit.object.userData.isChoice) { if (pickSpaceFn) pickSpaceFn(hit.object.userData.space, hit.object.userData.hotel); }
    else if (pickFn) pickFn(hit.object.userData.hotel);
  });

  // ---------------------------------------------------------------- post-processing: tilt-shift miniature
  const TiltShift = {
    uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, amount: { value: 1.1 }, focus: { value: 0.5 }, band: { value: 0.24 }, res: { value: new THREE.Vector2(1, 1) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 dir; uniform float amount; uniform float focus; uniform float band; uniform vec2 res; varying vec2 vUv;
      void main(){ float d = max(0.0, abs(vUv.y - focus) - band); float s = amount * smoothstep(0.0, 0.3, d) * 2.2; vec2 st = dir / res * s;
        vec4 c = texture2D(tDiffuse, vUv) * 0.2270270270;
        c += (texture2D(tDiffuse, vUv + st * 1.3846153846) + texture2D(tDiffuse, vUv - st * 1.3846153846)) * 0.3162162162;
        c += (texture2D(tDiffuse, vUv + st * 3.2307692308) + texture2D(tDiffuse, vUv - st * 3.2307692308)) * 0.0702702703;
        gl_FragColor = c; }`
  };
  // phones already draw at 2-3x pixel density, where 2x multisampling looks the same as 4x for half the cost
  const FULL_SAMPLES = SMALL && (window.devicePixelRatio || 1) >= 2 ? 2 : 4;
  // high-precision buffers where the device can render to them (older iPads/Macs can't: they'd show a black screen)
  const halfOK = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: halfOK ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: FULL_SAMPLES });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  // ambient occlusion: soft contact shadows where buildings meet the ground and in corners (desktop-class GPUs)
  let gtao = null;
  const aoOK = GTAOPass && opts.quality !== 'low' && Math.min(window.innerWidth, window.innerHeight) >= 600;
  if (aoOK) {
    gtao = new GTAOPass(scene, camera, 256, 256);
    gtao.updateGtaoMaterial({ radius: 0.28, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 10, distanceFallOff: 1, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 10 });
    gtao.blendIntensity = 0.85;
    const ov = gtao.overrideVisibility.bind(gtao);
    gtao.overrideVisibility = function () { ov(); scene.traverse(o => { const m = o.material; if (m && !Array.isArray(m) && m.transparent && m.depthWrite === false) o.visible = false; if (o === fwPoints) o.visible = false; }); };
    composer.addPass(gtao);
  }
  const tsH = new ShaderPass(TiltShift), tsV = new ShaderPass(TiltShift); tsV.uniforms.dir.value.set(0, 1);
  composer.addPass(tsH); composer.addPass(tsV);
  // a soft glow on lamps, headlights and the sun's glint — only in the driver's seat, where it reads as a lens
  const bloom = UnrealBloomPass ? new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.5, 0.82) : null;
  if (bloom) { bloom.enabled = false; composer.addPass(bloom); }
  let bloomWanted = false;
  function setBloom(on) { bloomWanted = !!on; if (bloom) bloom.enabled = bloomWanted && !liteProfile; }
  // the far reaches go soft: blur grows with distance beyond the play area (uses the occlusion pass's depth)
  let farBlur = null;
  if (gtao) {
    farBlur = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, tDepth: { value: gtao.depthTexture }, near: { value: 0.1 }, far: { value: 200 }, start: { value: 20 }, end: { value: 45 }, res: { value: new THREE.Vector2(1, 1) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform float near, far, start, end; uniform vec2 res; varying vec2 vUv;
        float lin(vec2 uv){ float z = texture2D(tDepth, uv).x * 2.0 - 1.0; return 2.0 * near * far / (far + near - z * (far - near)); }
        void main(){ float d = lin(vUv); float k = smoothstep(start, end, d); vec4 c = texture2D(tDiffuse, vUv); if (k < 0.01) { gl_FragColor = c; return; }
          vec2 r = k * 7.0 / res; vec4 acc = c; float w = 1.0;
          for (int i = 0; i < 12; i++) { float a = float(i) * 2.39996; float rr = sqrt(float(i) + 0.5) / 3.5; vec2 o = vec2(cos(a), sin(a)) * rr * r; acc += texture2D(tDiffuse, vUv + o); w += 1.0; }
          gl_FragColor = acc / w; }`
    });
    composer.addPass(farBlur);
  }
  composer.addPass(new OutputPass());
  // film grade after tone mapping: a touch of contrast and warmth, and a soft vignette
  const grade = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, vig: { value: 0.22 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform float vig; varying vec2 vUv;
      void main(){ vec4 c = texture2D(tDiffuse, vUv); vec3 col = c.rgb;
        col = mix(col, col * col * (3.0 - 2.0 * col), 0.18);            // gentle S-curve
        float l = dot(col, vec3(0.299, 0.587, 0.114)); col = mix(vec3(l), col, 1.08); // a little more colour
        col *= vec3(1.015, 1.0, 0.98);                                    // warm
        vec2 d = vUv - 0.5; col *= 1.0 - vig * smoothstep(0.35, 0.85, length(d * vec2(1.25, 1.0)));
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a); }`
  });
  composer.addPass(grade);
  // ---------------------------------------------------------------- performance governor
  // 'auto' (default) starts sharp and lowers the drawing resolution in small steps if frames run slow, creeping back
  // up when there's headroom; 'high' holds full resolution; 'low' is the light mode. In every mode the scene is only
  // drawn at 30 fps while nothing is moving (waves and clouds don't need 60), and the sun's shadow map is only
  // redrawn when something that casts a shadow moves.
  const DPR = window.devicePixelRatio || 1;
  const perf = { mode: 'auto', max: Math.min(DPR, 2), min: 0.75, pr: Math.min(DPR, 2), ceil: Math.min(DPR, 2), ceilAt: 0,
    win: 0, n: 0, slow: 0, fast: 0, roomy: 0, upgraded: false, lastDraw: 0, lastShadow: -1, busyUntil: 0, lite: false, liteAt: 0, cb: null, fps: 0, fpsN: 0, fpsT: 0,
    camP: new THREE.Vector3(), camQ: new THREE.Quaternion() };
  const notify = () => { if (perf.cb) perf.cb({ lite: perf.lite, profile: liteProfile ? 'lite' : 'full', tier, opts: Object.assign({}, opt), pr: perf.pr, mode: perf.mode }); };
  function setSamples() {
    const want = liteProfile ? (renderer.getPixelRatio() >= 1.5 ? 0 : 2) : FULL_SAMPLES;
    for (const t of [composer.renderTarget1, composer.renderTarget2]) if (t && t.samples !== want) { t.samples = want; t.dispose(); }
  }
  function setPR(pr) {
    pr = Math.max(perf.min, Math.min(perf.max, Math.round(pr * 4) / 4)); if (Math.abs(pr - renderer.getPixelRatio()) < 0.01) return;
    perf.pr = pr; renderer.setPixelRatio(pr); composer.setPixelRatio(pr); lastSize = ''; resize(); setSamples(); renderer.shadowMap.needsUpdate = true; notify();
  }
  function setLite(on) { if (perf.lite === on) return; perf.lite = on; perf.liteAt = performance.now(); notify(); }

  // The lite profile for older tablets and laptops: same board and pieces, cheaper finish.
  //  - glossy clear-coat off (pieces look a touch more matte)   - 1024 shadow map with plain (not soft) edges
  //  - less multisampling at high pixel density                  - no ambient occlusion, distance blur or glow pass
  //  - the biggest textures (board print, sand) at half size     - 15 clouds instead of 40, 900 raindrops, smaller firework bursts
  const _saved = { coat: new Map(), tex: new Map() };
  function halveTex(t, lite) {
    if (lite) {
      const img = t.image; if (_saved.tex.has(t) || !img || !(img instanceof HTMLCanvasElement) || img.width < 2048 || img.height < 1024) return;
      const c = canvas(img.width >> 1, img.height >> 1); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      _saved.tex.set(t, img); t.image = c; t.needsUpdate = true;
    } else if (_saved.tex.has(t)) { t.image = _saved.tex.get(t); _saved.tex.delete(t); t.needsUpdate = true; }
  }
  function applyProfile(lite) {
    lite = !!lite; if (liteProfile === lite) return; liteProfile = lite;
    const mats = new Set(); scene.traverse(o => { const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach(x => mats.add(x)); });
    for (const m of mats) {
      if (m.isMeshPhysicalMaterial) {
        if (lite) { if (m.clearcoat > 0) { _saved.coat.set(m, m.clearcoat); m.clearcoat = 0; } }
        else if (_saved.coat.has(m)) m.clearcoat = _saved.coat.get(m);
      }
      for (const key of ['map', 'roughnessMap', 'bumpMap', 'normalMap', 'emissiveMap']) if (m[key] && m[key].isTexture) halveTex(m[key], lite);
    }
    if (!lite) _saved.coat.clear();
    const want = lite ? 1024 : SHADOW_FULL;
    if (sun.shadow.mapSize.x !== want) { sun.shadow.mapSize.setScalar(want); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
    renderer.shadowMap.type = lite ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap; renderer.shadowMap.needsUpdate = true;
    clouds.forEach((m, i) => { m.userData.liteSkip = i % 8 >= 3; });
    rainGeo.setDrawRange(0, (lite ? RAIN_LITE : RAIN_N) * 2);
    if (gtao) gtao.enabled = !lite;
    if (bloom) bloom.enabled = !lite && bloomWanted;
    setSamples(); notify();
  }
  // ---------------------------------------------------------------- tiers and individual performance switches
  // full: everything.  lite: see applyProfile.  low: lite plus simple shading, painted shadows, no see-through effects
  // (clouds, rain, glows, foam), no post-processing, 30 fps and merged scenery. Each switch can also be flipped on its own.
  const opt = { simple: false, blobs: false, noOverlays: false, noPost: false, cap30: false, merge: false };
  let tier = 'full';
  const TIERS = { full: { lite: false, simple: false, blobs: false, noOverlays: false, noPost: false, cap30: false, merge: true },
    lite: { lite: true, simple: false, blobs: false, noOverlays: false, noPost: false, cap30: false, merge: true },
    low: { lite: true, simple: true, blobs: true, noOverlays: true, noPost: true, cap30: true, merge: true } };
  function setTier(t) { tier = TIERS[t] ? t : 'full'; setOptions(TIERS[tier], true); }
  function setOptions(o, fromTier) {
    if (!fromTier) { tier = 'custom'; perf.mode = 'custom'; }
    if ('lite' in o) applyProfile(o.lite);
    if ('simple' in o && !!o.simple !== opt.simple) {
      opt.simple = !!o.simple;
      if (opt.simple && renderer.compileAsync) { const want = ++simpleGen; prepareSimple().then(() => { if (want === simpleGen && opt.simple) applySimple(true); }); }
      else { simpleGen++; applySimple(opt.simple); }
    }
    if ('blobs' in o && !!o.blobs !== opt.blobs) { opt.blobs = !!o.blobs; applyBlobs(opt.blobs); }
    if ('noOverlays' in o && !!o.noOverlays !== opt.noOverlays) { opt.noOverlays = !!o.noOverlays; applyOverlays(); }
    if ('noPost' in o) { opt.noPost = !!o.noPost; vignette.style.display = opt.noPost ? 'block' : 'none'; }
    if ('cap30' in o) opt.cap30 = !!o.cap30;
    if ('merge' in o && !!o.merge !== opt.merge) { opt.merge = !!o.merge; if (opt.merge) mergeStatic(); else unmergeAll(); }
    perf.slow = perf.fast = 0; renderer.shadowMap.needsUpdate = true; notify();
  }
  // a CSS vignette stands in for the colour-grade pass when post-processing is off (costs nothing)
  const vignette = document.createElement('div');
  Object.assign(vignette.style, { position: 'absolute', inset: '0', pointerEvents: 'none', display: 'none', background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,.22) 100%)' });
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(vignette);

  // simple shading: Lambert (matte) or Phong (glossy) copies of the physically based materials. Colours and textures are
  // shared with the originals, so owner colours etc. still follow; fading values are copied across every frame.
  const simpleOf = new Map(), origOf = new Map();
  function simpleFor(m) {
    let n = simpleOf.get(m); if (n) return n;
    const P = { map: m.map, emissiveMap: m.emissiveMap, emissiveIntensity: m.emissiveIntensity, bumpMap: m.bumpMap, bumpScale: m.bumpScale, normalMap: m.normalMap,
      transparent: m.transparent, opacity: m.opacity, side: m.side, depthWrite: m.depthWrite, depthTest: m.depthTest, alphaTest: m.alphaTest, alphaMap: m.alphaMap,
      vertexColors: m.vertexColors, blending: m.blending, polygonOffset: m.polygonOffset, polygonOffsetFactor: m.polygonOffsetFactor, polygonOffsetUnits: m.polygonOffsetUnits,
      fog: m.fog, flatShading: m.flatShading, visible: m.visible, toneMapped: m.toneMapped };
    for (const k in P) if (P[k] === undefined || P[k] === null) delete P[k];
    const glossy = m.roughness < 0.3;
    n = glossy ? new THREE.MeshPhongMaterial(Object.assign(P, { shininess: 40 + (0.3 - m.roughness) * 220, specular: new THREE.Color(0x2a2a2a) })) : new THREE.MeshLambertMaterial(P);
    n.color = m.color; n.emissive = m.emissive; if (m.normalMap) n.normalScale = m.normalScale;
    if (Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile')) n.onBeforeCompile = m.onBeforeCompile;
    simpleOf.set(m, n); origOf.set(n, m); return n;
  }
  function swapMat(m, on) {
    if (on) return m && m.isMeshStandardMaterial ? simpleFor(m) : m;
    return origOf.get(m) || m;
  }
  function applySimple(on) {
    scene.traverse(o => { if (!(o.isMesh || o.isInstancedMesh) || !o.material || o.userData.noSimple) return;
      o.material = Array.isArray(o.material) ? o.material.map(m => swapMat(m, on)) : swapMat(o.material, on); });
  }
  // the simple materials don't receive the soft sky reflection lighting, so an ambient light stands in for it
  const simpleAmb = new THREE.AmbientLight('#eef2ff', 0); scene.add(simpleAmb);
  let SIMPLE_AMB = 6.5;
  // build the simple materials and compile them off-screen, so switching to them doesn't stall a frame
  let simpleGen = 0;
  function prepareSimple() {
    const tmp = new THREE.Scene(), g = new THREE.BoxGeometry(0.01, 0.01, 0.01), seen = new Set();
    scene.traverse(o => { if (!(o.isMesh || o.isInstancedMesh) || !o.material || o.userData.noSimple) return;
      for (const m of [].concat(o.material)) if (m.isMeshStandardMaterial && !seen.has(m)) { seen.add(m); tmp.add(new THREE.Mesh(g, simpleFor(m))); } });
    return renderer.compileAsync(tmp, camera, scene).catch(() => {}).then(() => g.dispose());
  }
  function syncSimple() { simpleAmb.intensity = SIMPLE_AMB * scene.environmentIntensity; for (const [m, n] of simpleOf) { n.opacity = m.opacity; n.emissiveIntensity = m.emissiveIntensity; n.visible = m.visible; n.transparent = m.transparent; } }

  // painted shadows: a soft dark disc under each building, car and tree; the real-time shadow map is switched off
  let blobs = null;
  const chainVisible = o => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
  function buildBlobs() {
    blobs = []; scene.updateMatrixWorld(true);
    const box = new THREE.Box3(), c = new THREE.Vector3(), sz = new THREE.Vector3();
    for (const id in hotels) for (const obj of hotels[id].pieces) {
      box.makeEmpty(); box.expandByObject(obj); if (box.isEmpty()) continue; box.getCenter(c); box.getSize(sz); if (sz.y < 0.08) continue;
      const m = new THREE.Mesh(blobGeo, blobMat); m.userData.noSimple = true; m.renderOrder = 1;
      m.position.set(c.x + Math.min(0.25, sz.y * 0.12), box.min.y + 0.006, c.z + Math.min(0.2, sz.y * 0.09)); m.scale.set(sz.x * 1.3 + 0.1, 1, sz.z * 1.3 + 0.1);
      scene.add(m); blobs.push({ m, obj });
    }
    for (const car of cars) {
      const r = car.rotation.y; car.rotation.y = 0; car.updateMatrixWorld(true); box.makeEmpty(); box.expandByObject(car); car.rotation.y = r; car.updateMatrixWorld(true);
      box.getSize(sz); const m = new THREE.Mesh(blobGeo, blobMat); m.userData.noSimple = true; m.renderOrder = 1;
      m.position.set(0, box.min.y - car.position.y + 0.004, 0); m.scale.set(sz.x * 1.25, 1, sz.z * 1.25); car.add(m); blobs.push({ m, obj: car });
    }
  }
  function applyBlobs(on) {
    if (on && !blobs) buildBlobs();
    renderer.shadowMap.enabled = !on;
    scene.traverse(o => { const ms = o.material; if (ms) [].concat(ms).forEach(m => { m.needsUpdate = true; }); });
    if (treeParts.blob.mesh) treeParts.blob.mesh.visible = on;
    for (const b of blobs || []) b.m.visible = on && chainVisible(b.obj);
  }

  // no see-through extras: clouds and their shadows, rain, glow halos, wave lines and shore foam
  function applyOverlays() {
    const hide = opt.noOverlays;
    for (const [m] of glowMats) m.visible = !hide;
    for (const w of waves) w.visible = !hide; shoreFoam.visible = !hide;
    if (hide) { for (const m of clouds) { m.visible = false; m.userData.shadow.visible = false; } rain.visible = false; }
  }

  // merged scenery: static meshes that share a material are combined into one, so the browser issues far fewer
  // draw calls. Originals stay in the scene (moved to a hidden layer); if any of them moves or is shown/hidden,
  // its batch is undone automatically.
  const HIDE_LAYER = 30;
  var hotelBatches = {}, hotelDirty = new Set();
  let merged = [];
  function mergeStatic() {
    unmergeAll(); scene.updateMatrixWorld(true);
    const skip = new Set([...cars, ...clouds, ...waves, shoreFoam, rain, fwPoints, ...choices, ...pickables, ...treeGroups]);
    for (const id in hotels) { hotels[id].pieces.forEach(o => skip.add(o)); if (hotels[id].grounds) skip.add(hotels[id].grounds.group); }
    for (const id in flags) skip.add(flags[id].gp);
    for (const b of blobs || []) skip.add(b.m);
    const skipped = o => { for (let p = o; p; p = p.parent) if (skip.has(p)) return true; return false; };
    const groups = groupMeshes([scene], skipped);
    for (const list of groups.values()) { const b = makeBatch(list); if (b) merged.push(b); }
    for (const id in hotels) hotelDirty.add(id);
  }
  // Entries are { o: original mesh, mat, geo }. Meshes with several materials (allowed when splitMulti) are split
  // into one entry per material so each piece can join the batch for its material.
  function groupMeshes(roots, skipped, splitMulti) {
    const groups = new Map();
    const add = (o, m, geo) => {
      if (m.transparent) return;
      const attrs = Object.keys(geo.attributes).sort().map(k => k + geo.attributes[k].itemSize + (geo.attributes[k].array.constructor.name)).join(',');
      const key = m.uuid + '|' + attrs + '|' + (geo.index ? 'i' : 'n') + '|' + o.castShadow + o.receiveShadow + '|' + o.renderOrder;
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ o, mat: m, geo });
    };
    for (const r of roots) r.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.userData.merged || o.layers.mask !== 1) return;
      const g = o.geometry; if (!g || !g.attributes.position || Object.keys(g.morphAttributes).length) return;
      if (!chainVisible(o) || (skipped && skipped(o))) return;
      if (!Array.isArray(o.material)) return add(o, o.material, g);
      if (!splitMulti || !g.groups.length || o.material.some(m => m.transparent)) return;
      const src = g.index ? g : null; if (!src) return;
      for (const gr of g.groups) {
        const m = o.material[gr.materialIndex]; if (!m) continue;
        const part = new THREE.BufferGeometry(); for (const k in g.attributes) part.setAttribute(k, g.attributes[k]);
        part.setIndex(Array.from(g.index.array.slice(gr.start, gr.start + gr.count))); add(o, m, part);
      }
    });
    return groups;
  }
  function makeBatch(list, hotel) {
    // a lone ordinary mesh gains nothing from merging; a lone split part must still be merged, or the faces it carries would vanish
    if (list.length < 2 && !(list.length === 1 && list[0].geo !== list[0].o.geometry)) return null;
    const geos = list.map(e => { const c = e.geo.clone(); c.applyMatrix4(e.o.matrixWorld); return c; });
    const mg = mergeGeometries(geos, false); geos.forEach(g => g.dispose()); if (!mg) return null;
    const f = list[0].o, mesh = new THREE.Mesh(mg, list[0].mat); mesh.castShadow = f.castShadow; mesh.receiveShadow = f.receiveShadow; mesh.renderOrder = f.renderOrder;
    mesh.matrixAutoUpdate = false; mesh.userData.merged = true; scene.add(mesh);
    const uniq = [...new Set(list.map(e => e.o))];
    const originals = uniq.map(o => { o.layers.set(HIDE_LAYER); o.updateMatrix(); o.matrixAutoUpdate = false;
      return { o, parent: o.parent, pw: o.parent ? o.parent.matrixWorld.clone() : null, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }; });
    return { mesh, originals, hotel, mat: origOf.get(list[0].mat) || list[0].mat };
  }
  // Finished hotels are merged too (they are the bulk of the late-game scene). A hotel is unmerged the moment
  // setHotel touches it, and merged again once its building or demolition animation has finished.
  function mergeHotel(id) {
    unmergeHotel(id); const h = hotels[id];
    const roots = h.pieces.filter(o => o.visible); if (h.grounds && h.grounds.group.visible) roots.push(h.grounds.group);
    roots.forEach(r => r.updateMatrixWorld(true));
    const bs = []; for (const list of groupMeshes(roots, null, true).values()) { const b = makeBatch(list, id); if (b) { merged.push(b); bs.push(b); } }
    hotelBatches[id] = bs;
  }
  function unmergeHotel(id) {
    const bs = hotelBatches[id]; if (!bs) return; delete hotelBatches[id];
    for (const b of bs) { const i = merged.indexOf(b); if (i >= 0) { merged.splice(i, 1); unmergeBatch(b); } }
  }
  function stepHotelMerge() {
    if (!opt.merge || !hotelDirty.size) return;
    const busy = new Set(); for (const a of anims) { const o = a.obj || a.g; if (o && o.userData && o.userData.hotel) busy.add(o.userData.hotel); if (a.kind === 'build' || a.kind === 'sprout') busy.add('*'); }
    if (busy.has('*')) return;
    for (const id of hotelDirty) { if (busy.has(id)) continue; hotelDirty.delete(id); mergeHotel(id); break; } // one hotel per tick spreads the work
  }
  function unmergeBatch(b) { scene.remove(b.mesh); b.mesh.geometry.dispose(); for (const r of b.originals) { r.o.layers.set(0); r.o.matrixAutoUpdate = true; r.o.updateMatrixWorld(true); } }
  function unmergeAll() { merged.forEach(unmergeBatch); merged = []; for (const id in hotelBatches) delete hotelBatches[id]; for (const id in hotels) hotelDirty.add(id); }
  function checkMerged() {
    merged = merged.filter(b => {
      for (const r of b.originals) { const o = r.o;
        if (o.parent !== r.parent || !chainVisible(o) || !o.position.equals(r.p) || !o.quaternion.equals(r.q) || !o.scale.equals(r.s) || (r.pw && !o.parent.matrixWorld.equals(r.pw))) {
          unmergeBatch(b); if (b.hotel) { const id = b.hotel; setTimeout(() => { unmergeHotel(id); hotelDirty.add(id); }, 0); } return false; } }
      b.mesh.material = opt.simple && b.mat.isMeshStandardMaterial ? simpleFor(b.mat) : b.mat; // follows simple-shading swaps
      return true;
    });
  }
  // Auto-freeze: scenery that existed when the board was built and hasn't moved for a second stops having its matrix
  // rebuilt every frame. Every half second each one is checked; the moment one moves it is unfrozen for good.
  // Cars, trees, clouds, waves, flags, fireworks, the hotel stages (handled by setHotel) and lights are never frozen.
  let watch = null;
  function initAutoFreeze() {
    const skip = new Set([...cars, ...clouds, ...waves, shoreFoam, rain, fwPoints, ...treeGroups, sun, sun.target, moon, fill, hemi, camera]);
    for (const id in hotels) { hotels[id].pieces.forEach(o => skip.add(o)); if (hotels[id].grounds) skip.add(hotels[id].grounds.group); }
    for (const id in flags) skip.add(flags[id].gp);
    watch = [];
    const visit = o => { if (skip.has(o) || o.isLight || o.isCamera) return; if (o !== scene && o.matrixAutoUpdate) watch.push({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(), still: 0 }); o.children.forEach(visit); };
    visit(scene);
  }
  function stepAutoFreeze() {
    if (!watch) return;
    watch = watch.filter(w => {
      const o = w.o, same = o.position.equals(w.p) && o.quaternion.equals(w.q) && o.scale.equals(w.s);
      if (!o.matrixAutoUpdate) { // frozen: thaw for good if anything changed
        if (!same) { o.matrixAutoUpdate = true; o.updateMatrixWorld(true); return false; }
        return true;
      }
      if (same) { if (++w.still >= 2) { o.updateMatrix(); o.matrixAutoUpdate = false; } }
      else { w.p.copy(o.position); w.q.copy(o.quaternion); w.s.copy(o.scale); w.still = 0; }
      return true;
    });
  }
  let lastUpkeep = 0, lastScan = 0;
  function labUpkeep(now) {
    if (!opt.simple) simpleAmb.intensity = 0;
    if (opt.simple) { syncSimple(); if (now - lastScan > 2000) { lastScan = now; applySimple(true); } }
    if (opt.blobs && blobs) for (const b of blobs) b.m.visible = chainVisible(b.obj);
    if (opt.noOverlays) for (const [m] of glowMats) m.visible = false;
    if (now - lastUpkeep > 500) { lastUpkeep = now; if (merged.length) checkMerged(); stepAutoFreeze(); stepHotelMerge(); }
  }

  function setQuality(q, o) {
    o = o || {};
    if (q === 'custom') { perf.mode = 'custom'; notify(); return; }
    perf.mode = q === 'auto' ? 'auto' : 'fixed';
    const t = q === 'auto' ? (TIERS[o.tier] ? o.tier : 'full') : q === 'high' ? 'full' : q === 'lite' ? 'lite' : q === 'low' ? 'low' : 'full';
    grade.enabled = true;
    perf.max = t === 'low' && q !== 'auto' ? Math.min(DPR, 1.25) : t === 'lite' && q !== 'auto' ? Math.min(DPR, 1.5) : Math.min(DPR, 2);
    setTier(t);
    if (gtao) gtao.enabled = !liteProfile;
    perf.ceil = perf.max; perf.slow = perf.fast = 0;
    setPR(perf.max); setLite(false); notify();
  }
  function setSharpness(v) {
    if (v === 'auto') { perf.mode = 'auto'; perf.max = Math.min(DPR, 2); perf.ceil = perf.max; setPR(perf.max); }
    else { perf.mode = 'custom'; const pr = Math.max(0.5, Math.min(2, +v)); perf.max = pr; perf.min = Math.min(0.75, pr); perf.ceil = pr; setPR(pr); perf.min = 0.75; }
    notify();
  }
  // something on screen is moving: cars, building work, camera flights, fireworks, or the player steering the view
  function busyNow() {
    if (anims.length || fwLive > 0 || fwQueue.length) return true;
    for (const m of cars) if (m.userData.driving) return true;
    const moved = camera.position.distanceToSquared(perf.camP) > 1e-8 || 1 - Math.abs(camera.quaternion.dot(perf.camQ)) > 1e-9;
    perf.camP.copy(camera.position); perf.camQ.copy(camera.quaternion);
    return moved;
  }
  // Auto mode, when frames run slow: sharpness down to 1.5x (barely visible on dense screens), then the lite profile,
  // then sharpness down to 1x, then plain panels instead of frosted glass, then (on 1x screens) a little below 1x.
  function govern(now, ms, busy) {
    if (perf.mode !== 'auto' || !busy || ms > 250) return; // only judge frames that should be smooth; ignore one-off hitches
    perf.win += ms; perf.n++;
    if (perf.win < 1500) return;
    const avg = perf.win / perf.n; perf.win = 0; perf.n = 0;
    if (now - perf.ceilAt > 180000) perf.ceil = perf.max; // give the top level another chance every few minutes
    const step = () => { perf.ceil = perf.pr - 0.25; perf.ceilAt = now; setPR(perf.pr - 0.25); };
    const target = opt.cap30 ? 33.4 : 16.7;
    if (avg > target * 1.38) { perf.fast = 0; if (++perf.slow >= 2) { perf.slow = 0;
        if (perf.pr > 1.5 + 0.01) step();
        else if (tier === 'full') setTier('lite');
        else if (perf.pr > 1 + 0.01) step();
        else if (tier === 'lite') setTier('low');
        else if (!perf.lite) setLite(true);
        else if (perf.pr > perf.min + 0.01) step(); } }
    else if (avg < target * 1.08) {
      // lots of headroom for a sustained spell (about 18 s of moving frames): try the next richer look, once per session
      if (avg < target * 0.6 && tier !== 'full' && tier !== 'custom' && !perf.upgraded && perf.pr >= perf.ceil - 0.01) { if (++perf.roomy >= 12) { perf.roomy = 0; perf.upgraded = true; setTier(tier === 'low' ? 'lite' : 'full'); return; } }
      else perf.roomy = 0;
      perf.slow = 0; if (++perf.fast >= 4) { perf.fast = 0;
        if (perf.pr < Math.min(1, perf.ceil) - 0.01) setPR(perf.pr + 0.25);
        else if (perf.lite && now - perf.liteAt > 60000) setLite(false);
        else if (perf.pr < perf.ceil - 0.01) setPR(perf.pr + 0.25); } }
    else { perf.slow = 0; perf.fast = 0; }
  }
  let tilt = opts.tiltShift !== false;
  function setTiltShift(on) { tilt = !!on; tsH.enabled = tsV.enabled = tilt; }
  setTiltShift(tilt);

  // ---------------------------------------------------------------- resize and loop
  let insetLeft = 0;
  let lastSize = '';
  function resize() {
    const w = container.clientWidth || 800, h = container.clientHeight || 600;
    if (insetLeft > 0 && w > 720) camera.setViewOffset(w + insetLeft, h, 0, 0, w, h); else camera.clearViewOffset();
    const key = w + 'x' + h + '@' + renderer.getPixelRatio();
    if (key !== lastSize) { lastSize = key; renderer.setSize(w, h, false); composer.setSize(w, h); }
    if (gtao) { const ap = Math.min(renderer.getPixelRatio(), 1.25); gtao.setSize(Math.round(w * ap), Math.round(h * ap)); } if (farBlur) farBlur.uniforms.res.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    const pr = renderer.getPixelRatio(); tsH.uniforms.res.value.set(w * pr, h * pr); tsV.uniforms.res.value.set(w * pr, h * pr);
    const off = insetLeft > 0 && w > 720 ? insetLeft : 0;
    camera.aspect = (w + off) / h; camera.fov = driver ? (w / h < 0.85 ? 72 : 58) : (w / h < 0.85 ? 50 : w / h < 1.2 ? 40 : 32); camera.near = driver ? 0.02 : 0.1; camera.updateProjectionMatrix();
    renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
  }
  new ResizeObserver(resize).observe(container); resize();
  const clock = new THREE.Clock();
  let running = true;
  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    now = now || performance.now();
    // idle: hold to ~30 fps (the next frame after any input or motion is drawn straight away)
    if ((opt.cap30 || now > perf.busyUntil) && now - perf.lastDraw < 31) return;
    const ms = now - perf.lastDraw; perf.lastDraw = now; perf.lastMs = ms;
    perf.fpsN++; if (now - perf.fpsT >= 1000) { perf.fps = Math.round(perf.fpsN * 1000 / (now - perf.fpsT)); perf.fpsN = 0; perf.fpsT = now; }
    const dt = Math.min(0.1, clock.getDelta());
    simulate(dt);
    const wasBusy = perf.lastDraw - ms <= perf.busyUntil; // the previous frame was a full-rate one too, so ms is a true frame time
    const busy = busyNow(); if (busy) perf.busyUntil = now + 400;
    // shadows: every frame while things move, otherwise ~8 times a second (the sun and the trees drift slowly)
    const shadowMovers = anims.length > 0 || cars.some(m => m.userData.driving);
    if (shadowMovers || now - perf.lastShadow > 125 || perf.lastShadow < 0) { renderer.shadowMap.needsUpdate = true; perf.lastShadow = now; }
    labUpkeep(now);
    if (opt.noPost) { renderer.setRenderTarget(null); renderer.render(scene, camera); } else composer.render(dt);
    govern(now, ms, busy && wasBusy);
  }
  // Phones and tablets can drop the 3D context (switching apps, low memory). Ask for it back, pause meanwhile, resume after.
  let lostCb = null;
  renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); running = false; if (lostCb) lostCb(true); }, false);
  renderer.domElement.addEventListener('webglcontextrestored', () => { running = true; lastSize = ''; resize(); renderer.shadowMap.needsUpdate = true; requestAnimationFrame(frame); if (lostCb) lostCb(false); }, false);
  // any touch, drag or wheel on the board wakes the loop to full rate at once
  for (const evn of ['pointerdown', 'pointermove', 'wheel', 'touchstart']) renderer.domElement.addEventListener(evn, e => { if (evn === 'pointermove' && !e.buttons) return; perf.busyUntil = performance.now() + 600; }, { passive: true });
  document.addEventListener('visibilitychange', () => { clock.getDelta(); perf.win = 0; perf.n = 0; });
  function simulate(dt) {
    stepAnims(dt);
    stepCars(dt);
    stepEnv(dt);
    stepFireworks(dt);
    if (farBlur) { const u = farBlur.uniforms, d = camera.position.distanceTo(controls.target); u.near.value = camera.near; u.far.value = camera.far; u.start.value = driver ? 9 : d + 12; u.end.value = driver ? 22 : d + 36; farBlur.enabled = !!(gtao && gtao.enabled); }
    if (bloom) { const fwOn = fwLive > 0 || fwQueue.length > 0; bloom.enabled = !liteProfile && (bloomWanted || fwOn); if (fwOn && !bloomWanted) { bloom.strength = 0.6; bloom.threshold = 1.6; bloom.radius = 0.35; } }
    waterNormal.offset.x += dt * (0.02 + wcur.wind * 0.03); waterNormal.offset.y += dt * 0.013;
    if (driver && !cutaway) stepDriverCam(dt);
    else if (cutaway) camera.lookAt(controls.target);
    else {
      stepFollow(dt);
      controls.update();
      // keep the camera over the board
      controls.target.x = Math.max(-8.5, Math.min(8.5, controls.target.x)); controls.target.z = Math.max(-7, Math.min(7, controls.target.z)); controls.target.y = Math.max(0, Math.min(2, controls.target.y));
      if (camera.position.y < 0.6) camera.position.y = 0.6;
    }
  }
  updateTreeInstances();
  scene.updateMatrixWorld(true);
  initAutoFreeze();
  scene.updateMatrix(); scene.matrixAutoUpdate = false; // the scene root never moves, so it needn't force a rebuild of everything below it
  for (const id in hotels) { for (const o of hotels[id].pieces) if (!o.visible) freeze(o); const g = hotels[id].grounds; if (g && !g.group.visible) freeze(g.group); }
  // Compile every shader in the background (parallel where the browser supports it) before drawing the first frame,
  // instead of freezing the page while the first frame compiles them all. setQuality runs before this starts.
  let readyResolve; const ready = new Promise(r => { readyResolve = r; });
  setTimeout(() => {
    const go = () => { if (!started) { started = true; requestAnimationFrame(frame); } readyResolve(); };
    let started = false;
    try { (renderer.compileAsync ? renderer.compileAsync(scene, camera) : Promise.resolve()).then(go, go); } catch (e) { go(); }
    setTimeout(go, 12000); // never wait forever
  }, 0);

  // first framing of the whole board
  { const v = homeView(); camera.position.copy(v.pos); controls.target.copy(v.target); controls.update(); }

  return {
    _cars: cars, fireworks, onSound(fn) { soundCb = fn; }, camDistance: () => camera.position.distanceTo(controls.target), isCutaway: () => cutaway, setQuality, _fwLive: () => fwLive,
    setHotel, setEntrance, moveCar, flyTo, setTiltShift, entranceSide,
    setOwner, saleSign, spaceImage, zoomBy, setDriverView, isDriverView: () => !!driver,
    showcase,
    setSafeArea(a) { safe = Object.assign({ top: 0, right: 0, bottom: 0, left: 0 }, a); },
    setDriveSpeed(k) { driveSpeed = k; },
    _govern(ms, secs, t0) { let t = t0 || performance.now(); const end = t + secs * 1000; while (t < end) { t += ms; govern(t, ms, true); } return { pr: perf.pr, lite: perf.lite, ceil: perf.ceil }; }, // test hook
    _advance(sec) { for (let t = 0; t < sec; t += 1 / 30) simulate(1 / 30); }, // test hook: run the world forward without drawing
    onPerf(fn) { perf.cb = fn; notify(); }, ready, onContextLost(fn) { lostCb = fn; }, perfState: () => ({ mode: perf.mode, tier, profile: liteProfile ? 'lite' : 'full', pr: perf.pr, lite: perf.lite, ceil: perf.ceil, fps: perf.fps, idle: performance.now() > perf.busyUntil, n: perf.n, slow: perf.slow, fast: perf.fast, last: Math.round(perf.lastMs || 0) }),
    _applyProfile: applyProfile, setOptions, setSharpness, setTier, getOptions: () => Object.assign({ lite: liteProfile }, opt), _merged: () => merged.length, _ambK(k) { SIMPLE_AMB = k; }, _upkeep() { labUpkeep(performance.now()); }, _profileFrame() { const t0 = performance.now(); simulate(1 / 30); const t1 = performance.now(); labUpkeep(t1); busyNow(); const t2 = performance.now(); if (opt.noPost) { renderer.setRenderTarget(null); renderer.render(scene, camera); } else composer.render(1 / 30); const t3 = performance.now(); return { sim: t1 - t0, upkeep: t2 - t1, render: t3 - t2 }; }, _composer: composer, _renderOnce() { if (opt.noPost) { renderer.setRenderTarget(null); renderer.render(scene, camera); } else composer.render(0.016); },
    getEnv, setTimeMode, setWeather, envState, followEnv, onEnv(fn) { env.listeners.push(fn); fn(getEnv()); },
    setInsetLeft(px) { insetLeft = px; resize(); },
    setCar(i, v) { if (cars[i]) cars[i].visible = !!v; },
    onPick(fn) { pickFn = fn; },
    onPickSpace(fn) { pickSpaceFn = fn; },
    showEntranceChoices, clearEntranceChoices,
    hotelState: id => ({ built: hotels[id].built, facilities: hotels[id].facilities }),
    renderer, scene, camera, controls,
    dispose() { running = false; renderer.dispose(); }
  };
}
if (typeof module !== 'undefined') module.exports = createBoard3D;
