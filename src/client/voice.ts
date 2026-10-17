// Push-to-talk FIREBALL recognition. Native Web Speech API only; nothing is recorded or uploaded by us.
const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
export const voiceSupported = !!SR;

const WORDS = ["fireball", "fireboll", "firebal", "firebol", "fierball", "firebowl", "fyreball", "ไฟร์บอล", "ไฟบอล", "ไฟบอล์", "ไฟร์บอลล์"];
export const normalize = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
export const isFireball = (s: string) => {
  const n = normalize(s);
  return WORDS.some((w) => n.includes(w)) || (n.includes("fire") && (n.includes("ball") || n.includes("bowl")));
};

export interface VoiceHandlers {
  onMatch(): void;
  onHeard(text: string): void;
  onState(listening: boolean): void;
  onError(msg: string, fatal: boolean): void;
}

let active: any = null;

export function listen(lang: string, h: VoiceHandlers) {
  if (!SR) return h.onError("Voice not supported here — tap to cast!", true);
  if (active) { active.abort(); return; }
  const rec = new SR();
  active = rec;
  rec.lang = lang; rec.continuous = false; rec.interimResults = true; rec.maxAlternatives = 5;
  let matched = false;
  const timer = setTimeout(() => rec.stop(), 4000);
  rec.onresult = (e: any) => {
    let best = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      for (let j = 0; j < r.length; j++) {
        const t = r[j].transcript;
        if (!best) best = t;
        if (!matched && isFireball(t)) { matched = true; h.onHeard(t); h.onMatch(); rec.stop(); return; }
      }
    }
    if (best) h.onHeard(best);
  };
  rec.onerror = (e: any) => {
    const map: Record<string, [string, boolean]> = {
      "not-allowed": ["Mic permission denied — tap to cast instead", true],
      "service-not-allowed": ["Voice unavailable here — tap to cast instead", true],
      "no-speech": ["Didn't hear anything — shout FIREBALL!", false],
      network: ["Voice needs a network connection", false],
      "audio-capture": ["No microphone found", true],
    };
    if (e.error === "aborted") return;
    const [msg, fatal] = map[e.error] || ["Voice error: " + e.error, false];
    h.onError(msg, fatal);
  };
  rec.onend = () => { clearTimeout(timer); active = null; h.onState(false); };
  try { rec.start(); h.onState(true); }
  catch { active = null; h.onError("Couldn't start voice — tap to cast", false); }
}
