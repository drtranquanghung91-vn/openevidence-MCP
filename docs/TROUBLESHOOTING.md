# Troubleshooting

This project is unofficial and uses your own authenticated OpenEvidence browser session. Do not paste cookies, session tokens, browser profile files, storage-state files, private screenshots, patient-identifiable information, or account identifiers into public issues.

## `authenticated: false`

Your saved session is missing, expired, or no longer accepted by OpenEvidence.

```bash
npm run login:session
npm run smoke
```

If you use a custom path, confirm `OE_MCP_USER_DATA_DIR` points to the intended local browser profile.

`npm run smoke` redacts account and history content by default. Use `npm run smoke -- --verbose` only in a private terminal when raw payloads are needed for debugging.

## Expired Session

OpenEvidence session lifetime can vary. Rerun the login flow:

```bash
npm run login:session
```

The browser opens, you sign in with your own account, close that browser window after OpenEvidence loads, then press Enter in the terminal.

## Google Says the Browser or App Is Not Secure

Google sign-in may block automation-controlled browser contexts. This can happen on Windows, macOS, or Linux and is a Google OAuth security behavior, not a password or OpenEvidence MCP error.

Use the one-time session login flow:

```bash
npm run login:session
```

The script opens Chrome or Edge with a local OpenEvidence MCP profile. Complete OpenEvidence login in the opened browser, close that browser window, return to the terminal, and press Enter. Run `npm run smoke` afterward for the connectivity check.

The MCP server reuses that same local profile. It may start a minimized local browser process while the MCP server is running, but it does not install an extension or expose a public network service.

If auto-detection chooses the wrong browser, set one of:

```bash
OE_MCP_BROWSER=edge npm run login:session
OE_MCP_BROWSER=chrome npm run login:session
OE_MCP_BROWSER_PATH=/absolute/path/to/browser npm run login:session
```

PowerShell example:

```powershell
$env:OE_MCP_BROWSER = "edge"
npm run login:session
```

Do not use stealth flags, cookie-copying browser extensions, or instructions that bypass Google, OpenEvidence, institution, regional, or account controls.

## Location Restriction Page ("OpenEvidence is not available in your location")

If `oe_auth_status` reports `authenticated: false` with `blocked: "geo"`, or `oe_ask`/`oe_history_list` return an error mentioning a **network location** / **Unavailable page**, OpenEvidence served its static "Unavailable" page (HTTP 200, HTML) instead of the app. OpenEvidence is geo-restricted, and every route — including `/api/auth/me` — is replaced by that page, so without this detection the server would misreport a healthy session as "not authenticated".

This is not a login problem. The saved browser profile is fine and `npm run login:session` will not help.

Fix it by making the machine that runs the MCP server reach `openevidence.com` from a supported region — typically by connecting the VPN you normally use for OpenEvidence — then retry the tool. `npm run smoke` is a quick way to confirm the route is open again.

Do not attempt to hide the client's location from OpenEvidence beyond using the network you are entitled to use; this server only reports the restriction so the user can act on it.
## Anti-Bot Verification Page (DataDome)

If `oe_ask` returns an error mentioning an **anti-bot verification page**, OpenEvidence's protection layer (DataDome) served a verification interstitial to the local MCP browser profile instead of the app. Read-only tools (`oe_auth_status`, `oe_history_list`, `oe_article_get`) usually keep working; only new question submission is affected.

This is not a login problem and usually happens after several automated questions in a short time.

Fix it by passing the verification once in a visible browser window using the same profile:

```bash
npm run login:session
```

Complete the verification (and login if asked) in the opened window until the normal OpenEvidence page loads, close that window, then retry `oe_ask`.

To reduce repeat challenges, space out `oe_ask` calls instead of sending many questions back-to-back. Do not attempt captcha-solving services, stealth patches, or fingerprint spoofing — pass the check manually.

## `oe_ask` Fails

OpenEvidence may accept auth and read-only history requests while write/ask submission fails because the local session is expired, the page changed, or the local browser profile is not usable. In this state:

- `npm run smoke` may still pass;
- `oe_auth_status`, `oe_history_list`, and existing article reads may still work;
- `oe_ask` may fail to locate the question box or submit button;
- the OpenEvidence page may need a fresh one-time login.

This is not fixed by switching VPN endpoints, copying cookies, adding stealth flags, extension hacks, or replaying browser fingerprint values. Do not post returned HTML, cookies, browser profile data, storage state, or account details in an issue.

Refresh the local session profile:

```powershell
$env:OE_MCP_BROWSER = "edge"
npm run login:session
npm run smoke
```

Open an issue with sanitized logs and link to any existing upstream-protection report if `oe_ask` still fails. Do not post cookies, browser profile files, storage state, raw upstream HTML, or account details.

## Playwright Browser Install Error

Install Chromium for Playwright:

```bash
npx playwright install chromium
```

On Linux, Playwright may require additional system packages. Use the error output from Playwright and install only the required packages for your OS.

## Windows PowerShell Path Problems

Use absolute paths. In JSON and TOML examples, escape backslashes:

```toml
args = ["C:\\Users\\<user>\\openevidence-mcp\\dist\\server.js"]
```

From PowerShell, run setup from the repository root:

```powershell
.\scripts\setup-windows.ps1
```

## Codex or Claude Cannot Start the MCP Server

Confirm the project builds:

```bash
npm run build
```

Then confirm the MCP config points to the built file:

```text
/ABSOLUTE/PATH/openevidence-mcp/dist/server.js
```

Restart the MCP client after changing config. Some clients do not reload MCP server definitions while a session is running.

## Absolute Path Required

Use an absolute path to `dist/server.js` in MCP client configs. Relative paths can resolve from the client process working directory, not the repository.

## Node Version Too Old

This project requires Node.js 20 or newer.

```bash
node --version
npm --version
```

Upgrade Node if `node --version` reports a version below 20.

## Network Timeout

OpenEvidence requests can fail because of network issues, VPN/proxy behavior, account state, or service changes. Retry after confirming you can access OpenEvidence in a normal browser with your own account.

For long `oe_ask` calls, prefer the non-blocking flow:

1. Call `oe_ask` with `wait_for_completion=false`.
2. Copy the returned `article_id`.
3. Call `oe_article_wait` with that `article_id`.

This avoids MCP host/client timeouts while OpenEvidence finishes the article.

You can tune wait behavior from the MCP call parameters:

- `wait_for_completion`
- `timeout_sec`
- `poll_interval_ms`

If a follow-up unexpectedly returns stale context from a large prior thread, ask a fresh question without `original_article_id`.

## OpenEvidence UI or API Changed

This project relies on the currently observed OpenEvidence web endpoints. If OpenEvidence changes its UI or API behavior, login, smoke, or tools may fail.

Open an issue with:

- OS and Node/npm versions;
- MCP client;
- install method;
- command used;
- sanitized logs;
- whether auth state exists;
- reproduction steps.

Do not include cookies, tokens, browser profile files, storage-state files, private screenshots, patient data, or account identifiers.

## Model Selector Not Found / Model Mismatch

`oe_ask` selects the requested `model` (Osler, Sackett or Snow) in the dropdown next to the question box before submitting. If it reports that the selector button or the option was not found, first check `oe_auth_status` — a DataDome or location-restriction page hides the whole ask UI. Otherwise the OpenEvidence UI has probably changed; open an issue with the error text (no account data).

If it reports that the created article used a different model than requested, the article still exists in your account (its id is in the error); fetch it with `oe_article_get` or retry the question.

An `oe_ask` call made without `model` (an implicit default) does not hard-fail when the selector is absent; it logs a note to stderr and proceeds with whatever model the page's current selection is.
