CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  total_score INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0,
  matches INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS players_score ON players(total_score DESC);
CREATE TABLE IF NOT EXISTS matches (
  match_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  kills INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id)
);
CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  players INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS service_messages (
  match_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id)
);
