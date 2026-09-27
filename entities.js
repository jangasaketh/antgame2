// ---------------------------------------------------------------------------
// entities.js — the fire ant you drive, the colony that wants her dead, and
// the pieces of real ant life the reference films are full of: honeypot
// repletes you drink from, brood you carry out, nestmates you call for help.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  PLAYER, WEAPONS, ENEMY_TYPES, PICKUP_TYPES, RECRUIT,
  MIN_HEADROOM, CRAWL_HEADROOM,
} from './config.js';
import {
  makeAnt, makeReplete, makeLarva, makeStonePlug, makePickup, makeGland,
} from './models.js';

const UP = new THREE.Vector3(0, 1, 0);

// --------------------------------------------------------------- shared ----
function animateAnt(mesh, t, gait, opts = {}) {
  const d = mesh.userData;
  if (!d?.legs) return;
  // Real ants run an alternating tripod: three legs down, three swinging.
  const swing = 0.16 + gait * 0.62;
  const rate = 7 + gait * 17;
  for (const leg of d.legs) {
    const ph = t * rate + leg.userData.phase;
    leg.rotation.x = Math.sin(ph) * swing;
    leg.rotation.z = Math.cos(ph) * swing * 0.3;
    leg.position.y = (leg.userData.baseY ?? 0.5) + Math.max(0, Math.sin(ph)) * 0.06 * gait;
  }
  if (d.antennae) {
    // antennae sweep constantly — it is how an ant reads the world
    d.antennae.forEach((a, i) => {
      a.rotation.x = Math.sin(t * 3.6 + i * 2.1) * 0.34;
      a.rotation.z = Math.cos(t * 2.9 + i * 1.3) * 0.26;
      if (a.userData.flag) a.userData.flag.rotation.x = -0.95 + Math.sin(t * 5 + i) * 0.22;
    });
  }
  if (d.mandibles) {
    const open = opts.bite ?? (0.5 + Math.sin(t * 2.2) * 0.5) * 0.12;
    d.mandibles.forEach((j, i) => { j.rotation.y = (i ? -1 : 1) * open; });
  }
  if (d.gaster) {
    d.gaster.position.y = 0.56 + Math.sin(t * rate * 0.5) * 0.025;
    d.gaster.rotation.x = (opts.gasterTuck ?? 0);
  }
}

function emissives(mesh) {
  const out = [];
  mesh.traverse((m) => { if (m.isMesh && m.material?.emissive) out.push(m.material); });
  return out;
}

/** Follow the terrain, sliding around soil walls rather than sticking. */
function moveOnTerrain(pos, vel, dt, terrain, radius, need) {
  pos.x += vel.x * dt;
  pos.z += vel.z * dt;
  terrain.resolve(pos, radius, need);
}

// --------------------------------------------------------------- Player ----
export class Player {
  constructor(scene) {
    this.mesh = makeAnt({
      body: 0xb8461c, head: 0xc95322, gaster: 0x2e1609, legs: 0x83381a,
      scale: 1.35, detail: true, hairs: true,
    });
    scene.add(this.mesh);

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.facing = 0;
    this.grounded = true;
    this.level = 0;

    this.health = PLAYER.maxHealth;
    this.stamina = PLAYER.maxStamina;
    this.scent = PLAYER.maxScent;
    this.food = 0;

    this.weapon = 'acid';
    this.ammo = { acid: WEAPONS.acid.ammoStart, bite: 0 };
    this.cooldown = { acid: 0, bite: 0 };

    this.invuln = 0;
    this.hurtFlash = 0;
    this.sprinting = false;
    this.crawling = false;
    this.inWater = false;
    this.swimming = false;
    this.raft = null;          // leaf we are riding
    this.carrying = null;      // larva in the mandibles
    this.hasGland = false;
    this.callCd = 0;
    this.biteAnim = 0;
    this.mats = emissives(this.mesh);
  }

  get gun() { return WEAPONS[this.weapon]; }

  spawnAt(x, y, z, level) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.level = level;
    this.grounded = true;
    this.raft = null;
    this.mesh.position.copy(this.pos);
  }

  update(dt, input, world, camYaw, t, ctx) {
    const lv = world.levels[this.level];
    const terrain = lv.terrain;
    const baseY = world.levelY(this.level);

    // ---- what is under us: soil, a leaf on the flood, or nothing at all? --
    // Over an open shaft there is no floor, so the ground snap has to be
    // skipped entirely or you stand on thin air above the hole.
    const overShaft = world.isOverShaft(this.level, this.pos.x, this.pos.z);
    const groundSoil = baseY + terrain.floorAt(this.pos.x, this.pos.z);
    let ground = overShaft ? -Infinity : groundSoil;
    this.raft = null;
    if (ctx?.rafts) {
      for (const r of ctx.rafts) {
        if (r.level !== this.level || !r.afloat) continue;
        const d = Math.hypot(this.pos.x - r.pos.x, this.pos.z - r.pos.z);
        if (d < r.radius + 0.8 && this.pos.y >= r.topY - 1.8) {
          if (r.topY > ground) { ground = r.topY; this.raft = r; }
        }
      }
    }

    const head = terrain.headAt(this.pos.x, this.pos.z);
    this.crawling = head < CRAWL_HEADROOM;

    // ---- intent, relative to the camera ----------------------------------
    const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
    const right = new THREE.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw));
    const wish = new THREE.Vector3();
    if (input.forward) wish.add(fwd);
    if (input.back) wish.sub(fwd);
    if (input.right) wish.add(right);
    if (input.left) wish.sub(right);
    const moving = wish.lengthSq() > 0.001;
    if (moving) wish.normalize();

    this.sprinting = input.sprint && moving && this.stamina > 1 && !this.swimming && !this.crawling;
    if (this.sprinting) this.stamina = Math.max(0, this.stamina - PLAYER.staminaDrain * dt);
    else this.stamina = Math.min(PLAYER.maxStamina, this.stamina + PLAYER.staminaRegen * dt);

    let top = this.sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
    if (this.crawling) top *= PLAYER.crawlFactor;
    if (this.swimming) top = PLAYER.swimSpeed;
    if (this.carrying) top *= 0.82;             // brood is heavy

    if (moving) {
      this.vel.x += wish.x * PLAYER.accel * dt;
      this.vel.z += wish.z * PLAYER.accel * dt;
      const s = Math.hypot(this.vel.x, this.vel.z);
      if (s > top) { this.vel.x *= top / s; this.vel.z *= top / s; }
      this.facing = Math.atan2(wish.x, wish.z);
    } else {
      const f = Math.max(0, 1 - PLAYER.friction * dt);
      this.vel.x *= f; this.vel.z *= f;
    }

    if (input.jump && this.grounded && !this.crawling) {
      this.vel.y = PLAYER.jumpSpeed;
      this.grounded = false;
      input.jump = false;
    }

    this.vel.y -= PLAYER.gravity * dt;
    if (this.swimming) this.vel.y = Math.max(this.vel.y, -3.2);

    // ---- integrate --------------------------------------------------------
    const need = MIN_HEADROOM * 0.72;
    moveOnTerrain(this.pos, this.vel, dt, terrain, PLAYER.radius, need);
    this.pos.y += this.vel.y * dt;

    // a leaf we are standing on carries us with it
    if (this.raft) {
      this.pos.x += this.raft.drift.x * dt;
      this.pos.z += this.raft.drift.z * dt;
    }

    if (this.pos.y <= ground) {
      this.pos.y = ground;
      this.vel.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }

    // do not let the ceiling swallow us — but never while dropping down a shaft
    if (!overShaft) {
      const ceil = baseY + terrain.ceilAt(this.pos.x, this.pos.z) - 0.6;
      if (this.pos.y > ceil) { this.pos.y = ceil; this.vel.y = Math.min(this.vel.y, 0); }
    }

    // ---- scent sense ------------------------------------------------------
    if (input.scent && this.scent > 0) {
      this.scent = Math.max(0, this.scent - PLAYER.scentDrain * dt);
    } else {
      this.scent = Math.min(PLAYER.maxScent, this.scent + PLAYER.scentRegen * dt);
    }

    // ---- present ----------------------------------------------------------
    this.mesh.position.copy(this.pos);
    const turn = this.facing - this.mesh.rotation.y;
    this.mesh.rotation.y += Math.atan2(Math.sin(turn), Math.cos(turn)) * Math.min(1, dt * 17);
    // tilt to follow the slope of the hill underfoot
    const e = 1.4;
    const sx = terrain.floorAt(this.pos.x + e, this.pos.z) - terrain.floorAt(this.pos.x - e, this.pos.z);
    const sz = terrain.floorAt(this.pos.x, this.pos.z + e) - terrain.floorAt(this.pos.x, this.pos.z - e);
    const tgtPitch = this.grounded ? Math.atan2(-sz, 2 * e) : 0;
    const tgtRoll = this.grounded ? Math.atan2(sx, 2 * e) : 0;
    this.mesh.rotation.x += (tgtPitch - this.mesh.rotation.x) * Math.min(1, dt * 7);
    this.mesh.rotation.z += (tgtRoll - this.mesh.rotation.z) * Math.min(1, dt * 7);

    const gait = Math.min(1, Math.hypot(this.vel.x, this.vel.z) / PLAYER.sprintSpeed);
    if (this.biteAnim > 0) this.biteAnim -= dt;
    animateAnt(this.mesh, t, this.grounded ? gait : 0.12, {
      bite: this.biteAnim > 0 ? 0.65 : undefined,
      gasterTuck: this.weapon === 'acid' && this.cooldown.acid > 0.05 ? -0.5 : 0,
    });

    // the carried larva rides under the head
    if (this.carrying) {
      this.carrying.mesh.position.set(
        this.pos.x + Math.sin(this.facing) * 1.7,
        this.pos.y + 0.7,
        this.pos.z + Math.cos(this.facing) * 1.7
      );
      this.carrying.mesh.rotation.y = this.facing;
    }

    for (const k of Object.keys(this.cooldown)) if (this.cooldown[k] > 0) this.cooldown[k] -= dt;
    if (this.callCd > 0) this.callCd -= dt;
    const w = WEAPONS.acid;
    if (this.ammo.acid < w.ammoMax) this.ammo.acid = Math.min(w.ammoMax, this.ammo.acid + w.regen * dt);

    if (this.invuln > 0) this.invuln -= dt;
    if (this.hurtFlash > 0) {
      this.hurtFlash -= dt;
      for (const m of this.mats) m.emissiveIntensity = Math.max(0, this.hurtFlash) * 3;
    }
  }

  damage(amount) {
    if (this.invuln > 0) return false;
    this.health = Math.max(0, this.health - amount);
    this.invuln = PLAYER.invulnTime;
    this.hurtFlash = 0.3;
    for (const m of this.mats) m.emissive.setHex(0xff2200);
    return true;
  }

  drown(a) {
    this.health = Math.max(0, this.health - a);
    this.hurtFlash = 0.2;
    for (const m of this.mats) m.emissive.setHex(0x2a7fa0);
  }

  heal(v) { this.health = Math.min(PLAYER.maxHealth, this.health + v); }
  giveAcid(v) { this.ammo.acid = Math.min(WEAPONS.acid.ammoMax, this.ammo.acid + v); }
}

// ---------------------------------------------------------------- Enemy ----
export class Enemy {
  constructor(typeKey, scene, world, level, spot) {
    const cfg = ENEMY_TYPES[typeKey];
    this.type = typeKey;
    this.cfg = cfg;
    this.mesh = makeAnt({
      body: cfg.body, head: cfg.head, gaster: cfg.gaster, legs: cfg.legs,
      scale: cfg.scale, detail: cfg.scale > 1.4,
    });
    scene.add(this.mesh);
    this.mats = emissives(this.mesh);

    const terrain = world.terrainOf(level);
    this.pos = new THREE.Vector3(spot.x, world.levelY(level) + terrain.floorAt(spot.x, spot.z), spot.z);
    this.vel = new THREE.Vector3();
    this.level = level;
    this.hp = cfg.hp;
    this.maxHp = cfg.hp;

    // guards hold a chamber; scouts wander the whole nest
    this.home = cfg.guard ? terrain.roomAt(spot.x, spot.z) : null;
    this.state = 'patrol';
    this.goal = terrain.randomPoint();
    this.waypoint = null;
    this.repath = 0;
    this.memory = 0;
    this.attackTimer = 0;
    this.rooted = 0;
    this.flash = 0;
    this.dead = false;
    this.biteAnim = 0;
    this.mesh.position.copy(this.pos);
  }

  update(dt, ctx, t) {
    if (this.dead) return;
    const { player, world, alarm } = ctx;
    const cfg = this.cfg;
    const terrain = world.terrainOf(this.level);
    const baseY = world.levelY(this.level);

    if (this.rooted > 0) this.rooted -= dt;
    if (this.flash > 0) {
      this.flash -= dt;
      for (const m of this.mats) { m.emissive.setHex(0xff3a10); m.emissiveIntensity = this.flash * 4; }
    } else {
      for (const m of this.mats) m.emissiveIntensity = 0;
    }

    const same = player.level === this.level;
    const to = new THREE.Vector3().subVectors(player.pos, this.pos);
    const dist = to.length();
    const sight = cfg.sight + alarm * ctx.alarmSightBonus;

    // ---- perception: eyes need a clear tunnel, ears do not ---------------
    let sees = false;
    if (same && dist < sight) {
      sees = terrain.clearLine(this.pos.x, this.pos.z, player.pos.x, player.pos.z);
    }
    const hears = same && dist < cfg.hearing && (player.sprinting || ctx.playerNoisy);
    if (sees || hears) { this.memory = 4.5; ctx.sighted = true; }
    else if (this.memory > 0) this.memory -= dt;
    this.state = this.memory > 0 ? 'hunt' : 'patrol';

    // ---- where am I going -------------------------------------------------
    this.repath -= dt;
    if (this.repath <= 0) {
      this.repath = 0.4 + Math.random() * 0.25;
      if (this.state === 'hunt') {
        this.goal = { x: player.pos.x, z: player.pos.z };
      } else if (Math.hypot(this.goal.x - this.pos.x, this.goal.z - this.pos.z) < 4) {
        this.goal = this.home ? terrain.pointInRoom(this.home) : terrain.randomPoint();
      }
      const node = terrain.routeStep(this.pos.x, this.pos.z, this.goal.x, this.goal.z, ctx.blockedNodes);
      this.waypoint = node ? { x: node.x, z: node.z } : null;
    }

    const aim = this.waypoint ?? this.goal;
    const dx = aim.x - this.pos.x, dz = aim.z - this.pos.z;
    const len = Math.hypot(dx, dz) || 1;

    const speed = this.rooted > 0 ? 0
      : cfg.speed * (this.state === 'hunt' ? 1 : 0.45) * (1 + alarm * (ctx.alarmSpeedBonus - 1));

    this.vel.x += (dx / len) * speed * dt * 12;
    this.vel.z += (dz / len) * speed * dt * 12;
    const s = Math.hypot(this.vel.x, this.vel.z);
    if (s > speed) { this.vel.x *= speed / s; this.vel.z *= speed / s; }

    moveOnTerrain(this.pos, this.vel, dt, terrain, cfg.bodyRadius * 0.6, MIN_HEADROOM * 0.7);
    this.pos.y = baseY + terrain.floorAt(this.pos.x, this.pos.z);
    this.mesh.position.copy(this.pos);

    if (s > 0.1) {
      const want = Math.atan2(dx / len, dz / len);
      const turn = want - this.mesh.rotation.y;
      this.mesh.rotation.y += Math.atan2(Math.sin(turn), Math.cos(turn)) * Math.min(1, dt * 9);
    }
    if (this.biteAnim > 0) this.biteAnim -= dt;
    animateAnt(this.mesh, t, this.rooted > 0 ? 0.05 : (this.state === 'hunt' ? 1 : 0.35),
      { bite: this.biteAnim > 0 ? 0.7 : undefined });

    // ---- bite --------------------------------------------------------------
    this.attackTimer -= dt;
    if (same && this.rooted <= 0 && dist < cfg.contact &&
        Math.abs(player.pos.y - this.pos.y) < 3 && this.attackTimer <= 0) {
      if (player.damage(cfg.damage)) {
        this.attackTimer = cfg.attackCd;
        this.biteAnim = 0.3;
        const push = to.clone().setY(0).normalize().multiplyScalar(7);
        player.vel.x += push.x; player.vel.z += push.z;
        ctx.onHit?.(this);
      }
    }

    // recruits fight back
    if (ctx.recruits && this.rooted <= 0 && this.attackTimer <= 0) {
      for (const r of ctx.recruits) {
        if (r.dead || r.level !== this.level) continue;
        if (this.pos.distanceTo(r.pos) < cfg.contact) {
          r.hp -= cfg.damage;
          this.attackTimer = cfg.attackCd;
          this.biteAnim = 0.3;
          if (r.hp <= 0) r.dead = true;
          break;
        }
      }
    }
  }

  hurt(amount, root = 0) {
    this.hp -= amount;
    this.flash = 0.25;
    if (root) this.rooted = Math.max(this.rooted, root);
    if (this.hp <= 0) { this.dead = true; return true; }
    return false;
  }

  dispose(scene) { scene.remove(this.mesh); }
}

// -------------------------------------------------------------- Recruit ----
/**
 * A nestmate answering the call. Follows you, bites what you are fighting,
 * and joins a hauling crew at a stone plug. Greets you with an antennal
 * tap when it arrives, the way ants identify each other.
 */
export class Recruit {
  constructor(scene, world, level, spot, player) {
    this.mesh = makeAnt({
      body: 0xa8481e, head: 0xbb5524, gaster: 0x33190a, legs: 0x7d3a1a,
      scale: 1.15, detail: false,
    });
    scene.add(this.mesh);
    const terrain = world.terrainOf(level);
    this.pos = new THREE.Vector3(spot.x, world.levelY(level) + terrain.floorAt(spot.x, spot.z), spot.z);
    this.vel = new THREE.Vector3();
    this.level = level;
    this.player = player;
    this.hp = RECRUIT.hp;
    this.life = RECRUIT.life;
    this.dead = false;
    this.job = null;          // a StonePlug it is hauling
    this.greeted = false;
    this.greetTimer = 0;
    this.attackCd = 0;
    this.mesh.position.copy(this.pos);
  }

  update(dt, ctx, t) {
    if (this.dead) return;
    this.life -= dt;
    if (this.life <= 0) { this.dead = true; return; }

    const { world, enemies } = ctx;
    const terrain = world.terrainOf(this.level);
    const baseY = world.levelY(this.level);
    const player = this.player;

    // pick the nearest job: a plug being worked, else an enemy, else the player
    let target = null, mode = 'follow';
    if (this.job && !this.job.cleared) {
      target = { x: this.job.pos.x, z: this.job.pos.z };
      mode = 'haul';
    } else {
      let bd = 26 * 26;
      for (const e of enemies) {
        if (e.dead || e.level !== this.level) continue;
        const d = (e.pos.x - this.pos.x) ** 2 + (e.pos.z - this.pos.z) ** 2;
        if (d < bd) { bd = d; target = e; mode = 'fight'; }
      }
      if (!target) { target = { x: player.pos.x, z: player.pos.z }; mode = 'follow'; }
    }

    const tx = target.pos ? target.pos.x : target.x;
    const tz = target.pos ? target.pos.z : target.z;
    const dist = Math.hypot(tx - this.pos.x, tz - this.pos.z);

    const stop = mode === 'fight' ? 2.2 : (mode === 'haul' ? 3.4 : 5.0);
    let aimX = tx, aimZ = tz;
    if (!terrain.clearLine(this.pos.x, this.pos.z, tx, tz)) {
      const n = terrain.routeStep(this.pos.x, this.pos.z, tx, tz, ctx.blockedNodes);
      if (n) { aimX = n.x; aimZ = n.z; }
    }

    if (dist > stop) {
      const dx = aimX - this.pos.x, dz = aimZ - this.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const sp = RECRUIT.speed * (dist > 16 ? 1.25 : 1);
      this.vel.x += (dx / len) * sp * dt * 14;
      this.vel.z += (dz / len) * sp * dt * 14;
      const s = Math.hypot(this.vel.x, this.vel.z);
      if (s > sp) { this.vel.x *= sp / s; this.vel.z *= sp / s; }
    } else {
      this.vel.x *= 0.82; this.vel.z *= 0.82;
    }

    moveOnTerrain(this.pos, this.vel, dt, terrain, 0.8, MIN_HEADROOM * 0.7);
    this.pos.y = baseY + terrain.floorAt(this.pos.x, this.pos.z);
    this.mesh.position.copy(this.pos);

    const s = Math.hypot(this.vel.x, this.vel.z);
    if (s > 0.1) {
      const want = Math.atan2(this.vel.x, this.vel.z);
      const turn = want - this.mesh.rotation.y;
      this.mesh.rotation.y += Math.atan2(Math.sin(turn), Math.cos(turn)) * Math.min(1, dt * 11);
    }

    // antennation: a quick face-to-face tap when it first reaches you
    if (!this.greeted && mode === 'follow' && dist < 6) {
      this.greeted = true;
      this.greetTimer = 0.9;
    }
    if (this.greetTimer > 0) this.greetTimer -= dt;

    animateAnt(this.mesh, t, Math.min(1, s / RECRUIT.speed),
      { bite: this.greetTimer > 0 ? 0.5 : undefined });

    // bite whatever it caught up with
    this.attackCd -= dt;
    if (mode === 'fight' && dist < 2.8 && this.attackCd <= 0) {
      this.attackCd = 0.75;
      if (target.hurt(RECRUIT.damage)) ctx.onRecruitKill?.(target);
    }
  }

  dispose(scene) { scene.remove(this.mesh); }
}

// -------------------------------------------------------------- Replete ----
/**
 * A honeypot ant hanging in a larder chamber. Walk up and drink: trophallaxis,
 * exactly as the workers in the film do. The bead visibly empties.
 */
export class Replete {
  constructor(scene, world, level, spot) {
    this.mesh = makeReplete(1.5);
    const terrain = world.terrainOf(level);
    const baseY = world.levelY(level);
    const ceil = terrain.ceilAt(spot.x, spot.z);
    const floor = terrain.floorAt(spot.x, spot.z);
    // hangs from the roof, low enough that a worker on the floor can reach it
    const hang = Math.min(ceil - 1.6, floor + 4.2);
    this.pos = new THREE.Vector3(spot.x, baseY + Math.max(floor + 2.4, hang), spot.z);
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.z = Math.PI;         // hanging upside down
    this.mesh.rotation.y = Math.random() * 6.28;
    scene.add(this.mesh);

    this.level = level;
    this.charges = 2;
    this.drinking = 0;
    this.sway = Math.random() * 6.28;
  }

  get empty() { return this.charges <= 0; }

  update(dt, t) {
    this.sway += dt;
    this.mesh.position.y = this.pos.y + Math.sin(this.sway * 0.8) * 0.12;
    this.mesh.rotation.y += dt * 0.12;
    const f = this.charges / 2;
    const bead = this.mesh.userData.bead;
    const want = 0.35 + f * 0.65;
    bead.scale.setScalar(bead.scale.x + (want - bead.scale.x) * Math.min(1, dt * 3));
    this.mesh.userData.glow.intensity = 9 * (0.25 + f * 0.75);
    this.mesh.userData.honeyMat.emissiveIntensity = 0.65 * (0.3 + f * 0.7);
  }

  dispose(scene) { scene.remove(this.mesh); }
}

// ---------------------------------------------------------------- Larva ----
export class Larva {
  constructor(scene, world, level, spot) {
    this.mesh = makeLarva();
    const terrain = world.terrainOf(level);
    this.pos = new THREE.Vector3(
      spot.x, world.levelY(level) + terrain.floorAt(spot.x, spot.z) + 0.1, spot.z);
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = Math.random() * 6.28;
    this.mesh.scale.setScalar(1.5);
    scene.add(this.mesh);
    this.level = level;
    this.carried = false;
    this.delivered = false;
    this.wriggle = Math.random() * 6.28;
  }

  update(dt, t) {
    this.wriggle += dt;
    if (!this.carried) {
      this.mesh.rotation.z = Math.sin(this.wriggle * 1.4) * 0.09;
      this.mesh.position.y = this.pos.y + Math.abs(Math.sin(this.wriggle * 0.9)) * 0.06;
    } else {
      this.mesh.rotation.z = Math.sin(this.wriggle * 5) * 0.2;
    }
  }

  dispose(scene) { scene.remove(this.mesh); }
}

// ----------------------------------------------------------- Stone plug ----
/**
 * A cave-in sealing a tunnel. One ant cannot shift it; a hauling crew can.
 * Cooperative transport, which is how ants move anything heavy.
 */
export class StonePlug {
  constructor(scene, world, level, tunnel) {
    this.tunnel = tunnel;
    this.level = level;
    const terrain = world.terrainOf(level);
    const mx = (tunnel.x1 + tunnel.x2) / 2;
    const mz = (tunnel.z1 + tunnel.z2) / 2;
    this.pos = new THREE.Vector3(mx, world.levelY(level) + terrain.floorAt(mx, mz), mz);

    this.mesh = makeStonePlug(world.levels[level].rng);
    this.mesh.position.copy(this.pos);
    const ang = Math.atan2(tunnel.z2 - tunnel.z1, tunnel.x2 - tunnel.x1);
    this.mesh.rotation.y = -ang;
    this.mesh.scale.set(1, 1, Math.max(1, tunnel.w / 3.2));
    scene.add(this.mesh);

    this.radius = tunnel.w * 0.9;
    this.progress = 0;
    this.cleared = false;
    this.crew = 0;
    this.node = tunnel.node;
  }

  /** Advance the dig if enough ants are on it. Returns true the moment it opens. */
  work(dt, crewCount) {
    this.crew = crewCount;
    if (this.cleared) return false;
    if (crewCount < RECRUIT.hauling) return false;
    this.progress += dt * (1 + (crewCount - RECRUIT.hauling) * 0.35);
    // stones visibly shuffle aside as the crew works
    const f = Math.min(1, this.progress / RECRUIT.haulTime);
    for (const s of this.mesh.userData.stones) {
      const h = s.userData.home;
      s.position.x = h.x * (1 + f * 2.2);
      s.position.y = h.y * (1 - f * 0.85);
      s.position.z = h.z * (1 + f * 1.4);
      s.rotation.x = f * 4;
    }
    if (this.progress >= RECRUIT.haulTime) {
      this.cleared = true;
      return true;
    }
    return false;
  }

  blocks(x, z) {
    if (this.cleared) return false;
    return Math.hypot(x - this.pos.x, z - this.pos.z) < this.radius;
  }

  dispose(scene) { scene.remove(this.mesh); }
}

// ------------------------------------------------------------ Leaf raft ----
/** A fallen leaf. Dry it is scenery; flooded it is a boat. */
export class LeafRaft {
  constructor(mesh, level, world) {
    this.mesh = mesh;
    this.level = level;
    // The leaf hangs off the level group, so its own position is local. Water
    // levels and the player are in world space, so keep the raft in world
    // space and convert back when writing the mesh.
    this.baseY = world.levelY(level);
    this.pos = new THREE.Vector3(mesh.position.x, this.baseY + mesh.position.y, mesh.position.z);
    this.groundY = this.pos.y;
    this.radius = 2.5 * (mesh.scale.x || 1);
    this.afloat = false;
    this.topY = this.groundY;
    this.drift = new THREE.Vector3();
    this.bob = Math.random() * 6.28;
    this.spin = (Math.random() - 0.5) * 0.25;
  }

  update(dt, waterY, terrain, baseY, t) {
    this.bob += dt;
    const float = waterY !== null && waterY > this.groundY + 0.25;
    this.afloat = float;

    if (float) {
      const target = waterY + 0.18;
      this.pos.y += (target - this.pos.y) * Math.min(1, dt * 3.5);
      // drifts on the current — enough that riding one actually takes you places
      const cur = 4.2;
      this.drift.set(Math.sin(t * 0.21 + this.bob) * cur, 0, Math.cos(t * 0.17 + this.bob) * cur);
      this.pos.x += this.drift.x * dt;
      this.pos.z += this.drift.z * dt;
      terrain.resolve(this.pos, this.radius * 0.5, MIN_HEADROOM * 0.6);
      this.mesh.rotation.y += this.spin * dt;
      this.mesh.rotation.z = Math.sin(this.bob * 1.3) * 0.045;
      this.mesh.rotation.x = Math.cos(this.bob * 1.1) * 0.045;
    } else {
      this.drift.set(0, 0, 0);
      this.pos.y += (this.groundY - this.pos.y) * Math.min(1, dt * 4);
      this.mesh.rotation.z *= 0.9;
      this.mesh.rotation.x *= 0.9;
    }
    this.topY = this.pos.y + 0.2;
    this.mesh.position.set(this.pos.x, this.pos.y - this.baseY, this.pos.z);
  }
}

// --------------------------------------------------------------- Pickups ----
export class Pickup {
  constructor(key, scene, world, level, spot) {
    this.def = PICKUP_TYPES[key];
    this.key = key;
    this.mesh = makePickup(this.def.color);
    const terrain = world.terrainOf(level);
    this.pos = new THREE.Vector3(
      spot.x, world.levelY(level) + terrain.floorAt(spot.x, spot.z) + 1.0, spot.z);
    this.mesh.position.copy(this.pos);
    this.level = level;
    this.spin = Math.random() * 6.28;
    scene.add(this.mesh);
  }

  update(dt, t) {
    this.spin += dt * 2;
    this.mesh.rotation.y = this.spin;
    this.mesh.position.y = this.pos.y + Math.sin(t * 2.3 + this.spin) * 0.22;
    this.mesh.userData.halo.scale.setScalar(1 + Math.sin(t * 3 + this.spin) * 0.09);
  }

  dispose(scene) { scene.remove(this.mesh); }
}

/** The recruitment gland: the power that makes hauling crews possible. */
export class Gland {
  constructor(scene, world, level, spot) {
    this.mesh = makeGland();
    const terrain = world.terrainOf(level);
    this.pos = new THREE.Vector3(
      spot.x, world.levelY(level) + terrain.floorAt(spot.x, spot.z) + 1.6, spot.z);
    this.mesh.position.copy(this.pos);
    this.level = level;
    this.t = 0;
    scene.add(this.mesh);
  }

  update(dt, t) {
    this.t += dt;
    this.mesh.position.y = this.pos.y + Math.sin(this.t * 1.5) * 0.3;
    this.mesh.userData.core.rotation.y += dt * 0.8;
    this.mesh.userData.rings.forEach((r, i) => {
      r.rotation.x += dt * (0.4 + i * 0.25);
      r.rotation.y += dt * (0.3 - i * 0.1);
    });
  }

  dispose(scene) { scene.remove(this.mesh); }
}
