# Medusa pure-vs-native split — Stage 1 probe (Holo Hub / ADR-0094)

The honest fork the ADR promised to resolve empirically, not guess. Pinned at
Medusa **v2.15.5** (`b74b5b19569534412a67835ffae8fb3afbf6f5c5`). Classification was
VERIFIED by reading the actual source, not inferred from names.

## Headline finding

Medusa's commerce logic cleanly separates into a **dependency-light PURE math layer**
and a **DI/ORM/transaction service layer**. The pure layer is a clean Holo Forge target;
the service layer is realized natively over the κ-store. The data model + Store-API are
adopted as byte-pinned κ.

## ADOPT — byte-pinned κ, the contract (never executed)
- `www/apps/api-reference/specs/store/openapi.full.yaml` (1.37 MB) —
  κ `did:holo:sha256:40e306a68628bd0e6f51b1dfa9dff9fac18a2db901a41f8f38d8ecf37a97ca78`.
  The Store-API contract. The storefront speaks this shape; projected as MCP + `/~hub/api`
  (ADR-0093). The deeper MikroORM entity models (`packages/modules/*/src/models/*.ts`) are
  pinned in Stage 2 when products map to κ.

## COMPILE — vendored, Forge κ-transform (ADR-0051), runs in-tab
Deterministic functions, inputs→outputs, re-derivable (L5).

**Stage 3 DONE — the clean pure core (compiled + witnessed 11/11):** the tax+totals MATH —
- `totals/math.ts` → `MathBN`: pure arithmetic over `bignumber.js`. **Verified pure.**
- `totals/big-number.ts` → the `BigNumber` value type. **Verified pure** (deps: `bignumber.js`,
  `common/{is-defined,is-string,is-big-number,is-object}`; `process.env.*` defined away at build).
- `totals/tax/index.ts` → `calculateTaxTotal`, `calculateAmountsWithTax`. **Verified pure.**
Closure = `bignumber.js@9.1.2` (vendored, `../bignumber.js/`) + the pure `common` helpers; the
impure `../common` barrel is resolved to a curated pure-subset shim at build time (verbatim files
untouched). `@medusajs/types` is type-only → esbuild elides. Compiled to one 48 KB self-contained
ESM kernel (`holo-hub-kernel.mjs`); deterministic (same κ), 0-network at runtime.

**Next compile sub-stage — wider totals (NOT yet pure-closed):** `totals/{cart,line-item,
shipping-method,promotion,adjustment,credit-lines}` + `pricing/price-list.ts` reach the impure
`../common` barrel for non-trivial helpers (e.g. `pickValueFromObject`) + `defaults/currencies`;
they compile once those helpers are curated into the pure-subset shim.

## RECLASSIFIED to NATIVE — `promotion/src/utils/compute-actions/**` (NOT pure)
Stage-1 listed these as COMPILE candidates; reading the source corrected that. They import
`@medusajs/framework/utils` (6×), `@mikro-orm/postgresql` (1×), and `@models` (4×) — i.e. ORM
query building + the framework SDK. **Promotion ACTION-SELECTION is glue**, realized natively over
the κ-store, not compiled. (Promotion TOTALS math, `totals/promotion`, remains a COMPILE target.)

## NATIVE — realized over the κ-store (the ADR-0029 trade; written in later stages)
DI/ORM/transaction service classes — NOT pure, NOT vendored as runtime. Identified, surfaced:
- `packages/modules/*/src/services/*-module-service.ts` (e.g. `tax-module-service.ts`).
  **Verified glue:** `extends ModulesSdkUtils.MedusaService`, injected `DAL.RepositoryService`,
  `@InjectManager` / `@InjectTransactionManager`, MikroORM `@models`. These manage persistence
  + transactions + providers — replaced by κ-store reads/writes + the Stage-3 pure kernels.

## What this means for the stages
- Stage 2: back the adopted model with the κ-store; map the 41 catalog apps → product κ.
- Stage 3: vendor `bignumber.js` + helpers; Forge-compile the COMPILE set → WASM κ-transforms;
  witness a pricing/tax transform re-derives byte-for-byte (L5).
- Stage 5: cart→checkout uses the Stage-3 kernels in-tab (0-network), settles to a κ Title.
