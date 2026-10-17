import { initLine, shareInvite, inviteUrl, fetchLeaderboard, wsUrl, sendResultToLine, loginWithLine, playAsGuest, type LineIdentity } from "./line";
import { ARENA_ROOM, MAX_PLAYERS, PALETTE, type ClientAction, type GameEvent, type GameSnapshot, type PlayerState, type ServerEvent, type Stat } from "../shared/protocol";
import { render, resize, fxHit, fxShapeDestroyed, fxExplosion, fxFireball, tankPos, type Frame } from "./scene";
import { listen, voiceSupported } from "./voice";

const $ = (id: string) => document.getElementById(id)!;
const setText = (el: HTMLElement, s: string) => { if (el.textContent !== s) el.textContent = s; };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- toasts / banner / flash ----------
function toast(msg: string, ms = 2200) {
  const d = document.createElement("div"); d.className = "toast card"; d.textContent = msg; $("toasts").insertBefore(d, $("toasts").firstChild);
  while ($("toasts").children.length > 4) $("toasts").lastChild!.remove();
  setTimeout(() => d.remove(), ms);
}
let bannerTimer = 0;
function banner(html: string) {
  const b = $("banner"); b.innerHTML = html; b.classList.add("show");
  clearTimeout(bannerTimer); bannerTimer = window.setTimeout(() => b.classList.remove("show"), 1800);
}
function flash(strength: number) {
  const f = $("flash"); f.style.transition = "none"; f.style.opacity = String(strength);
  requestAnimationFrame(() => { f.style.transition = "opacity .7s ease-out"; f.style.opacity = "0"; });
}

// ---------- network ----------
let lastError = "";
let ws: WebSocket | null = null, identity: LineIdentity, myId = "", roomId = "", backoff = 1000;
let offset = 0, haveOffset = false;
const snaps: GameSnapshot[] = [];
const serverNow = () => Date.now() + offset;
const send = (a: ClientAction) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(a)); };

function setConn(state: "ok" | "bad" | "wait") { $("conn").className = state === "wait" ? "" : state; }

function connect() {
  setConn("wait");
  const sock = new WebSocket(wsUrl({ ...identity, roomId: roomId || identity.roomId }));
  ws = sock;
  sock.onopen = () => { backoff = 1000; setConn("ok"); send({ type: "ping", t: Date.now() }); };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    setConn("bad"); snaps.length = 0;
    // 4001 replaced by another device, 4002 daily free-tier limit, 4003 full/invalid/flood: never auto-retry.
    if (e.code >= 4001 && e.code <= 4003) {
      setText($("loadMsg"), e.code === 4001 ? "You're playing on another device. Tap here to play on this one."
        : `${lastError || "Disconnected"} — tap to try again.`);
      $("loading").classList.remove("hidden");
      $("loading").addEventListener("click", () => { $("loading").classList.add("hidden"); connect(); }, { once: true });
      return;
    }
    setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 4000);
  };
  sock.onmessage = (e) => {
    let m: ServerEvent; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === "snapshot") onSnapshot(m.state);
    else if (m.type === "room_joined") { myId = m.playerId; roomId = m.roomId; setText($("roomText"), "ROOM " + roomId); }
    else if (m.type === "pong") {
      const now = Date.now(), est = m.server + (now - m.t) / 2 - now;
      offset = haveOffset ? offset * 0.7 + est * 0.3 : est; haveOffset = true;
    }
    else if (m.type === "game_event") onEvent(m.event);
    else if (m.type === "error") { lastError = m.message; toast("⚠️ " + m.message); }
  };
}
setInterval(() => send({ type: "ping", t: Date.now() }), 5000); // keepalive (server idle timeout 15s)

function onSnapshot(s: GameSnapshot) {
  if (!haveOffset) { offset = s.t - Date.now(); haveOffset = true; }
  snaps.push(s); if (snaps.length > 12) snaps.shift();
  if (s.roomId && s.roomId !== roomId) { roomId = s.roomId; setText($("roomText"), "ROOM " + roomId); }
  updateHud(s);
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpAng = (a: number, b: number, k: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
const EMPTY: Frame = { players: [], shapes: [], bullets: [], fireballs: [] };

function frameAt(t: number): Frame {
  if (!snaps.length) return EMPTY;
  let b = snaps[snaps.length - 1], a = b;
  for (let i = snaps.length - 1; i > 0; i--) if (snaps[i - 1].t <= t) { a = snaps[i - 1]; b = snaps[i]; break; }
  const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 1;
  const prev = new Map(a.players.map((p) => [p.id, p]));
  const players = b.players.map((p) => {
    const q = prev.get(p.id); if (!q || !q.alive || !p.alive) return p;
    return { ...p, x: lerp(q.x, p.x, k), z: lerp(q.z, p.z, k), rot: lerpAng(q.rot, p.rot, k), aim: lerpAng(q.aim, p.aim, k) };
  });
  // projectiles: dead-reckon from newest snapshot (velocities assumed units/second)
  const latest = snaps[snaps.length - 1], dt = Math.max(-0.25, Math.min(0.15, (t - latest.t) / 1000));
  const move = <T extends { x: number; z: number; vx: number; vz: number }>(o: T) => ({ ...o, x: o.x + o.vx * dt, z: o.z + o.vz * dt });
  return { players, shapes: latest.shapes, bullets: latest.bullets.map(move), fireballs: latest.fireballs.map(move) };
}

const nameOf = (id: string) => snaps[snaps.length - 1]?.players.find((p) => p.id === id)?.name ?? "Someone";
const me = (): PlayerState | undefined => snaps[snaps.length - 1]?.players.find((p) => p.id === myId);

function onEvent(e: GameEvent) {
  switch (e.kind) {
    case "hit": fxHit(e.target, e.x, e.z); break;
    case "shape_destroyed": fxShapeDestroyed(e.id, e.x, e.z); break;
    case "kill": {
      const p = tankPos(e.victim); if (p) fxExplosion(p.x, p.z);
      toast(`${nameOf(e.killer)} 💥 ${nameOf(e.victim)}`);
      if (e.killer === myId) flash(0.15);
      break;
    }
    case "level_up": if (e.player === myId) { toast(`⭐ LEVEL ${e.level}! Pick an upgrade`); flash(0.12); } break;
    case "fireball_cast": banner(`🔥 FIREBALL!<small>${esc(nameOf(e.owner))} ${e.via === "voice" ? "shouted it 🎤" : "tapped it"}</small>`); break;
    case "fireball_explode": {
      const m = me(), d = m ? Math.hypot(m.x - e.x, m.z - e.z) : 99;
      fxFireball(e.x, e.z, e.radius, d < e.radius * 2.5);
      flash(e.hits.includes(myId) ? 0.85 : d < e.radius * 3 ? 0.5 : 0.2);
      break;
    }
    case "match_end": showResults(e.results); break;
  }
}

function showResults(results: { id: string; name: string; score: number; kills: number; rank: number }[]) {
  $("results").innerHTML = results.slice(0, 12).map((r) =>
    `<tr${r.id === myId ? ' style="color:#06a046"' : ""}><td>${RANK_BADGES[r.rank - 1] ? `<img class="badge" src="${RANK_BADGES[r.rank - 1]}" alt="#${r.rank}">` : "#" + r.rank}</td><td>${esc(r.name)}</td><td>${r.kills}💥</td><td>${r.score}</td></tr>`).join("");
  const mine = results.find((r) => r.id === myId);
  const btn = $("sendResult") as HTMLButtonElement;
  btn.classList.toggle("hidden", !(identity.loggedIn && mine));
  btn.disabled = false; setText(btn, "📩 Send result to LINE");
  $("matchEnd").classList.remove("hidden");
  setTimeout(() => $("matchEnd").classList.add("hidden"), 10000);
}

const RANK_BADGES = ["/ui/badge-rank-gold.png", "/ui/badge-rank-silver.png", "/ui/badge-rank-bronze.png"];
$("sendResult").addEventListener("click", async () => {
  const btn = $("sendResult") as HTMLButtonElement;
  btn.disabled = true; setText(btn, "Sending…");
  const r = await sendResultToLine();
  setText(btn, r.ok ? "✅ Sent to LINE" : "📩 Send result to LINE");
  btn.disabled = r.ok;
  toast(r.message, 2500);
});

// ---------- HUD ----------
const upBtns = [...document.querySelectorAll<HTMLButtonElement>(".up")];
function updateHud(s: GameSnapshot) {
  const m = s.players.find((p) => p.id === myId);
  setText($("count"), `${s.players.length}/${MAX_PLAYERS}`);
  const sorted = [...s.players].sort((a, b) => b.score - a.score);
  const myRank = sorted.findIndex((p) => p.id === myId);
  const rows = sorted.slice(0, 3).map((p, i) => [i, p] as const);
  if (myRank >= 3) rows.push([myRank, sorted[myRank]] as const);
  const html = rows.map(([i, p]) => `<div class="${p.id === myId ? "mine" : ""}"><span>${i + 1}. ${esc(p.name)}</span><span>${p.score}</span></div>`).join("");
  if ($("board").innerHTML !== html) $("board").innerHTML = html;
  if (!m) return;
  setText($("meName"), m.name); setText($("meScore"), `${m.score} pts · ${m.kills} kills`);
  ($("avatar") as HTMLElement).style.background = "#" + PALETTE[m.color % 12].toString(16).padStart(6, "0");
  setText($("lvlText"), `LEVEL ${m.level}`);
  ($("xpFill") as HTMLElement).style.width = `${Math.min(100, (m.xp / Math.max(1, m.xpNext)) * 100)}%`;
  for (const b of upBtns) {
    const stat = b.dataset.stat as Stat;
    setText(b.querySelector("span")!, String(m.upgrades?.[stat] ?? 0));
    b.classList.toggle("can", m.points > 0);
  }
  $("death").classList.toggle("hidden", m.alive || s.phase === "ended");
}

function tickHud() {
  const s = snaps[snaps.length - 1];
  if (s) {
    const left = Math.max(0, Math.ceil((s.endsAt - serverNow()) / 1000));
    setText($("timer"), (s.phase === "ended" ? "Next match " : "") + `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`);
  }
  const cd = cooldown();
  $("micBtn").classList.toggle("cool", cd > 0);
  const txt = listening ? "Listening…\nsay FIREBALL!" : cd > 0 ? `${cd}s` : voiceOk ? "Say\nFIREBALL!" : "Tap\nFIREBALL!";
  if (($("micText") as HTMLElement).innerText !== txt) ($("micText") as HTMLElement).innerText = txt;
}

// ---------- fireball / voice ----------
let listening = false, voiceOk = voiceSupported, lang = "en-US";
const cooldown = () => { const m = me(); return m ? Math.max(0, Math.ceil((m.fireballReadyAt - serverNow()) / 1000)) : 0; };
function cast(via: "voice" | "touch") {
  const cd = cooldown();
  if (cd > 0) return toast(`🔥 Fireball recharging… ${cd}s`, 1200);
  send({ type: "cast_fireball", via });
}
let heardTimer = 0;
function heard(t: string) {
  const h = $("heard"); h.textContent = `🎤 “${t}”`; h.classList.remove("hidden");
  clearTimeout(heardTimer); heardTimer = window.setTimeout(() => h.classList.add("hidden"), 2500);
}
function voice() {
  if (!voiceOk) return cast("touch");
  if (!listening && cooldown() > 0) return cast("voice"); // shows recharge toast
  listen(lang, {
    onMatch: () => cast("voice"),
    onHeard: heard,
    onState: (on) => { listening = on; $("micBtn").classList.toggle("listen", on); },
    onError: (msg, fatal) => { toast(msg); if (fatal) { voiceOk = false; setText($("fireLbl"), "Tap to cast"); } },
  });
}
$("micBtn").addEventListener("click", voice);
$("tapBtn").addEventListener("click", () => cast("touch"));
$("langBtn").addEventListener("click", () => { lang = lang === "en-US" ? "th-TH" : "en-US"; setText($("langBtn"), lang === "en-US" ? "EN" : "TH"); toast(lang === "th-TH" ? "พูดว่า “ไฟร์บอล!”" : "Say “FIREBALL!”", 1200); });
if (!voiceOk) setText($("fireLbl"), "Tap to cast");

// ---------- buttons ----------
for (const b of upBtns) b.addEventListener("click", () => send({ type: "upgrade", stat: b.dataset.stat as Stat }));
$("roomChip").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(inviteUrl(roomId)); toast("🔗 Invite link copied!"); } catch { toast(inviteUrl(roomId), 4000); }
});
$("inviteBtn").addEventListener("click", async () => {
  try { const r = await shareInvite(roomId); toast(r === "shared" ? "✅ Invite sent!" : r === "copied" ? "🔗 Invite link copied!" : "Invite cancelled"); }
  catch { toast("Couldn't share invite"); }
});
$("rankBtn").addEventListener("click", async () => {
  $("rankTable").innerHTML = "<tr><td>Loading…</td></tr>"; $("rankModal").classList.remove("hidden");
  try {
    const rows = await fetchLeaderboard();
    $("rankTable").innerHTML = rows.length ? rows.slice(0, 50).map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.wins}🏆 ${r.kills}💥</td><td>${r.totalScore}</td></tr>`).join("")
      : "<tr><td>No ranks yet — finish a match!</td></tr>";
  } catch { $("rankTable").innerHTML = "<tr><td>Couldn't load ranks</td></tr>"; }
});
$("rankClose").addEventListener("click", () => $("rankModal").classList.add("hidden"));

// ---------- movement input ----------
const keys = new Set<string>();
addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (!e.repeat && k === "f") cast("touch");
  if (!e.repeat && k === "v") voice();
  keys.add(k);
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => keys.clear());

const joy = $("joy"), knob = $("knob"), R = 50;
let joyId = -1, jx = 0, jz = 0;
function joyMove(e: PointerEvent) {
  const r = joy.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const len = Math.hypot(dx, dy), s = len > R ? R / len : 1;
  jx = (dx * s) / R; jz = (dy * s) / R; knob.style.transform = `translate(${dx * s}px,${dy * s}px)`;
}
joy.addEventListener("pointerdown", (e) => { joyId = e.pointerId; joy.setPointerCapture(e.pointerId); joyMove(e); });
joy.addEventListener("pointermove", (e) => { if (e.pointerId === joyId) joyMove(e); });
const joyEnd = (e: PointerEvent) => { if (e.pointerId !== joyId) return; joyId = -1; jx = jz = 0; knob.style.transform = ""; };
joy.addEventListener("pointerup", joyEnd); joy.addEventListener("pointercancel", joyEnd);

let lastSent = "0,0", lastSentAt = 0;
function sendMove(now: number) {
  let x = jx, z = jz;
  if (keys.has("a") || keys.has("arrowleft")) x -= 1;
  if (keys.has("d") || keys.has("arrowright")) x += 1;
  if (keys.has("w") || keys.has("arrowup")) z -= 1;
  if (keys.has("s") || keys.has("arrowdown")) z += 1;
  const len = Math.hypot(x, z); if (len > 1) { x /= len; z /= len; }
  if (len < 0.15) x = z = 0;
  const key = `${x.toFixed(2)},${z.toFixed(2)}`;
  const held = key !== "0.00,0.00";
  if ((key !== lastSent && now - lastSentAt >= 100) || (held && now - lastSentAt >= 1000)) { // ≤10 msg/s keeps us in the free tier
    send({ type: "move", x: +x.toFixed(2), z: +z.toFixed(2) }); lastSent = key; lastSentAt = now;
  }
}

// ---------- loop ----------
let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  sendMove(now);
  render(frameAt(serverNow() - 100), myId, dt);
  tickHud();
  requestAnimationFrame(loop);
}

// ---------- boot ----------
addEventListener("resize", resize); resize();
requestAnimationFrame(loop);
(async () => {
  try { identity = await initLine(); }
  catch (err) {
    console.error(err);
    identity = { loggedIn: false, name: "Guest-" + Math.floor(Math.random() * 9000 + 1000), roomId: ARENA_ROOM, liffAvailable: false };
  }
  // Let the player choose: LINE identity (ranked) or a Turnstile-verified guest with a random name.
  const lineBtn = $("lineBtn") as HTMLButtonElement, guestBtn = $("guestBtn") as HTMLButtonElement;
  if (identity.loggedIn && new URLSearchParams(location.search).get("login") === "1") return begin();
  setText(lineBtn, identity.loggedIn ? `▶ Play as ${identity.name}` : "Login with LINE");
  lineBtn.classList.toggle("hidden", !identity.loggedIn && !identity.liffAvailable);
  setText($("loadMsg"), identity.loggedIn ? "LINE players are ranked worldwide." : "Log in to get ranked, or jump in as a guest.");
  $("startChoice").classList.remove("hidden");
  lineBtn.onclick = () => { if (identity.loggedIn) begin(); else if (!loginWithLine()) toast("LINE login unavailable"); };
  guestBtn.onclick = async () => {
    lineBtn.disabled = guestBtn.disabled = true;
    setText($("loadMsg"), "Quick security check…");
    try { identity = await playAsGuest($("tsBox")); begin(); }
    catch (err) { setText($("loadMsg"), `${(err as Error).message} — try again.`); lineBtn.disabled = guestBtn.disabled = false; $("tsBox").replaceChildren(); }
  };
})();

function begin() {
  $("startChoice").classList.add("hidden");
  roomId = identity.roomId;
  setText($("roomText"), "ROOM " + roomId); setText($("meName"), identity.name);
  setText($("guestTag"), identity.loggedIn ? "LINE ✓" : "Guest mode — not LINE login");
  const av = $("avatar");
  if (identity.avatar) { const img = new Image(); img.src = identity.avatar; img.alt = ""; av.replaceChildren(img); }
  else av.textContent = identity.name.slice(0, 1).toUpperCase();
  setText($("loadMsg"), identity.loggedIn ? `Welcome, ${identity.name}!` : "Guest mode — not LINE login");
  connect();
  setTimeout(() => $("loading").classList.add("hidden"), 900);
}
