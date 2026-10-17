import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { verifySession } from "./auth";
import { recordMatch, reportRoom } from "./db";
import {
  ARENA_HALF, ARENA_ROOM, TICK_HZ, MATCH_MS, FIREBALL_COOLDOWN_MS, MAX_PLAYERS, PALETTE,
  type PlayerState, type ShapeState, type BulletState, type FireballState,
  type GameEvent, type ServerEvent, type Stat, type MatchResult,
} from "../src/shared/protocol";

const DT = 1 / TICK_HZ;
const TANK_R = 1.2;
const SPEED = 9;
const SHAPE_COUNT = 35;
const SHAPE_RESPAWN_MS = 4000;
const PLAYER_RESPAWN_MS = 3000;
const AIM_PLAYER_RANGE = 16;
const AIM_SHAPE_RANGE = 14;
const BULLET_SPEED = 28;
const BULLET_LIFE = 0.8;
const BULLET_R = 0.3;
const FB_SPEED = 18;
const FB_LIFE = 1.6;
const FB_R = 0.8;
const FB_RADIUS = 7;
const FB_KNOCKBACK = 4;
const END_PAUSE_MS = 10_000;
const IDLE_MS = 15_000;
const MAX_MSGS_PER_SEC = 25; // normal client sends ~11/s while moving; more than this = flood, socket is closed
// Free-tier guard (Durable Objects free plan: ~100k requests/day; incoming WS messages bill 20:1).
// Leave headroom for connects and the Worker's own calls. Counters reset at 00:00 UTC.
const DAILY_MSG_BUDGET = 1_500_000; // ≈ 75k DO requests
const DAILY_CONNECT_BUDGET = 5_000;
const MAX_UPGRADE = 5;
const CLOSED_MSG = "Arena is resting for today (free tier limit). Back at 07:00 Thailand time!";
const KINDS = {
  cube: { hp: 30, xp: 10 },
  hex: { hp: 60, xp: 25 },
  pyramid: { hp: 100, xp: 50 },
} as const;
const KIND_NAMES = Object.keys(KINDS) as ShapeState["kind"][];

interface Player {
  s: PlayerState;
  ws: WebSocket | null;
  avatarFull?: string;
  mx: number; mz: number; // desired move dir
  lastSeen: number;
  fireCd: number; // seconds until next shot
  respawnAt: number;
  msgWindow: number; msgCount: number;
}
interface Bullet extends BulletState { life: number; dmg: number }
interface Fireball extends FireballState { life: number; dmgLevel: number }

const r2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const shapeR = (s: ShapeState) => s.size * 0.7;
const xpNextFor = (level: number) => Math.round(50 * Math.pow(1.4, level - 1));

export class GameRoom extends DurableObject<Env> {
  roomId = "";
  players = new Map<string, Player>();
  shapes: ShapeState[] = [];
  shapeRespawns: number[] = []; // timestamps
  bullets: Bullet[] = [];
  fireballs: Fireball[] = [];
  phase: "playing" | "ended" = "playing";
  endsAt = 0;
  matchId = "";
  timer: ReturnType<typeof setInterval> | null = null;
  budget = { day: "", msgs: 0, connects: 0 };
  budgetLoaded = false;

  async loadBudget() {
    if (!this.budgetLoaded) {
      const b = await this.ctx.storage.get<{ day: string; msgs: number; connects: number }>("budget");
      if (b) this.budget = b;
      this.budgetLoaded = true;
    }
    this.rollBudgetDay();
  }
  rollBudgetDay() {
    const day = new Date().toISOString().slice(0, 10); // UTC day = Cloudflare's free-tier reset
    if (this.budget.day !== day) this.budget = { day, msgs: 0, connects: 0 };
  }
  saveBudget() { this.ctx.waitUntil(this.ctx.storage.put("budget", this.budget)); }
  overBudget() { this.rollBudgetDay(); return this.budget.msgs > DAILY_MSG_BUDGET || this.budget.connects > DAILY_CONNECT_BUDGET; }
  closeForToday() {
    this.saveBudget();
    for (const p of [...this.players.values()]) {
      const ws = p.ws;
      this.send(ws, { type: "error", message: CLOSED_MSG });
      try { ws?.close(4002, "daily limit"); } catch {}
      if (ws) this.onClose(p, ws);
    }
  }
  lastReport = 0;
  nextId = 1;
  shapeSeq = 1;

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const url = new URL(req.url);
    this.roomId = ARENA_ROOM;
    await this.loadBudget();

    let ident: { id: string; name: string; avatar?: string; guest: boolean } | null = null;
    // Everyone needs a signed session: LINE users via /api/session, guests via Turnstile at /api/guest.
    const session = url.searchParams.get("session");
    if (session) {
      const v = await verifySession(this.env, session).catch(() => null);
      if (v) ident = { id: String(v.id), name: sanitizeName(v.name), avatar: v.avatar, guest: !!v.guest };
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const reject = (message: string, code = 4003) => {
      server.send(JSON.stringify({ type: "error", message } satisfies ServerEvent));
      server.close(code, message.slice(0, 120));
      return new Response(null, { status: 101, webSocket: client });
    };
    if (this.overBudget()) return reject(CLOSED_MSG, 4002);
    this.budget.connects++;
    if (!ident) return reject("invalid session");

    const existing = this.players.get(ident.id);
    if (!existing && this.players.size >= MAX_PLAYERS) return reject("room full");

    if (this.players.size === 0) this.startRoom();
    const now = Date.now();
    let p = existing;
    if (p) {
      const old = p.ws;
      p.ws = server;
      // 4001 tells the old client not to auto-reconnect (avoids two devices kicking each other forever).
      try { old?.close(4001, "replaced"); } catch {}
    } else {
      p = this.newPlayer(ident, server, now);
      this.players.set(ident.id, p);
    }
    p.lastSeen = now;
    const player = p;

    server.addEventListener("message", (e) => this.onMessage(player, server, e.data));
    const onGone = () => this.onClose(player, server);
    server.addEventListener("close", onGone);
    server.addEventListener("error", onGone);

    this.send(server, { type: "room_joined", playerId: ident.id, roomId: this.roomId });
    this.report();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- lifecycle ----------
  startRoom() {
    this.shapes = [];
    this.shapeRespawns = [];
    this.bullets = [];
    this.fireballs = [];
    for (let i = 0; i < SHAPE_COUNT; i++) this.spawnShape();
    this.startMatch();
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000 / TICK_HZ);
  }

  startMatch() {
    const now = Date.now();
    this.phase = "playing";
    this.endsAt = now + MATCH_MS;
    this.matchId = `${this.roomId}-${now}`;
  }

  stopRoom() {
    this.saveBudget();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.players.clear();
    this.shapes = [];
    this.shapeRespawns = [];
    this.bullets = [];
    this.fireballs = [];
  }

  newPlayer(ident: { id: string; name: string; avatar?: string; guest: boolean }, ws: WebSocket, now: number): Player {
    const used = new Set([...this.players.values()].map((p) => p.s.color));
    let color = 0;
    while (used.has(color) && color < PALETTE.length - 1) color++;
    const spot = this.randomSpot();
    return {
      s: {
        id: ident.id, name: ident.name, avatar: ident.avatar, guest: ident.guest, color,
        x: spot.x, z: spot.z, rot: 0, aim: 0,
        hp: 100, maxHp: 100, level: 1, xp: 0, xpNext: xpNextFor(1), points: 0,
        upgrades: { damage: 0, fireRate: 0, maxHp: 0 },
        score: 0, kills: 0, alive: true, fireballReadyAt: now,
      },
      ws, mx: 0, mz: 0, lastSeen: now, fireCd: 0, respawnAt: 0, msgWindow: now, msgCount: 0,
    };
  }

  onClose(p: Player, ws: WebSocket) {
    if (p.ws !== ws) return; // replaced by a reconnect
    p.ws = null;
    this.players.delete(p.s.id);
    if (this.players.size === 0) this.stopRoom();
    this.report();
  }

  report() {
    const n = this.players.size;
    this.lastReport = Date.now();
    this.ctx.waitUntil(reportRoom(this.env, this.roomId, n).catch(() => {}));
  }

  // ---------- networking ----------
  send(ws: WebSocket | null, msg: ServerEvent) {
    if (!ws) return;
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  broadcastRaw(data: string) {
    for (const p of this.players.values()) {
      if (p.ws) try { p.ws.send(data); } catch {}
    }
  }

  emit(event: GameEvent) {
    this.broadcastRaw(JSON.stringify({ type: "game_event", event } satisfies ServerEvent));
  }

  onMessage(p: Player, ws: WebSocket, data: unknown) {
    if (p.ws !== ws) return;
    const now = Date.now();
    p.lastSeen = now;
    if (now - p.msgWindow >= 1000) { p.msgWindow = now; p.msgCount = 0; }
    if (++p.msgCount > MAX_MSGS_PER_SEC) { try { ws.close(4003, "too many messages"); } catch {} this.onClose(p, ws); return; }
    if (++this.budget.msgs > DAILY_MSG_BUDGET) { this.closeForToday(); return; }
    if (typeof data !== "string" || data.length > 512) return;
    let m: any;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== "object") return;
    switch (m.type) {
      case "ping":
        if (Number.isFinite(m.t)) this.send(ws, { type: "pong", t: m.t, server: now });
        break;
      case "move": {
        if (!Number.isFinite(m.x) || !Number.isFinite(m.z)) return;
        let x = clamp(m.x, -1, 1), z = clamp(m.z, -1, 1);
        const len = Math.hypot(x, z);
        if (len > 1) { x /= len; z /= len; }
        p.mx = x; p.mz = z;
        break;
      }
      case "upgrade": {
        const stat = m.stat as Stat;
        if (stat !== "damage" && stat !== "fireRate" && stat !== "maxHp") return;
        if (p.s.points <= 0 || p.s.upgrades[stat] >= MAX_UPGRADE) return;
        p.s.points--;
        p.s.upgrades[stat]++;
        if (stat === "maxHp") { p.s.maxHp += 25; if (p.s.alive) p.s.hp += 25; }
        break;
      }
      case "cast_fireball": {
        if (m.via !== "voice" && m.via !== "touch") return;
        if (!p.s.alive || this.phase !== "playing" || now < p.s.fireballReadyAt) return;
        p.s.fireballReadyAt = now + FIREBALL_COOLDOWN_MS;
        const dir = p.s.aim;
        this.fireballs.push({
          id: this.nextId++, owner: p.s.id,
          x: p.s.x + Math.sin(dir) * (TANK_R + FB_R), z: p.s.z + Math.cos(dir) * (TANK_R + FB_R),
          vx: Math.sin(dir) * FB_SPEED, vz: Math.cos(dir) * FB_SPEED,
          life: FB_LIFE, dmgLevel: p.s.upgrades.damage,
        });
        this.emit({ kind: "fireball_cast", owner: p.s.id, via: m.via });
        break;
      }
    }
  }

  // ---------- simulation ----------
  tick() {
    const now = Date.now();
    // drop silent clients
    for (const p of [...this.players.values()]) {
      if (now - p.lastSeen > IDLE_MS) {
        const ws = p.ws;
        try { ws?.close(1000, "idle"); } catch {}
        if (ws) this.onClose(p, ws);
      }
    }
    if (this.players.size === 0) return;
    if (now - this.lastReport > 30_000) { this.report(); this.saveBudget(); } // heartbeat for /party + persist budget

    if (this.phase === "playing" && now >= this.endsAt) this.endMatch(now);
    else if (this.phase === "ended" && now >= this.endsAt) this.resetMatch();

    // shape respawns
    this.shapeRespawns = this.shapeRespawns.filter((t) => {
      if (now < t) return true;
      this.spawnShape();
      return false;
    });

    const alive = [...this.players.values()].filter((p) => p.s.alive);

    // player respawn
    for (const p of this.players.values()) {
      if (!p.s.alive && now >= p.respawnAt) {
        const spot = this.randomSpot();
        Object.assign(p.s, { x: spot.x, z: spot.z, hp: p.s.maxHp, alive: true });
      }
    }

    // movement
    for (const p of alive) {
      if (p.mx || p.mz) {
        p.s.x += p.mx * SPEED * DT;
        p.s.z += p.mz * SPEED * DT;
        p.s.rot = Math.atan2(p.mx, p.mz);
      }
    }
    // collisions: players vs shapes, players vs players, arena bounds
    for (const p of alive) {
      for (const sh of this.shapes) pushOut(p.s, sh.x, sh.z, TANK_R + shapeR(sh));
    }
    for (let i = 0; i < alive.length; i++)
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i].s, b = alive[j].s;
        const dx = a.x - b.x, dz = a.z - b.z, d = Math.hypot(dx, dz), min = TANK_R * 2;
        if (d < min) {
          const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0, push = (min - d) / 2;
          a.x += nx * push; a.z += nz * push; b.x -= nx * push; b.z -= nz * push;
        }
      }
    for (const p of alive) clampArena(p.s);

    // auto-aim + auto-fire
    for (const p of alive) {
      let tx = 0, tz = 0, best = AIM_PLAYER_RANGE * AIM_PLAYER_RANGE, found = false;
      for (const o of alive) {
        if (o === p) continue;
        const d = (o.s.x - p.s.x) ** 2 + (o.s.z - p.s.z) ** 2;
        if (d < best) { best = d; tx = o.s.x; tz = o.s.z; found = true; }
      }
      if (!found) {
        best = AIM_SHAPE_RANGE * AIM_SHAPE_RANGE;
        for (const sh of this.shapes) {
          const d = (sh.x - p.s.x) ** 2 + (sh.z - p.s.z) ** 2;
          if (d < best) { best = d; tx = sh.x; tz = sh.z; found = true; }
        }
      }
      p.fireCd -= DT;
      if (!found) { p.s.aim = p.s.rot; continue; }
      p.s.aim = Math.atan2(tx - p.s.x, tz - p.s.z);
      if (p.fireCd <= 0 && this.phase === "playing") {
        p.fireCd = 1 / (2.5 * (1 + 0.2 * p.s.upgrades.fireRate));
        const sx = Math.sin(p.s.aim), sz = Math.cos(p.s.aim);
        this.bullets.push({
          id: this.nextId++, owner: p.s.id,
          x: p.s.x + sx * TANK_R, z: p.s.z + sz * TANK_R,
          vx: sx * BULLET_SPEED, vz: sz * BULLET_SPEED,
          life: BULLET_LIFE, dmg: 10 * (1 + 0.25 * p.s.upgrades.damage),
        });
      }
    }

    // bullets
    this.bullets = this.bullets.filter((b) => {
      b.x += b.vx * DT; b.z += b.vz * DT; b.life -= DT;
      if (b.life <= 0 || Math.abs(b.x) > ARENA_HALF || Math.abs(b.z) > ARENA_HALF) return false;
      for (const sh of this.shapes) {
        if ((sh.x - b.x) ** 2 + (sh.z - b.z) ** 2 < (shapeR(sh) + BULLET_R) ** 2) {
          this.damageShape(sh, b.dmg, b.owner);
          return false;
        }
      }
      for (const p of this.players.values()) {
        if (!p.s.alive || p.s.id === b.owner) continue;
        if ((p.s.x - b.x) ** 2 + (p.s.z - b.z) ** 2 < (TANK_R + BULLET_R) ** 2) {
          this.damagePlayer(p, b.dmg, b.owner);
          return false;
        }
      }
      return true;
    });

    // fireballs
    this.fireballs = this.fireballs.filter((f) => {
      f.x += f.vx * DT; f.z += f.vz * DT; f.life -= DT;
      let boom = f.life <= 0 || Math.abs(f.x) > ARENA_HALF || Math.abs(f.z) > ARENA_HALF;
      if (!boom) boom = this.shapes.some((sh) => (sh.x - f.x) ** 2 + (sh.z - f.z) ** 2 < (shapeR(sh) + FB_R) ** 2);
      if (!boom) for (const p of this.players.values()) {
        if (p.s.alive && p.s.id !== f.owner && (p.s.x - f.x) ** 2 + (p.s.z - f.z) ** 2 < (TANK_R + FB_R) ** 2) { boom = true; break; }
      }
      if (boom) this.explode(f);
      return !boom;
    });

    this.broadcastRaw(JSON.stringify({ type: "snapshot", state: this.snapshot(now) } satisfies ServerEvent));
  }

  explode(f: Fireball) {
    const x = clamp(f.x, -ARENA_HALF, ARENA_HALF), z = clamp(f.z, -ARENA_HALF, ARENA_HALF);
    const hits: string[] = [];
    const R2 = FB_RADIUS * FB_RADIUS;
    for (const p of this.players.values()) {
      if (!p.s.alive || p.s.id === f.owner) continue;
      const dx = p.s.x - x, dz = p.s.z - z, d2 = dx * dx + dz * dz;
      if (d2 > R2) continue;
      hits.push(p.s.id);
      const d = Math.sqrt(d2);
      const nx = d > 1e-6 ? dx / d : Math.random() - 0.5, nz = d > 1e-6 ? dz / d : Math.random() - 0.5;
      const nl = Math.hypot(nx, nz) || 1;
      p.s.x += (nx / nl) * FB_KNOCKBACK; p.s.z += (nz / nl) * FB_KNOCKBACK;
      clampArena(p.s);
      this.damagePlayer(p, 60 + 15 * f.dmgLevel, f.owner);
    }
    for (const sh of [...this.shapes]) {
      if ((sh.x - x) ** 2 + (sh.z - z) ** 2 > (FB_RADIUS + shapeR(sh)) ** 2) continue;
      hits.push(sh.id);
      this.damageShape(sh, 200, f.owner);
    }
    this.emit({ kind: "fireball_explode", owner: f.owner, x: r2(x), z: r2(z), radius: FB_RADIUS, hits });
  }

  damageShape(sh: ShapeState, dmg: number, by: string) {
    if (this.phase !== "playing") return;
    sh.hp -= dmg;
    this.emit({ kind: "hit", target: sh.id, x: r2(sh.x), z: r2(sh.z), dmg: r2(dmg) });
    if (sh.hp > 0) return;
    this.shapes = this.shapes.filter((s) => s !== sh);
    this.shapeRespawns.push(Date.now() + SHAPE_RESPAWN_MS);
    this.emit({ kind: "shape_destroyed", id: sh.id, x: r2(sh.x), z: r2(sh.z), by });
    const killer = this.players.get(by);
    if (killer) {
      const xp = KINDS[sh.kind].xp;
      killer.s.score += xp;
      this.giveXp(killer, xp);
    }
  }

  damagePlayer(p: Player, dmg: number, by: string) {
    if (this.phase !== "playing" || !p.s.alive) return;
    p.s.hp = Math.max(0, p.s.hp - dmg);
    this.emit({ kind: "hit", target: p.s.id, x: r2(p.s.x), z: r2(p.s.z), dmg: r2(dmg) });
    if (p.s.hp > 0) return;
    p.s.alive = false;
    p.respawnAt = Date.now() + PLAYER_RESPAWN_MS;
    const killer = this.players.get(by);
    if (killer) {
      killer.s.kills++;
      killer.s.score += 100;
      this.giveXp(killer, 30 + 10 * p.s.level);
    }
    this.emit({ kind: "kill", killer: by, victim: p.s.id });
  }

  giveXp(p: Player, xp: number) {
    p.s.xp += xp;
    while (p.s.xp >= p.s.xpNext) {
      p.s.xp -= p.s.xpNext;
      p.s.level++;
      p.s.points++;
      p.s.xpNext = xpNextFor(p.s.level);
      if (p.s.alive) p.s.hp = Math.min(p.s.maxHp, p.s.hp + p.s.maxHp * 0.2);
      this.emit({ kind: "level_up", player: p.s.id, level: p.s.level });
    }
  }

  endMatch(now: number) {
    this.phase = "ended";
    this.endsAt = now + END_PAUSE_MS;
    this.bullets = [];
    this.fireballs = [];
    const ranked = [...this.players.values()].sort((a, b) => b.s.score - a.s.score || b.s.kills - a.s.kills);
    const results: MatchResult[] = ranked.map((p, i) => ({
      id: p.s.id, name: p.s.name, score: p.s.score, kills: p.s.kills, rank: i + 1, guest: p.s.guest,
    }));
    this.emit({ kind: "match_end", results });
    const withAvatar = results.map((r, i) => ({ ...r, avatar: ranked[i].s.avatar }));
    this.ctx.waitUntil(recordMatch(this.env, this.matchId, withAvatar).catch((e) => console.error("recordMatch", e)));
  }

  resetMatch() {
    const now = Date.now();
    for (const p of this.players.values()) {
      const spot = this.randomSpot();
      Object.assign(p.s, {
        x: spot.x, z: spot.z, hp: 100, maxHp: 100, level: 1, xp: 0, xpNext: xpNextFor(1), points: 0,
        upgrades: { damage: 0, fireRate: 0, maxHp: 0 }, score: 0, kills: 0, alive: true, fireballReadyAt: now,
      });
      p.fireCd = 0;
    }
    this.startMatch();
  }

  spawnShape() {
    const kind = KIND_NAMES[Math.random() < 0.55 ? 0 : Math.random() < 0.7 ? 1 : 2];
    const spot = this.randomSpot();
    const hp = KINDS[kind].hp;
    this.shapes.push({
      id: "s" + this.shapeSeq++, kind, color: Math.floor(Math.random() * PALETTE.length),
      x: spot.x, z: spot.z, size: r2(1 + Math.random()), hp, maxHp: hp,
    });
  }

  randomSpot() {
    const lim = ARENA_HALF - 3;
    let x = 0, z = 0;
    for (let tries = 0; tries < 30; tries++) {
      x = (Math.random() * 2 - 1) * lim;
      z = (Math.random() * 2 - 1) * lim;
      let ok = true;
      for (const sh of this.shapes) if ((sh.x - x) ** 2 + (sh.z - z) ** 2 < 16) { ok = false; break; }
      if (ok) for (const p of this.players.values()) if ((p.s.x - x) ** 2 + (p.s.z - z) ** 2 < 25) { ok = false; break; }
      if (ok) break;
    }
    return { x, z };
  }

  snapshot(now: number) {
    return {
      t: now, roomId: this.roomId, phase: this.phase, endsAt: this.endsAt,
      players: [...this.players.values()].map(({ s }) => ({
        ...s, x: r2(s.x), z: r2(s.z), rot: r2(s.rot), aim: r2(s.aim),
        hp: r2(s.hp), maxHp: s.maxHp, upgrades: { ...s.upgrades },
      })),
      shapes: this.shapes.map((sh) => ({ ...sh, x: r2(sh.x), z: r2(sh.z), hp: r2(sh.hp) })),
      bullets: this.bullets.map((b) => ({ id: b.id, owner: b.owner, x: r2(b.x), z: r2(b.z), vx: r2(b.vx), vz: r2(b.vz) })),
      fireballs: this.fireballs.map((f) => ({ id: f.id, owner: f.owner, x: r2(f.x), z: r2(f.z), vx: r2(f.vx), vz: r2(f.vz) })),
    };
  }
}

function pushOut(p: { x: number; z: number }, cx: number, cz: number, min: number) {
  const dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz);
  if (d >= min) return;
  if (d < 1e-6) { p.x += min; return; }
  p.x = cx + (dx / d) * min;
  p.z = cz + (dz / d) * min;
}

function clampArena(p: { x: number; z: number }) {
  const lim = ARENA_HALF - TANK_R;
  p.x = clamp(p.x, -lim, lim);
  p.z = clamp(p.z, -lim, lim);
}

function sanitizeName(raw: unknown): string {
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim();
  return [...s].slice(0, 16).join("") || "Guest";
}
