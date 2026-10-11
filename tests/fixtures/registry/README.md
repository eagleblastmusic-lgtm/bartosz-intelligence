# Public Prompt Pack golden fixture

`master-prompt-pack-v1.1.1.md` is the exact LF-normalized section 24 of the
owner's Master Architecture v1.1.1, up to section 25. It contains only the nine
public schemas and six public prompt templates already imported into
`config/registry/master-bundle.json`, with their original explanatory text.
It contains no transcript, account credential, production response or full Plan.

The contract test pins the extract's SHA-256
`f37e621be98cd85293fded035294299b93e21239c40de93075bfc1a9f574a103`, the
original Master revision hash and the imported bundle hash, and compares every
schema and template. When the private Master is present it must also match this
section. A clean public checkout does not require the owner's private `Plan/`.

Preserve these golden bytes. Updating code or its formatting must not rewrite
the source fixture to match a changed implementation.
