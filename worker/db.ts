import type { Env } from "./env";
import type { MatchResult } from "../src/shared/protocol";

/** Persist authoritative results for a finished match (call only from GameRoom). Guests are skipped inside. */
export async function recordMatch(env: Env, matchId: string, results: (MatchResult & { avatar?: string })[]): Promise<void> {
  const now = Date.now();
  const stmts = results.filter((r) => !r.guest).flatMap((r) => [
    env.DB.prepare(
      `INSERT INTO players (id, name, avatar, total_score, wins, kills, matches, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = COALESCE(excluded.avatar, players.avatar),
         total_score = players.total_score + excluded.total_score, wins = players.wins + excluded.wins,
         kills = players.kills + excluded.kills, matches = players.matches + 1, updated_at = excluded.updated_at`,
    ).bind(r.id, r.name, r.avatar ?? null, r.score, r.rank === 1 ? 1 : 0, r.kills, now),
    env.DB.prepare(`INSERT OR IGNORE INTO matches (match_id, player_id, score, kills, rank, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(matchId, r.id, r.score, r.kills, r.rank, now),
  ]);
  if (stmts.length) await env.DB.batch(stmts);
}

/** Report live room player count for /party and quick-join (throttle calls; count 0 = room empty). */
export async function reportRoom(env: Env, roomId: string, count: number): Promise<void> {
  if (count <= 0) await env.DB.prepare(`DELETE FROM rooms WHERE room_id = ?`).bind(roomId).run();
  else await env.DB.prepare(
    `INSERT INTO rooms (room_id, players, updated_at) VALUES (?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET players = excluded.players, updated_at = excluded.updated_at`,
  ).bind(roomId, count, Date.now()).run();
}

/** Login-time profile upsert (no stat changes). */
export async function upsertPlayer(env: Env, id: string, name: string, avatar?: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO players (id, name, avatar, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, updated_at = excluded.updated_at`,
  ).bind(id, name, avatar ?? null, Date.now()).run();
}

export interface RankRow { name: string; avatar?: string; totalScore: number; wins: number; kills: number; matches: number }
export async function topPlayers(env: Env, limit = 20): Promise<RankRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT name, avatar, total_score, wins, kills, matches FROM players WHERE matches > 0 ORDER BY total_score DESC, wins DESC LIMIT ?`,
  ).bind(limit).all<{ name: string; avatar: string | null; total_score: number; wins: number; kills: number; matches: number }>();
  return results.map((r) => ({ name: r.name, avatar: r.avatar ?? undefined, totalScore: r.total_score, wins: r.wins, kills: r.kills, matches: r.matches }));
}

export interface RoomRow { roomId: string; players: number }
/** Rooms with a heartbeat in the last 2 minutes that still have space (1..11 players). */
export async function publicRooms(env: Env): Promise<RoomRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT room_id, players FROM rooms WHERE updated_at > ? AND players BETWEEN 1 AND 11 ORDER BY players DESC LIMIT 10`,
  ).bind(Date.now() - 120_000).all<{ room_id: string; players: number }>();
  return results.map((r) => ({ roomId: r.room_id, players: r.players }));
}
