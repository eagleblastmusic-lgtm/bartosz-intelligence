# Public OAuth branding pages

Deployed on the existing free Cloudflare Worker on 2026-10-08:

- Homepage: https://bartosz-intelligence.eagleblastmusic.workers.dev/about
- Privacy: https://bartosz-intelligence.eagleblastmusic.workers.dev/privacy
- Optional terms: https://bartosz-intelligence.eagleblastmusic.workers.dev/terms

The Worker serves these exact paths before SPA assets, with no bindings, owner
queries, scripts or cookies. The private application entry and existing OAuth
callbacks are unchanged. No paid resources or new hosting were enabled.

Privacy copy reflects `packages/core/src/auth/oidc.ts`, `drive/oauth.ts`,
`drive/client.ts`, `drive/credentials.ts`, `drive/conflict.ts`, `drive/disconnect.ts`
and the existing Drive/backup runbooks. In particular, disconnect removes the
local credential but preserves files and mappings and does not revoke Google's
grant or purge recovery copies. There is no invented automatic retention period.

Google requirements checked on 2026-10-08:

- [Brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification):
  public descriptive homepage, privacy on the same domain and linked from the
  homepage, accurate identity and support contact, ownership verification for
  authorized domains using a project-associated Google account.
- [Verification requirements](https://support.google.com/cloud/answer/13464321?hl=en):
  privacy must describe access, use, storage and sharing and comply with Limited Use.
- [User Data Policy](https://developers.google.com/terms/api-services-user-data-policy):
  transparent disclosure and no undisclosed secondary use.

Public HTTP availability is verified; Google Search Console ownership and the
project's Authorized domains configuration have not been inspected. Workers.dev
availability alone does not establish Google domain verification. Do not claim
brand approval or a Production publishing change from this deployment. Personal
use has a documented review exception; Production publishing and verified
branding are separate states.

Paste the homepage and privacy URLs into Google Auth Platform → Branding.
If Google requires ownership verification, use Search Console under an Owner or
Editor account associated with this Cloud project, using the authorized domain
Google requests. No Search Console token was available in this task; deploying
an HTML verification file or tag requires that exact token. Do not invent one,
change callbacks, register a paid domain or activate paid hosting as a workaround.

Verification: 14 targeted Worker tests passed (public pages, Drive OAuth and
disconnect), API typecheck and scoped lint passed, full build passed.
`docs/verification/deployment/public-oauth-pages.json` records anonymous HTTPS
200 HTML responses for all three pages and 401 for private Drive status.
