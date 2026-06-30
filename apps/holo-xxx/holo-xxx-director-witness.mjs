// holo-xxx-director-witness.mjs — scene-director (AURA Phase C) witness. Node-runnable, no brain.
// Proves the literal command→action mapping (instant/offline path), the Q fuzzy backstop, the mood default,
// and ZERO EGRESS (only the command string reaches Q). Run: node holo-xxx-director-witness.mjs
import { directCommand, parseAction } from "./holo-xxx-director.mjs";

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n); } };
const act = (s) => { const a = parseAction(s); return a && a.action; };

(async () => {
  console.log("scene-director witness");

  // literal controls
  ok("'skip to the good part' → seek_fwd 90", (() => { const a = parseAction("skip to the good part"); return a.action === "seek_fwd" && a.arg === 90; })());
  ok("'jump ahead' → seek_fwd", act("jump ahead") === "seek_fwd");
  ok("'rewind a bit' → seek_back", act("rewind a bit") === "seek_back");
  ok("'start over' → restart", act("start over") === "restart");
  ok("'next one' → next", act("show me the next one") === "next");
  ok("'pause' → pause", act("pause") === "pause");
  ok("'keep going' → play", act("keep going") === "play");
  ok("'mute it' → mute", act("mute it") === "mute");
  ok("'sound back on' → unmute", act("sound back on") === "unmute");
  ok("'turn it up' → louder", act("turn it up") === "louder");
  ok("'turn it down' → quieter", act("turn it down") === "quieter");
  ok("'go bigger' → theater", act("go bigger") === "theater");
  ok("'make it sharper' → project8k", act("make it sharper") === "project8k");
  ok("'surround sound' → spatial", act("give me surround sound") === "spatial");
  ok("'add to vault' → save", act("add to vault") === "save");

  // content-mood vs audio disambiguation
  ok("'something slower' → mood (content, not audio)", act("something slower") === "mood");
  ok("'softer audio' → quieter (audio, not mood)", act("softer audio") === "quieter");
  ok("'more like this' → mood", act("more like this") === "mood");
  ok("'rougher' → mood", act("give me something rougher") === "mood");

  // no literal hit + no brain → default to mood (so the utterance still does something)
  {
    const a = await directCommand("show me something dreamy and ethereal", { chat: null });
    ok("unmatched + no brain → mood default", a && a.action === "mood" && /dreamy/.test(a.arg));
  }

  // Q fuzzy backstop: a phrasing the literals miss → Q classifies; ZERO EGRESS (only the command reaches Q)
  {
    const seen = [];
    const chat = async (h) => { seen.push(JSON.stringify(h)); return "project8k"; };
    const a = await directCommand("can you make the picture nicer", { chat });
    ok("Q backstop maps fuzzy → project8k", a && a.action === "project8k");
    const blob = seen.join(" | ");
    ok("only the command string reached Q (no scene/title/url)", blob.includes("make the picture nicer") && !/title|performer|http|_src|\"id\"/i.test(blob));
  }

  // Q returning junk → caller still gets a usable default (mood)
  {
    const chat = async () => "I think you should probably consider the bbb option maybe";
    const a = await directCommand("zxqw nonsense", { chat });
    ok("Q junk reply → mood default (never null on non-empty input)", a && a.action === "mood");
  }

  ok("empty input → null", (await directCommand("", { chat: null })) === null);

  console.log(`\n${pass}/${pass + fail} passed` + (fail ? ` — ${fail} FAILED` : " — all green"));
  process.exit(fail ? 1 : 0);
})();
