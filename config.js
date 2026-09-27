// ---------------------------------------------------------------------------
// config.js — every tunable number.
//
// The colony is a BURROW, not a maze: rounded chambers of varying size joined
// by tunnels of varying width, with soil hills rising from the floor. Walls
// are where the ceiling sinks down to meet the floor, so nothing is a box.
// ---------------------------------------------------------------------------

export const SPAN = 300;          // world units across one burrow level
export const FIELD = 220;         // heightfield resolution (FIELD x FIELD)
export const LEVEL_DROP = 26;     // vertical gap between levels
export const SHAFT_RADIUS = 4.2;

// Headroom below this is solid soil you cannot enter.
export const MIN_HEADROOM = 2.6;
export const CRAWL_HEADROOM = 4.0;   // below this you are squeezing; slower

export const PLAYER = {
  walkSpeed: 11.5,
  sprintSpeed: 18.5,
  crawlFactor: 0.55,
  accel: 78,
  friction: 15,
  jumpSpeed: 12.5,
  gravity: 30,
  radius: 1.0,
  height: 2.2,
  stepUp: 1.9,           // how tall a lip the ant climbs without jumping
  maxHealth: 160,

  maxStamina: 100,
  staminaDrain: 19,
  staminaRegen: 24,

  maxScent: 100,         // pheromone sense fuel
  scentDrain: 26,
  scentRegen: 7,

  invulnTime: 0.6,
  swimSpeed: 6.0,
};

export const WEAPONS = {
  acid: {
    key: 'acid', name: 'Formic acid', kind: 'hitscan',
    damage: 38, crit: 2.0, rate: 0.14, range: 95,
    ammoMax: 70, ammoStart: 70, regen: 2.2,
    tint: 0xf6ef7a, hue: '#f2d54a',
  },
  bite: {
    key: 'bite', name: 'Mandibles', kind: 'melee',
    damage: 55, crit: 1.6, rate: 0.5, range: 4.6, arc: 1.1,
    ammoMax: 0, ammoStart: 0, regen: 0,
    tint: 0xffb37a, hue: '#e08a4a',
  },
};

// Ants only. Species chosen to look distinct at a glance.
export const ENEMY_TYPES = {
  scout: {
    label: 'Black scout', speed: 9.2, hp: 38, damage: 9,
    bodyRadius: 1.0, headY: 1.2, sight: 46, hearing: 20, contact: 2.6,
    attackCd: 0.8, scale: 1.0, drop: 0.5, guard: false,
    body: 0x1a1a22, head: 0x2b2b34, legs: 0x101015, gaster: 0x0e0e14,
  },
  soldier: {
    label: 'Black soldier', speed: 7.8, hp: 78, damage: 16,
    bodyRadius: 1.35, headY: 1.6, sight: 50, hearing: 24, contact: 3.1,
    attackCd: 1.0, scale: 1.5, drop: 0.7, guard: true,
    body: 0x17171f, head: 0x4a3524, legs: 0x0d0d12, gaster: 0x0c0c12,
  },
  bullet: {
    label: 'Bullet ant', speed: 12.6, hp: 56, damage: 20,
    bodyRadius: 1.1, headY: 1.35, sight: 54, hearing: 30, contact: 2.7,
    attackCd: 0.6, scale: 1.25, drop: 0.8, guard: false,
    body: 0x2e1810, head: 0x47281b, legs: 0x180c07, gaster: 0x241009,
  },
  major: {
    label: 'Elephant ant', speed: 5.6, hp: 165, damage: 30,
    bodyRadius: 2.1, headY: 2.5, sight: 44, hearing: 26, contact: 4.0,
    attackCd: 1.3, scale: 2.5, drop: 1.0, guard: true,
    body: 0x3e2d1d, head: 0x63492c, legs: 0x261b11, gaster: 0x2c2013,
  },
};

export const PICKUP_TYPES = {
  crumb:  { kind: 'food', value: 1, color: 0xd8b271, label: 'Leaf crumb' },
  seed:   { kind: 'food', value: 2, color: 0xc08a48, label: 'Seed' },
  acid:   { kind: 'acid', value: 20, color: 0xf2d54a, label: 'Honeydew' },
  nectar: { kind: 'heal', value: 50, color: 0xf06a8a, label: 'Nectar' },
};

// Chamber identities. Landmarks are how you navigate a burrow — every chamber
// looks different so you can orient yourself without a map.
export const ROOM_KINDS = [
  'brood',    // pale larvae and pupae in rows
  'larder',   // honeypot repletes hanging from the ceiling
  'fungus',   // grey-green fungus combs on mounds
  'granary',  // seed husks heaped up
  'midden',   // refuse pile: husks, dead ants, dark soil
  'gallery',  // plain tall chamber with root columns
];

export const LEVELS = [
  {
    name: 'Entrance galleries',
    tagline: 'Follow the tunnels down. Scouts work these galleries.',
    foodNeeded: 6,
    rooms: 6, roomMin: 19, roomMax: 30, tunnelMin: 5.5, tunnelMax: 9,
    height: [7, 14], hills: 7, loops: 2,
    fog: 0x2a1c10, fogDensity: 0.021, lamp: 0xffb45e, soil: 0x6b4f30,
    enemies: { scout: 7 },
    pickups: { crumb: 9, seed: 4, acid: 4, nectar: 2 },
    repletes: 3, larvae: 4,
    hazards: [],
  },
  {
    name: 'Cistern galleries',
    tagline: 'Rain is getting in. When the water comes, ride a leaf.',
    foodNeeded: 8,
    rooms: 7, roomMin: 21, roomMax: 33, tunnelMin: 6, tunnelMax: 10,
    height: [8, 15], hills: 9, loops: 3,
    fog: 0x16292c, fogDensity: 0.022, lamp: 0x86cfdd, soil: 0x5b5340,
    enemies: { scout: 6, soldier: 3 },
    pickups: { crumb: 10, seed: 5, acid: 5, nectar: 2 },
    repletes: 3, larvae: 4, leaves: 7,
    hazards: ['flood'],
  },
  {
    name: 'The blocked deep',
    tagline: 'Cave-ins have sealed the way down. You cannot shift stone alone.',
    foodNeeded: 9,
    rooms: 7, roomMin: 20, roomMax: 32, tunnelMin: 5.5, tunnelMax: 9.5,
    height: [7, 14], hills: 8, loops: 3,
    fog: 0x24170d, fogDensity: 0.023, lamp: 0xf0a860, soil: 0x6a4a2c,
    enemies: { scout: 6, soldier: 4, bullet: 2 },
    pickups: { crumb: 10, seed: 6, acid: 6, nectar: 3 },
    repletes: 4, larvae: 5,
    hazards: ['blockade'],
  },
  {
    name: 'Fungus deeps',
    tagline: 'The combs are guarded. Majors patrol between the mounds.',
    foodNeeded: 11,
    rooms: 8, roomMin: 22, roomMax: 34, tunnelMin: 6, tunnelMax: 10,
    height: [8, 16], hills: 10, loops: 4,
    fog: 0x1d2a1a, fogDensity: 0.022, lamp: 0x9fe08a, soil: 0x55603c,
    enemies: { scout: 6, soldier: 5, bullet: 3, major: 1 },
    pickups: { crumb: 11, seed: 7, acid: 6, nectar: 3 },
    repletes: 4, larvae: 5,
    hazards: ['collapse'],
  },
  {
    name: "The queen's vault",
    tagline: 'Everything left alive is between you and the way out.',
    foodNeeded: 12, final: true, timeLimit: 240,
    rooms: 8, roomMin: 22, roomMax: 36, tunnelMin: 6, tunnelMax: 11,
    height: [9, 17], hills: 9, loops: 4,
    fog: 0x2a0d08, fogDensity: 0.024, lamp: 0xff7a44, soil: 0x5a3324,
    enemies: { scout: 6, soldier: 6, bullet: 4, major: 2 },
    pickups: { crumb: 12, seed: 8, acid: 8, nectar: 4 },
    repletes: 5, larvae: 6,
    hazards: ['flood', 'collapse', 'blockade'],
  },
];

export const ALARM = {
  risePerSecond: 28,
  decayPerSecond: 12,
  sightBonusAtMax: 16,
  speedBonusAtMax: 1.35,
};

// Recruitment: the power picked up on the blocked level. Calling brings
// nestmates who haul stone and fight beside you.
export const RECRUIT = {
  cooldown: 16,
  count: 4,
  life: 38,
  speed: 11.5,
  hp: 55,
  damage: 12,
  hauling: 3,        // ants needed to shift one stone plug
  haulTime: 4.2,     // seconds of work per plug
  callRadius: 30,
};
