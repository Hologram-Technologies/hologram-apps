import { openRealModel, realForward, argmax } from "./gguf-forge-qwen35-real.mjs";
const M = await openRealModel("holo-apps/apps/q/forge/.models/qwen3.5-9b-thinking.holo");
let ids = [760, 6511, 314, 9338, 369];   // "The capital of France is"
const N = Number(process.argv[2] || 6);
for (let i = 0; i < N; i++) {
  const logits = await realForward(M, ids, { normPlusOne: false });
  const t = argmax(logits); ids.push(t);
  process.stderr.write(`\r  generated ${i + 1}/${N}: +${t}    `);
}
process.stderr.write("\r");
console.log("IDS", JSON.stringify(ids));
M.close();
