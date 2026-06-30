// holo-xxx-director.mjs — the in-player SCENE DIRECTOR (AURA Phase C). Map a free-text/voice command spoken WHILE
// watching ("skip to the good part", "something slower", "more like this", "mute", "go bigger") to a concrete
// player ACTION. Literal keyword mapping handles the common commands instantly + offline; Q (on-device, injected)
// is the fuzzy backstop for anything the keywords miss. PRIVACY: only the command STRING reaches Q — never the
// scene, title, performer, or any signal. The caller executes the returned {action,arg} against the <video>/UI.
//
// Actions: play | pause | seek_fwd(arg s) | seek_back(arg s) | restart | next | mute | unmute | louder | quieter |
//          theater | project8k | spatial | save | mood(arg=phrase → swap to a Q-picked scene of that mood)

const VOCAB = ["play", "pause", "seek_fwd", "seek_back", "restart", "next", "mute", "unmute", "louder", "quieter", "theater", "project8k", "spatial", "save", "mood"];

// ordered literal rules — first match wins. Tuned so audio words ("turn it down") don't collide with content words.
const RULES = [
  [/\b(skip|jump)\s+(to\s+)?(the\s+)?(good|best|juicy|action)\b/, { action: "seek_fwd", arg: 90 }],
  [/\b(skip|forward|ahead|fast[\s-]?forward|next part|skip ahead)\b/, { action: "seek_fwd", arg: 60 }],
  [/\b(rewind|go back|back up|replay that|a bit back|few seconds back)\b/, { action: "seek_back", arg: 30 }],
  [/\b(restart|start over|from the (start|beginning)|again from the top)\b/, { action: "restart" }],
  [/\b(next|another|something else|skip this|change it|new one)\b/, { action: "next" }],
  [/\b(pause|hold on|wait|freeze)\b/, { action: "pause" }],
  [/\b(resume|unpause|keep going|continue|play it|press play)\b/, { action: "play" }],
  [/\b(unmute|sound (back )?on|audio on)\b/, { action: "unmute" }],
  [/\b(mute|silence|no sound|audio off|sound off)\b/, { action: "mute" }],
  [/\b(louder|volume up|turn it up|crank it|more volume)\b/, { action: "louder" }],
  [/\b(quieter|volume down|turn it down|lower (the )?(volume|sound)|less volume|softer audio)\b/, { action: "quieter" }],
  [/\b(theater|theatre|cinema|full[\s-]?screen|big screen|go big(ger)?)\b/, { action: "theater" }],
  [/\b(8k|super[\s-]?res|project|sharper|crisper|higher (res|quality)|max quality)\b/, { action: "project8k" }],
  [/\b(spatial|3d audio|surround|immersive audio|wider (sound|audio)|hrtf)\b/, { action: "spatial" }],
  [/\b(save|like(?!\s+(this|that))|favou?rite|add to (vault|favou?rites)|keep this|bookmark)\b/, { action: "save" }],
];
// content-MOOD adjustments (swap to a new scene of that mood) — distinct from audio "softer/quieter".
const MOOD_RE = /\b(slower|slow|softer|gentler|gentle|tender|sensual|romantic|passionate|intimate|intense|harder|rougher|rough|faster|wilder|kinkier|more like (this|that)|like (this|that)|similar)\b/;

export function parseAction(raw) {
  const u = String(raw || "").toLowerCase().trim();
  if (!u) return null;
  for (const [re, act] of RULES) if (re.test(u)) return { ...act };
  if (MOOD_RE.test(u)) return { action: "mood", arg: u };
  return null;                                                   // no literal hit → caller may try Q, else default to mood
}

// classify a fuzzy command via Q into ONE vocab token (or null). Strict parse so a chatty model can't inject an action.
async function classifyWithQ(u, chat, timeoutMs) {
  const SYSTEM = "You are a media player command classifier. Map the user's request to EXACTLY ONE token from this "
    + "list and reply with ONLY that token, nothing else: " + VOCAB.join(", ") + ". Use 'mood' for any request about "
    + "the KIND/feel of content (slower, rougher, more like this). Use 'next' for a different scene. Examples — "
    + "'turn it up'->louder; 'jump ahead'->seek_fwd; 'make it sharper'->project8k; 'something gentler'->mood.";
  try {
    const res = await Promise.race([
      Promise.resolve(chat([{ role: "system", content: SYSTEM }, { role: "user", content: u.slice(0, 120) }], { maxTokens: 8 })),
      new Promise((r) => setTimeout(() => r("__t__"), timeoutMs)),
    ]);
    if (!res || res === "__t__") return null;
    const txt = (typeof res === "string" ? res : (res.text || res.content || res.reply || "")).toLowerCase();
    const hit = VOCAB.find((v) => new RegExp("\\b" + v + "\\b").test(txt));
    if (!hit) return null;
    if ((hit === "seek_fwd" || hit === "seek_back")) return { action: hit, arg: hit === "seek_fwd" ? 60 : 30 };
    if (hit === "mood") return { action: "mood", arg: u };
    return { action: hit };
  } catch (_) { return null; }
}

// directCommand(raw, {chat}) → Promise<{action,arg}|null>. Literal first (instant/offline), Q fuzzy backstop, then
// default to treating the whole utterance as a mood (so "show me something dreamy" still does something useful).
export async function directCommand(raw, { chat = null, timeoutMs = 6000 } = {}) {
  const lit = parseAction(raw);
  if (lit) return lit;
  if (chat) { const q = await classifyWithQ(String(raw || "").toLowerCase().trim(), chat, timeoutMs); if (q) return q; }
  const u = String(raw || "").trim();
  return u ? { action: "mood", arg: u } : null;
}

export default { directCommand, parseAction };
