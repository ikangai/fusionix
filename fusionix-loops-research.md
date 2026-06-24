# Research answer (preset=research-high, web=used, cost=$2.0682256000000003)

**Writer:** anthropic/claude-opus-4.8 · **Judge:** openai/gpt-5.2 · **Panel:** anthropic/claude-opus-4.8, openai/gpt-5.2, google/gemini-3.1-pro-preview

---

# Loops for LLM Application Development: State of the Art

The dominant insight across modern LLM engineering is that reliable systems are built not from single model calls but from **iterative loops** — control structures that let a model act, observe, verify, and improve. These loops cluster into five families: (1) agent action/observation loops, (2) generate→verify→revise self-correction loops, (3) inference-time search/selection loops, (4) eval-driven development and human-in-the-loop review, and (5) training/RL loops. Below is the state of the art, the design principles that make loops reliable, and a mapping of which pattern fits which problem.

---

## 1. The current state of the art

### Agent action/observation loops (ReAct-style)
The foundational pattern is **ReAct** (Yao et al., *ReAct: Synergizing Reasoning and Acting in Language Models*, ICLR 2023), which interleaves chain-of-thought reasoning with tool calls and observations. Modern implementations layer **structured/function calling** (OpenAI function calling, Anthropic tool use) on top of this loop to make the action step a typed, parseable interface rather than free text. Orchestration frameworks that implement and extend the action loop include **LangGraph** (graph-based state machines with explicit recursion limits), **LlamaIndex**, **CrewAI** (multi-agent role decomposition), Hugging Face's **smolagents** (code-action agents), and OpenAI's **Swarm** (now largely an educational/reference design). The trend over 2024–2025 has been convergence on a shared agent runtime abstraction: a loop over (plan → call tool → observe → update state) with deterministic budget controls.

### Generate→verify→revise (self-correction) loops
Here a model produces a candidate, an external or internal verifier critiques it, and the model revises. The most important caveat from the literature: **intrinsic self-correction (the model critiquing itself with no external signal) is weak and can degrade outputs.** This is well established and should be treated as settled, not contested — self-correction reliably helps only when grounded in an *external* signal (unit tests, a compiler, a schema validator, retrieval, or a separate judge model). Influential work includes **Self-Refine** (Madaan et al., 2023) and **Reflexion** (Shinn et al., 2023), which add verbal feedback and episodic memory to the revise step.

### Inference-time search/selection loops
Often omitted from agent-centric surveys but central to the SOTA: **self-consistency** (Wang et al., 2022, sample-and-vote), **Tree of Thoughts** (Yao et al., 2023), **Graph of Thoughts** (Besta et al., 2024), and **best-of-N** sampling. These trade compute for accuracy by exploring multiple trajectories and selecting among them — a loop over *generation breadth* rather than *revision depth*.

### Eval-driven development (EDD) and observability loops
The most consequential shift in practice is treating evaluation as a continuous loop rather than a one-time benchmark. Tooling: **OpenAI Evals**, **HELM**, **lm-eval-harness**, **RAGAS** and **ARES** (for retrieval-augmented systems), **Self-RAG** (Asai et al., 2023), and observability/tracing platforms (**Phoenix**, plus commercial offerings like Braintrust, DeepEval, MLflow). **LLM-as-judge** (e.g., **G-Eval**, Liu et al., 2023) is widely used but must be **calibrated against human labels**; uncalibrated judges suffer from position bias, verbosity bias, and rubric drift. **DSPy** represents an emerging "compile/optimize" loop where prompts and few-shot examples are programmatically optimized against a metric — promising but not yet a settled industry standard.

A key practical observation: **evals and tracing are becoming inseparable**. Replay of recorded traces against eval suites is the mechanism that closes the development loop.

### Training/RL loops
At the model level, the frontier is **reinforcement learning from verifiable rewards (RLVR)**, using objectively checkable rewards (e.g., test-passing, math correctness) to avoid the reward-model hacking that plagues subjective RLHF. **GRPO** (Group Relative Policy Optimization) has become a widely used algorithm here. A known failure mode: when all sampled trajectories for a prompt are incorrect, the group-relative advantage collapses to zero and no learning signal is produced — a practical reason to curate problem difficulty during training.

---

## 2. Best practices for designing reliable loops

**Hard budgets are non-negotiable.** Every loop needs deterministic ceilings: maximum steps/iterations, token budgets, wall-clock time, and cost caps. Frameworks like LangGraph expose explicit recursion limits for exactly this reason. Relying on the model to "know when to stop" is unreliable.

**Detect non-progress, don't just count steps.** Step counts alone produce either premature termination or runaway cost. Better stopping criteria combine:
- **Cycle/loop detection** — e.g., hashing the tool-call name plus arguments to catch the agent repeating the same action.
- **Plateau detection** — terminate when the verifier score stops improving across iterations.
- **Graceful escalation** — on budget exhaustion or detected non-progress, escalate to a human or return the best candidate so far rather than failing hard.

**Ground verification externally.** This is the single biggest reliability lever. Prefer deterministic checks (compilers, unit tests, JSON-schema validators, type checkers, retrieval-grounded fact checks) over model self-judgment. When you must use an LLM judge, validate its agreement against human labels before trusting it and keep the judge model separate from (ideally stronger than) the generator.

**Control compounding error over long horizons.** Per-step reliability compounds multiplicatively: a 95%-reliable step yields very low success over a 100-step plan. The implications are to keep horizons short, decompose tasks, checkpoint intermediate state, and add verification gates between phases rather than only at the end.

**Manage context growth.** Long action loops accumulate observations that degrade model performance ("context rot"/overflow) and can trigger degenerate behavior. Mitigations: summarize or prune history, externalize state to memory/scratchpads, and cap accumulated context.

**Budget evaluation cost.** Eval and judge loops are expensive (LLM-judged evaluation can cost an order of magnitude more than deterministic checks). Use cheap deterministic gates first and reserve expensive judging for cases that pass them.

**Avoid degenerate self-correction.** Because intrinsic self-correction can make outputs worse, gate every revise step behind an external signal and abandon revision when the verifier shows no improvement.

---

## 3. Mapping loop patterns to problems

The decisive design question is: **is correctness externally verifiable?**

| Problem type | Recommended loop | Why |
|---|---|---|
| **Code generation, math, structured data extraction** | Generate→verify→revise grounded in tools (tests/compiler/schema) | Cheap, objective verifiers make iterative repair highly reliable; this is the strongest case for self-correction. Benchmarks like SWE-bench and systems like SWE-agent demonstrate the value of the execute-and-repair loop. |
| **Multi-step tasks requiring external tools/data** | ReAct-style action/observation loop with tool use | Reasoning interleaved with grounded observations; keep horizons short and add verification gates. |
| **Retrieval-augmented QA / knowledge tasks** | Retrieval-grounded loops with RAG-specific eval (RAGAS, ARES; Self-RAG for adaptive retrieval) | Grounding in retrieved evidence is the verification signal; dedicated metrics catch faithfulness failures. |
| **Hard reasoning with no single deterministic check** | Inference-time search (self-consistency, ToT/GoT, best-of-N) | Spend compute on breadth and select among candidates when you can't cheaply verify one. |
| **High-stakes or irreversible actions** (payments, deletions, medical/legal output) | Human-in-the-loop approval gates with audit logging | Verification is expensive or impossible to automate safely; insert mandatory review before action. |
| **Subjective/open-ended generation** (writing, summaries) | LLM-as-judge eval loops calibrated to human labels; EDD over a curated test set | No deterministic check exists; calibrated judges plus human-anchored evals are the best available signal. |
| **Improving the base model on a verifiable domain** | RLVR / GRPO training loop | Objective rewards avoid reward-model hacking; curate difficulty to avoid zero-advantage collapse. |
| **Systematic prompt/program optimization** | DSPy-style compile/optimize loop (*emerging*) | Automates prompt and example tuning against a metric; powerful but not yet standardized. |

---

## What is established vs. contested

**Established:** the value of hard budgets and external grounding; the weakness of intrinsic self-correction; the necessity of calibrating LLM judges; the effectiveness of execute-and-repair loops in verifiable domains; ReAct, Reflexion, Self-Refine, self-consistency, and ToT as foundational techniques; RLVR/GRPO as the current training frontier.

**Emerging or contested:** the relative centrality of DSPy as EDD infrastructure; the long-term consolidation of agent runtimes around a single abstraction; the framing of agentic "design patterns" as a fixed standard taxonomy. Specific operational numbers sometimes cited (e.g., recommended judge-agreement thresholds, default recursion limits, exact compounding-error figures) are useful heuristics but vary by framework and task and should be tuned empirically rather than taken as fixed constants.

**Remaining uncertainty:** robust, low-cost detection of degenerate loops in long-horizon agents and reliable automated evaluation of open-ended outputs are active, unsolved problem areas — both currently lean on human oversight where stakes are high.

---

## Judge analysis

**Ranking:** Best evidence quality: includes many primary-source links (arXiv papers, official docs, OSS repos) and covers all three requested areas (SOTA + best practices + scenario mapping) with comparatively clear established-vs-contested distinctions. Some synthesis claims remain uncited but the core survey is well-supported. > Strong depth on reliability engineering (stopping, progress detection, context growth, degenerate-loop failure modes) and a detailed training-loop section. However, citations are not verifiable because they are internal indices without references/URLs, so many concrete claims cannot be checked. > Reasonable high-level taxonomy and some practical advice, but it lacks citations entirely and introduces multiple specific paper/system claims that are not verifiable and may be incorrect. Overall lowest evidence quality.

**Consensus:**
- Core taxonomy of loop families — All three treat 'loops' broadly across (a) agent action/observation tool loops, (b) generate→verify→revise/self-correction loops, (c) eval-driven development loops, (d) human-in-the-loop gates, and (e) training/RL loops. — Moderate overall; [2] supplies primary links for several families; [1] uses non-verifiable inline cite indexes; [3] provides no citations.
- Reliability requires hard bounds + verification, not just prompting — All three recommend deterministic budgets (max steps/tokens/time/cost) and emphasize external verification/grounding (tests, validators, tool execution, retrieval) as the main lever for reliability. — Moderate; mostly engineering best practice claims. [2] partially supports with framework docs (e.g., function-calling, smolagents); much remains uncited.
- LLM-as-judge/eval loops are useful but risky without calibration — [1] and [2] explicitly warn about LLM-judge reliability and advocate validation against human labels; [3] implies caution via recommending stronger separate judge models and rubrics. — Moderate for existence/usage; stronger in [2] where a specific 'G-Eval' paper is linked; [1] references 'criteria drift' with non-verifiable cite indexing; [3] is uncited.
- Scenario mapping: verifiable domains benefit most from iterative repair loops — All map code/math/structured extraction to execute/validate/repair (generate→verify→revise grounded in tools), and high-stakes actions to HITL gates. — Moderate; [2] cites SWE-bench/SWE-agent and RAG evaluation papers; [1] and [3] scenario mappings are largely uncited.

**Contradictions:**
- ReAct publication date
- What is 'standard taxonomy' for agent/workflow patterns
- Relative centrality of DSPy in eval-driven development
- Training-loop frontier emphasis

**Blind spots:**
- Most claims rely on opaque '<cite index=…>' markers without an actual reference list/URLs; therefore specific assertions (e.g., 'LangGraph is now a dominant orchestration layer', judge agreement targets '75–90%', 'evaluation cost 10×', 'action loop ratio correlates with diminished success', 'meltdown' characterization, and GRPO being 'de facto') are not independently checkable from the answer text.
- Specific numeric/operational guidance (e.g., hashing tool-call+args cycle detection, default recursion_limit=25, 100-step plan success ~0.6% at 95% per-step reliability) is presented without a verifiable external citation in the response.
- Several synthesis claims are uncited, e.g., 'agent runtime convergence (2024–2026)', 'evals + tracing becoming inseparable', and 'many teams use RLHF-like thinking without full RL'. These are plausible but not supported with primary evidence in-text.
- Some framework popularity/value claims (e.g., CrewAI 'widely used', Swarm described as 'educational') are not evidenced beyond links.
- Provides essentially no citations; nearly all factual statements are unsupported in-text.
- Mentions specific papers/systems ('Understanding the Dark Side of LLMs' Intrinsic Self-Correction' (Zhang et al., ACL 2025), 'LLM-Wiki (2026)', 'Training Language Models to Self-Correct via Reinforcement Learning' (Kumar et al., ICLR 2025), 'PULSE' (Kim et al., ICLR 2026)) without citations; cannot be validated and may be hallucinated.
- Claims Andrew Ng's 'Agentic Design Patterns' are the 'standard taxonomy' and that DSPy is 'state-of-the-art' for EDD—both unsupported.
