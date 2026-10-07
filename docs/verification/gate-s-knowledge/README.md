# Local Knowledge search and GUI acceptance

`2026-10-07-local-knowledge-pass.json` records actual local workerd/D1 and the built GUI on an isolated synthetic corpus of 10,000 Items. Search render p95 is 109.738 ms against the unchanged 300 ms threshold. Six surfaces (Search, Ledger, Entities, Item, Profiles, Prompt Studio with Lab budget/history) passed 48 combinations of four widths and two themes with zero recorded WCAG A/AA axe violations and no horizontal overflow. Keyboard opening/closing of Evidence restored focus; the exact synthetic original quote including Polish characters and an emoji was verified. Unknown source time stayed NONE.

Run `pnpm gate:s --scope knowledge` or `pnpm gate:u --scope knowledge --items 10000`. Optional `--output <new-directory>` creates an exclusive report; existing reports are never overwritten. The default uses a unique private `.local/search-gate-*` directory. The harness selects a free loopback port, rejects external requests and mutations, and applies a 25 ms/10 Mbps response delivery budget. CLI subprocesses and reads are bounded. The test does not contact Gemini or the production application.

The first two reports preserve historical harness FAIL. One locator selected the first textarea inside a collapsed panel; the next required an exact label although the existing editor label matching is partial. Both were fixed using the Studio E2E locator. Neither failure was a provider failure. The successful measurement is separate and does not erase either FAIL.

This is local automated evidence, not production D1 or manual screen-reader acceptance. The corpus has 10,000 Items and 1,666 selected runs, but only one synthetic byte-verified canonical/Evidence and Observation path. It does not claim 10,000 human-qualified analyses, stress coverage for 10,000 Observations, or Full/Custom provider quality. Compiler/reprocess/Studio mutation flows are exercised separately by E2E and D1 tests. Manual screen reader, real provider quality, deployment, fresh quota and long-run Gate C remain open. No Stage completion handoff or quality approval is issued here.

Hashes of immutable reports:

- Hidden textarea FAIL: `c79aecfe9231d44bfc53ebc098f20c5eabb01c71ea2e16b1b319467e301e070c`.
- Exact label FAIL: `6b9cdd04bef964ea492fa8d01bc6e2758d2248478b2fced334ca29423be9a609`.
- Local Knowledge PASS: `834c05960fc61d224ce645e58a9fe84104cc69ffd47f4f8fac8b9805c28a9e07`.
