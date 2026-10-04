# CP-1.2 evidence

Date: 2026-10-04. Policy version 1. All providers initially unselected.

Passed: lint, workspace/Node typecheck, verify:config, Vitest unit suite
(22 tests), web build and web bundle scan for server credential names and registry fields.
Default config denies paid=true, unknown keys, invalid timezone/flags and
activation without matching measurement evidence. Provider descriptors are
copied and frozen with immutable capabilities and model arrays.

Guard tests inject a transport spy: paid, trial, unknown/ineligible Free,
missing/stale/mismatched evidence, auto-purchase, optional without measurement,
disabled provider, unselected route, unapproved model and denied target all
produce zero network submissions. Presence of a paid API key grants no route.
The eligible test route uses a mocked transport only; it does not qualify Gate E.
HTTPS origins are allowlisted and redirects fail closed.

Config errors contain stable codes without input values. Public config contains
only version/timezone. Nested credential fields, Bearer strings, credential query
parameters and explicit secret values are redacted before log serialization.
No live provider implementation or submission exists yet outside guardedFetch.
Secrets are ignored and `.env.example` contains names with empty values only.

Gate E/0/CPU/0B: NOT_RUN. Architecture deviations: NONE.
