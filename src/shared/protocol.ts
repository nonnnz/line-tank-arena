// Shared network contract. Owned by lead. Agents: do not change without telling the lead.
export const ARENA_HALF = 30; // arena spans -30..30 on x and z
export const TICK_HZ = 15;
export const MATCH_MS = 180_000;
export const FIREBALL_COOLDOWN_MS = 20_000;
export const MAX_PLAYERS = 12;
// Free-tier deployment: exactly one public room. The Worker rejects any other room id.
export const ARENA_ROOM = "ARENA";

export type Stat = "damage" | "fireRate" | "maxHp";

export type ClientAction =
  | { type: "move"; x: number; z: number } // desired direction, each -1..1 (world space)
  | { type: "upgrade"; stat: Stat }
  | { type: "cast_fireball"; via: "voice" | "touch" }
  | { type: "ping"; t: number };

export interface PlayerState {
  id: string;
  name: string;
  avatar?: string;
  guest: boolean;
  color: number; // palette index 0..11
  x: number; z: number;
  rot: number; // hull heading (radians, atan2(x,z))
  aim: number; // turret heading (radians)
  hp: number; maxHp: number;
  level: number; xp: number; xpNext: number;
  points: number; // unspent upgrade points
  upgrades: Record<Stat, number>;
  score: number; kills: number;
  alive: boolean;
  fireballReadyAt: number; // server ms timestamp
}

export interface ShapeState {
  id: string;
  kind: "cube" | "hex" | "pyramid";
  color: number; // palette index
  x: number; z: number;
  size: number;
  hp: number; maxHp: number;
}

export interface BulletState { id: number; owner: string; x: number; z: number; vx: number; vz: number }
export interface FireballState { id: number; owner: string; x: number; z: number; vx: number; vz: number }

export interface GameSnapshot {
  t: number; // server Date.now()
  roomId: string;
  phase: "playing" | "ended";
  endsAt: number; // server ms when match ends (or next match starts when ended)
  players: PlayerState[];
  shapes: ShapeState[];
  bullets: BulletState[];
  fireballs: FireballState[];
}

export interface MatchResult { id: string; name: string; score: number; kills: number; rank: number; guest: boolean }

export type GameEvent =
  | { kind: "hit"; target: string; x: number; z: number; dmg: number }
  | { kind: "shape_destroyed"; id: string; x: number; z: number; by: string }
  | { kind: "kill"; killer: string; victim: string }
  | { kind: "level_up"; player: string; level: number }
  | { kind: "fireball_cast"; owner: string; via: "voice" | "touch" }
  | { kind: "fireball_explode"; owner: string; x: number; z: number; radius: number; hits: string[] }
  | { kind: "match_end"; results: MatchResult[] };

export type ServerEvent =
  | { type: "snapshot"; state: GameSnapshot }
  | { type: "room_joined"; playerId: string; roomId: string }
  | { type: "game_event"; event: GameEvent }
  | { type: "pong"; t: number; server: number }
  | { type: "error"; message: string };

// WebSocket URL: wss://<host>/ws/<ROOMID>?session=<token from POST /api/session> | ?guest=<name>
// Room IDs: 5 chars [A-Z0-9], uppercase.
export const PALETTE = [0x3b82f6, 0xef4444, 0xfacc15, 0x22c55e, 0xa855f7, 0xf97316, 0x06b6d4, 0xec4899, 0x84cc16, 0x6366f1, 0x14b8a6, 0xf43f5e];
