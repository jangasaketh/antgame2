// ---------------------------------------------------------------------------
// world.js — turns the terrain heightfields into soil you can see and walk on,
// dresses each chamber with its landmark, and owns the lights.
//
// The floor and the ceiling are two surfaces over the same grid. Where the
// headroom drops to nothing the ceiling sinks onto the floor, and that seam is
// what you read as a wall of packed earth. There are no boxes anywhere.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { SPAN, FIELD, LEVEL_DROP, SHAFT_RADIUS, MIN_HEADROOM, LEVELS } from './config.js';
import { Terrain } from './terrain.js';
import {
  soilTexture, makeGlowCap, makeRoot, makeSeedPile, makeMidden,
  makeFungusComb, makeLeaf,
} from './models.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELL = SPAN / FIELD;
const HALF = SPAN / 2;
const STEP = 2;                  // mesh resolution: every Nth field sample

export class World {
  constructor(scene, seed = 7331) {
    this.scene = scene;
    this.seed = seed;
    this.levels = [];
    this.current = -1;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.#lights();
  }

  levelY(i) { return -i * LEVEL_DROP; }

  /** Incremental build so the loading screen can show progress. */
  *buildAll() {
    for (let i = 0; i < LEVELS.length; i++) {
      yield { done: i, total: LEVELS.length, name: LEVELS[i].name };
      this.levels.push(this.#buildLevel(LEVELS[i], i));
    }
    yield { done: LEVELS.length, total: LEVELS.length, name: 'ready' };
  }

  // ------------------------------------------------------------- one level --
  #buildLevel(def, index) {
    const rng = mulberry32(this.seed + index * 104729);
    const terrain = new Terrain(def, rng);
    terrain.buildGraph();

    const y = this.levelY(index);
    const group = new THREE.Group();
    group.position.y = y;
    group.visible = false;
    this.root.add(group);

    const shaft = { x: terrain.exit.x, z: terrain.exit.z };
    const level = {
      def, index, group, y, terrain, rng, shaft,
      gateOpen: false, plugs: [], leaves: [],
      spawn: terrain.pointInRoom(terrain.entry, 0.3),
      visited: new Set(),
    };

    this.#buildSoil(level);
    this.#buildShaft(level);
    this.#dress(level);
    return level;
  }

  // ------------------------------------------------------------ soil mesh --
  #buildSoil(level) {
    const { terrain, def, group, rng } = level;
    const fPos = [], fCol = [], fIdx = [];
    const cPos = [], cCol = [], cIdx = [];
    const shaft = level.shaft;

    // Map from field index to vertex index, built lazily per surface.
    const fMap = new Map(), cMap = new Map();

    const soil = new THREE.Color(def.soil);
    const deep = new THREE.Color(def.soil).multiplyScalar(0.34);

    const vert = (map, arrP, arrC, i, j, isCeil) => {
      const key = j * FIELD + i;
      let v = map.get(key);
      if (v !== undefined) return v;
      const x = -HALF + i * CELL;
      const z = -HALF + j * CELL;
      const f = terrain.floorF[key] ?? 0;
      const h = terrain.headF[key] ?? 0;
      arrP.push(x, isCeil ? f + Math.max(h, 0.06) : f, z);

      // Bake a crevice shadow: the tighter the gap, the darker the soil. This
      // is what gives the burrow depth without paying for real shadow maps.
      const ao = Math.min(1, h / 9);
      const c = deep.clone().lerp(soil, 0.1 + Math.pow(ao, 0.8) * 0.9);
      // ceilings sit in their own shade, floors catch more bounce light
      const k = isCeil ? 0.62 : 1.0;
      const grain = 0.86 + ((i * 31 + j * 17) % 13) / 46;
      arrC.push(c.r * k * grain, c.g * k * grain, c.b * k * grain);
      v = arrP.length / 3 - 1;
      map.set(key, v);
      return v;
    };

    for (let j = 0; j + STEP < FIELD; j += STEP) {
      for (let i = 0; i + STEP < FIELD; i += STEP) {
        const k00 = j * FIELD + i;
        const k10 = j * FIELD + i + STEP;
        const k01 = (j + STEP) * FIELD + i;
        const k11 = (j + STEP) * FIELD + i + STEP;
        const h = Math.max(terrain.headF[k00], terrain.headF[k10],
          terrain.headF[k01], terrain.headF[k11]);
        if (h < 0.05) continue;                 // solid rock, never seen

        const x = -HALF + i * CELL, z = -HALF + j * CELL;
        const inShaft = Math.hypot(x - shaft.x, z - shaft.z) < SHAFT_RADIUS;

        if (!inShaft) {
          const a = vert(fMap, fPos, fCol, i, j, false);
          const b = vert(fMap, fPos, fCol, i + STEP, j, false);
          const c = vert(fMap, fPos, fCol, i, j + STEP, false);
          const d = vert(fMap, fPos, fCol, i + STEP, j + STEP, false);
          fIdx.push(a, c, b, b, c, d);
        }

        const a2 = vert(cMap, cPos, cCol, i, j, true);
        const b2 = vert(cMap, cPos, cCol, i + STEP, j, true);
        const c2 = vert(cMap, cPos, cCol, i, j + STEP, true);
        const d2 = vert(cMap, cPos, cCol, i + STEP, j + STEP, true);
        cIdx.push(a2, b2, c2, b2, d2, c2);      // wound to face downward
      }
    }

    const tex = soilTexture(`#${def.soil.toString(16).padStart(6, '0')}`, '#1d1207', 256, 1400);
    tex.repeat.set(0.16, 0.16);

    const mkGeo = (pos, col, idx) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      // planar UVs so the grain texture tiles across the soil
      const uv = new Float32Array((pos.length / 3) * 2);
      for (let v = 0; v < pos.length / 3; v++) {
        uv[v * 2] = pos[v * 3];
        uv[v * 2 + 1] = pos[v * 3 + 2];
      }
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      return g;
    };

    const floorMat = new THREE.MeshStandardMaterial({
      vertexColors: true, map: tex, roughness: 0.99, metalness: 0.0,
      side: THREE.DoubleSide,
    });
    const ceilMat = new THREE.MeshStandardMaterial({
      vertexColors: true, map: tex, roughness: 1.0, metalness: 0.0,
      side: THREE.DoubleSide,
    });

    const floor = new THREE.Mesh(mkGeo(fPos, fCol, fIdx), floorMat);
    const ceil = new THREE.Mesh(mkGeo(cPos, cCol, cIdx), ceilMat);
    group.add(floor, ceil);
    level.floorMesh = floor;
    level.ceilMesh = ceil;

    // Loose grit scattered over the floor: pure scale cue, very cheap.
    const gritGeo = new THREE.DodecahedronGeometry(0.11, 0);
    const gritMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(def.soil).multiplyScalar(1.12), roughness: 0.98, flatShading: true,
    });
    const gritCount = 340;
    const grit = new THREE.InstancedMesh(gritGeo, gritMat, gritCount);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    const p = new THREE.Vector3(), s = new THREE.Vector3();
    let placed = 0;
    for (let tries = 0; tries < gritCount * 8 && placed < gritCount; tries++) {
      const pt = terrain.randomPoint();
      if (!terrain.walkable(pt.x, pt.z)) continue;
      const sc = 0.35 + rng() * 1.1;
      p.set(pt.x, terrain.floorAt(pt.x, pt.z) + sc * 0.06, pt.z);
      q.setFromEuler(new THREE.Euler(rng() * 3, rng() * 3, rng() * 3));
      s.set(sc, sc * 0.7, sc);
      grit.setMatrixAt(placed++, m.compose(p, q, s));
    }
    grit.count = placed;
    grit.instanceMatrix.needsUpdate = true;
    group.add(grit);
  }

  // ---------------------------------------------------------------- shaft --
  #buildShaft(level) {
    const { terrain, group, shaft } = level;
    const fy = terrain.floorAt(shaft.x, shaft.z);

    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS * 1.25, LEVEL_DROP, 22, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x1b1108, roughness: 1, side: THREE.BackSide })
    );
    tube.position.set(shaft.x, fy - LEVEL_DROP / 2, shaft.z);
    group.add(tube);

    // the lip of packed soil around the mouth
    const lip = new THREE.Mesh(
      new THREE.TorusGeometry(SHAFT_RADIUS + 0.7, 0.85, 7, 26),
      new THREE.MeshStandardMaterial({ color: 0x4a3420, roughness: 1, flatShading: true })
    );
    lip.rotation.x = -Math.PI / 2;
    lip.position.set(shaft.x, fy - 0.25, shaft.z);
    lip.scale.y = 0.55;
    group.add(lip);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(SHAFT_RADIUS + 0.2, 0.17, 7, 30),
      new THREE.MeshStandardMaterial({
        color: 0x8fd8b4, emissive: 0x2f8f63, emissiveIntensity: 0.45, roughness: 0.5,
      })
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(shaft.x, fy + 0.1, shaft.z);
    group.add(rim);
    level.rim = rim;

    // root lattice across the mouth until the crop quota is filled
    const grate = new THREE.Group();
    const rootMat = new THREE.MeshPhysicalMaterial({
      color: 0x6a4a28, roughness: 0.85, clearcoat: 0.25, flatShading: true,
    });
    for (let k = 0; k < 6; k++) {
      const bar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.22, SHAFT_RADIUS * 2.2, 6), rootMat);
      bar.rotation.z = Math.PI / 2;
      bar.rotation.y = (k / 6) * Math.PI;
      bar.position.y = 0.4 + Math.sin(k * 1.9) * 0.3;
      grate.add(bar);
    }
    grate.position.set(shaft.x, fy, shaft.z);
    group.add(grate);
    level.grate = grate;
  }

  // ------------------------------------------------------- chamber dressing --
  #dress(level) {
    const { terrain, def, group, rng } = level;
    const lampCol = def.lamp;

    for (const room of terrain.rooms) {
      const fy = terrain.floorAt(room.x, room.z);

      // glow fungus: enough to see by, clustered near the walls
      const caps = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < caps; i++) {
        const p = terrain.pointInRoom(room, 0.85);
        const cap = makeGlowCap(lampCol, rng);
        cap.position.set(p.x, terrain.floorAt(p.x, p.z), p.z);
        group.add(cap);
      }

      // root columns for scale in the taller chambers
      if (room.h > 10) {
        const n = 1 + Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
          const p = terrain.pointInRoom(room, 0.7);
          const h = terrain.headAt(p.x, p.z);
          if (h < 6) continue;
          const r = makeRoot(h * 0.95, rng);
          r.position.set(p.x, terrain.floorAt(p.x, p.z), p.z);
          group.add(r);
        }
      }

      // the landmark that tells you which chamber you are standing in
      const put = (make, count, spread = 0.6) => {
        for (let i = 0; i < count; i++) {
          const p = terrain.pointInRoom(room, spread);
          const o = make();
          o.position.set(p.x, terrain.floorAt(p.x, p.z), p.z);
          o.rotation.y = rng() * Math.PI * 2;
          group.add(o);
        }
      };

      if (room.kind === 'granary') put(() => makeSeedPile(rng), 3 + Math.floor(rng() * 3));
      else if (room.kind === 'midden') put(() => makeMidden(rng), 2 + Math.floor(rng() * 2));
      else if (room.kind === 'fungus') put(() => makeFungusComb(rng), 4 + Math.floor(rng() * 3));
      else if (room.kind === 'brood') {
        // brood chambers are swept clean — the larvae themselves get added later
        put(() => makeGlowCap(0xbfe8c8, rng), 2);
      }

      room.floorY = fy;
    }

    // fallen leaves: ramps, landmarks, and rafts when the water comes
    const leafCount = def.leaves ?? 3;
    for (let i = 0; i < leafCount; i++) {
      const p = terrain.randomPoint();
      const leaf = makeLeaf(1.6 + rng() * 1.5, [0x6f8f3a, 0x8a9b3c, 0x7d6a2c][i % 3]);
      leaf.position.set(p.x, terrain.floorAt(p.x, p.z) + 0.12, p.z);
      leaf.rotation.y = rng() * Math.PI * 2;
      leaf.userData.home = leaf.position.clone();
      group.add(leaf);
      level.leaves.push(leaf);
    }
  }

  // --------------------------------------------------------------- lights --
  #lights() {
    // Almost nothing: underground, light has to come from somewhere real.
    this.hemi = new THREE.HemisphereLight(0x2b3347, 0x070402, 0.085);
    this.scene.add(this.hemi);

    // two roving lamps standing in for the fungus glow of nearby chambers
    this.lamps = [0, 1].map(() => {
      const l = new THREE.PointLight(0xffffff, 0, 70, 1.8);
      this.scene.add(l);
      return l;
    });

    // A close warm light riding with the ant. Without it she is a silhouette,
    // and the whole point of the model is that you can see the chitin shine.
    this.lantern = new THREE.PointLight(0xffc98a, 26, 17, 2.0);
    this.scene.add(this.lantern);
    // a cool counter-light so the far side of her is not pure black
    this.rim = new THREE.DirectionalLight(0x8fb4d8, 0.16);
    this.scene.add(this.rim);
  }

  setActiveLevel(i) {
    this.current = i;
    this.levels.forEach((lv, k) => { lv.group.visible = (k === i || k === i + 1); });
    const def = LEVELS[i];
    this.scene.fog = new THREE.FogExp2(def.fog, def.fogDensity);
    this.scene.background = new THREE.Color(def.fog);
    this.hemi.groundColor.setHex(def.soil);
    this.hemi.intensity = 0.085;
    for (const l of this.lamps) { l.color.setHex(def.lamp); l.intensity = 0; }
    this.lantern.color.setHex(def.lamp).lerp(new THREE.Color(0xfff0dc), 0.8);
  }

  /** Keep the two lamps in the chambers nearest the player. */
  updateLamps(px, py, pz, levelIndex) {
    const lv = this.levels[levelIndex];
    if (!lv) return;
    const rooms = lv.terrain.rooms;
    const sorted = rooms
      .map((r) => ({ r, d: (r.x - px) ** 2 + (r.z - pz) ** 2 }))
      .sort((a, b) => a.d - b.d);
    for (let k = 0; k < this.lamps.length; k++) {
      const room = sorted[k]?.r;
      if (!room) { this.lamps[k].intensity = 0; continue; }
      const l = this.lamps[k];
      // sit the lamp low, where the fungus actually grows, so chambers read
      // as pools of light with dark tunnels between them
      l.position.set(room.x, lv.y + room.floorY + Math.min(room.h * 0.3, 4.5), room.z);
      l.distance = room.r * 1.9;
      l.intensity = 260;
    }
    this.lantern.position.set(px, py + 3.2, pz);
    this.rim.position.set(px + 14, py + 20, pz + 10);
    this.rim.target.position.set(px, py, pz);
    this.rim.target.updateMatrixWorld();
  }

  openGate(i) {
    const lv = this.levels[i];
    if (!lv || lv.gateOpen) return;
    lv.gateOpen = true;
    lv.group.remove(lv.grate);
    lv.rim.material.emissiveIntensity = 2.4;
    lv.rim.material.color.setHex(0xffd08a);
    lv.rim.material.emissive.setHex(0xff8c2c);
  }

  isOverShaft(i, x, z) {
    const lv = this.levels[i];
    if (!lv || !lv.gateOpen) return false;
    return Math.hypot(x - lv.shaft.x, z - lv.shaft.z) < SHAFT_RADIUS - 0.5;
  }

  terrainOf(i) { return this.levels[i]?.terrain; }
}
