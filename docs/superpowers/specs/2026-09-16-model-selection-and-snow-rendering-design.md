# v0.3.1 — Model selection for `oe_ask` and Snow-grade answer rendering

**Status:** approved design (2026-09-16) · **Repo:** drtranquanghung91-vn/openevidence-MCP (fork of bakhtiersizhaev/openevidence-mcp, based on `feat/v0.3.0-cleanup-and-features`)

## 1. Why

OpenEvidence now offers three answer models on the ask page: **Osler** (direct answers, ~5–90 s), **Sackett** (comprehensive answers for complex cases, ~30 s) and **Snow** (deep consults / long-form research, ~4–7 min). The server selects the model per article through `inputs.model_profile_name` in `POST /api/article` (verified 2026-09-16: choosing *Sackett* in the dropdown produced a 201 with `"model_profile_name":"sackett"`; a *Snow* article completed in ~4 min with a 7-section, 53-citation, 32 k-character answer including a summary table and four figures).

The MCP server today always submits with whatever model the profile last used (in practice Osler) and cannot request another one. Two rendering gaps also surfaced on Snow output that Osler answers never triggered:

1. The `Table` widget (`REACTCOMPONENT!:!Table!:!{...}`) is dropped by `renderReactComponents` because it is an unknown component type — Snow's summary tables are lost from `answer_text`.
2. `<h2>`/`<h3>` HTML headings in `output.text` are passed through verbatim instead of becoming markdown headings.

This release adds an explicit `model` input to `oe_ask`, renders tables and headings, and lengthens the wait ceiling so Snow can be awaited in one call.

## 2. Scope

In scope:

- `oe_ask.model` — optional enum `"osler" | "sackett" | "snow"`; default `"osler"`.
- Selecting the model in the OpenEvidence UI before the question is submitted, and verifying the selection took effect.
- Returning `model_profile_name` in the `oe_ask` result (the created-article payload already carries `inputs.model_profile_name`; expose it at top level of the sanitized result).
- `oe_ask.timeout_sec` maximum raised from 600 to 900 (matching `oe_article_wait`).
- `renderReactComponents`: render `Table` widgets to a markdown pipe table; convert `<h2>…</h2>` / `<h3>…</h3>` / `<h4>…</h4>` to `## ` / `### ` / `#### ` headings.
- Tests, README (fork notes + tool table), CHANGELOG `0.3.1`, `package.json` version bump.

Out of scope (deliberately):

- Submitting `POST /api/article` directly instead of through the UI. The UI path is kept because it is what upstream uses and what the account's normal traffic looks like; direct POST is a possible future optimisation, not part of this release.
- Any change to the DataDome / geo-block handling shipped in `fix/geo-block-detection`.
- Per-model default timeouts or automatic model choice — callers (e.g. Evidentia's router) decide.
- Streaming partial Snow output (`partial_output`) — `oe_article_wait` semantics are unchanged.

## 3. Design

### 3.1 API surface (`src/server.ts`, `src/types.ts`)

```ts
// types.ts
export type OpenEvidenceModel = "osler" | "sackett" | "snow";
export const OPENEVIDENCE_MODELS: readonly OpenEvidenceModel[] = ["osler", "sackett", "snow"];
export interface OpenEvidenceAskRequest {
  question: string;
  originalArticleId?: string;
  model?: OpenEvidenceModel;   // default "osler"
}
```

`oe_ask` input schema gains `model: z.enum(["osler","sackett","snow"]).default("osler").optional()` and `timeout_sec` becomes `.max(900)`. The tool description documents the three models with their typical latency and recommends `wait_for_completion=false` + `oe_article_wait` for Snow. The `mcp-contract` test's sorted key list becomes `["model","original_article_id","poll_interval_ms","question","timeout_sec","wait_for_completion"]`.

The sanitized `oe_ask` result (`sanitizeCreatedArticle`) adds `model_profile_name: string | null`, read from `created.inputs.model_profile_name` when present, else the requested model.

### 3.2 Model selection in the browser (`src/browser-session.ts`)

New step inside `ask()`, executed after `pageForAsk()` and before `fillQuestion()`:

```
selectModel(page, model):
  trigger = first <button data-slot="dropdown-menu-trigger"> whose text starts with Osler|Sackett|Snow
  if trigger text already starts with requested label -> return (no click)
  click trigger
  wait for [role="menuitem"] whose text starts with requested label (timeout 5 s)
  click it
  wait until trigger text starts with requested label (timeout 5 s)
  if still mismatched -> throw MODEL_SELECT_FAILED error
```

Label mapping: `osler → "Osler"`, `sackett → "Sackett"`, `snow → "Snow"` (match on the leading word of the menu item / trigger `textContent`, case-sensitive, because the description line is concatenated into `textContent`).

Failure policy: a model-selection failure is a hard error for that ask (the caller asked for a specific model; silently submitting with another one would be wrong). The error message names the requested model and says the OpenEvidence UI may have changed. If the model trigger is not found at all, the blocked-page classifier (`classifyBlockedPage`) is consulted first so a DataDome/geo page still yields the actionable blocked message rather than a confusing "model selector not found".

Post-submit verification: when `waitForPostArticle` returns the created article, `ask()` compares `data.inputs.model_profile_name` with the requested model; a mismatch is returned to the caller as an error whose text includes the article id (the article was still created on OE, so nothing is lost).

The fallback branches that build a synthetic `{ id, status: "pending", article_type }` result (route change observed without a captured POST) also carry `model_profile_name: <requested model>`.

The model is set explicitly on every ask, including the default `osler`, because the page remembers the last selection and a previous caller's choice must not leak into the next call.

### 3.3 Rendering (`src/article.ts`)

`renderComponentMarkdown` gains a `Table` branch:

- Prefer `record.table_text` when it is a non-empty string (OE already supplies a markdown pipe table).
- Else build a pipe table from `record.table_data` (array of flat objects): header = keys of the first row in order; each cell stringified, `|` escaped as `\|`, newlines collapsed to spaces.
- Else return `""` (fail-safe, as for other widgets).
- Output is wrapped in blank lines so it stands alone as a block.

New `convertHtmlHeadings(text)` applied inside `renderReactComponents` after widget substitution: `<h2>…</h2>`, `<h3>…</h3>`, `<h4>…</h4>` (single-line, case-insensitive) become `\n## …\n`, `\n### …\n`, `\n#### …\n` with the inner text trimmed. Other HTML tags are left untouched (not in scope).

### 3.4 Docs

- `README.md`: tool table row for `oe_ask` lists `model`; the fork-notes block gains one bullet.
- `docs/TROUBLESHOOTING.md`: short entry "Model selector not found / model mismatch".
- `CHANGELOG.md`: `## [0.3.1] - 2026-09-16` with Added (model param, Table rendering, heading conversion, timeout ceiling) and Fixed (Snow tables were silently dropped).
- `package.json`: `0.3.1`.

## 4. Testing

Unit (`node --test`, no network):

- `tests/model-selection.test.ts`: label mapping; `selectModel` against a Playwright-free fake page object (stub `locator().textContent()/click()/count()/waitFor()`) covering: already selected → no click; select Sackett → click sequence; menu item missing → throws with model name; trigger text never updates → throws.
- `tests/article-normalize.test.ts`: `Table` with `table_text`; `Table` with only `table_data`; `Table` with neither → `""`; `<h2>`/`<h3>` conversion; existing tests unchanged.
- `tests/mcp-contract.test.ts`: updated `oe_ask` key list; `model` enum values; `timeout_sec` max 900.

Manual (requires VPN + logged-in profile; documented in `docs/SESSION_UAT.md`):

- `oe_ask` with `model: "sackett"`, `wait_for_completion: true` → result has `model_profile_name: "sackett"`.
- `oe_ask` with `model: "snow"`, `wait_for_completion: false` → `oe_article_wait` (900 s) → `answer_text` contains `## ` headings and at least one `| … |` table row; citations ≥ 30.
- `oe_ask` without `model` after a Snow ask → trigger is reset to Osler (the previous selection must not leak between calls).

## 5. Risks

- OE may rename models or change the dropdown markup; selection is isolated in one function with one test double, and failure is loud.
- Snow answers are large (~60 k chars raw). `oe_article_get(include_raw=true)` responses grow accordingly; no change to limits is planned.
- Model selection adds two UI clicks per ask; negligible against generation time, and it mirrors what a human does.
