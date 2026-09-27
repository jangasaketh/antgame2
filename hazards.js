// ---------------------------------------------------------------------------
// hazards.js — the burrow turning on you.
//
// The flood matters because the floor is not flat: as the water climbs, the
// soil hills become islands and the fallen leaves come loose and float.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { SPAN, MIN_HEADROOM } from './config.js';

export class Flood {
  constructor(scene, world, levelIndex) {
    this.world = world;
    this.level = levelIndex;
    const lv = world.levels[levelIndex];
    this.baseY = lv.y;
    this.terrain = lv.terrain;

    // high enough to drown the low ground, low enough to leave hilltops dry
    let maxHill = 0;
    for (const h of this.terrain.hills) maxHill = Math.max(maxHill, h.h);
    this.maxHeight = Math.max(3.2, maxHill * 0.78);

    this.height = -1.0;
    this.phase = 'dry';
    this.timer = 22;
    this.warned = false;

    const geo = new THREE.PlaneGeometry(SPAN, SPAN, 48, 48);
    geo.rotateX(-Math.PI / 2);
    this.geo = geo;
    this.base = Float32Array.from(geo.attributes.position.array);

    this.mesh = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
      color: 0x2f6a74, roughness: 0.08, metalness: 0.2,
      transparent: true, opacity: 0.74,
      transmission: 0, clearcoat: 1, clearcoatRoughness: 0.05,
      emissive: 0x0b2a2e, emissiveIntensity: 0.5,
      side: THREE.DoubleSide,
    }));
    this.mesh.position.y = this.baseY - 1;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  get surfaceY() { return this.baseY + this.height; }

  /** Water level in world space, or null when the level is dry. */
  get activeY() { return this.height > -0.9 ? this.surfaceY : null; }

  update(dt, player, t, notify) {
    this.timer -= dt;
    if (this.timer <= 0) {
      if (this.phase === 'dry') {
        this.phase = 'rising'; this.timer = 11;
        notify?.('Water is coming through. Get onto a leaf or up a hill.', 'warn');
      } else if (this.phase === 'rising') {
        this.phase = 'deep'; this.timer = 9;
      } else if (this.phase === 'deep') {
        this.phase = 'draining'; this.timer = 8;
        notify?.('The water is draining away.', 'calm');
      } else {
        this.phase = 'dry'; this.timer = 30 + Math.random() * 12;
      }
    }

    const target = (this.phase === 'rising' || this.phase === 'deep') ? this.maxHeight : -1.0;
    const rate = this.phase === 'rising' ? 0.85 : this.phase === 'draining' ? 0.9 : 3;
    this.height += (target - this.height) * Math.min(1, dt * rate);

    this.mesh.visible = this.height > -0.85;
    if (this.mesh.visible) {
      this.mesh.position.y = this.surfaceY;
      // ripple the surface so it reads as moving water
      const pos = this.geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = this.base[i * 3], z = this.base[i * 3 + 2];
        pos.setY(i, Math.sin(x * 0.07 + t * 1.7) * 0.16 + Math.cos(z * 0.09 - t * 1.3) * 0.13);
      }
      pos.needsUpdate = true;
    }

    if (player.level !== this.level) { player.swimming = false; return; }

    const depth = this.surfaceY - player.pos.y;
    player.inWater = depth > 0.3;
    // riding a leaf keeps you out of it entirely
    if (player.raft) { player.swimming = false; return; }
    player.swimming = depth > 1.4;
    // only actually drowning once your head is under
    if (depth > 2.8) player.drown(15 * dt);
    if (player.inWater && !player.swimming) {
      player.vel.x *= 0.97;
      player.vel.z *= 0.97;
    }
  }

  dispose(scene) { scene.remove(this.mesh); this.geo.dispose(); }
}

/** Roof falls. Marked first, so it is a dodge, not a coin flip. */
export class Collapse {
  constructor(scene, world, levelIndex, interval = 5.0) {
    this.scene = scene;
    this.world = world;
    this.level = levelIndex;
    const lv = world.levels[levelIndex];
    this.baseY = lv.y;
    this.terrain = lv.terrain;
    this.interval = interval;
    this.timer = 5;
    this.events = [];
  }

  #spawn() {
    const p = this.terrain.randomPoint();
    const fy = this.baseY + this.terrain.floorAt(p.x, p.z);
    const head = this.terrain.headAt(p.x, p.z);
    if (head < MIN_HEADROOM + 1) return;
    const radius = 2.4 + Math.random() * 2.0;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.68, radius, 26),
      new THREE.MeshBasicMaterial({
        color: 0xff6a2a, transparent: true, opacity: 0.8,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(p.x, fy + 0.14, p.z);
    this.scene.add(ring);

    const rock = new THREE.Mesh(
      new THREE.DodecahedronGeometry(radius * 0.85, 0),
      new THREE.MeshStandardMaterial({ color: 0x533b25, roughness: 1, flatShading: true })
    );
    rock.position.set(p.x, fy + head - 0.5, p.z);
    this.scene.add(rock);

    // dust sifting down before it goes
    const dustGeo = new THREE.BufferGeometry();
    const n = 26;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = p.x + (Math.random() - 0.5) * radius * 2;
      arr[i * 3 + 1] = fy + Math.random() * head;
      arr[i * 3 + 2] = p.z + (Math.random() - 0.5) * radius * 2;
    }
    dustGeo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
      color: 0xb59a76, size: 0.22, transparent: true, opacity: 0.6, depthWrite: false,
    }));
    this.scene.add(dust);

    this.events.push({
      ring, rock, dust, dustGeo, x: p.x, z: p.z, fy, radius,
      warn: 1.4, vy: 0, landed: false, life: 4.5,
    });
  }

  update(dt, player, notify, onImpact) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.#spawn();
      this.timer = this.interval * (0.65 + Math.random() * 0.8);
    }

    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];

      // dust always falls
      const dp = e.dustGeo.attributes.position;
      for (let k = 0; k < dp.count; k++) {
        let y = dp.getY(k) - dt * 2.4;
        if (y < e.fy) y = e.fy + e.radius * 2;
        dp.setY(k, y);
      }
      dp.needsUpdate = true;

      if (e.warn > 0) {
        e.warn -= dt;
        e.ring.material.opacity = 0.35 + Math.abs(Math.sin(e.warn * 13)) * 0.5;
        continue;
      }

      if (!e.landed) {
        e.vy -= 52 * dt;
        e.rock.position.y += e.vy * dt;
        e.rock.rotation.x += dt * 2.6;
        e.rock.rotation.z += dt * 1.3;
        if (e.rock.position.y <= e.fy + e.radius * 0.45) {
          e.rock.position.y = e.fy + e.radius * 0.45;
          e.landed = true;
          e.ring.material.opacity = 0;
          onImpact?.(0.5);
          if (player.level === this.level &&
              Math.hypot(player.pos.x - e.x, player.pos.z - e.z) < e.radius + 1.2) {
            player.damage(34);
          }
        }
        continue;
      }

      e.life -= dt;
      e.dust.material.opacity = Math.max(0, e.life / 4.5) * 0.6;
      if (e.life <= 0) {
        this.scene.remove(e.ring, e.rock, e.dust);
        e.dustGeo.dispose();
        this.events.splice(i, 1);
      }
    }
  }

  dispose(scene) {
    for (const e of this.events) {
      scene.remove(e.ring, e.rock, e.dust);
      e.dustGeo.dispose();
    }
    this.events.length = 0;
  }
}
