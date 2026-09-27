// ---------------------------------------------------------------------------
// game.js — renderer, camera, input, level flow, combat, HUD.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  LEVELS, PLAYER, WEAPONS, ALARM, RECRUIT,
  SPAN, FIELD, LEVEL_DROP, SHAFT_RADIUS, MIN_HEADROOM, CRAWL_HEADROOM,
} from './config.js';
import { World, mulberry32 } from './world.js';
import {
  Player, Enemy, Recruit, Replete, Larva, StonePlug, LeafRaft, Pickup, Gland,
} from './entities.js';
import { Flood, Collapse } from './hazards.js';
import { Audio } from './audio.js';

const $ = (id) => document.getElementById(id);

const ROOM_LABEL = {
  brood: 'Brood chamber', larder: 'The larder', fungus: 'Fungus garden',
  granary: 'Granary', midden: 'Refuse heap', gallery: 'Gallery',
};

class Game {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    $('app').appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 500);

    this.clock = new THREE.Clock();
    this.state = 'loading';
    this.yaw = 0; this.pitch = 0.26; this.camDist = 9.0;
    this.shake = 0; this.snapCam = true; this.everLocked = false;

    this.input = {
      forward: 0, back: 0, left: 0, right: 0,
      sprint: false, jump: false, fire: false, alt: false, scent: false,
    };

    this.enemies = []; this.pickups = []; this.repletes = []; this.larvae = [];
    this.plugs = []; this.rafts = []; this.recruits = []; this.tracers = [];
    this.hazards = []; this.numbers = []; this.motes = [];
    this.gland = null;

    this.audio = new Audio();
    this.world = new World(this.scene, 20260927);

    this.alarm = 0;
    this.noisyTimer = 0;
    this.toastTimer = 0;
    this.levelTimer = null;
    this.roomLabelTimer = 0;
    this.lastRoom = null;
    this.stats = { food: 0, kills: 0, crits: 0, brood: 0, time: 0 };

    this.minimap = $('minimap');
    this.mm = this.minimap.getContext('2d');
    this.numberPool = [...$('dmg-layer').children];

    this.#buildMotes();
    this.#bind();
    this.#load();
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  // ------------------------------------------------------------- loading ---
  #load() {
    const gen = this.world.buildAll();
    const tick = () => {
      const r = gen.next();
      if (r.done) return;
      const { done, total, name } = r.value;
      $('load-bar').style.width = `${(done / total) * 100}%`;
      $('load-what').textContent = done >= total ? 'Ready' : `Digging ${name.toLowerCase()}…`;
      if (done >= total) {
        setTimeout(() => {
          this.player = new Player(this.scene);
          const lv = this.world.levels[0];
          this.world.setActiveLevel(0);
          this.player.spawnAt(lv.spawn.x, lv.y + lv.terrain.floorAt(lv.spawn.x, lv.spawn.z), lv.spawn.z, 0);
          $('screen-load').classList.add('gone');
          $('screen-title').classList.remove('gone');
          this.state = 'menu';
        }, 260);
        return;
      }
      setTimeout(tick, 0);       // let the browser paint between levels
    };
    setTimeout(tick, 60);
  }

  #buildMotes() {
    const n = 90;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    this.moteGeo = geo;
    this.moteMesh = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0x9fe8c8, size: 0.42, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.scene.add(this.moteMesh);
    for (let i = 0; i < n; i++) this.motes.push({ t: i / n, life: 0 });
  }

  // -------------------------------------------------------------- events ---
  #bind() {
    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });

    const keys = {
      KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back',
      KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
    };

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (keys[e.code]) { this.input[keys[e.code]] = 1; e.preventDefault(); }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.input.sprint = true;
      if (e.code === 'Space') { this.input.jump = true; e.preventDefault(); }
      if (e.code === 'KeyQ') this.input.scent = true;
      if (e.code === 'KeyE') this.#interact();
      if (e.code === 'KeyC') this.#callNestmates();
      if (e.code === 'Digit1') this.#switch('acid');
      if (e.code === 'Digit2') this.#switch('bite');
      if (e.code === 'KeyM') {
        this.audio.setMuted(!this.audio.muted);
        this.toast(this.audio.muted ? 'Sound off' : 'Sound on');
      }
      if (e.code === 'Escape' && this.state === 'playing') this.pause();
      if (e.code === 'KeyR' && (this.state === 'dead' || this.state === 'win')) this.restart();
    });

    addEventListener('keyup', (e) => {
      if (keys[e.code]) this.input[keys[e.code]] = 0;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.input.sprint = false;
      if (e.code === 'KeyQ') this.input.scent = false;
    });

    const cv = this.renderer.domElement;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('mousedown', (e) => {
      if (this.state !== 'playing') return;
      if (document.pointerLockElement !== cv) { cv.requestPointerLock(); return; }
      if (e.button === 0) this.input.fire = true;
      if (e.button === 2) this.input.alt = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.input.fire = false;
      if (e.button === 2) this.input.alt = false;
    });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== cv) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = Math.max(-0.5, Math.min(0.95, this.pitch + e.movementY * 0.0017));
    });
    addEventListener('wheel', (e) => {
      if (this.state !== 'playing') return;
      this.camDist = Math.max(4.5, Math.min(16, this.camDist + e.deltaY * 0.008));
    }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === cv) { this.everLocked = true; return; }
      if (this.state === 'playing' && this.everLocked) this.pause();
    });

    $('btn-start').onclick = () => this.start();
    $('btn-resume').onclick = () => this.resume();
    $('btn-retry').onclick = () => this.restart();
    $('btn-again').onclick = () => this.restart();
  }

  #switch(k) {
    if (this.state !== 'playing' || this.player.weapon === k) return;
    if (k === 'acid' && this.player.carrying) {
      this.toast('Your mandibles are full. Drop the brood first.', 'warn');
      return;
    }
    this.player.switchTo?.(k);
    this.player.weapon = k;
    this.audio.greet();
    this.#paintWeapon();
  }

  // ---------------------------------------------------------- level flow ---
  start() {
    this.audio.start();
    $('screen-title').classList.add('gone');
    this.stats = { food: 0, kills: 0, crits: 0, brood: 0, time: 0 };
    this.player.health = PLAYER.maxHealth;
    this.player.ammo.acid = WEAPONS.acid.ammoStart;
    this.player.scent = PLAYER.maxScent;
    this.player.hasGland = false;
    this.player.carrying = null;
    this.player.weapon = 'acid';
    for (const lv of this.world.levels) { lv.gateOpen = false; lv.visited.clear(); }
    this.loadLevel(0, true);
    this.state = 'playing';
    this.renderer.domElement.requestPointerLock();
  }

  restart() {
    $('screen-dead').classList.add('gone');
    $('screen-win').classList.add('gone');
    this.start();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.fire = this.input.alt = false;
    this.audio.setIntensity(0);
    $('screen-pause').classList.remove('gone');
    document.exitPointerLock?.();
  }

  resume() {
    $('screen-pause').classList.add('gone');
    this.state = 'playing';
    this.renderer.domElement.requestPointerLock();
  }

  #clear() {
    const all = [this.enemies, this.pickups, this.repletes, this.larvae,
      this.plugs, this.recruits, this.hazards];
    for (const a of all) { for (const o of a) o.dispose?.(this.scene); a.length = 0; }
    for (const t of this.tracers) this.scene.remove(t.line);
    this.tracers.length = 0;
    this.rafts.length = 0;
    if (this.gland) { this.gland.dispose(this.scene); this.gland = null; }
  }

  loadLevel(i, teleport) {
    this.#clear();
    const def = LEVELS[i];
    const lv = this.world.levels[i];
    const terrain = lv.terrain;
    const rng = lv.rng;

    this.world.setActiveLevel(i);
    this.audio.setLevel(i);
    this.player.level = i;
    this.player.food = 0;
    this.player.carrying = null;

    if (teleport) {
      this.player.spawnAt(lv.spawn.x, lv.y + terrain.floorAt(lv.spawn.x, lv.spawn.z), lv.spawn.z, i);
      this.snapCam = true;
    } else {
      // dropped in through the shaft above: land near this level's entry
      this.player.spawnAt(lv.spawn.x, lv.y + terrain.floorAt(lv.spawn.x, lv.spawn.z) + 3, lv.spawn.z, i);
      this.snapCam = true;
    }

    // ---- pickups, scattered by chamber ------------------------------------
    for (const [key, n] of Object.entries(def.pickups)) {
      for (let k = 0; k < n; k++) {
        this.pickups.push(new Pickup(key, this.scene, this.world, i, terrain.randomPoint(lv.spawn, 14)));
      }
    }

    // ---- honeypot repletes hang in the larder, and a few elsewhere -------
    const larders = terrain.rooms.filter((r) => r.kind === 'larder');
    for (let k = 0; k < (def.repletes ?? 0); k++) {
      const room = larders.length ? larders[k % larders.length]
        : terrain.rooms[1 + Math.floor(rng() * (terrain.rooms.length - 1))];
      this.repletes.push(new Replete(this.scene, this.world, i, terrain.pointInRoom(room, 0.55)));
    }

    // ---- brood, laid out in the brood chambers ----------------------------
    const broods = terrain.rooms.filter((r) => r.kind === 'brood');
    for (let k = 0; k < (def.larvae ?? 0); k++) {
      const room = broods.length ? broods[k % broods.length]
        : terrain.rooms[1 + Math.floor(rng() * (terrain.rooms.length - 1))];
      this.larvae.push(new Larva(this.scene, this.world, i, terrain.pointInRoom(room, 0.5)));
    }

    // ---- hostiles ---------------------------------------------------------
    for (const [key, n] of Object.entries(def.enemies)) {
      for (let k = 0; k < n; k++) {
        this.enemies.push(new Enemy(key, this.scene, this.world, i, terrain.randomPoint(lv.spawn, 26)));
      }
    }

    // ---- leaves become rafts when the water rises -------------------------
    for (const leaf of lv.leaves) {
      leaf.position.copy(leaf.userData.home);
      this.rafts.push(new LeafRaft(leaf, i, this.world));
    }

    // ---- hazards ----------------------------------------------------------
    if (def.hazards.includes('flood')) this.hazards.push(new Flood(this.scene, this.world, i));
    if (def.hazards.includes('collapse')) this.hazards.push(new Collapse(this.scene, this.world, i, 5.2));

    // ---- the blocked way down --------------------------------------------
    if (def.hazards.includes('blockade')) {
      for (const t of terrain.tunnelsIntoExit()) {
        this.plugs.push(new StonePlug(this.scene, this.world, i, t));
      }
      if (!this.player.hasGland) {
        // the gland sits in a chamber you can actually reach
        const open = terrain.rooms.filter((r) => r !== terrain.exit && r !== terrain.entry);
        const room = open[Math.floor(rng() * open.length)] ?? terrain.entry;
        this.gland = new Gland(this.scene, this.world, i, terrain.pointInRoom(room, 0.4));
      }
    }

    this.levelTimer = def.timeLimit ?? null;
    $('timer-wrap').classList.toggle('gone', this.levelTimer === null);
    $('floor-name').textContent = def.name;
    $('floor-sub').textContent = `Floor ${i + 1} of ${LEVELS.length} · ${i * LEVEL_DROP} cm down`;
    $('crop-need').textContent = def.foodNeeded;
    this.alarm = 0;
    this.lastRoom = null;
    this.#buildMapCanvas(lv);
    this.#paintWeapon();
    this.#paintPowers();

    $('banner-name').textContent = def.name;
    $('banner-line').textContent = def.tagline;
    const b = $('banner');
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  }

  descend() {
    const next = this.player.level + 1;
    if (next >= LEVELS.length) return this.win();
    this.player.heal(45);
    this.loadLevel(next, false);
    this.audio.descend();
  }

  win() {
    this.state = 'win';
    this.audio.setIntensity(0);
    document.exitPointerLock?.();
    $('stat-food').textContent = this.stats.food;
    $('stat-kills').textContent = this.stats.kills;
    $('stat-brood').textContent = this.stats.brood;
    $('stat-time').textContent = this.#clock(this.stats.time);
    $('screen-win').classList.remove('gone');
  }

  die(reason) {
    this.state = 'dead';
    this.input.fire = this.input.alt = false;
    this.audio.setIntensity(0);
    document.exitPointerLock?.();
    $('dead-reason').textContent = reason;
    $('dead-floor').textContent = LEVELS[this.player.level].name;
    $('dead-kills').textContent = this.stats.kills;
    $('screen-dead').classList.remove('gone');
  }

  // -------------------------------------------------------- interactions ---
  #interact() {
    if (this.state !== 'playing') return;
    const p = this.player;

    // drop what we are carrying
    if (p.carrying) {
      const l = p.carrying;
      l.carried = false;
      l.pos.copy(l.mesh.position);
      p.carrying = null;
      this.toast('Brood set down.');
      this.#paintPowers();
      return;
    }

    // drink from a replete — trophallaxis
    let best = null, bd = 5.2;
    for (const r of this.repletes) {
      if (r.level !== p.level || r.empty) continue;
      const d = Math.hypot(r.pos.x - p.pos.x, r.pos.z - p.pos.z);
      if (d < bd) { bd = d; best = r; }
    }
    if (best) {
      best.charges--;
      p.heal(60);
      p.giveAcid(26);
      this.audio.drink();
      this.toast('You drink from the replete. Strength returns.', 'good');
      this.#feed('Fed by a honeypot ant');
      return;
    }

    // pick up brood
    let bl = null, bld = 4.4;
    for (const l of this.larvae) {
      if (l.level !== p.level || l.carried || l.delivered) continue;
      const d = Math.hypot(l.pos.x - p.pos.x, l.pos.z - p.pos.z);
      if (d < bld) { bld = d; bl = l; }
    }
    if (bl) {
      bl.carried = true;
      p.carrying = bl;
      p.weapon = 'bite';
      this.toast('Brood in your mandibles. Carry it to the shaft.', 'good');
      this.audio.pickup();
      this.#paintWeapon();
      this.#paintPowers();
      return;
    }

    this.toast('Nothing here to take.');
  }

  #callNestmates() {
    if (this.state !== 'playing') return;
    const p = this.player;
    if (!p.hasGland) {
      this.toast('You have no way to call them yet.', 'warn');
      return;
    }
    if (p.callCd > 0) {
      this.toast(`Your gland is spent. ${Math.ceil(p.callCd)}s`, 'warn');
      return;
    }
    p.callCd = RECRUIT.cooldown;
    this.audio.call();
    this.#feed('You call for help');

    const terrain = this.world.terrainOf(p.level);
    // the nearest uncleared plug becomes the crew's job
    let job = null, jd = RECRUIT.callRadius;
    for (const plug of this.plugs) {
      if (plug.cleared || plug.level !== p.level) continue;
      const d = Math.hypot(plug.pos.x - p.pos.x, plug.pos.z - p.pos.z);
      if (d < jd) { jd = d; job = plug; }
    }

    for (let k = 0; k < RECRUIT.count; k++) {
      const a = (k / RECRUIT.count) * Math.PI * 2;
      const spot = { x: p.pos.x + Math.cos(a) * 6, z: p.pos.z + Math.sin(a) * 6 };
      if (!terrain.walkable(spot.x, spot.z)) { spot.x = p.pos.x; spot.z = p.pos.z; }
      const r = new Recruit(this.scene, this.world, p.level, spot, p);
      r.job = job;
      this.recruits.push(r);
    }
    this.toast(job ? 'Nestmates coming — they will shift the stones.'
      : 'Nestmates coming.', 'good');
    this.#paintPowers();
  }

  // ------------------------------------------------------------- shooting --
  #aim() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return { origin: this.camera.position.clone(), dir };
  }

  #muzzle() {
    const p = this.player;
    const d = new THREE.Vector3(-Math.sin(p.mesh.rotation.y), 0, -Math.cos(p.mesh.rotation.y));
    return new THREE.Vector3(p.pos.x + d.x * 1.8, p.pos.y + 1.3, p.pos.z + d.z * 1.8);
  }

  #fire() {
    const p = this.player;
    const w = p.gun;
    if (p.cooldown[p.weapon] > 0) return;

    if (w.kind === 'hitscan') {
      if (p.carrying) { this.toast('Not while you are carrying brood.', 'warn'); return; }
      if (p.ammo.acid < 1) { p.cooldown.acid = 0.25; this.audio.dry(); return; }
      p.ammo.acid -= 1;
      p.cooldown.acid = w.rate;
      this.noisyTimer = 0.4;
      p.facing = this.yaw + Math.PI;
      p.mesh.rotation.y = p.facing;
      this.#hitscan(w);
    } else {
      p.cooldown.bite = w.rate;
      p.biteAnim = 0.26;
      this.noisyTimer = 0.2;
      p.facing = this.yaw + Math.PI;
      p.mesh.rotation.y = p.facing;
      this.#melee(w);
    }
    this.#paintWeapon();
  }

  #hitscan(w) {
    const { origin, dir } = this.#aim();
    const terrain = this.world.terrainOf(this.player.level);
    let best = null, bestT = Infinity, point = null;

    for (const e of this.enemies) {
      if (e.dead || e.level !== this.player.level) continue;
      const c = e.pos.clone();
      c.y += e.cfg.headY * 0.55;
      const t = c.clone().sub(origin).dot(dir);
      if (t < 0 || t > w.range) continue;
      const near = origin.clone().addScaledVector(dir, t);
      if (near.distanceTo(c) > e.cfg.bodyRadius + 0.85) continue;
      if (!terrain.clearLine(this.player.pos.x, this.player.pos.z, e.pos.x, e.pos.z)) continue;
      if (t < bestT) { bestT = t; best = e; point = near; }
    }

    const end = best ? point : origin.clone().addScaledVector(dir, w.range * 0.5);
    this.#tracer(this.#muzzle(), end, w.tint);
    this.audio.spit();
    if (!best) return;

    const crit = point.y - best.pos.y > best.cfg.headY * 0.7;
    const dmg = Math.round(w.damage * (crit ? w.crit : 1));
    const killed = best.hurt(dmg);
    this.#number(point, dmg, crit);
    this.#hitmark(crit);
    if (crit) { this.stats.crits++; this.audio.crit(); } else this.audio.hit();
    if (killed) this.#kill(best);
  }

  #melee(w) {
    const p = this.player;
    const fwd = new THREE.Vector3(-Math.sin(p.facing), 0, -Math.cos(p.facing));
    let any = false;
    for (const e of [...this.enemies]) {
      if (e.dead || e.level !== p.level) continue;
      const to = new THREE.Vector3().subVectors(e.pos, p.pos);
      const d = to.length();
      if (d > w.range + e.cfg.bodyRadius) continue;
      to.y = 0; to.normalize();
      if (fwd.dot(to) < Math.cos(w.arc)) continue;
      const crit = e.rooted > 0 || e.state !== 'hunt';
      const dmg = Math.round(w.damage * (crit ? w.crit : 1));
      const killed = e.hurt(dmg);
      this.#number(e.pos.clone().setY(e.pos.y + e.cfg.headY), dmg, crit);
      any = true;
      if (crit) this.stats.crits++;
      if (killed) this.#kill(e);
    }
    this.audio.bite();
    if (any) this.#hitmark(false);
  }

  #kill(e) {
    this.stats.kills++;
    this.#feed(`${e.cfg.label} down`);
    this.audio.kill();
    e.dispose(this.scene);
    const i = this.enemies.indexOf(e);
    if (i >= 0) this.enemies.splice(i, 1);
    if (Math.random() < e.cfg.drop) {
      const key = Math.random() < 0.75 ? 'acid' : 'nectar';
      this.pickups.push(new Pickup(key, this.scene, this.world, e.level,
        { x: e.pos.x, z: e.pos.z }));
    }
  }

  #tracer(a, b, colour) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: colour, transparent: true, opacity: 0.95,
    }));
    this.scene.add(line);
    this.tracers.push({ line, life: 0.09 });
  }

  #hitmark(crit) {
    const el = $('hitmarker');
    el.classList.toggle('crit', crit);
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  }

  #number(pos, amount, crit) {
    const el = this.numberPool.find((n) => !n.dataset.busy);
    if (!el) return;
    el.dataset.busy = '1';
    el.textContent = crit ? `${amount}!` : `${amount}`;
    el.className = crit ? 'dmg crit' : 'dmg';
    this.numbers.push({ el, pos: pos.clone(), life: 0.85 });
  }

  #feed(text) {
    const el = document.createElement('li');
    el.textContent = text;
    $('killfeed').prepend(el);
    setTimeout(() => el.remove(), 3600);
    while ($('killfeed').children.length > 4) $('killfeed').lastElementChild.remove();
  }

  toast(text, tone = 'info') {
    const el = $('toast');
    el.textContent = text;
    el.dataset.tone = tone;
    el.classList.add('show');
    this.toastTimer = 3.2;
  }

  #clock(s) {
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  // --------------------------------------------------------------- frame ---
  #frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    if (this.state === 'playing') this.#update(dt, t);
    else if (this.state === 'menu' && this.player) this.#menuCam(t);
    this.renderer.render(this.scene, this.camera);
  }

  #update(dt, t) {
    const p = this.player;
    const world = this.world;
    const lv = world.levels[p.level];
    const terrain = lv.terrain;
    const def = LEVELS[p.level];
    const baseY = lv.y;

    this.stats.time += dt;
    if (this.noisyTimer > 0) this.noisyTimer -= dt;

    // Cleared every frame; only a live flood sets them again. Otherwise you
    // keep "swimming" on dry floors after leaving a flooded one.
    p.inWater = false;
    p.swimming = false;

    // ---- hazards first so water height is current ------------------------
    let waterY = null;
    for (const h of this.hazards) {
      if (h instanceof Flood) {
        h.update(dt, p, t, (m, tone) => this.toast(m, tone));
        waterY = h.activeY;
      } else {
        h.update(dt, p, (m, tone) => this.toast(m, tone),
          (s) => { this.shake = Math.max(this.shake, s); this.audio.thud(); });
      }
    }

    for (const r of this.rafts) r.update(dt, waterY, terrain, baseY, t);

    p.update(dt, this.input, world, this.yaw, t, { rafts: this.rafts });

    // stone plugs are solid until a crew shifts them
    for (const plug of this.plugs) {
      if (plug.cleared || plug.level !== p.level) continue;
      if (plug.blocks(p.pos.x, p.pos.z)) {
        const dx = p.pos.x - plug.pos.x, dz = p.pos.z - plug.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        p.pos.x = plug.pos.x + (dx / d) * plug.radius;
        p.pos.z = plug.pos.z + (dz / d) * plug.radius;
        p.vel.x *= 0.2; p.vel.z *= 0.2;
      }
    }

    if (this.input.fire || this.input.alt) this.#fire();

    // ---- enemies ----------------------------------------------------------
    const blockedNodes = new Set();
    for (const plug of this.plugs) {
      if (!plug.cleared && plug.node != null) blockedNodes.add(plug.node);
    }
    const ctx = {
      player: p, world,
      alarm: this.alarm / 100,
      alarmSightBonus: ALARM.sightBonusAtMax,
      alarmSpeedBonus: ALARM.speedBonusAtMax,
      playerNoisy: this.noisyTimer > 0,
      recruits: this.recruits,
      enemies: this.enemies,
      blockedNodes,
      sighted: false,
      onHit: () => { this.audio.hurt(); this.shake = Math.max(this.shake, 0.3); },
      onRecruitKill: (e) => this.#kill(e),
    };
    for (const e of this.enemies) e.update(dt, ctx, t);

    this.alarm = Math.max(0, Math.min(100,
      this.alarm + (ctx.sighted ? ALARM.risePerSecond : -ALARM.decayPerSecond) * dt));

    // ---- recruits and hauling crews ---------------------------------------
    for (let i = this.recruits.length - 1; i >= 0; i--) {
      const r = this.recruits[i];
      r.update(dt, ctx, t);
      if (r.greetTimer > 0 && !r.greetSound) { r.greetSound = true; this.audio.greet(); }
      if (r.dead) { r.dispose(this.scene); this.recruits.splice(i, 1); }
    }
    for (const plug of this.plugs) {
      if (plug.cleared || plug.level !== p.level) continue;
      let crew = 0;
      for (const r of this.recruits) {
        if (r.dead || r.level !== plug.level) continue;
        if (Math.hypot(r.pos.x - plug.pos.x, r.pos.z - plug.pos.z) < 6) crew++;
      }
      // the player counts as one of the crew if standing with them
      if (Math.hypot(p.pos.x - plug.pos.x, p.pos.z - plug.pos.z) < 7) crew++;
      if (plug.work(dt, crew)) {
        this.audio.rumble();
        this.shake = Math.max(this.shake, 0.55);
        this.toast('The stones give way. The tunnel is open.', 'good');
        this.#feed('Tunnel cleared');
      } else if (crew > 0 && crew < RECRUIT.hauling && Math.random() < dt * 0.6) {
        this.toast(`Too few to shift it — ${RECRUIT.hauling} ants needed.`, 'warn');
      }
    }

    // ---- tracers ----------------------------------------------------------
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      tr.life -= dt;
      tr.line.material.opacity = Math.max(0, tr.life / 0.09);
      if (tr.life <= 0) { this.scene.remove(tr.line); this.tracers.splice(i, 1); }
    }

    // ---- world objects ----------------------------------------------------
    for (const r of this.repletes) r.update(dt, t);
    for (const l of this.larvae) l.update(dt, t);
    if (this.gland) {
      this.gland.update(dt, t);
      if (this.gland.level === p.level &&
          Math.hypot(this.gland.pos.x - p.pos.x, this.gland.pos.z - p.pos.z) < 3.2) {
        p.hasGland = true;
        this.gland.dispose(this.scene);
        this.gland = null;
        this.audio.power();
        this.toast('Recruitment gland taken. Press C to call nestmates.', 'good');
        this.#feed('Power gained: call nestmates');
        this.#paintPowers();
      }
    }

    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const q = this.pickups[i];
      q.update(dt, t);
      if (q.level !== p.level) continue;
      if (Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z) < 2.8 &&
          Math.abs(q.pos.y - p.pos.y) < 4) {
        const d = q.def;
        if (d.kind === 'food') { p.food += d.value; this.stats.food += d.value; }
        else if (d.kind === 'acid') p.giveAcid(d.value);
        else if (d.kind === 'heal') p.heal(d.value);
        this.audio.pickup();
        q.dispose(this.scene);
        this.pickups.splice(i, 1);
      }
    }

    // ---- brood delivery ---------------------------------------------------
    if (p.carrying && Math.hypot(p.pos.x - lv.shaft.x, p.pos.z - lv.shaft.z) < SHAFT_RADIUS + 4) {
      const l = p.carrying;
      l.delivered = true;
      l.dispose(this.scene);
      const li = this.larvae.indexOf(l);
      if (li >= 0) this.larvae.splice(li, 1);
      p.carrying = null;
      p.food += 3;
      this.stats.food += 3;
      this.stats.brood++;
      p.weapon = 'acid';
      this.audio.pickup();
      this.toast('Brood carried to safety. +3 crop.', 'good');
      this.#feed('Brood rescued');
      this.#paintWeapon();
      this.#paintPowers();
    }

    // ---- timer, gate, descent ---------------------------------------------
    if (this.levelTimer !== null) {
      this.levelTimer -= dt;
      if (this.levelTimer <= 0) return this.die('The vault came down on top of you.');
      if (this.levelTimer < 25) this.shake = Math.max(this.shake, 0.09);
    }

    if (!lv.gateOpen && p.food >= def.foodNeeded) {
      world.openGate(p.level);
      this.audio.gate();
      this.toast('Crop full. The way down is open — find the amber ring.', 'good');
    }
    if (p.pos.y < baseY + terrain.floorAt(lv.shaft.x, lv.shaft.z) - LEVEL_DROP * 0.45) {
      if (def.final) return this.win();
      this.descend();
      return;
    }

    if (p.health <= 0) {
      return this.die(p.swimming ? 'You drowned in the flooded gallery.'
        : 'The colony tore you apart.');
    }

    // ---- ambience ---------------------------------------------------------
    let threat = 0;
    for (const e of this.enemies) {
      if (e.level !== p.level) continue;
      if (e.state === 'hunt') {
        const d = e.pos.distanceTo(p.pos);
        threat = Math.max(threat, Math.max(0, 1 - d / 46));
      }
    }
    this.audio.setIntensity(Math.max(threat, this.alarm / 160));

    this.#roomLabel(terrain);
    this.#explore(lv);
    this.#scentTrail(dt, lv, terrain);
    world.updateLamps(p.pos.x, p.pos.y, p.pos.z, p.level);
    this.#camera(dt, terrain, baseY);
    this.#hud(dt);
  }

  /** Name the chamber as you walk into it — how you navigate without a map. */
  #roomLabel(terrain) {
    const p = this.player;
    const room = terrain.roomAt(p.pos.x, p.pos.z);
    if (room && room !== this.lastRoom) {
      this.lastRoom = room;
      const el = $('room-label');
      el.textContent = room.isExit ? 'The way down' : (ROOM_LABEL[room.kind] ?? 'Gallery');
      el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    }
  }

  #explore(lv) {
    const p = this.player;
    const g = 64;
    const gx = Math.floor(((p.pos.x + SPAN / 2) / SPAN) * g);
    const gz = Math.floor(((p.pos.z + SPAN / 2) / SPAN) * g);
    const r = 3;
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        if (i * i + j * j > r * r) continue;
        const x = gx + i, z = gz + j;
        if (x < 0 || z < 0 || x >= g || z >= g) continue;
        lv.visited.add(z * g + x);
      }
    }
  }

  /** Hold Q: motes drift from you along the route to whatever you need next. */
  #scentTrail(dt, lv, terrain) {
    const p = this.player;
    const on = this.input.scent && p.scent > 1;
    const mat = this.moteMesh.material;
    mat.opacity += ((on ? 0.85 : 0) - mat.opacity) * Math.min(1, dt * 6);
    if (!on) return;

    // what are we looking for? the shaft once fed, otherwise the nearest food
    let goal = null;
    if (lv.gateOpen) goal = { x: lv.shaft.x, z: lv.shaft.z };
    else {
      let bd = Infinity;
      for (const q of this.pickups) {
        if (q.level !== p.level || q.def.kind !== 'food') continue;
        const d = (q.pos.x - p.pos.x) ** 2 + (q.pos.z - p.pos.z) ** 2;
        if (d < bd) { bd = d; goal = { x: q.pos.x, z: q.pos.z }; }
      }
      if (!goal) goal = { x: lv.shaft.x, z: lv.shaft.z };
    }

    const node = terrain.routeStep(p.pos.x, p.pos.z, goal.x, goal.z);
    const tx = node ? node.x : goal.x;
    const tz = node ? node.z : goal.z;
    const dx = tx - p.pos.x, dz = tz - p.pos.z;
    const len = Math.hypot(dx, dz) || 1;

    const pos = this.moteGeo.attributes.position;
    for (let i = 0; i < this.motes.length; i++) {
      const m = this.motes[i];
      m.t += dt * 0.55;
      if (m.t > 1) m.t -= 1;
      const reach = Math.min(len, 26) * m.t;
      const wobble = Math.sin(m.t * 9 + i) * 1.1;
      const x = p.pos.x + (dx / len) * reach - (dz / len) * wobble;
      const z = p.pos.z + (dz / len) * reach + (dx / len) * wobble;
      pos.setXYZ(i, x,
        lv.y + terrain.floorAt(x, z) + 1.1 + Math.sin(m.t * 6 + i) * 0.4, z);
    }
    pos.needsUpdate = true;
  }

  // -------------------------------------------------------------- camera ---
  #camera(dt, terrain, baseY) {
    const p = this.player;
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch)
    );
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const target = new THREE.Vector3(p.pos.x, p.pos.y + 2.3, p.pos.z).addScaledVector(right, 1.0);

    // pull in when soil is behind us, so the camera never buries itself
    let dist = this.camDist;
    for (let s = 1.2; s <= this.camDist; s += 0.6) {
      const pr = target.clone().addScaledVector(dir, s);
      const head = terrain.headAt(pr.x, pr.z);
      const fl = baseY + terrain.floorAt(pr.x, pr.z);
      if (head < MIN_HEADROOM * 0.8 || pr.y < fl + 0.6 || pr.y > fl + head - 0.3) {
        dist = Math.max(2.6, s - 0.8);
        break;
      }
    }

    const want = target.clone().addScaledVector(dir, dist);
    const fl = baseY + terrain.floorAt(want.x, want.z);
    const ce = fl + Math.max(terrain.headAt(want.x, want.z), 1.2);
    want.y = Math.max(fl + 0.8, Math.min(ce - 0.4, want.y));

    if (this.snapCam) { this.camera.position.copy(want); this.snapCam = false; }
    else this.camera.position.lerp(want, Math.min(1, dt * 13));

    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 1.7);
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
    }
    this.camera.lookAt(target);
  }

  #menuCam(t) {
    const p = this.player;
    const lv = this.world.levels[0];
    const r = 13;
    this.camera.position.set(
      p.pos.x + Math.cos(t * 0.19) * r,
      p.pos.y + 5.5,
      p.pos.z + Math.sin(t * 0.19) * r
    );
    this.camera.lookAt(p.pos.x, p.pos.y + 1.4, p.pos.z);
    this.world.updateLamps(p.pos.x, p.pos.y, p.pos.z, 0);
    p.mesh.rotation.y = t * 0.4;
  }

  // ----------------------------------------------------------------- HUD ---
  #paintWeapon() {
    const p = this.player;
    const w = p.gun;
    $('gun-name').textContent = w.name;
    $('slot-acid').classList.toggle('active', p.weapon === 'acid');
    $('slot-bite').classList.toggle('active', p.weapon === 'bite');
    if (w.kind === 'hitscan') {
      $('ammo-count').textContent = Math.floor(p.ammo.acid);
      $('ammo-max').textContent = w.ammoMax;
      $('ammo-wrap').classList.remove('melee');
    } else {
      $('ammo-count').textContent = '∞';
      $('ammo-max').textContent = '';
      $('ammo-wrap').classList.add('melee');
    }
    document.documentElement.style.setProperty('--gun', w.hue);
  }

  #paintPowers() {
    const p = this.player;
    $('pw-call').classList.toggle('have', p.hasGland);
    $('pw-carry').classList.toggle('have', !!p.carrying);
  }

  #hud(dt) {
    const p = this.player;
    const def = LEVELS[p.level];

    $('hp-fill').style.width = `${(p.health / PLAYER.maxHealth) * 100}%`;
    $('hp-num').textContent = Math.ceil(p.health);
    $('stam-fill').style.width = `${(p.stamina / PLAYER.maxStamina) * 100}%`;
    $('scent-fill').style.width = `${(p.scent / PLAYER.maxScent) * 100}%`;
    $('alarm-fill').style.width = `${this.alarm}%`;
    $('hurt').style.opacity = String(Math.max(0, p.invuln / PLAYER.invulnTime) * 0.5);
    $('crop-have').textContent = Math.min(p.food, def.foodNeeded);
    $('hud').classList.toggle('crawling', p.crawling);
    $('hud').classList.toggle('swimming', p.swimming);
    $('hud').classList.toggle('rafting', !!p.raft);
    this.#paintWeapon();

    const ch = $('crosshair');
    ch.classList.toggle('firing', this.input.fire || this.input.alt);
    ch.classList.toggle('dry', p.weapon === 'acid' && p.ammo.acid < 1);

    if (p.callCd > 0) $('pw-call').dataset.cd = Math.ceil(p.callCd);
    else delete $('pw-call').dataset.cd;

    if (this.levelTimer !== null) {
      $('timer').textContent = this.#clock(Math.max(0, this.levelTimer));
      $('timer-wrap').classList.toggle('critical', this.levelTimer < 30);
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) $('toast').classList.remove('show');
    }

    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      n.life -= dt;
      n.pos.y += dt * 2.4;
      if (n.life <= 0) {
        n.el.style.opacity = '0';
        delete n.el.dataset.busy;
        this.numbers.splice(i, 1);
        continue;
      }
      const v = n.pos.clone().project(this.camera);
      if (v.z > 1) { n.el.style.opacity = '0'; continue; }
      n.el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
      n.el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
      n.el.style.opacity = String(Math.min(1, n.life * 3));
    }

    this.#drawMap();
  }

  /** Render the burrow shape once per level; the fog mask is drawn each frame. */
  #buildMapCanvas(lv) {
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    const img = g.createImageData(S, S);
    const terrain = lv.terrain;

    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const x = -SPAN / 2 + (i / S) * SPAN;
        const z = -SPAN / 2 + (j / S) * SPAN;
        const h = terrain.headAt(x, z);
        const k = (j * S + i) * 4;
        if (h < MIN_HEADROOM) {
          img.data[k] = 26; img.data[k + 1] = 17; img.data[k + 2] = 9; img.data[k + 3] = 255;
        } else {
          // brighter where the chamber is tall, so big rooms read as big
          const f = Math.min(1, h / 12);
          img.data[k] = 150 + f * 78;
          img.data[k + 1] = 118 + f * 62;
          img.data[k + 2] = 78 + f * 40;
          img.data[k + 3] = 255;
        }
      }
    }
    g.putImageData(img, 0, 0);
    lv.mapCanvas = cv;

    const fog = document.createElement('canvas');
    fog.width = fog.height = 64;
    lv.fogCanvas = fog;
  }

  #drawMap() {
    const g = this.mm;
    const S = this.minimap.width;
    const p = this.player;
    const lv = this.world.levels[p.level];
    if (!lv.mapCanvas) return;

    g.clearRect(0, 0, S, S);
    g.drawImage(lv.mapCanvas, 0, 0, S, S);

    // fog of war: everything you have not walked near stays dark
    const fg = lv.fogCanvas.getContext('2d');
    fg.clearRect(0, 0, 64, 64);
    fg.fillStyle = 'rgba(9,6,3,0.96)';
    fg.fillRect(0, 0, 64, 64);
    fg.globalCompositeOperation = 'destination-out';
    for (const k of lv.visited) {
      fg.fillRect(k % 64, Math.floor(k / 64), 1, 1);
    }
    fg.globalCompositeOperation = 'source-over';
    g.imageSmoothingEnabled = true;
    g.drawImage(lv.fogCanvas, 0, 0, S, S);

    const toMap = (x, z) => [((x + SPAN / 2) / SPAN) * S, ((z + SPAN / 2) / SPAN) * S];
    const seen = (x, z) => {
      const gx = Math.floor(((x + SPAN / 2) / SPAN) * 64);
      const gz = Math.floor(((z + SPAN / 2) / SPAN) * 64);
      return lv.visited.has(gz * 64 + gx);
    };

    // pickups you have already laid eyes on
    g.fillStyle = '#f2d54a';
    for (const q of this.pickups) {
      if (q.level !== p.level || !seen(q.pos.x, q.pos.z)) continue;
      const [x, y] = toMap(q.pos.x, q.pos.z);
      g.fillRect(x - 1.4, y - 1.4, 2.8, 2.8);
    }

    // repletes: worth remembering where the food is
    g.fillStyle = '#ffb040';
    for (const r of this.repletes) {
      if (r.level !== p.level || r.empty || !seen(r.pos.x, r.pos.z)) continue;
      const [x, y] = toMap(r.pos.x, r.pos.z);
      g.beginPath(); g.arc(x, y, 2.6, 0, 6.28); g.fill();
    }

    // stone plugs
    for (const plug of this.plugs) {
      if (plug.cleared || plug.level !== p.level || !seen(plug.pos.x, plug.pos.z)) continue;
      const [x, y] = toMap(plug.pos.x, plug.pos.z);
      g.strokeStyle = '#c9b79a';
      g.lineWidth = 2.4;
      g.beginPath(); g.moveTo(x - 4, y - 4); g.lineTo(x + 4, y + 4);
      g.moveTo(x + 4, y - 4); g.lineTo(x - 4, y + 4); g.stroke();
    }

    // threats
    for (const e of this.enemies) {
      if (e.level !== p.level) continue;
      const hunting = e.state === 'hunt';
      if (!hunting && !seen(e.pos.x, e.pos.z)) continue;
      const [x, y] = toMap(e.pos.x, e.pos.z);
      g.fillStyle = hunting ? '#ff4d2b' : 'rgba(255,90,60,0.45)';
      g.beginPath(); g.arc(x, y, hunting ? 3.2 : 2.4, 0, 6.28); g.fill();
    }

    // friends
    g.fillStyle = '#8fd8b4';
    for (const r of this.recruits) {
      const [x, y] = toMap(r.pos.x, r.pos.z);
      g.beginPath(); g.arc(x, y, 2.4, 0, 6.28); g.fill();
    }

    // the way down, once you have found it
    if (seen(lv.shaft.x, lv.shaft.z)) {
      const [x, y] = toMap(lv.shaft.x, lv.shaft.z);
      g.strokeStyle = lv.gateOpen ? '#ffb347' : 'rgba(143,216,180,0.6)';
      g.lineWidth = lv.gateOpen ? 3 : 1.8;
      g.beginPath(); g.arc(x, y, 6, 0, 6.28); g.stroke();
    }

    // you
    const [px, py] = toMap(p.pos.x, p.pos.z);
    g.save();
    g.translate(px, py);
    g.rotate(-this.yaw);
    g.fillStyle = p.raft ? '#9fe0ff' : '#ffd9a0';
    g.beginPath();
    g.moveTo(0, -6); g.lineTo(4.4, 5); g.lineTo(0, 2.4); g.lineTo(-4.4, 5);
    g.closePath(); g.fill();
    g.restore();
  }
}

addEventListener('DOMContentLoaded', () => {
  try {
    window.game = new Game();
  } catch (err) {
    console.error(err);
    document.body.insertAdjacentHTML('beforeend', `<div class="fatal">${err.message}</div>`);
  }
});
