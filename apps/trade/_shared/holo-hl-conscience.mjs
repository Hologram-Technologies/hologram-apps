// holo-hl-conscience.mjs — the pre-dispatch conscience gate for Holo Trade (ADR-0070 + ADR-0033).
// PURE + isomorphic (no imports): the SAME function runs in the browser exchange layer and in the
// Node witness, so what the witness proves is exactly what the app enforces.
//
// An action is screened BEFORE it is ever signed. A blocked action produces NO signature — the
// substrate refuses to put the user's key behind an order that breaks their own rules. Two kinds
// of rule: risk limits (notional / leverage), and ATTENUATION — an agent-scoped wallet (a
// Hyperliquid `approveAgent` key, withdrawal-less by design) is ALSO refused, client-side, any
// fund-moving action, so the substrate enforces the same boundary the venue does (defence in depth).

const FUND_MOVING = new Set(["withdraw3", "spotSend", "usdSend", "vaultTransfer", "sendAsset", "cWithdraw"]);

// screen(action, limits) → { allow, reason, verdict }
//   limits = { scope: "agent"|"master", maxNotionalUsd?, maxLeverage?, perMarketNotionalUsd?, allowFundMovement? }
export function screen(action, limits = {}) {
  const checks = [];
  const fail = (reason) => ({ allow: false, reason, verdict: { decision: "block", reason, checks } });
  const t = action && action.type;

  // attenuation — agent keys can never move funds (mirrors Hyperliquid's agent-wallet design)
  if (FUND_MOVING.has(t)) {
    const may = limits.scope !== "agent" && limits.allowFundMovement !== false;
    checks.push({ rule: "fund-movement", action: t, scope: limits.scope || "master", pass: may });
    if (!may) return fail(`${limits.scope === "agent" ? "agent wallet" : "this session"} may not move funds (${t})`);
  }

  // risk limits on orders — notional ceiling per order and (optionally) per market
  if (t === "order") {
    for (const o of (action.orders || [])) {
      const notional = (Number(o.p) || 0) * (Number(o.s) || 0);
      if (limits.maxNotionalUsd != null) {
        const pass = notional <= limits.maxNotionalUsd;
        checks.push({ rule: "max-notional", asset: o.a, notionalUsd: notional, cap: limits.maxNotionalUsd, pass });
        if (!pass) return fail(`order notional $${notional.toFixed(2)} exceeds cap $${limits.maxNotionalUsd}`);
      }
      if (limits.perMarketNotionalUsd != null && limits.perMarketNotionalUsd[o.a] != null) {
        const cap = limits.perMarketNotionalUsd[o.a], pass = notional <= cap;
        checks.push({ rule: "per-market-notional", asset: o.a, notionalUsd: notional, cap, pass });
        if (!pass) return fail(`order notional $${notional.toFixed(2)} exceeds market cap $${cap}`);
      }
    }
  }

  // leverage ceiling
  if (t === "updateLeverage" && limits.maxLeverage != null) {
    const pass = (Number(action.leverage) || 0) <= limits.maxLeverage;
    checks.push({ rule: "max-leverage", leverage: action.leverage, cap: limits.maxLeverage, pass });
    if (!pass) return fail(`leverage ${action.leverage}x exceeds cap ${limits.maxLeverage}x`);
  }

  return { allow: true, reason: "ok", verdict: { decision: "accept", checks } };
}
