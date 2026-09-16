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
