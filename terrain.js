// ---------------------------------------------------------------------------
// terrain.js — the burrow itself.
//
// A real ant nest is not a maze of walls. It is a set of rounded chambers dug
// out of soil, joined by tunnels, with the floor humped into hills and the
// ceiling domed above. So instead of placing wall blocks, this builds two
// smooth heightfields:
//
//     floor(x,z)   soil you stand on, humped by hills
//     head(x,z)    how much air there is above it
//
// Solid rock is simply where head() is too small to squeeze through. Walls are
// where the ceiling curves down and meets the floor, which is why nothing in
// here looks like a box.
// ---------------------------------------------------------------------------

import { SPAN, FIELD, MIN_HEADROOM } from './config.js';

const CELL = SPAN / FIELD;
const HALF = SPAN / 2;

/** smoothstep 1 -> 0 as t goes 0 -> 1 */
function fall(t) {
  if (t >= 1) return 0;
  if (t <= 0) return 1;
  const s = 1 - t;
  return s * s * (3 - 2 * s);
}

export class Terrain {
  constructor(def, rng) {
    this.def = def;
    this.rng = rng;
    this.cell = CELL;
    this.half = HALF;
    this.n = FIELD;

    this.rooms = [];
    this.tunnels = [];
    this.hills = [];

    this.#layout();

    this.floorF = new Float32Array(FIELD * FIELD);
    this.headF = new Float32Array(FIELD * FIELD);
    this.#bake();
  }

  // ------------------------------------------------------------- layout ---
  /**
   * Grow chambers outward from the entry like a real nest: each new chamber
   * buds off an existing one along a tunnel, so the whole thing stays
   * connected and still branches unpredictably.
   */
  #layout() {
    const rng = this.rng;
    const d = this.def;
    const rad = () => d.roomMin + rng() * (d.roomMax - d.roomMin);
    const limit = HALF - d.roomMax - 12;

    // entry chamber, offset from centre so the level is not symmetric
    const a0 = rng() * Math.PI * 2;
    const r0 = limit * 0.62;
    this.rooms.push({
      x: Math.cos(a0) * r0, z: Math.sin(a0) * r0,
      r: rad() * 0.8, h: d.height[0] + 2, kind: 'gallery', depth: 0,
    });

    let guard = 0;
    while (this.rooms.length < d.rooms && guard++ < 700) {
      // Prefer budding off the deepest chambers, so the nest reaches away from
      // the entry instead of collapsing into a star with everything one hop out.
      const from = this.#pickParent();
      const ang = rng() * Math.PI * 2;
      const r = rad();
      // far enough apart to read as two rooms, close enough to link
      const gap = from.r + r + 6 + rng() * 26;
      const x = from.x + Math.cos(ang) * gap;
      const z = from.z + Math.sin(ang) * gap;
      if (Math.hypot(x, z) > limit) continue;

      let clash = false;
      for (const o of this.rooms) {
        if (Math.hypot(x - o.x, z - o.z) < (r + o.r) * 0.86) { clash = true; break; }
      }
      if (clash) continue;

      const room = {
        x, z, r,
        h: d.height[0] + rng() * (d.height[1] - d.height[0]),
        kind: 'gallery', depth: from.depth + 1,
      };
      this.rooms.push(room);
      this.tunnels.push(this.#tunnel(from, room));
    }

    // Pick the exit on the bare tree, before any shortcuts exist.
    this.#assignRoles();

    // Extra links so the burrow loops back on itself instead of being a tree.
    // Never link the exit: its one tunnel stays the way down, which keeps a
    // stone plug across it a guaranteed-solvable gate rather than a dead end.
    let loops = d.loops;
    for (let i = 0; i < this.rooms.length && loops > 0; i++) {
      for (let j = i + 2; j < this.rooms.length && loops > 0; j++) {
        const a = this.rooms[i], b = this.rooms[j];
        if (a === this.exit || b === this.exit) continue;
        if (this.#linked(a, b)) continue;
        const dist = Math.hypot(a.x - b.x, a.z - b.z);
        if (dist > a.r + b.r + 52) continue;
        this.tunnels.push(this.#tunnel(a, b));
        loops--;
      }
    }

    this.hops = this.#hopCounts(this.entry);
    this.#raiseHills();
  }

  #pickParent() {
    let deepest = 0;
    for (const r of this.rooms) deepest = Math.max(deepest, r.depth);
    // weight grows steeply with depth, so the burrow keeps extending outward
    let total = 0;
    const w = this.rooms.map((r) => {
      const v = Math.pow(1 + r.depth, 2.4) + (r.depth === deepest ? 6 : 0);
      total += v;
      return v;
    });
    let pick = this.rng() * total;
    for (let i = 0; i < this.rooms.length; i++) {
      pick -= w[i];
      if (pick <= 0) return this.rooms[i];
    }
    return this.rooms[this.rooms.length - 1];
  }

  #tunnel(a, b) {
    const d = this.def;
    return {
      a, b,
      x1: a.x, z1: a.z, x2: b.x, z2: b.z,
      w: d.tunnelMin + this.rng() * (d.tunnelMax - d.tunnelMin),
      h: Math.min(a.h, b.h) * (0.52 + this.rng() * 0.2),
    };
  }

  #linked(a, b) {
    return this.tunnels.some((t) => (t.a === a && t.b === b) || (t.a === b && t.b === a));
  }

  /** Entry, exit, and a landmark identity for every chamber between them. */
  #assignRoles() {
    const rng = this.rng;
    this.entry = this.rooms[0];
    this.entry.kind = 'gallery';

    // exit = the chamber that takes the most tunnels to reach from the entry
    const hops = this.#hopCounts(this.entry);
    let best = this.rooms[1] ?? this.rooms[0];
    for (const r of this.rooms) {
      if ((hops.get(r) ?? -1) > (hops.get(best) ?? -1)) best = r;
    }
    this.exit = best;
    this.exit.kind = 'gallery';
    this.exit.isExit = true;

    // every other chamber gets a distinct look so you can navigate by landmark
    const pool = ['brood', 'larder', 'fungus', 'granary', 'midden'];
    let p = Math.floor(rng() * pool.length);
    for (const r of this.rooms) {
      if (r === this.entry || r === this.exit) continue;
      r.kind = pool[p % pool.length];
      p++;
    }
    this.treeHops = hops;
  }

  #hopCounts(start) {
    const seen = new Map([[start, 0]]);
    const q = [start];
    while (q.length) {
      const cur = q.shift();
      for (const t of this.tunnels) {
        const nxt = t.a === cur ? t.b : (t.b === cur ? t.a : null);
        if (!nxt || seen.has(nxt)) continue;
        seen.set(nxt, seen.get(cur) + 1);
        q.push(nxt);
      }
    }
    return seen;
  }

  /** Soil hills inside chambers — high ground, cover, and flood refuge. */
  #raiseHills() {
    const rng = this.rng;
    for (let i = 0; i < this.def.hills; i++) {
      const room = this.rooms[Math.floor(rng() * this.rooms.length)];
      if (room === this.exit) continue;
      const a = rng() * Math.PI * 2;
      const d = rng() * room.r * 0.55;
      this.hills.push({
        x: room.x + Math.cos(a) * d,
        z: room.z + Math.sin(a) * d,
        r: 6 + rng() * 13,
        h: 2.2 + rng() * (room.h * 0.42),
      });
    }
  }

  // --------------------------------------------------------------- bake ---
  #bake() {
    for (let j = 0; j < FIELD; j++) {
      const z = -HALF + j * CELL;
      for (let i = 0; i < FIELD; i++) {
        const x = -HALF + i * CELL;
        const k = j * FIELD + i;
        this.floorF[k] = this.#calcFloor(x, z);
        this.headF[k] = this.#calcHead(x, z);
      }
    }
  }

  #calcFloor(x, z) {
    let y = 0;
    for (const h of this.hills) {
      const t = Math.hypot(x - h.x, z - h.z) / h.r;
      if (t < 1) y += h.h * fall(t) * fall(t * 0.85);
    }
    // fine soil ripple so the ground is never a flat plane
    y += Math.sin(x * 0.11) * Math.cos(z * 0.13) * 0.45;
    y += Math.sin(x * 0.31 + 1.7) * Math.cos(z * 0.27) * 0.2;
    return y;
  }

  #calcHead(x, z) {
    let h = 0;
    for (const r of this.rooms) {
      const t = Math.hypot(x - r.x, z - r.z) / r.r;
      if (t < 1) h = Math.max(h, r.h * fall(t * t));
    }
    for (const t of this.tunnels) {
      const dx = t.x2 - t.x1, dz = t.z2 - t.z1;
      const len2 = dx * dx + dz * dz || 1;
      let u = ((x - t.x1) * dx + (z - t.z1) * dz) / len2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const px = t.x1 + dx * u, pz = t.z1 + dz * u;
      const d = Math.hypot(x - px, z - pz) / t.w;
      if (d < 1) h = Math.max(h, t.h * fall(d * d));
    }
    return h;
  }

  // ------------------------------------------------------------ sampling --
  #bilinear(field, x, z) {
    const fx = (x + HALF) / CELL;
    const fz = (z + HALF) / CELL;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= FIELD - 1 || j >= FIELD - 1) return 0;
    const tx = fx - i, tz = fz - j;
    const a = field[j * FIELD + i];
    const b = field[j * FIELD + i + 1];
    const c = field[(j + 1) * FIELD + i];
    const d = field[(j + 1) * FIELD + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  floorAt(x, z) { return this.#bilinear(this.floorF, x, z); }
  headAt(x, z) { return this.#bilinear(this.headF, x, z); }
  ceilAt(x, z) { return this.floorAt(x, z) + Math.max(this.headAt(x, z), 0.1); }

  /** Can a body of this radius stand here? */
  walkable(x, z, need = MIN_HEADROOM) {
    return this.headAt(x, z) >= need;
  }

  /** Direction that leads to more headroom — used to slide along soil walls. */
  gradient(x, z, out) {
    const e = CELL * 1.2;
    const gx = this.headAt(x + e, z) - this.headAt(x - e, z);
    const gz = this.headAt(x, z + e) - this.headAt(x, z - e);
    const len = Math.hypot(gx, gz) || 1;
    out.x = gx / len;
    out.z = gz / len;
    return out;
  }

  /**
   * Push a circle out of solid soil. Walks uphill on the headroom field until
   * it can stand, which makes bodies slide around curved walls instead of
   * sticking on them.
   */
  resolve(pos, radius, need = MIN_HEADROOM) {
    const g = { x: 0, z: 0 };
    for (let pass = 0; pass < 6; pass++) {
      // sample a ring so a fat body cannot poke its side into the wall
      let worst = this.headAt(pos.x, pos.z);
      let wx = pos.x, wz = pos.z;
      for (let a = 0; a < 6; a++) {
        const ang = (a / 6) * Math.PI * 2;
        const sx = pos.x + Math.cos(ang) * radius;
        const sz = pos.z + Math.sin(ang) * radius;
        const h = this.headAt(sx, sz);
        if (h < worst) { worst = h; wx = sx; wz = sz; }
      }
      if (worst >= need) return;
      this.gradient(wx, wz, g);
      pos.x += g.x * this.cell * 1.1;
      pos.z += g.z * this.cell * 1.1;
    }
  }

  /** Straight-line visibility: soil between two points blocks it. */
  clearLine(ax, az, bx, bz, need = MIN_HEADROOM) {
    const dx = bx - ax, dz = bz - az;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(2, Math.ceil(dist / (CELL * 1.6)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      if (this.headAt(ax + dx * t, az + dz * t) < need) return false;
    }
    return true;
  }

  roomAt(x, z) {
    for (const r of this.rooms) {
      if (Math.hypot(x - r.x, z - r.z) < r.r) return r;
    }
    return null;
  }

  /** A standable spot inside a chamber. */
  pointInRoom(room, margin = 0.62) {
    for (let i = 0; i < 40; i++) {
      const a = this.rng() * Math.PI * 2;
      const d = this.rng() * room.r * margin;
      const x = room.x + Math.cos(a) * d;
      const z = room.z + Math.sin(a) * d;
      if (this.walkable(x, z, MIN_HEADROOM + 0.4)) return { x, z };
    }
    return { x: room.x, z: room.z };
  }

  randomPoint(avoid = null, minDist = 0) {
    for (let i = 0; i < 60; i++) {
      const room = this.rooms[Math.floor(this.rng() * this.rooms.length)];
      const p = this.pointInRoom(room);
      if (avoid && Math.hypot(p.x - avoid.x, p.z - avoid.z) < minDist) continue;
      return p;
    }
    return this.pointInRoom(this.rooms[0]);
  }

  // --------------------------------------------------------- navigation ---
  /**
   * Coarse waypoint graph over chamber centres and tunnel midpoints, so ants
   * walk the tunnels rather than trying to push through soil.
   */
  buildGraph() {
    const nodes = [];
    const index = new Map();
    for (const r of this.rooms) {
      index.set(r, nodes.length);
      nodes.push({ x: r.x, z: r.z, room: r, links: [] });
    }
    for (const t of this.tunnels) {
      const mid = {
        x: (t.x1 + t.x2) / 2, z: (t.z1 + t.z2) / 2, room: null, links: [],
      };
      const mi = nodes.length;
      nodes.push(mid);
      const ai = index.get(t.a), bi = index.get(t.b);
      nodes[ai].links.push(mi); mid.links.push(ai);
      nodes[bi].links.push(mi); mid.links.push(bi);
      t.node = mi;
    }
    this.nodes = nodes;
    this.roomNode = index;
    return nodes;
  }

  nearestNode(x, z) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /**
   * Where to walk next, or null when the target is already in plain sight.
   *
   * Returns the FURTHEST waypoint on the route that is still directly
   * visible, rather than the very next one. Aiming at the next node makes a
   * body dither whenever it sits between two of them; aiming at the furthest
   * visible one is stable, and it cuts corners through open chambers the way
   * an ant actually walks.
   */
  routeStep(fromX, fromZ, toX, toZ, blockedNodes = null) {
    if (this.clearLine(fromX, fromZ, toX, toZ)) return null;
    const start = this.nearestNode(fromX, fromZ);
    const goal = this.nearestNode(toX, toZ);
    if (start === goal) return this.nodes[goal];

    const prev = new Int32Array(this.nodes.length).fill(-1);
    prev[start] = start;
    const q = [start];
    let head = 0, found = false;
    while (head < q.length) {
      const cur = q[head++];
      if (cur === goal) { found = true; break; }
      for (const nx of this.nodes[cur].links) {
        if (prev[nx] !== -1) continue;
        if (blockedNodes && blockedNodes.has(nx)) continue;
        prev[nx] = cur;
        q.push(nx);
      }
    }
    if (!found) return this.nodes[goal];

    const path = [];
    let cur = goal;
    for (let guard = 0; guard < this.nodes.length + 2; guard++) {
      path.push(cur);
      if (cur === start) break;
      cur = prev[cur];
    }
    path.reverse();

    for (let i = path.length - 1; i >= 0; i--) {
      const n = this.nodes[path[i]];
      if (this.clearLine(fromX, fromZ, n.x, n.z)) return n;
    }
    return this.nodes[path[Math.min(1, path.length - 1)]];
  }

  /** Tunnels that must be crossed to reach the exit — where plugs go. */
  tunnelsIntoExit() {
    return this.tunnels.filter((t) => t.a === this.exit || t.b === this.exit);
  }
}
