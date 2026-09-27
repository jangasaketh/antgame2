// ---------------------------------------------------------------------------
// models.js — every mesh is generated in code, no external art.
//
// The ant is built the way a real one is put together: head, alitrunk, a
// petiole node, then a gaster of overlapping plates. Chitin gets a clearcoat
// so it catches light the way the reference photograph does.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

const texCache = new Map();

export function soilTexture(base, speck, size = 256, blobs = 1100) {
  const key = `${base}|${speck}|${size}|${blobs}`;
  if (texCache.has(key)) return texCache.get(key);

  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < blobs; i++) {
    g.globalAlpha = 0.06 + Math.random() * 0.3;
    g.fillStyle = Math.random() > 0.42 ? speck : base;
    g.beginPath();
    g.arc(Math.random() * size, Math.random() * size, 0.8 + Math.random() * 7, 0, Math.PI * 2);
    g.fill();
  }
  // scattered grit specks so soil reads as grains up close
  for (let i = 0; i < blobs / 3; i++) {
    g.globalAlpha = 0.25 + Math.random() * 0.5;
    g.fillStyle = Math.random() > 0.5 ? '#0d0803' : '#b09468';
    g.fillRect(Math.random() * size, Math.random() * size, 1.4, 1.4);
  }
  g.globalAlpha = 1;

  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

function chitin(color, opts = {}) {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: opts.roughness ?? 0.46,
    metalness: opts.metalness ?? 0.06,
    clearcoat: opts.clearcoat ?? 0.55,
    clearcoatRoughness: opts.ccRough ?? 0.3,
    sheen: 0.25,
    sheenColor: new THREE.Color(0x6a3e22),
  });
}

/**
 * Revolve a silhouette into a single smooth body part. Overlapping spheres
 * always show their seams; a lathe gives one continuous surface, which is how
 * you get a gaster that tapers instead of a row of beads.
 * `profile` is [[along, radius], ...] running from the part's base to its tip.
 */
function lathe(mat, profile, segments, axis = 'back') {
  const pts = profile.map(([a, r]) => new THREE.Vector2(Math.max(r, 0.0001), a));
  const geo = new THREE.LatheGeometry(pts, segments);
  // the profile runs along Y; tip it so it runs along Z instead
  geo.rotateX(axis === 'back' ? -Math.PI / 2 : Math.PI / 2);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

/** A tapered limb piece whose pivot sits at its top end. */
function limb(mat, rTop, rBot, len, segs = 6) {
  const geo = new THREE.CylinderGeometry(rTop, rBot, len, segs);
  geo.translate(0, -len / 2, 0);
  return new THREE.Mesh(geo, mat);
}

/**
 * One insect leg: coxa -> femur -> tibia -> tarsus -> claw.
 * Returns the root pivot; animation swings the whole thing from the body.
 */
function buildLeg(mat, side, len, detail) {
  const root = new THREE.Group();

  const coxa = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), mat);
  root.add(coxa);

  // femur reaches out and slightly up from the body, as an ant's does
  const femur = limb(mat, 0.042, 0.03, len * 0.42, detail ? 7 : 5);
  femur.rotation.z = side * 1.28;
  femur.rotation.x = -0.26;
  root.add(femur);

  const knee = new THREE.Group();
  knee.position.y = -len * 0.42;
  femur.add(knee);

  // tibia drops from the knee back down to the ground
  const tibia = limb(mat, 0.028, 0.016, len * 0.44, detail ? 6 : 4);
  tibia.rotation.z = -side * 2.05;
  tibia.rotation.x = 0.22;
  knee.add(tibia);

  const ankle = new THREE.Group();
  ankle.position.y = -len * 0.44;
  tibia.add(ankle);

  if (detail) {
    let parent = ankle;
    for (let i = 0; i < 3; i++) {
      const seg = limb(mat, 0.014 - i * 0.003, 0.011 - i * 0.003, len * 0.075, 4);
      seg.rotation.z = -side * 0.2;
      parent.add(seg);
      const j = new THREE.Group();
      j.position.y = -len * 0.075;
      seg.add(j);
      parent = j;
    }
    const claw = limb(mat, 0.009, 0.003, len * 0.05, 4);
    claw.rotation.z = -side * 0.8;
    parent.add(claw);
  } else {
    const tar = limb(mat, 0.013, 0.005, len * 0.22, 4);
    tar.rotation.z = -side * 0.3;
    ankle.add(tar);
  }

  return root;
}

/** Elbowed antenna: one long scape, then a chain of flagellum beads. */
function buildAntenna(mat, side, detail) {
  const root = new THREE.Group();
  const scape = limb(mat, 0.028, 0.02, 0.46, detail ? 6 : 4);
  scape.rotation.set(-1.0, 0, side * 0.42);
  root.add(scape);

  const elbow = new THREE.Group();
  elbow.position.y = -0.5;
  scape.add(elbow);

  const flag = new THREE.Group();
  flag.rotation.set(-0.95, 0, side * 0.2);
  elbow.add(flag);

  const beads = detail ? 8 : 3;
  let parent = flag;
  for (let i = 0; i < beads; i++) {
    const w = 0.021 - i * 0.0014;
    const seg = limb(mat, w, w * 0.9, 0.42 / beads, 4);
    parent.add(seg);
    const j = new THREE.Group();
    j.position.y = -0.42 / beads;
    seg.add(j);
    parent = j;
  }
  root.userData.flag = flag;
  return root;
}

/**
 * Build an ant facing +Z.
 * Returns a Group whose userData exposes legs / antennae / head / mandibles
 * so the animation code can drive them.
 */
export function makeAnt(opt = {}) {
  const o = Object.assign({
    body: 0x8e3415,      // alitrunk: deep brick
    head: 0x9a3b18,
    gaster: 0x20100a,    // near-black glossy abdomen, as in the reference
    legs: 0x6b3015,
    eye: 0x241a1c,
    scale: 1,
    detail: true,
    hairs: false,
  }, opt);

  const g = new THREE.Group();
  const bodyMat = chitin(o.body);
  const headMat = chitin(o.head, { roughness: 0.3 });
  const gastMat = chitin(o.gaster, { roughness: 0.16, clearcoat: 1.0, ccRough: 0.05, metalness: 0.3 });
  const limbMat = chitin(o.legs, { roughness: 0.52, clearcoat: 0.4 });
  const eyeMat = new THREE.MeshPhysicalMaterial({
    color: o.eye, roughness: 0.14, metalness: 0.1,
    clearcoat: 1, clearcoatRoughness: 0.02,
    sheen: 1, sheenColor: new THREE.Color(0x4a3a30),
  });

  const LS = o.detail ? 14 : 8;   // lathe/sphere segments

  // ---- gaster ------------------------------------------------------------
  // A single revolved teardrop: fat in the middle, tapering to a point at the
  // back, pinched at the front where the petiole meets it.
  const gaster = new THREE.Group();
  gaster.position.set(0, 0.6, -0.37);

  // Each pair of points with a small radius drop is one tergite edge, so the
  // plates show as real ridges in the silhouette rather than hoops stuck on.
  const bulb = lathe(gastMat, [
    [0.00, 0.075], [0.06, 0.205], [0.14, 0.275],
    [0.24, 0.315], [0.255, 0.302],
    [0.36, 0.352], [0.375, 0.339],
    [0.50, 0.368], [0.515, 0.354],
    [0.64, 0.352], [0.655, 0.337],
    [0.78, 0.292], [0.90, 0.205], [0.99, 0.0],
  ], LS + 6);
  bulb.scale.set(0.94, 1.0, 1);
  gaster.add(bulb);
  g.add(gaster);

  // ---- petiole: the narrow waist and its raised node ---------------------
  const stalk = limb(limbMat, 0.05, 0.05, 0.16, 6);
  stalk.position.set(0, 0.56, -0.36);
  stalk.rotation.x = Math.PI / 2;
  g.add(stalk);

  const node = new THREE.Mesh(new THREE.SphereGeometry(0.085, 8, 7), bodyMat);
  node.scale.set(0.8, 1.6, 0.6);
  node.position.set(0, 0.63, -0.38);
  g.add(node);

  // ---- alitrunk ----------------------------------------------------------
  // Also one revolved piece: shoulders at the pronotum, a dip at the waist,
  // sloping away to the propodeum at the back.
  const trunk = lathe(bodyMat, [
    [0.00, 0.075], [0.06, 0.185], [0.18, 0.232], [0.34, 0.222],
    [0.50, 0.238], [0.66, 0.258], [0.80, 0.225], [0.90, 0.145], [0.96, 0.085],
  ], LS + 4, 'front');
  trunk.position.set(0, 0.55, -0.3);
  g.add(trunk);

  // ---- head --------------------------------------------------------------
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.57, 0.62);
  g.add(headPivot);

  const collar = new THREE.Mesh(new THREE.SphereGeometry(0.1, 9, 7), limbMat);
  collar.scale.set(0.95, 0.95, 0.6);
  collar.position.z = -0.12;
  headPivot.add(collar);

  const skull = lathe(headMat, [
    [0.00, 0.06], [0.05, 0.19], [0.14, 0.268], [0.26, 0.297],
    [0.38, 0.285], [0.50, 0.228], [0.60, 0.145], [0.66, 0.07],
  ], LS + 4, 'front');
  skull.scale.set(1.0, 0.9, 1);        // heads are wider than they are tall
  skull.position.z = -0.1;
  headPivot.add(skull);

  const mandibles = [];
  for (const s of [-1, 1]) {
    // compound eye: a modest oval sitting flush on the side of the head
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.072, o.detail ? 12 : 7, o.detail ? 10 : 6), eyeMat);
    eye.scale.set(0.6, 1.3, 1.2);
    eye.position.set(s * 0.252, 0.06, 0.18);
    headPivot.add(eye);

    if (o.detail && s > 0) {
      for (let i = 0; i < 3; i++) {                     // ocelli on the crown
        const oc = new THREE.Mesh(new THREE.SphereGeometry(0.014, 6, 5), eyeMat);
        oc.position.set((i - 1) * 0.05, 0.235, 0.0);
        headPivot.add(oc);
      }
    }

    // curved, pointed mandible that can open and shut
    const jaw = new THREE.Group();
    jaw.position.set(s * 0.085, -0.07, 0.48);
    const base = limb(limbMat, 0.034, 0.024, 0.14, 5);
    base.rotation.set(1.52, 0, s * 0.24);
    jaw.add(base);
    const tip = new THREE.Group();
    tip.position.set(0, -0.14, 0);
    base.add(tip);
    const point = limb(limbMat, 0.022, 0.004, 0.16, 5);
    point.rotation.set(0, 0, s * 1.3);
    tip.add(point);
    headPivot.add(jaw);
    mandibles.push(jaw);
  }

  const antennae = [];
  for (const s of [-1, 1]) {
    const a = buildAntenna(limbMat, s, o.detail);
    a.position.set(s * 0.105, 0.14, 0.34);
    headPivot.add(a);
    antennae.push(a);
  }

  // ---- six legs ----------------------------------------------------------
  const legs = [];
  const mounts = [
    { z: 0.33, len: 1.34 },
    { z: 0.11, len: 1.44 },
    { z: -0.16, len: 1.62 },
  ];
  for (const s of [-1, 1]) {
    mounts.forEach((m, i) => {
      const leg = buildLeg(limbMat, s, m.len, o.detail);
      leg.position.set(s * 0.19, 0.5, m.z);
      leg.userData.phase = i * 2.094 + (s > 0 ? Math.PI : 0);
      leg.userData.side = s;
      leg.userData.rest = leg.rotation.x;
      leg.userData.baseY = 0.5;
      legs.push(leg);
      g.add(leg);
    });
  }

  // ---- body hairs: only for the player, purely for the close-up ----------
  if (o.hairs) {
    const hairMat = new THREE.MeshBasicMaterial({ color: 0x8a5a30, transparent: true, opacity: 0.55 });
    const hairGeo = new THREE.CylinderGeometry(0.0035, 0.001, 0.1, 3);
    const hairs = new THREE.InstancedMesh(hairGeo, hairMat, 34);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < 34; i++) {
      const t = i / 34;
      const ang = t * Math.PI * 18;
      const z = 0.45 - t * 1.6;
      const rr = z < -0.5 ? 0.4 : 0.24;
      v.set(Math.cos(ang) * rr * 0.9, 0.58 + Math.sin(ang) * rr * 0.5, z);
      q.setFromEuler(new THREE.Euler(Math.cos(ang) * 0.7, 0, Math.sin(ang) * 0.7));
      hairs.setMatrixAt(i, m.compose(v, q, sc));
    }
    hairs.instanceMatrix.needsUpdate = true;
    g.add(hairs);
  }

  g.scale.setScalar(o.scale);
  g.traverse((m) => { if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; } });
  g.userData = { legs, antennae, mandibles, headPivot, gaster, kind: 'ant' };
  return g;
}

/**
 * Honeypot ant — a replete. Hangs from a chamber ceiling with a gaster
 * swollen into a translucent amber bead. Straight out of the reference film.
 */
export function makeReplete(scale = 1) {
  const g = new THREE.Group();
  const worker = makeAnt({
    body: 0x2a2028, head: 0x342730, gaster: 0x241a20,
    legs: 0x1d1418, scale: 0.85, detail: false,
  });
  // the gaster is replaced by the honey bead, so hide the stock one
  worker.userData.gaster.visible = false;
  g.add(worker);

  const honeyMat = new THREE.MeshPhysicalMaterial({
    color: 0xd98a22,
    emissive: 0xb85e10,
    emissiveIntensity: 0.85,
    roughness: 0.08,
    metalness: 0.0,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    transparent: true,
    opacity: 0.88,
  });
  const bead = new THREE.Mesh(new THREE.SphereGeometry(1.05, 20, 16), honeyMat);
  bead.position.set(0, 0.35, -1.55);
  bead.scale.set(1, 0.95, 1.05);
  g.add(bead);

  // the stretched seams where the plates have pulled apart
  const seamMat = new THREE.MeshPhysicalMaterial({
    color: 0x6b3a12, roughness: 0.3, clearcoat: 0.8, transparent: true, opacity: 0.85,
  });
  for (let i = 0; i < 4; i++) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(1.02, 0.045, 5, 18), seamMat);
    band.rotation.set(Math.PI / 2, 0, (i / 4) * Math.PI);
    band.position.copy(bead.position);
    g.add(band);
  }

  const glow = new THREE.PointLight(0xffb040, 9, 16, 1.8);
  glow.position.copy(bead.position);
  g.add(glow);

  g.scale.setScalar(scale);
  g.userData = { bead, honeyMat, glow, worker };
  return g;
}

/** Ant brood: a pale, segmented grub curled on the floor. */
export function makeLarva() {
  const g = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xf0e2c6, roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.25,
    transmission: 0, sheen: 0.6, sheenColor: new THREE.Color(0xd8b98a),
  });
  const segs = 7;
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1);
    const r = 0.3 * Math.sin(0.35 + t * 2.4);
    const seg = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.1, r), 10, 8), mat);
    // curled into the comma shape a larva holds
    const a = -0.5 + t * 1.5;
    seg.position.set(Math.sin(a) * 0.55, 0.22 + Math.cos(a) * 0.1, Math.cos(a) * 0.55 - 0.3);
    seg.scale.set(1, 0.9, 1.1);
    g.add(seg);
  }
  g.userData = { mat };
  return g;
}

/** A fallen leaf — raft, ramp, and landmark. */
export function makeLeaf(size = 1, colour = 0x6f8f3a) {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(0, -1.9);
  shape.bezierCurveTo(1.5, -1.1, 1.65, 1.0, 0, 2.1);
  shape.bezierCurveTo(-1.65, 1.0, -1.5, -1.1, 0, -1.9);

  const geo = new THREE.ShapeGeometry(shape, 26);
  // sag the middle so it reads as a real leaf rather than a cut-out
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    pos.setZ(i, -0.16 * (1 - Math.min(1, (x * x) / 2.4)) * (1 - Math.abs(y) / 2.4));
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshPhysicalMaterial({
    color: colour, roughness: 0.62, side: THREE.DoubleSide,
    clearcoat: 0.35, sheen: 0.5, sheenColor: new THREE.Color(0x9fc060),
  });
  const blade = new THREE.Mesh(geo, mat);
  blade.rotation.x = -Math.PI / 2;
  g.add(blade);

  const veinMat = new THREE.MeshStandardMaterial({ color: 0x4d6a24, roughness: 0.7 });
  const mid = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.03, 3.9, 5), veinMat);
  mid.rotation.x = Math.PI / 2;
  mid.position.y = 0.04;
  g.add(mid);
  for (let i = 0; i < 6; i++) {
    const t = -1.5 + i * 0.6;
    for (const s of [-1, 1]) {
      const v = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.012, 1.25, 4), veinMat);
      v.position.set(s * 0.42, 0.04, t + 0.35);
      v.rotation.set(Math.PI / 2, 0, s * 0.85);
      g.add(v);
    }
  }

  g.scale.setScalar(size);
  g.userData = { blade, mat };
  return g;
}

/** A plug of packed stones sealing a tunnel. Cleared by a hauling crew. */
export function makeStonePlug(rng = Math.random) {
  const g = new THREE.Group();
  const stones = [];
  const mats = [0x6b6259, 0x7a6f61, 0x5c5349, 0x847768];
  for (let i = 0; i < 16; i++) {
    const r = 0.9 + rng() * 1.9;
    const mat = new THREE.MeshPhysicalMaterial({
      color: mats[i % mats.length], roughness: 0.88, metalness: 0.04,
      clearcoat: 0.15, flatShading: true,
    });
    const s = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), mat);
    const a = rng() * Math.PI * 2;
    const d = rng() * 2.6;
    s.position.set(Math.cos(a) * d, r * 0.55 + rng() * 2.6, Math.sin(a) * d * 0.5);
    s.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    s.userData.home = s.position.clone();
    g.add(s);
    stones.push(s);
  }
  g.userData = { stones };
  return g;
}

/** Fungus comb: the grey-green sponge leafcutters farm. */
export function makeFungusComb(rng = Math.random) {
  const g = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x9db584, roughness: 0.92, sheen: 0.7,
    sheenColor: new THREE.Color(0xc8dcae), flatShading: true,
  });
  const n = 9 + Math.floor(rng() * 7);
  for (let i = 0; i < n; i++) {
    const r = 0.5 + rng() * 1.3;
    const lobe = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), mat);
    const a = rng() * Math.PI * 2;
    const d = rng() * 2.6;
    lobe.position.set(Math.cos(a) * d, r * 0.7 + rng() * 1.8, Math.sin(a) * d);
    lobe.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    g.add(lobe);
  }
  return g;
}

/** Bioluminescent fungus — the only real light down here. */
export function makeGlowCap(colour, rng = Math.random) {
  const g = new THREE.Group();
  const stalkMat = new THREE.MeshPhysicalMaterial({ color: 0xd8cbb0, roughness: 0.8, clearcoat: 0.3 });
  const capMat = new THREE.MeshPhysicalMaterial({
    color: colour, emissive: colour, emissiveIntensity: 3.4, roughness: 0.42, clearcoat: 0.6,
  });
  const n = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const h = 0.8 + rng() * 2.0;
    const px = (rng() - 0.5) * 2.6, pz = (rng() - 0.5) * 2.6;
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.19, h, 6), stalkMat);
    stalk.position.set(px, h / 2, pz);
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.34 + rng() * 0.3, 11, 8, 0, Math.PI * 2, 0, Math.PI / 2), capMat);
    cap.scale.y = 0.62;
    cap.position.set(px, h, pz);
    g.add(stalk, cap);
  }
  return g;
}

/** Root columns hanging through a chamber — the scale cue for a big space. */
export function makeRoot(height, rng = Math.random) {
  const g = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x5a4024, roughness: 0.88, clearcoat: 0.2, flatShading: true,
  });
  const pts = [];
  const segs = 7;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push(new THREE.Vector3(
      Math.sin(t * 3.4 + rng()) * 0.9,
      t * height,
      Math.cos(t * 2.8 + rng()) * 0.9
    ));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const trunk = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 14, 0.42 + rng() * 0.45, 6, false), mat);
  g.add(trunk);
  // rootlets branching off
  for (let i = 0; i < 4; i++) {
    const t = 0.25 + rng() * 0.6;
    const p = curve.getPoint(t);
    const sub = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.03, 1.4 + rng() * 2.2, 5), mat);
    sub.position.copy(p);
    sub.rotation.set(rng() * 1.6 - 0.8, rng() * 6, rng() * 1.6 - 0.8);
    g.add(sub);
  }
  return g;
}

/** Heaped seed husks for the granary. */
export function makeSeedPile(rng = Math.random) {
  const g = new THREE.Group();
  const mats = [0xb9884a, 0xa0713a, 0xcfa05c];
  for (let i = 0; i < 18; i++) {
    const mat = new THREE.MeshPhysicalMaterial({
      color: mats[i % 3], roughness: 0.6, clearcoat: 0.45, clearcoatRoughness: 0.3,
    });
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.28 + rng() * 0.28, 8, 6), mat);
    s.scale.set(1, 0.72, 1.5);
    const a = rng() * Math.PI * 2, d = rng() * 2.4;
    s.position.set(Math.cos(a) * d, 0.22 + rng() * 0.9, Math.sin(a) * d);
    s.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    g.add(s);
  }
  return g;
}

/** Refuse heap — husks, grit and spent shells. Ants keep a tidy graveyard. */
export function makeMidden(rng = Math.random) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x35281b, roughness: 1, flatShading: true });
  const mound = new THREE.Mesh(new THREE.SphereGeometry(2.6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat);
  mound.scale.y = 0.42;
  g.add(mound);
  const bitMat = new THREE.MeshStandardMaterial({ color: 0x6b5a3e, roughness: 0.85, flatShading: true });
  for (let i = 0; i < 14; i++) {
    const b = new THREE.Mesh(new THREE.TetrahedronGeometry(0.22 + rng() * 0.3), bitMat);
    const a = rng() * Math.PI * 2, d = rng() * 2.5;
    b.position.set(Math.cos(a) * d, 0.15 + rng() * 0.8, Math.sin(a) * d);
    b.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    g.add(b);
  }
  return g;
}

export function makePickup(color) {
  const g = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.46, 0),
    new THREE.MeshPhysicalMaterial({
      color, emissive: color, emissiveIntensity: 0.75,
      roughness: 0.32, clearcoat: 0.8, flatShading: true,
    })
  );
  g.add(core);
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.95, 12, 10),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, depthWrite: false })
  );
  g.add(halo);
  g.userData = { core, halo };
  return g;
}

/** The gland that lets you call nestmates. Picked up once, on the deep level. */
export function makeGland() {
  const g = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffd76a, emissive: 0xff9a2e, emissiveIntensity: 1.4,
    roughness: 0.1, clearcoat: 1, transparent: true, opacity: 0.92,
  });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.72, 1), mat);
  g.add(core);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffc04a, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
  });
  const rings = [];
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(1.0 + i * 0.35, 0.035, 5, 28), ringMat);
    r.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    g.add(r);
    rings.push(r);
  }
  const light = new THREE.PointLight(0xffb040, 14, 22, 1.7);
  g.add(light);
  g.userData = { core, rings };
  return g;
}
