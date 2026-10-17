import * as THREE from "three";
import { ARENA_HALF, PALETTE, type PlayerState, type ShapeState, type BulletState, type FireballState } from "../shared/protocol";

export const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 300);

// ---------- environment ----------
const sky = document.createElement("canvas"); sky.width = 2; sky.height = 256;
{ const g = sky.getContext("2d")!, gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, "#5fb8ff"); gr.addColorStop(1, "#e6f6ff"); g.fillStyle = gr; g.fillRect(0, 0, 2, 256); }
const skyTex = new THREE.CanvasTexture(sky); skyTex.colorSpace = THREE.SRGBColorSpace;
scene.background = skyTex;
scene.fog = new THREE.Fog(0xd8efff, 45, 110);
scene.add(new THREE.HemisphereLight(0xffffff, 0xb8d4ee, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(12, 30, 18); scene.add(sun);

const tile = document.createElement("canvas"); tile.width = tile.height = 128;
{ const g = tile.getContext("2d")!; g.fillStyle = "#fbfdff"; g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#eef3fa"; g.fillRect(0, 0, 64, 64); g.fillRect(64, 64, 64, 64);
  g.strokeStyle = "#dbe5f2"; g.lineWidth = 3; g.strokeRect(0, 0, 128, 128); }
const tileTex = new THREE.CanvasTexture(tile); tileTex.colorSpace = THREE.SRGBColorSpace;
tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping; tileTex.anisotropy = 4;
const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_HALF * 4, ARENA_HALF * 4), new THREE.MeshLambertMaterial({ map: tileTex }));
floor.rotation.x = -Math.PI / 2; tileTex.repeat.set(60, 60); scene.add(floor);
{ const wallMat = new THREE.MeshLambertMaterial({ color: 0x9fd6ff }), capMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const L = ARENA_HALF * 2 + 2;
  for (const [x, z, r] of [[0, -ARENA_HALF - 0.5, 0], [0, ARENA_HALF + 0.5, 0], [-ARENA_HALF - 0.5, 0, 1], [ARENA_HALF + 0.5, 0, 1]]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(L, 1.2, 1), wallMat); w.position.set(x, 0.6, z); w.rotation.y = r * Math.PI / 2; scene.add(w);
    const c = new THREE.Mesh(new THREE.BoxGeometry(L, 0.25, 1.2), capMat); c.position.set(x, 1.3, z); c.rotation.y = r * Math.PI / 2; scene.add(c);
  } }

// ---------- shared assets ----------
const flat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.05, flatShading: true });
const shapeMats = PALETTE.map((c) => flat(new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.35).getHex()));
const glowMats = PALETTE.map((c) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.4) }));
const haloMats = PALETTE.map((c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
const shapeGeo = { cube: new THREE.BoxGeometry(1, 1, 1), hex: new THREE.CylinderGeometry(0.6, 0.6, 0.9, 6), pyramid: new THREE.ConeGeometry(0.7, 1.1, 4) };
const sphere = new THREE.SphereGeometry(1, 16, 12);
const treadMat = new THREE.MeshStandardMaterial({ color: 0x2b3245, roughness: 0.8 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x3a4357, roughness: 0.4 });
const geo = {
  body: new THREE.BoxGeometry(1.5, 0.55, 1.9), bodyTop: new THREE.CylinderGeometry(0.75, 0.75, 1.5, 16, 1, false, 0, Math.PI),
  tread: new THREE.BoxGeometry(0.42, 0.5, 2.1), wheel: new THREE.CylinderGeometry(0.26, 0.26, 0.46, 12),
  dome: new THREE.SphereGeometry(0.55, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), barrel: new THREE.CylinderGeometry(0.14, 0.17, 1.3, 12),
  muzzle: new THREE.CylinderGeometry(0.2, 0.2, 0.22, 12), ring: new THREE.RingGeometry(1.45, 1.75, 40), shock: new THREE.RingGeometry(0.85, 1, 64),
};
const barBg = new THREE.SpriteMaterial({ color: 0x1f2a44, depthTest: false, transparent: true, opacity: 0.6 });
const barFg = new THREE.SpriteMaterial({ color: 0x22c55e, depthTest: false });

const dotTex = (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.35, "rgba(255,255,255,.7)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();

// ---------- particles (two pooled Points systems) ----------
class Particles {
  n: number; pos: Float32Array; col: Float32Array; vel: Float32Array; life: Float32Array; max: Float32Array; base: Float32Array; grav: Float32Array; i = 0;
  geo = new THREE.BufferGeometry();
  constructor(n: number, size: number) {
    this.n = n; this.pos = new Float32Array(n * 3).fill(-999); this.col = new Float32Array(n * 3); this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n); this.max = new Float32Array(n).fill(1); this.base = new Float32Array(n * 3); this.grav = new Float32Array(n);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3)); this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    const pts = new THREE.Points(this.geo, new THREE.PointsMaterial({ size, map: dotTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    pts.frustumCulled = false; scene.add(pts);
  }
  emit(x: number, y: number, z: number, count: number, color: THREE.Color, speed: number, life: number, grav = -9, up = 0.5) {
    for (let k = 0; k < count; k++) {
      const i = this.i = (this.i + 1) % this.n, a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
      this.pos.set([x, y, z], i * 3);
      this.vel.set([Math.cos(a) * s, (Math.random() * 0.6 + up) * s, Math.sin(a) * s], i * 3);
      this.base.set([color.r, color.g, color.b], i * 3); this.life[i] = this.max[i] = life * (0.6 + Math.random() * 0.4); this.grav[i] = grav;
    }
  }
  update(dt: number) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt; const k = Math.max(0, this.life[i] / this.max[i]), j = i * 3;
      this.vel[j + 1] += this.grav[i] * dt;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] = Math.max(0.05, this.pos[j + 1] + this.vel[j + 1] * dt); this.pos[j + 2] += this.vel[j + 2] * dt;
      this.col[j] = this.base[j] * k; this.col[j + 1] = this.base[j + 1] * k; this.col[j + 2] = this.base[j + 2] * k;
      if (k === 0) this.pos[j + 1] = -999;
    }
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.color.needsUpdate = true;
  }
}
const sparks = new Particles(600, 0.45), fire = new Particles(900, 1.6);
const FIRE = [new THREE.Color(0xffd166), new THREE.Color(0xff7a1a), new THREE.Color(0xff3d00)];

// ---------- shockwave rings (pooled) ----------
const rings: { m: THREE.Mesh; t: number; dur: number; r: number }[] = [];
function ring(x: number, z: number, radius: number, color: number, dur: number) {
  let r = rings.find((q) => q.t >= q.dur);
  if (!r) { r = { m: new THREE.Mesh(geo.shock, new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })), t: 0, dur: 1, r: 1 };
    r.m.rotation.x = -Math.PI / 2; scene.add(r.m); rings.push(r); }
  r.t = 0; r.dur = dur; r.r = radius; r.m.visible = true; r.m.position.set(x, 0.15, z); (r.m.material as THREE.MeshBasicMaterial).color.setHex(color);
}

// ---------- name tags ----------
function makeTag() {
  const c = document.createElement("canvas"); c.width = 256; c.height = 72;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(4.6, 1.3, 1); s.position.y = 2.9; s.renderOrder = 10;
  return { s, c, tex, key: "" };
}
function drawTag(t: ReturnType<typeof makeTag>, p: PlayerState, mine: boolean) {
  const key = `${p.name}|${p.hp}|${p.maxHp}|${p.level}`; if (key === t.key) return; t.key = key;
  const g = t.c.getContext("2d")!; g.clearRect(0, 0, 256, 72);
  g.font = "800 26px 'Baloo 2', system-ui, sans-serif"; g.textAlign = "center"; g.lineWidth = 6; g.strokeStyle = "#1f2a44";
  const label = `Lv${p.level} ${p.name}`.slice(0, 20);
  g.strokeText(label, 128, 28); g.fillStyle = mine ? "#b9ffcf" : "#fff"; g.fillText(label, 128, 28);
  const w = 180, x = 38, y = 42, k = Math.max(0, p.hp / p.maxHp);
  g.fillStyle = "#1f2a44"; g.beginPath(); g.roundRect(x - 3, y - 3, w + 6, 20, 9); g.fill();
  g.fillStyle = k > 0.5 ? "#22c55e" : k > 0.25 ? "#facc15" : "#ef4444"; g.beginPath(); g.roundRect(x, y, w * k, 14, 7); g.fill();
  t.tex.needsUpdate = true;
}

// ---------- tanks ----------
interface Tank { g: THREE.Group; turret: THREE.Group; mat: THREE.MeshStandardMaterial; tag: ReturnType<typeof makeTag>; flash: number; color: number; ring?: THREE.Mesh }
const tanks = new Map<string, Tank>();
function makeTank(color: number): Tank {
  const g = new THREE.Group(), mat = flat(PALETTE[color % 12]); mat.flatShading = false;
  const body = new THREE.Mesh(geo.body, mat); body.position.y = 0.55; g.add(body);
  const top = new THREE.Mesh(geo.bodyTop, mat); top.rotation.z = Math.PI / 2; top.rotation.y = Math.PI / 2; top.scale.set(1, 1, 0.45); top.position.y = 0.82; g.add(top);
  for (const sx of [-0.85, 0.85]) {
    const t = new THREE.Mesh(geo.tread, treadMat); t.position.set(sx, 0.3, 0); g.add(t);
    for (const wz of [-0.7, 0, 0.7]) { const w = new THREE.Mesh(geo.wheel, darkMat); w.rotation.z = Math.PI / 2; w.position.set(sx * 1.02, 0.3, wz); g.add(w); }
  }
  const turret = new THREE.Group(); turret.position.y = 1.05; g.add(turret);
  turret.add(new THREE.Mesh(geo.dome, mat));
  const barrel = new THREE.Mesh(geo.barrel, darkMat); barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.2, 0.9); turret.add(barrel);
  const muzzle = new THREE.Mesh(geo.muzzle, darkMat); muzzle.rotation.x = Math.PI / 2; muzzle.position.set(0, 0.2, 1.55); turret.add(muzzle);
  const tag = makeTag(); g.add(tag.s);
  scene.add(g);
  return { g, turret, mat, tag, flash: 0, color };
}

// ---------- shapes ----------
interface Shape { g: THREE.Group; m: THREE.Mesh; fg: THREE.Sprite; bars: THREE.Group; phase: number; pop: number; dying: number; color: number; size: number }
const shapes = new Map<string, Shape>();
const dyingShapes: Shape[] = [];
function makeShape(s: ShapeState): Shape {
  const g = new THREE.Group(), m = new THREE.Mesh(shapeGeo[s.kind] || shapeGeo.cube, shapeMats[s.color % 12]);
  g.add(m);
  const bars = new THREE.Group(), bg = new THREE.Sprite(barBg), fg = new THREE.Sprite(barFg);
  bg.scale.set(1.3, 0.16, 1); fg.center.set(0, 0.5); fg.position.x = -0.6; fg.scale.set(1.2, 0.1, 1); bg.renderOrder = fg.renderOrder = 9;
  bars.add(bg, fg); g.add(bars); scene.add(g);
  return { g, m, fg, bars, phase: Math.random() * 6, pop: 0, dying: -1, color: s.color, size: s.size };
}

// ---------- bullets & fireballs ----------
const bulletPool: THREE.Group[] = [];
function bullet(i: number, color: number) {
  let b = bulletPool[i];
  if (!b) { b = new THREE.Group(); const core = new THREE.Mesh(sphere, glowMats[0]); core.scale.setScalar(0.28); const halo = new THREE.Mesh(sphere, haloMats[0]); halo.scale.setScalar(0.55);
    b.add(core, halo); scene.add(b); bulletPool[i] = b; }
  (b.children[0] as THREE.Mesh).material = glowMats[color % 12]; (b.children[1] as THREE.Mesh).material = haloMats[color % 12];
  b.visible = true; return b;
}
const fbOuterMat = new THREE.MeshBasicMaterial({ color: 0xff6a00, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
const fbMidMat = new THREE.MeshBasicMaterial({ color: 0xffa500, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
const fbCoreMat = new THREE.MeshBasicMaterial({ color: 0xfff3b0 });
const fbPool: { g: THREE.Group; core: THREE.Mesh; mid: THREE.Mesh; light: THREE.PointLight }[] = [];
for (let i = 0; i < 3; i++) { // lights pre-allocated: adding lights later would force shader recompiles
  const g = new THREE.Group(), outer = new THREE.Mesh(sphere, fbOuterMat), mid = new THREE.Mesh(sphere, fbMidMat), core = new THREE.Mesh(sphere, fbCoreMat);
  outer.scale.setScalar(1.9); mid.scale.setScalar(1.3); core.scale.setScalar(0.8);
  const light = new THREE.PointLight(0xff8a2a, 0, 18, 1.5); g.add(outer, mid, core); g.visible = false; scene.add(g, light);
  fbPool.push({ g, core, mid, light });
}

// ---------- public API ----------
let shake = 0, time = 0;
const camTarget = new THREE.Vector3(), camPos = new THREE.Vector3(0, 30, 30);
const myRing = new THREE.Mesh(geo.ring, new THREE.MeshBasicMaterial({ color: 0x06c755, transparent: true, opacity: 0.9, depthWrite: false }));
myRing.rotation.x = -Math.PI / 2; myRing.position.y = 0.06; scene.add(myRing);

export interface Frame { players: PlayerState[]; shapes: ShapeState[]; bullets: BulletState[]; fireballs: FireballState[] }

export function render(f: Frame, myId: string, dt: number) {
  time += dt;
  const seen = new Set<string>();
  for (const p of f.players) {
    seen.add(p.id);
    let t = tanks.get(p.id);
    if (!t || t.color !== p.color) { if (t) scene.remove(t.g); t = makeTank(p.color); tanks.set(p.id, t); }
    t.g.visible = p.alive; t.g.position.set(p.x, 0, p.z); t.g.rotation.y = p.rot; t.turret.rotation.y = p.aim - p.rot;
    drawTag(t.tag, p, p.id === myId);
    t.flash = Math.max(0, t.flash - dt * 4); t.mat.emissive.setRGB(t.flash, t.flash * 0.9, t.flash * 0.9);
    if (p.id === myId) { myRing.visible = p.alive; myRing.position.x = p.x; myRing.position.z = p.z; myRing.scale.setScalar(1 + Math.sin(time * 4) * 0.05);
      camTarget.set(p.x, 0, p.z); }
  }
  for (const [id, t] of tanks) if (!seen.has(id)) { scene.remove(t.g); t.mat.dispose(); t.tag.tex.dispose(); tanks.delete(id); }

  seen.clear();
  for (const s of f.shapes) {
    seen.add(s.id);
    let v = shapes.get(s.id); if (!v) { v = makeShape(s); shapes.set(s.id, v); }
    const sc = s.size * (1 + v.pop * 0.25); v.pop = Math.max(0, v.pop - dt * 5);
    v.g.position.set(s.x, s.size * 0.6 + Math.sin(time * 1.6 + v.phase) * 0.15, s.z);
    v.m.scale.setScalar(sc); v.m.rotation.y = time * 0.5 + v.phase; v.m.rotation.x = Math.sin(time * 0.7 + v.phase) * 0.2;
    const k = s.hp / s.maxHp; v.bars.visible = k < 0.999; v.bars.position.y = s.size * 0.9 + 0.4; v.fg.scale.x = 1.2 * Math.max(0, k);
  }
  for (const [id, v] of shapes) if (!seen.has(id)) { shapes.delete(id); v.dying = 0; v.bars.visible = false; dyingShapes.push(v); }
  for (let i = dyingShapes.length - 1; i >= 0; i--) {
    const v = dyingShapes[i]; v.dying += dt;
    const k = v.dying / 0.25; v.m.scale.setScalar(v.size * (k < 0.4 ? 1 + k : Math.max(0, 1.4 * (1 - (k - 0.4) / 0.6))));
    if (k >= 1) { scene.remove(v.g); dyingShapes.splice(i, 1); }
  }

  const color = (owner: string) => f.players.find((p) => p.id === owner)?.color ?? 0;
  f.bullets.forEach((b, i) => bullet(i, color(b.owner)).position.set(b.x, 0.9, b.z));
  for (let i = f.bullets.length; i < bulletPool.length; i++) bulletPool[i].visible = false;

  fbPool.forEach((fb, i) => {
    const s = f.fireballs[i];
    fb.g.visible = !!s; fb.light.intensity = s ? 60 + Math.random() * 30 : 0;
    if (!s) return;
    fb.g.position.set(s.x, 1.6, s.z); fb.light.position.set(s.x, 2.2, s.z);
    const fl = 1 + Math.sin(time * 37) * 0.08 + Math.random() * 0.08;
    fb.core.scale.setScalar(0.8 * fl); fb.mid.scale.setScalar(1.3 + Math.sin(time * 23) * 0.1); fb.g.rotation.y += dt * 6;
    for (let k = 0; k < 4; k++) fire.emit(s.x + (Math.random() - 0.5), 1.4 + Math.random(), s.z + (Math.random() - 0.5), 1, FIRE[k % 3], 2, 0.6, 2, 0.4);
  });

  sparks.update(dt); fire.update(dt);
  for (const r of rings) { if (r.t >= r.dur) { r.m.visible = false; continue; }
    r.t += dt; const k = Math.min(1, r.t / r.dur), e = 1 - Math.pow(1 - k, 3);
    r.m.scale.setScalar(0.3 + e * r.r); (r.m.material as THREE.MeshBasicMaterial).opacity = 1 - k; }

  // camera: fixed-heading follow so world-space joystick stays intuitive; pull back in portrait
  const aspect = canvas.clientWidth / canvas.clientHeight, dist = aspect < 1 ? 24 : 17;
  camPos.lerp(new THREE.Vector3(camTarget.x, dist * 1.05, camTarget.z + dist * 0.8), 1 - Math.exp(-dt * 6));
  camera.position.copy(camPos);
  shake = Math.max(0, shake - dt * 2.5);
  if (shake > 0) camera.position.add(new THREE.Vector3((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake));
  camera.lookAt(camPos.x, 0, camPos.z - dist * 0.8);
  renderer.render(scene, camera);
}

export function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = w < h ? 62 : 50; camera.updateProjectionMatrix();
}

// ---------- effects driven by game events ----------
export function fxHit(target: string, x: number, z: number) {
  const t = tanks.get(target); if (t) t.flash = 1;
  const s = shapes.get(target); if (s) s.pop = 1;
  sparks.emit(x, 1, z, 10, new THREE.Color(0xfff1a8), 6, 0.35);
}
export function fxShapeDestroyed(id: string, x: number, z: number) {
  const s = shapes.get(id) || dyingShapes.find((d) => d.g.position.x === x);
  const c = new THREE.Color(PALETTE[(s?.color ?? 0) % 12]);
  sparks.emit(x, 1, z, 26, c, 8, 0.7); sparks.emit(x, 1, z, 10, new THREE.Color(0xffffff), 5, 0.4);
  ring(x, z, 3, c.getHex(), 0.4);
}
export function fxExplosion(x: number, z: number) {
  for (let k = 0; k < 3; k++) fire.emit(x, 1, z, 14, FIRE[k], 7, 0.8, -3);
  sparks.emit(x, 1, z, 30, new THREE.Color(0xffffff), 10, 0.5); ring(x, z, 4, 0xff7a1a, 0.5);
}
export function fxFireball(x: number, z: number, radius: number, nearMe: boolean) {
  for (let k = 0; k < 3; k++) fire.emit(x, 1.5, z, 70, FIRE[k], radius * 2.2, 1.1, -2, 0.3);
  sparks.emit(x, 1, z, 90, new THREE.Color(0xfff3b0), radius * 3, 0.8);
  ring(x, z, radius, 0xff8a00, 0.6); ring(x, z, radius * 1.3, 0xffd166, 0.9);
  shake = nearMe ? 1.6 : 0.7;
}
export const tankPos = (id: string) => tanks.get(id)?.g.position;
