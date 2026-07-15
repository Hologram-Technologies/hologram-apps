import { openRealModel, realForward, argmax } from "./gguf-forge-qwen35-real.mjs";
const ids = [760, 6511, 314, 9338, 369];            // "The capital of France is"
const normPlusOne = process.argv[2] !== "false";
const M = await openRealModel("holo-apps/apps/q/forge/.models/qwen3.5-9b-thinking.holo");
const t0 = Date.now();
const logits = await realForward(M, ids, { normPlusOne, onLayer: (L, ty) => process.stderr.write(`\r  layer ${L} ${ty}    `) });
const top = [...logits.keys()].sort((a, b) => logits[b] - logits[a]).slice(0, 8);
process.stderr.write("\r");
console.log(`normPlusOne=${normPlusOne}  time=${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log("argmax:", argmax(logits), " (expected 11751 = ' Paris')");
console.log("top8 ids:", top.map((i) => `${i}:${logits[i].toFixed(2)}`).join("  "));
M.close();
