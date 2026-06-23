# Fugu-inspired extensions (v0.9) — design notes

## Source

Sakana AI, *Sakana Fugu Technical Report* (2026). Fugu is a family of **learned
orchestrators** that, given a query, build an agentic scaffold over a pool of frontier
LLM workers (panel/judge/writer-style coordination, debate, routing). The report
benchmarks against **OpenRouter Fusion** — the product fusionix re-implements — and
names the core weakness of a *fixed* deliberation pipeline (§4.4):

> dynamic adaptation of an aggregator role is precisely the kind of adaptation
> unavailable to existing multi-agent systems … which necessitate a fixed model to
> *always* act as a final synthesizer … such systems are thereby bottlenecked by that
> rigidity.

fusionix is exactly such a pipeline (fixed `judge` and `writer`). The Fugu ideas are
worth adopting; the constraint is that **fusionix is a deterministic, zero-runtime-dep
gateway pipeline with no training loop**, so it adopts Fugu's *structural* ideas as
small, deterministic, opt-in controls — not as a learned policy.

The user mandate for v0.9 was "everything, supersede spec": implement all tiers as the
new product and bump the frozen v0.8 spec to v0.9 (§22), superseding the relevant §19
non-goals.

## What was implemented (tiers → features)

| Fugu idea | fusionix feature | Flag(s) | Spec | Commit |
|---|---|---|---|---|
| Domain-specialization priors (§4.2) | Capability table `capabilities.ts` | — | §22.6 | `c5ce15d` |
| Configurable agent pools (§2–3) | Provider filtering | `--only-provider` / `--exclude-provider` | §22.1 | `d9469cb` |
| Latency-aware single-worker variant | Single-model routing | `--route`, `--mode fast` | §22.4 | `d9469cb` |
| Two operating points (Fugu vs Fugu-Ultra) | Mode sugar | `--mode fast\|deliberate` | §22.3 | `d9469cb` |
| Per-query aggregator (§4.4) | Adaptive writer selection | `--writer-strategy top-ranked\|capability` | §22.2 | `2db2545` |
| Aggregator *resolves* contradictions (§4.4) | Stronger writer prompt | (always on) | §22.2 | `2db2545` |
| Debate & aggregation topologies (§4.4) | Debate revision round | `--topology debate` | §22.5 | `a20cab5` |
| "beyond any individual agent" (§4) | A/B eval harness | `node qa/ab-eval.mjs` | — | `c507401` |

**Hard invariant across all of them:** off by default. With no v0.9 flag, the pipeline
is byte-for-byte §1 behavior (QA regression guard `M8`, plus the unchanged 78 baseline
cases). Everything is resolved deterministically in `normalizeRequest` before any
gateway call (§6.8), except the adaptive writer, which is a pure function of the judge
analysis at the judge→writer seam.

### Design choices worth recording

- **Judge ranking had to be pinned to model-ids.** The judge's `ranking` was free-form
  text and answers were labelled with *both* an index and a model-id, so `ranking[0]`
  could not be mapped to a model. `top-ranked` therefore required a one-line `JUDGE_SYSTEM`
  change (rank by model-id) plus `resolveRankedModel` (slug / `[n]` index / family
  substring → surviving model). A bare numeric token is treated strictly as an index, never
  a substring, so `"4"` does not spuriously match the `4` in `claude-opus-4.8`.
- **Routing reuses the bypass path** rather than adding a parallel execution path: it sets
  `bypass = true` and `writer = <routed model>` in normalization. It only applies to the
  `fusionix` meta-model so an explicitly named model is never silently swapped (code review
  finding M1).
- **Category detection reads the user turn only**, not the system/persona prompt, which is
  usually fixed across turns and would otherwise pin every query to one category (M2).
- **Debate is monotonic on the panel**: a failed or empty revision keeps the round-1
  answer, so a debate round can only improve or preserve the panel.

## Deferred (intentionally not built)

- **Persistent shared memory + intra-workflow access-list isolation** (Fugu §3.2.2). Fugu
  isolates each agent's function-call trajectory and shares memory across multi-turn
  workflows via an *access list* (each subtask declares which prior outputs it sees). This
  is meaningful only with tool-use / multi-turn function calling, which fusionix v0.9 does
  not have (single-turn, no tools). The access-list concept is a cleaner context-flow
  primitive than the current hardcoded "judge sees all answers, writer sees judge JSON" and
  is the natural design if/when fusionix grows tools — but building it now would be
  speculative scaffolding with no substrate to attach to.

## Not applicable (and why)

- **Learned orchestration** — Fugu trains the orchestrator: SFT on a soft per-worker
  performance distribution, sep-CMA-ES on end-to-end terminal reward, and GRPO with a
  format+correctness reward (report §3). fusionix is deterministic and zero-ML; there is no
  model to train. The single transferable idea — *measure each model's strength per task
  category and use it as a routing prior* — is realized, hand-authored, as the §22.6
  capability table.
- **Benchmark scores / model card** (report §4, Tables 1–4): marketing/eval results, not
  design input. The qualitative tasks (Rubik's solver synthesis, blindfold chess, online
  trading, CAD) only loosely informed the A/B eval harness idea.

## Caveats

The capability prior (`capabilities.ts`) and `detectCategory` are **coarse heuristics**, not
measurements, and model slugs drift (cf. `config/default.config.json`). They are product
data, like the preset model lists (§4) — revisit them as the model lineup changes. The
routing classifier is a keyword scan; it is deliberately simple and will mis-categorize
unusual phrasings (it falls back to `general`, which keeps the configured/first-fit model).
