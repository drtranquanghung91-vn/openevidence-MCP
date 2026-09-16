# v0.3.1 Model Selection & Snow Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `oe_ask` choose the OpenEvidence answer model (`osler` / `sackett` / `snow`) and render Snow-grade answers (tables, HTML headings) into `answer_text`.

**Architecture:** Model choice is a small pure module (`src/model-selection.ts`) that drives the OpenEvidence dropdown through a minimal `ModelSelectorPage` interface, so it is unit-tested with a fake page and wired into `BrowserSession.ask()` in one place. Rendering changes live entirely in `src/article.ts` (`Table` widget branch + heading conversion). The MCP surface change is confined to `src/server.ts` (schema, description, sanitized result) and `src/types.ts`.

**Tech Stack:** TypeScript (ESM, `tsc`), Playwright (system Chrome), `@modelcontextprotocol/sdk`, `zod`, `node --test` via `tsx`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-16-model-selection-and-snow-rendering-design.md` — read it first.
- Node `>=20`; run tests with `npm test` (explicit file list in `package.json` → add new test files there).
- Model enum values are exactly `"osler" | "sackett" | "snow"`; default `"osler"`; UI labels `Osler` / `Sackett` / `Snow`. Match labels as a **prefix** of `textContent` (no word-boundary `\b`): the trigger reads `Sackett`, menu items read `SackettComprehensive answers for complex cases · 30s`.
- `oe_ask.timeout_sec` maximum becomes `900`.
- Model selection is done on **every** ask (including the default) — no leaking of a previous selection.
- Model-selection failure and post-submit model mismatch are hard errors (never silently submit with another model).
- Unknown widgets still render to `""` (fail-safe); only `Table` is added.
- Files in this repo use CRLF; do not mass-reformat. Commit with `git -c core.safecrlf=false commit …` to silence the LF/CRLF warning.
- Every commit message ends with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Working branch: `feat/v0.3.1-model-selection` created from `fix/geo-block-detection` (current `mine/main`).

---

### Task 0: Branch

**Files:** none

- [ ] **Step 1: Create the working branch**

```bash
cd ~/openevidence-mcp
git checkout fix/geo-block-detection
git checkout -b feat/v0.3.1-model-selection
```

- [ ] **Step 2: Confirm the baseline is green**

Run: `npm test`
Expected: `ℹ pass 38`, `ℹ fail 0`.

---

### Task 1: Model types and the `selectModel` driver (pure module, fake-page tests)

**Files:**
- Modify: `src/types.ts` (add `OpenEvidenceModel`, `OPENEVIDENCE_MODELS`, `model?` on `OpenEvidenceAskRequest`)
- Create: `src/model-selection.ts`
- Create: `tests/model-selection.test.ts`
- Modify: `package.json` (`"test"` script — add the new test file)

**Interfaces:**
- Produces:
  - `type OpenEvidenceModel = "osler" | "sackett" | "snow"` (types.ts)
  - `const OPENEVIDENCE_MODELS: readonly OpenEvidenceModel[]` (types.ts)
  - `const DEFAULT_MODEL: OpenEvidenceModel = "osler"` (model-selection.ts)
  - `const MODEL_LABELS: Record<OpenEvidenceModel, string>` (model-selection.ts)
  - `interface ModelSelectorLocator { first(): ModelSelectorLocator; count(): Promise<number>; textContent(): Promise<string | null>; click(): Promise<void>; waitFor(options: { timeout: number }): Promise<void>; }`
  - `interface ModelSelectorPage { locator(selector: string, options?: { hasText?: RegExp }): ModelSelectorLocator; }` — Playwright's `Page` satisfies this structurally.
  - `class ModelSelectError extends Error { readonly model: OpenEvidenceModel; readonly reason: "trigger_missing" | "option_missing" | "not_applied"; }`
  - `async function selectModel(page: ModelSelectorPage, model: OpenEvidenceModel): Promise<void>`
  - `function verifyCreatedModel(created: Record<string, unknown>, model: OpenEvidenceModel): string | null` — returns an error message when `created.inputs.model_profile_name` is a string that differs from `model`, otherwise `null`.

- [ ] **Step 1: Add the model type to `src/types.ts`**

Replace the `OpenEvidenceAskRequest` block (lines 1–4) with:

```ts
export type OpenEvidenceModel = "osler" | "sackett" | "snow";
export const OPENEVIDENCE_MODELS: readonly OpenEvidenceModel[] = ["osler", "sackett", "snow"];

export interface OpenEvidenceAskRequest {
  question: string;
  originalArticleId?: string;
  /** OpenEvidence answer model; defaults to "osler" when omitted. */
  model?: OpenEvidenceModel;
}
```

- [ ] **Step 2: Write the failing tests `tests/model-selection.test.ts`**

```ts
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MODEL,
  MODEL_LABELS,
  ModelSelectError,
  selectModel,
  verifyCreatedModel,
  type ModelSelectorLocator,
  type ModelSelectorPage,
} from "../src/model-selection.js";

/** Minimal fake of the OpenEvidence ask page: one trigger button and a menu that opens on click. */
function fakePage(options: { current: string; menu: string[]; applyOnClick?: boolean }) {
  const state = { trigger: options.current, menuOpen: false, clicks: [] as string[] };
  const apply = options.applyOnClick ?? true;

  const locatorFor = (kind: "trigger" | "menu" | "none", label?: string): ModelSelectorLocator => ({
    first() {
      return this;
    },
    async count() {
      if (kind === "trigger") return 1;
      if (kind === "menu") return state.menuOpen && options.menu.some((m) => m.startsWith(label ?? "")) ? 1 : 0;
      return 0;
    },
    async textContent() {
      if (kind === "trigger") return `${state.trigger}Direct answers · 5s`;
      if (kind === "menu") return options.menu.find((m) => m.startsWith(label ?? "")) ?? null;
      return null;
    },
    async click() {
      if (kind === "trigger") {
        state.clicks.push("trigger");
        state.menuOpen = true;
      } else if (kind === "menu") {
        state.clicks.push(`menu:${label}`);
        state.menuOpen = false;
        if (apply && label) state.trigger = label;
      }
    },
    async waitFor({ timeout }) {
      if ((await this.count()) === 0) throw new Error(`timeout ${timeout}ms`);
    },
  });

  const page: ModelSelectorPage = {
    locator(selector, opts) {
      const wanted = opts?.hasText?.source.replace(/^\^/, "") ?? "";
      if (selector.includes("dropdown-menu-trigger")) return locatorFor("trigger");
      if (selector.includes("menuitem")) return locatorFor("menu", wanted);
      return locatorFor("none");
    },
  };
  return { page, state };
}

test("MODEL_LABELS maps every model to its UI label and default is osler", () => {
  assert.deepEqual(MODEL_LABELS, { osler: "Osler", sackett: "Sackett", snow: "Snow" });
  assert.equal(DEFAULT_MODEL, "osler");
});

test("selectModel does nothing when the requested model is already selected", async () => {
  const { page, state } = fakePage({ current: "Osler", menu: ["OslerDirect", "SackettComprehensive", "SnowDeep"] });
  await selectModel(page, "osler");
  assert.deepEqual(state.clicks, []);
});

test("selectModel opens the menu and picks the requested model", async () => {
  const { page, state } = fakePage({ current: "Osler", menu: ["OslerDirect", "SackettComprehensive", "SnowDeep"] });
  await selectModel(page, "sackett");
  assert.deepEqual(state.clicks, ["trigger", "menu:Sackett"]);
  assert.equal(state.trigger, "Sackett");
});

test("selectModel throws option_missing when the menu lacks the model", async () => {
  const { page } = fakePage({ current: "Osler", menu: ["OslerDirect", "SackettComprehensive"] });
  await assert.rejects(selectModel(page, "snow"), (error: unknown) => {
    assert.ok(error instanceof ModelSelectError);
    assert.equal(error.model, "snow");
    assert.equal(error.reason, "option_missing");
    assert.match(error.message, /Snow/);
    return true;
  });
});

test("selectModel throws not_applied when the trigger never updates", async () => {
  const { page } = fakePage({ current: "Osler", menu: ["OslerDirect", "SnowDeep"], applyOnClick: false });
  await assert.rejects(selectModel(page, "snow"), (error: unknown) => {
    assert.ok(error instanceof ModelSelectError);
    assert.equal(error.reason, "not_applied");
    return true;
  });
});

test("selectModel throws trigger_missing when there is no model button", async () => {
  const page: ModelSelectorPage = {
    locator() {
      const none: ModelSelectorLocator = {
        first() { return this; },
        async count() { return 0; },
        async textContent() { return null; },
        async click() {},
        async waitFor() { throw new Error("timeout"); },
      };
      return none;
    },
  };
  await assert.rejects(selectModel(page, "osler"), (error: unknown) => {
    assert.ok(error instanceof ModelSelectError);
    assert.equal(error.reason, "trigger_missing");
    return true;
  });
});

test("verifyCreatedModel accepts matching or absent model_profile_name and rejects a mismatch", () => {
  assert.equal(verifyCreatedModel({ id: "a", inputs: { model_profile_name: "snow" } }, "snow"), null);
  assert.equal(verifyCreatedModel({ id: "a", inputs: {} }, "snow"), null);
  assert.equal(verifyCreatedModel({ id: "a" }, "snow"), null);
  const message = verifyCreatedModel({ id: "abc-123", inputs: { model_profile_name: "osler" } }, "snow");
  assert.match(message ?? "", /requested snow/);
  assert.match(message ?? "", /osler/);
  assert.match(message ?? "", /abc-123/);
});
```

- [ ] **Step 3: Register the test file and run it to confirm failure**

In `package.json`, change the `"test"` script to include the new file (keep alphabetical order):

```
"test": "node --import tsx --test tests/article-normalize.test.ts tests/bot-challenge.test.ts tests/citations-bibtex.test.ts tests/geo-block.test.ts tests/history-redaction.test.ts tests/installer.test.ts tests/mcp-contract.test.ts tests/model-selection.test.ts",
```

Run: `node --import tsx --test tests/model-selection.test.ts`
Expected: FAIL — `Cannot find module '../src/model-selection.js'`.

- [ ] **Step 4: Create `src/model-selection.ts`**

```ts
import type { OpenEvidenceModel } from "./types.js";

export const DEFAULT_MODEL: OpenEvidenceModel = "osler";

/** Leading word of the dropdown trigger / menu item text on openevidence.com. */
export const MODEL_LABELS: Record<OpenEvidenceModel, string> = {
  osler: "Osler",
  sackett: "Sackett",
  snow: "Snow",
};

const TRIGGER_SELECTOR = 'button[data-slot="dropdown-menu-trigger"]';
const MENU_ITEM_SELECTOR = '[role="menuitem"]';
const ANY_MODEL_RE = /^(Osler|Sackett|Snow)/; // no \b: OE concatenates the description right after the label
const SELECT_TIMEOUT_MS = 5_000;

/** Subset of Playwright's Locator that model selection needs (kept small so tests can fake it). */
export interface ModelSelectorLocator {
  first(): ModelSelectorLocator;
  count(): Promise<number>;
  textContent(): Promise<string | null>;
  click(): Promise<void>;
  waitFor(options: { timeout: number }): Promise<void>;
}

/** Subset of Playwright's Page that model selection needs. */
export interface ModelSelectorPage {
  locator(selector: string, options?: { hasText?: RegExp }): ModelSelectorLocator;
}

export class ModelSelectError extends Error {
  constructor(
    readonly model: OpenEvidenceModel,
    readonly reason: "trigger_missing" | "option_missing" | "not_applied",
  ) {
    super(describe(model, reason));
    this.name = "ModelSelectError";
  }
}

function describe(model: OpenEvidenceModel, reason: ModelSelectError["reason"]): string {
  const label = MODEL_LABELS[model];
  const detail =
    reason === "trigger_missing"
      ? "the model selector button was not found on the ask page"
      : reason === "option_missing"
        ? `the "${label}" option was not found in the model menu`
        : `the selector still did not show "${label}" after choosing it`;
  return `Could not select the OpenEvidence model "${label}" (${model}): ${detail}. The OpenEvidence UI may have changed; no question was submitted.`;
}

function labelRegex(model: OpenEvidenceModel): RegExp {
  return new RegExp(`^${MODEL_LABELS[model]}`);
}

async function currentLabel(trigger: ModelSelectorLocator): Promise<string> {
  const text = (await trigger.textContent()) ?? "";
  return ANY_MODEL_RE.exec(text.trim())?.[1] ?? "";
}

/**
 * Ensure the OpenEvidence ask page has `model` selected in its model dropdown.
 * Idempotent: does not click when the requested model is already shown.
 */
export async function selectModel(page: ModelSelectorPage, model: OpenEvidenceModel): Promise<void> {
  const trigger = page.locator(TRIGGER_SELECTOR, { hasText: ANY_MODEL_RE }).first();
  if ((await trigger.count()) === 0) {
    throw new ModelSelectError(model, "trigger_missing");
  }
  const wanted = MODEL_LABELS[model];
  if ((await currentLabel(trigger)) === wanted) {
    return;
  }

  await trigger.click();
  const option = page.locator(MENU_ITEM_SELECTOR, { hasText: labelRegex(model) }).first();
  try {
    await option.waitFor({ timeout: SELECT_TIMEOUT_MS });
  } catch {
    throw new ModelSelectError(model, "option_missing");
  }
  await option.click();

  const deadline = Date.now() + SELECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await currentLabel(trigger)) === wanted) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new ModelSelectError(model, "not_applied");
}

/**
 * After OpenEvidence creates the article, confirm it used the requested model.
 * Returns an error message on mismatch, otherwise null.
 */
export function verifyCreatedModel(created: Record<string, unknown>, model: OpenEvidenceModel): string | null {
  const inputs = created.inputs;
  if (!inputs || typeof inputs !== "object") {
    return null;
  }
  const actual = (inputs as Record<string, unknown>).model_profile_name;
  if (typeof actual !== "string" || actual === model) {
    return null;
  }
  const id = typeof created.id === "string" ? created.id : "unknown";
  return `OpenEvidence created article ${id} with model "${actual}" although the caller requested ${model}. The article exists in the account; retry the question or fetch it with oe_article_get.`;
}
```

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test tests/model-selection.test.ts`
Expected: 7 tests pass. Then `npm run check` → no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/model-selection.ts tests/model-selection.test.ts package.json
git -c core.safecrlf=false commit -m "feat: model-selection driver and OpenEvidenceModel type

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire model selection into `BrowserSession.ask()`

**Files:**
- Modify: `src/browser-session.ts` (imports; `BrowserAskPayload`; `ask()` body at ~lines 161–197)
- Modify: `src/openevidence-client.ts:39-41` (pass `model` through)

**Interfaces:**
- Consumes: `selectModel`, `verifyCreatedModel`, `ModelSelectError`, `DEFAULT_MODEL` (Task 1); `classifyBlockedPage`, `blockedPageMessage`, `readLivePageText` (already in browser-session.ts).
- Produces: `BrowserAskPayload.model?: OpenEvidenceModel`; every object returned by `ask()` carries `model_profile_name: string` (from the created article when present, else the requested model).

- [ ] **Step 1: Add imports and extend the payload type**

At the top of `src/browser-session.ts` add:

```ts
import { DEFAULT_MODEL, ModelSelectError, selectModel, verifyCreatedModel } from "./model-selection.js";
import type { OpenEvidenceModel } from "./types.js";
```

Change `BrowserAskPayload` to:

```ts
export interface BrowserAskPayload {
  question: string;
  originalArticleId?: string;
  articleType?: string;
  model?: OpenEvidenceModel;
}
```

- [ ] **Step 2: Replace the body of `ask()`**

```ts
  async ask(payload: BrowserAskPayload): Promise<Record<string, unknown>> {
    return this.runExclusive(async () => {
      const model = payload.model ?? DEFAULT_MODEL;
      const page = await this.pageForAsk(payload.originalArticleId);
      const previousArticleId = extractArticleId(page.url());
      await this.selectModelOrExplain(page, model);
      await fillQuestion(page, payload.question);

      const postResponsePromise = waitForPostArticle(page);
      const routeArticlePromise = waitForNewArticleId(page, previousArticleId);
      await clickSubmit(page);

      const pending = (id: string) => ({
        id,
        status: "pending",
        article_type: payload.articleType ?? DEFAULT_ARTICLE_TYPE,
        model_profile_name: model,
      });

      const first = await Promise.race([postResponsePromise, routeArticlePromise]);
      if (typeof first === "string") {
        return pending(first);
      }

      if (first) {
        assertWriteSucceeded(first);
        if (isRecord(first.data) && typeof first.data.id === "string") {
          const mismatch = verifyCreatedModel(first.data, model);
          if (mismatch) {
            throw new Error(mismatch);
          }
          return { ...first.data, model_profile_name: model };
        }
      }

      const fallbackArticleId = await routeArticlePromise;
      if (fallbackArticleId) {
        return pending(fallbackArticleId);
      }

      throw new Error("OpenEvidence question submit did not return an article id.");
    });
  }

  /** Select the model; if the selector is missing, prefer the blocked-page explanation over a UI error. */
  private async selectModelOrExplain(page: Page, model: OpenEvidenceModel): Promise<void> {
    try {
      await selectModel(page, model);
    } catch (error) {
      if (error instanceof ModelSelectError && error.reason === "trigger_missing") {
        const html = await page.content().catch(() => "");
        const blocked = classifyBlockedPage(`${html}\n${await readLivePageText(page)}`);
        if (blocked) {
          throw new Error(blockedPageMessage(blocked));
        }
      }
      throw error;
    }
  }
```

- [ ] **Step 3: Pass `model` through the client**

In `src/openevidence-client.ts` the `ask` method already forwards the whole payload (`return this.browserSession.ask(payload);`) and `OpenEvidenceAskRequest` now has `model?`, so no code change is needed there — verify by reading lines 39–41. If the client spreads fields explicitly instead, add `model: payload.model`.

- [ ] **Step 4: Type-check and run the full suite**

Run: `npm run check && npm test`
Expected: no type errors; all tests pass (45 = 38 + 7).

- [ ] **Step 5: Commit**

```bash
git add src/browser-session.ts src/openevidence-client.ts
git -c core.safecrlf=false commit -m "feat: select the requested OpenEvidence model before submitting a question

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Render `Table` widgets and HTML headings in `answer_text`

**Files:**
- Modify: `src/article.ts` (`renderReactComponents` return; `renderComponentMarkdown`)
- Modify: `tests/article-normalize.test.ts` (append tests)

**Interfaces:**
- Produces: `renderReactComponents(text)` now emits markdown pipe tables for `Table` widgets and `##`/`###`/`####` for `<h2>`/`<h3>`/`<h4>`. Exported helper `convertHtmlHeadings(text: string): string` (also used by tests).

- [ ] **Step 1: Append failing tests to `tests/article-normalize.test.ts`**

Add `convertHtmlHeadings` to the import list, then append:

```ts
test("renderReactComponents renders a Table widget from table_text", () => {
  const raw =
    'Summary:\n\nREACTCOMPONENT!:!Table!:!{"table_data": [{"Intervention": "Lifestyle", "Effect": "modest"}], "table_text": "| Intervention | Effect |\\n|---|---|\\n| Lifestyle | modest |"}\n\nAfter.';

  const cleaned = renderReactComponents(raw);

  assert.equal(cleaned.includes("REACTCOMPONENT"), false);
  assert.match(cleaned, /\| Intervention \| Effect \|\n\|---\|---\|\n\| Lifestyle \| modest \|/);
  assert.match(cleaned, /After\./);
});

test("renderReactComponents builds a Table from table_data when table_text is absent", () => {
  const raw =
    'REACTCOMPONENT!:!Table!:!{"table_data": [{"Drug": "Metformin", "Note": "a|b\\nc"}, {"Drug": "Letrozole", "Note": "first-line"}]}';

  const cleaned = renderReactComponents(raw);

  assert.equal(cleaned, "| Drug | Note |\n|---|---|\n| Metformin | a\\|b c |\n| Letrozole | first-line |");
});

test("renderReactComponents drops a Table widget with neither table_text nor table_data", () => {
  const raw = 'Before.\n\nREACTCOMPONENT!:!Table!:!{"title": "empty"}\n\nAfter.';
  assert.equal(renderReactComponents(raw), "Before.\n\nAfter.");
});

test("convertHtmlHeadings turns h2/h3/h4 into markdown headings and leaves other tags alone", () => {
  const raw = "Intro <b>bold</b>\n<h2>Scope and Framing</h2>\nText\n<H3> Sub </H3>\n<h4>Deep</h4>\n<h1>Ignored</h1>";
  assert.equal(
    convertHtmlHeadings(raw),
    "Intro <b>bold</b>\n\n## Scope and Framing\n\nText\n\n### Sub\n\n\n#### Deep\n\n<h1>Ignored</h1>",
  );
});

test("renderReactComponents converts headings even when no widget is present", () => {
  assert.equal(renderReactComponents("<h2>Only heading</h2>\nBody"), "## Only heading\n\nBody");
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --import tsx --test tests/article-normalize.test.ts`
Expected: FAIL — `convertHtmlHeadings` is not exported; Table tests fail on missing output.

- [ ] **Step 3: Implement in `src/article.ts`**

(a) Change the early return and the final return of `renderReactComponents` so headings are always converted:

```ts
export function renderReactComponents(text: string): string {
  if (!text.includes(REACT_COMPONENT_MARKER)) {
    return convertHtmlHeadings(text).replace(/\n{3,}/g, "\n\n").trim();
  }
  // ... existing loop unchanged ...
  // Collapse runs of 3+ newlines left behind by removed blocks.
  return convertHtmlHeadings(result).replace(/\n{3,}/g, "\n\n").trim();
}
```

(b) Add the heading converter (exported) next to `renderReactComponents`:

```ts
/**
 * OpenEvidence long-form (Snow) answers use raw <h2>/<h3>/<h4> tags for section
 * headings. Convert them to markdown so answer_text stays plain markdown.
 */
export function convertHtmlHeadings(text: string): string {
  return text.replace(/<h([2-4])>(.*?)<\/h\1>/gi, (_match, level: string, inner: string) => {
    const hashes = "#".repeat(Number(level));
    return `\n${hashes} ${inner.trim()}\n`;
  });
}
```

(c) In `renderComponentMarkdown`, insert before the trailing `return "";`:

```ts
  if (componentName === "Table") {
    const tableText = readNonEmptyString(record.table_text);
    if (tableText) {
      return `\n${tableText.trim()}\n`;
    }
    const table = renderTableData(record.table_data);
    return table ? `\n${table}\n` : "";
  }
```

(d) Add the `table_data` renderer near the other helpers:

```ts
function renderTableData(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }
  const rows = value.filter((row): row is Record<string, unknown> => isPlainObject(row));
  if (rows.length === 0) {
    return "";
  }
  const headers = Object.keys(rows[0]);
  if (headers.length === 0) {
    return "";
  }
  const cell = (input: unknown): string =>
    String(input ?? "")
      .replace(/\s*\n\s*/g, " ")
      .replace(/\|/g, "\\|")
      .trim();
  const lines = [
    `| ${headers.map(cell).join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${headers.map((h) => cell(row[h])).join(" | ")} |`),
  ];
  return lines.join("\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

If `article.ts` already has an equivalent of `isPlainObject` (e.g. `readObject` returning `Record<string, unknown> | null`), reuse it instead of adding a duplicate.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test tests/article-normalize.test.ts`
Expected: all pass, including the pre-existing widget tests (the `PublicationFigure` / `PublicationQuotation` / unknown-widget tests must still pass — headings conversion must not alter them).

- [ ] **Step 5: Commit**

```bash
git add src/article.ts tests/article-normalize.test.ts
git -c core.safecrlf=false commit -m "feat: render Table widgets and HTML headings in answer_text (Snow support)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `oe_ask` MCP surface — `model` input, 900 s ceiling, `model_profile_name` in results

**Files:**
- Modify: `src/server.ts` (`oe_ask` description + schema ~lines 191–206; handler ~208–241; `sanitizeCreatedArticle` ~385–393)
- Modify: `tests/mcp-contract.test.ts:51-62`

**Interfaces:**
- Consumes: `OPENEVIDENCE_MODELS` (Task 1); `client.ask({ question, originalArticleId, model })` (Task 2).
- Produces: `oe_ask` input `model` (enum, default `"osler"`), `timeout_sec` max 900; result `created.model_profile_name`.

- [ ] **Step 1: Update the contract test first**

In `tests/mcp-contract.test.ts` replace the `askInputs` assertion block with:

```ts
    // The oe_ask schema must only advertise inputs the server actually honors.
    const askSchema = byName.get("oe_ask")?.inputSchema as {
      properties?: Record<string, { enum?: string[]; default?: unknown; maximum?: number }>;
    };
    const askInputs = Object.keys(askSchema?.properties ?? {}).sort();
    assert.deepEqual(askInputs, [
      "model",
      "original_article_id",
      "poll_interval_ms",
      "question",
      "timeout_sec",
      "wait_for_completion",
    ]);
    assert.deepEqual(askSchema?.properties?.model?.enum, ["osler", "sackett", "snow"]);
    assert.equal(askSchema?.properties?.model?.default, "osler");
    assert.equal(askSchema?.properties?.timeout_sec?.maximum, 900);

    assert.match(byName.get("oe_ask")?.description ?? "", /wait_for_completion=false/);
    assert.match(byName.get("oe_ask")?.description ?? "", /snow/i);
```

Run: `node --import tsx --test tests/mcp-contract.test.ts`
Expected: FAIL on the key list (no `model`).

- [ ] **Step 2: Update `src/server.ts`**

Import at the top: `import { OPENEVIDENCE_MODELS } from "./types.js";` (keep existing imports).

Replace the `oe_ask` description string with:

```ts
      "Create an OpenEvidence research question, not medical advice or patient-specific diagnosis. Choose the answer model with `model`: osler (default; direct answer, typically under 90 s), sackett (comprehensive answer for complex cases, ~30 s), or snow (deep long-form research with sections, tables and 30-60 citations; typically 4-7 min). For snow or other long questions, prefer wait_for_completion=false and then call oe_article_wait with the returned article_id. Use original_article_id only for true follow-up continuity; omit it for fresh questions. Returns privacy-reduced created article data (including model_profile_name) and optionally normalized completed fields. Side effect: creates a question/article in the user's OpenEvidence account through the local browser profile.",
```

Replace the input schema with:

```ts
    inputSchema: z.object({
      question: z.string().min(3).max(6000),
      original_article_id: z.string().uuid().optional(),
      model: z.enum(OPENEVIDENCE_MODELS as [string, ...string[]]).default("osler").optional(),
      wait_for_completion: z.boolean().default(true).optional(),
      timeout_sec: z.number().int().min(5).max(900).default(120).optional(),
      poll_interval_ms: z.number().int().min(300).max(10000).default(1200).optional(),
    }),
```

In the handler, build the payload as:

```ts
      const askPayload: OpenEvidenceAskRequest = {
        question: args.question,
        originalArticleId: args.original_article_id,
        model: (args.model ?? "osler") as OpenEvidenceModel,
      };
```

(add `OpenEvidenceModel` to the existing `import type { ... } from "./types.js"`).

Replace `sanitizeCreatedArticle` with:

```ts
function sanitizeCreatedArticle(article: Record<string, unknown>) {
  const inputs = isRecordLike(article.inputs) ? article.inputs : {};
  const fromInputs = typeof inputs.model_profile_name === "string" ? inputs.model_profile_name : null;
  const fromTopLevel = typeof article.model_profile_name === "string" ? article.model_profile_name : null;
  return {
    article_id: typeof article.id === "string" ? article.id : null,
    status: typeof article.status === "string" ? article.status : null,
    article_type: typeof article.article_type === "string" ? article.article_type : null,
    model_profile_name: fromInputs ?? fromTopLevel,
    datetime_created:
      typeof article.datetime_created === "string" ? article.datetime_created : null,
  };
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

(If `server.ts` already has a record guard with another name, reuse it and skip `isRecordLike`.)

- [ ] **Step 3: Type-check and run the full suite**

Run: `npm run check && npm test`
Expected: no type errors; all tests pass. The `mcp-contract` test spawns the built server via `tsx`, so the schema assertions exercise the real registration.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts tests/mcp-contract.test.ts
git -c core.safecrlf=false commit -m "feat(oe_ask): model input (osler|sackett|snow), 900 s wait ceiling, model_profile_name in results

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Docs, version bump, manual UAT, push

**Files:**
- Modify: `package.json` (`"version": "0.3.1"`), `package-lock.json` (top two `version` fields)
- Modify: `CHANGELOG.md`, `README.md`, `docs/TROUBLESHOOTING.md`, `docs/SESSION_UAT.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Version bump**

In `package.json` set `"version": "0.3.1"`; run `npm install --package-lock-only` so `package-lock.json` follows. Confirm `npm test` still passes (the contract test reads the version from `package.json`).

- [ ] **Step 2: CHANGELOG**

Insert above `## [0.3.0] - 2026-07-06`:

```markdown
## [0.3.1] - 2026-09-16

### Added
- `oe_ask.model` — choose the OpenEvidence answer model: `osler` (default), `sackett`, or `snow` (deep long-form research). The selection is made in the OpenEvidence UI before submitting and verified against the created article's `model_profile_name`, which is now returned in the `created` payload.
- `oe_ask.timeout_sec` may now be up to 900 seconds so a Snow answer can be awaited in one call.
- `Table` widgets in answers are rendered as markdown pipe tables (from `table_text`, falling back to `table_data`).
- Raw `<h2>`/`<h3>`/`<h4>` headings in answers are converted to markdown headings.

### Fixed
- Snow answers lost their summary tables because the `Table` widget was treated as unknown and dropped.
```

- [ ] **Step 3: README**

Replace the `oe_ask` row in the tool table with:

```markdown
| `oe_ask` | Creates an OpenEvidence research question and optionally waits for the article to complete. `model` selects `osler` (default, fast), `sackett` (complex cases) or `snow` (deep long-form research, 4–7 min). Set `wait_for_completion=false` for fire-and-forget. | Yes. | Creates a question/article in your OpenEvidence account. |
```

Add a bullet to the fork-notes block:

```markdown
> - `oe_ask.model` (`osler` / `sackett` / `snow`) plus markdown rendering of Snow tables and headings (v0.3.1).
```

- [ ] **Step 4: TROUBLESHOOTING and SESSION_UAT**

Append to `docs/TROUBLESHOOTING.md`:

```markdown
## Model Selector Not Found / Model Mismatch

`oe_ask` selects the requested `model` (Osler, Sackett or Snow) in the dropdown next to the question box before submitting. If it reports that the selector button or the option was not found, first check `oe_auth_status` — a DataDome or location-restriction page hides the whole ask UI. Otherwise the OpenEvidence UI has probably changed; open an issue with the error text (no account data).

If it reports that the created article used a different model than requested, the article still exists in your account (its id is in the error); fetch it with `oe_article_get` or retry the question.
```

Append to `docs/SESSION_UAT.md` a "v0.3.1 model selection" checklist:

```markdown
## v0.3.1 — model selection

1. `oe_ask` with `model: "sackett"`, `wait_for_completion: true` → `created.model_profile_name === "sackett"`.
2. `oe_ask` with `model: "snow"`, `wait_for_completion: false` → `oe_article_wait` with `timeout_sec: 900` → `answer_text` contains `## ` headings and at least one `| … |` table row; `citations.length >= 30`.
3. `oe_ask` without `model` right after step 2 → `created.model_profile_name === "osler"` (previous selection did not leak).
```

- [ ] **Step 5: Manual UAT (VPN on, profile logged in, no other process holding the profile)**

Run the three checks from `docs/SESSION_UAT.md` through stdio, e.g.:

```bash
cd ~/openevidence-mcp && npm run build && printf '%s\n%s\n%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"uat","version":"0"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"oe_ask","arguments":{"question":"First-line antibiotic for uncomplicated cystitis?","model":"sackett","wait_for_completion":true}}}' \
| node dist/server.js 2>/dev/null | grep -o '"model_profile_name":"[a-z]*"'
```

Expected: `"model_profile_name":"sackett"`. Repeat with `"model":"snow","wait_for_completion":false`, then `oe_article_wait` (`timeout_sec: 900`) and inspect `answer_text` for `## ` and `| ` lines. Finally an ask without `model` → `"osler"`.

- [ ] **Step 6: Commit and push**

```bash
git add package.json package-lock.json CHANGELOG.md README.md docs/TROUBLESHOOTING.md docs/SESSION_UAT.md
git -c core.safecrlf=false commit -m "chore: release 0.3.1 — docs, UAT checklist, version bump

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u mine feat/v0.3.1-model-selection
git push mine feat/v0.3.1-model-selection:main
git tag v0.3.1 && git push mine v0.3.1
```

Then re-register nothing: Claude Desktop already points at `dist/server.js`; restart Claude Desktop so the new `model` input appears.

---

## Self-review

- **Spec coverage:** §3.1 → Task 1 (types) + Task 4 (schema, description, sanitized result, 900 s). §3.2 → Task 1 (`selectModel`, label mapping, failure policy, `verifyCreatedModel`) + Task 2 (wiring, blocked-page precedence, synthetic results carry `model_profile_name`, explicit selection every call). §3.3 → Task 3. §3.4 → Task 5. §4 unit tests → Tasks 1, 3, 4; manual UAT → Task 5.
- **Placeholders:** none; every code step is concrete.
- **Type consistency:** `OpenEvidenceModel` / `OPENEVIDENCE_MODELS` defined in Task 1 and used in Tasks 2 and 4; `selectModel(page, model)` / `verifyCreatedModel(created, model)` / `ModelSelectError.reason` names match between Task 1 tests, Task 1 implementation and Task 2; `convertHtmlHeadings` exported in Task 3 and imported by its test; `sanitizeCreatedArticle` return shape gains only `model_profile_name`.
