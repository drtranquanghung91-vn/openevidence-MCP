import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MODEL,
  MODEL_LABELS,
  ModelSelectError,
  selectModel,
  shouldTolerateMissingTrigger,
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

test("shouldTolerateMissingTrigger is true only for trigger_missing on an implicit (unspecified) model", () => {
  assert.equal(shouldTolerateMissingTrigger(new ModelSelectError("osler", "trigger_missing"), false), true);
  assert.equal(shouldTolerateMissingTrigger(new ModelSelectError("osler", "trigger_missing"), true), false);
  assert.equal(shouldTolerateMissingTrigger(new ModelSelectError("osler", "option_missing"), false), false);
  assert.equal(shouldTolerateMissingTrigger(new Error("boom"), false), false);
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
