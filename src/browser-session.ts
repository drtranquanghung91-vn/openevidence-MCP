import { platform } from "node:os";
import { chromium, type BrowserContext, type Page, type Response } from "playwright";

import type { AppConfig } from "./config.js";
import { classifyWriteFailure } from "./errors.js";
import {
  DEFAULT_MODEL,
  ModelSelectError,
  selectModel,
  shouldTolerateMissingTrigger,
  verifyCreatedModel,
} from "./model-selection.js";
import { findSystemBrowser } from "./system-browser.js";
import type { OpenEvidenceModel } from "./types.js";

const DEFAULT_ARTICLE_TYPE = "Ask OpenEvidence Light with citations";
const ARTICLE_ID_RE = /\/ask\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export const BOT_CHALLENGE_MESSAGE =
  "OpenEvidence is showing an anti-bot verification page (DataDome) for the local MCP browser profile, so the app UI did not load. " +
  "This is not a login problem and usually happens after many automated questions in a short time. " +
  "To fix it, the user must open the MCP browser profile manually and pass the verification once: " +
  "run `npm run login:session` (from the openevidence-mcp folder), complete the check in the opened browser window until the normal OpenEvidence page loads, " +
  "close that window, then retry this tool. Consider spacing out oe_ask calls to avoid repeat challenges.";

/**
 * DataDome serves a small interstitial page instead of the app.
 * Detect its unmistakable markers so we can tell the user exactly what to do
 * instead of a generic "UI may have changed" error.
 */
export function isBotChallengePage(html: string): boolean {
  return html.includes("captcha-delivery.com") || /\bvar\s+dd\s*=\s*\{[^}]*'rt'/.test(html);
}

export const GEO_BLOCK_MESSAGE =
  "OpenEvidence is refusing this connection because of its network location: instead of the app it returned its 'Unavailable' page " +
  "(\"OpenEvidence is not available in your location at this time\"). This is not a login problem and re-running login:session will not help, " +
  "because the saved browser session is fine. OpenEvidence is geo-restricted, so the machine running this MCP server must reach openevidence.com " +
  "from a supported region. Ask the user to connect the VPN they normally use for OpenEvidence (or otherwise route this machine through a supported region), then retry this tool.";

/**
 * OpenEvidence geo-blocks some regions and serves a static "Unavailable" page
 * (HTTP 200, HTML) for every route, including /api/auth/me. Detect it so we do
 * not misreport a healthy session as "not authenticated".
 */
export function isGeoBlockedPage(html: string): boolean {
  return (
    /not available in your location/i.test(html) ||
    /Transfer Restriction Notice/i.test(html) ||
    /<title>[^<]*\bUnavailable\b[^<]*OpenEvidence[^<]*<\/title>/i.test(html)
  );
}

export type BlockedPageKind = "geo" | "bot";

export function classifyBlockedPage(html: string): BlockedPageKind | null {
  if (isGeoBlockedPage(html)) {
    return "geo";
  }
  if (isBotChallengePage(html)) {
    return "bot";
  }
  return null;
}

export function blockedPageMessage(kind: BlockedPageKind): string {
  return kind === "geo" ? GEO_BLOCK_MESSAGE : BOT_CHALLENGE_MESSAGE;
}

interface BrowserFetchResult {
  status: number;
  contentType: string;
  data: unknown;
  text: string;
}

interface PostArticleResult {
  status: number;
  contentType: string;
  data: unknown;
  text: string;
}

export interface BrowserAskPayload {
  question: string;
  originalArticleId?: string;
  articleType?: string;
  model?: OpenEvidenceModel;
}

export class BrowserSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initPromise: Promise<void> | null = null;
  private queue = Promise.resolve();

  constructor(private readonly config: AppConfig) {}

  async init(): Promise<void> {
    this.initPromise ??= this.launch();
    await this.initPromise;
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.initPromise = null;
    await context?.close().catch(() => undefined);
  }

  async getAuthStatus(): Promise<{ authenticated: boolean; statusCode: number; user?: Record<string, unknown>; message?: string; blocked?: BlockedPageKind }> {
    return this.runExclusive(async () => {
      const result = await this.browserFetch("/api/auth/me");
      if (result.status !== 200 || !isRecord(result.data)) {
        const blocked = await this.detectBlockedPage(result.text);
        if (blocked) {
          return {
            authenticated: false,
            statusCode: result.status,
            blocked,
            message: blockedPageMessage(blocked),
          };
        }
      }
      if (result.status !== 200) {
        return {
          authenticated: false,
          statusCode: result.status,
          message: `OpenEvidence auth is not active (status ${result.status}). Run: npm run login:session`,
        };
      }
      if (!isRecord(result.data)) {
        return {
          authenticated: false,
          statusCode: result.status,
          message: "OpenEvidence auth endpoint did not return JSON. Session may be expired or redirected.",
        };
      }
      return {
        authenticated: true,
        statusCode: result.status,
        user: result.data,
      };
    });
  }

  async listHistory(limit = 20, offset = 0, search?: string): Promise<unknown> {
    return this.runExclusive(async () => {
      const query = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
      });
      if (search && search.length > 0) {
        query.set("search", search);
      }
      return this.getJson(`/api/article/list?${query.toString()}`);
    });
  }

  async getArticle(articleId: string): Promise<Record<string, unknown>> {
    return this.runExclusive(async () => {
      const data = await this.getJson(`/api/article/${articleId}`);
      if (!isRecord(data)) {
        throw new Error(`GET /api/article/${articleId} did not return an object.`);
      }
      return data;
    });
  }

  async ask(payload: BrowserAskPayload): Promise<Record<string, unknown>> {
    return this.runExclusive(async () => {
      const model = payload.model ?? DEFAULT_MODEL;
      const explicit = payload.model !== undefined;
      const page = await this.pageForAsk(payload.originalArticleId);
      const previousArticleId = extractArticleId(page.url());
      await this.selectModelOrExplain(page, model, explicit);
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

  /**
   * Select the model; if the selector is missing, prefer the blocked-page explanation
   * over a UI error. When the caller did not explicitly request a model (an implicit
   * default) and the selector is simply absent (not blocked), proceed with the page's
   * current model instead of hard-failing.
   */
  private async selectModelOrExplain(page: Page, model: OpenEvidenceModel, explicit: boolean): Promise<void> {
    try {
      await selectModel(page, model);
    } catch (error) {
      if (error instanceof ModelSelectError && error.reason === "trigger_missing") {
        const html = await page.content().catch(() => "");
        const blocked = classifyBlockedPage(`${html}\n${await readLivePageText(page)}`);
        if (blocked) {
          throw new Error(blockedPageMessage(blocked));
        }
        if (shouldTolerateMissingTrigger(error, explicit)) {
          process.stderr.write("[openevidence-mcp] model selector not found; submitting with the page's current model.\n");
          return;
        }
      }
      throw error;
    }
  }

  private async launch(): Promise<void> {
    const browser = findSystemBrowser();
    const isHeadless = process.env.OE_MCP_BROWSER_HEADLESS !== "0";

    // Drive Chrome's modern headless mode via an explicit `--headless=new` flag
    // rather than Playwright's legacy `--headless`, which crashes on current
    // Chrome builds (launch exits with code 21). We keep the system Chrome so the
    // login-session profile stays fully compatible. headless:false stops Playwright
    // from injecting the legacy flag; Playwright still attaches over the debug pipe.
    this.context = await chromium.launchPersistentContext(this.config.userDataDir, {
      executablePath: browser.executablePath,
      headless: false,
      viewport: isHeadless ? { width: 1280, height: 800 } : null,
      userAgent: getCleanUserAgent(),
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        ...(isHeadless ? ["--headless=new"] : []),
        "--no-first-run",
        "--no-default-browser-check",
        "--start-minimized",
        "--disable-blink-features=AutomationControlled",
        "--password-store=basic",
      ],
    });
    await this.context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", {
          get: () => undefined,
        });
      } catch {
        // Ignore errors in standard headless/non-headless environments
      }
    });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.page.setDefaultTimeout(parsePositiveInt(process.env.OE_MCP_BROWSER_TIMEOUT_MS, 30_000));
    await this.page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  }

  private async ensureOpenEvidencePage(path: string): Promise<Page> {
    await this.init();
    const page = await this.currentPage();
    const target = new URL(path, this.config.baseUrl).toString();
    if (!sameOrigin(page.url(), this.config.baseUrl)) {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
    }
    return page;
  }

  private async pageForAsk(originalArticleId?: string): Promise<Page> {
    const path = originalArticleId ? `/ask/${originalArticleId}` : "/";
    const page = await this.ensureOpenEvidencePage(path);
    const target = new URL(path, this.config.baseUrl).toString();
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return page;
  }

  private async currentPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }
    if (!this.context) {
      throw new Error("OpenEvidence browser session is not initialized.");
    }
    this.page = this.context.pages().find((candidate) => !candidate.isClosed()) ?? await this.context.newPage();
    return this.page;
  }

  private async browserFetch(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<BrowserFetchResult> {
    const page = await this.ensureOpenEvidencePage("/");
    return page.evaluate(
      async ({ requestPath, requestInit }) => {
        const headers = new Headers(requestInit?.headers ?? {});
        if (!headers.has("accept")) {
          headers.set("accept", "application/json, text/plain, */*");
        }
        if (requestInit?.body !== undefined && !headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
        const response = await fetch(requestPath, {
          method: requestInit?.method ?? "GET",
          headers,
          credentials: "include",
          body:
            requestInit?.body === undefined
              ? undefined
              : JSON.stringify(requestInit.body),
        });
        const contentType = response.headers.get("content-type") ?? "";
        const text = await response.text();
        let data: unknown = null;
        if (text.length > 0 && contentType.toLowerCase().includes("json")) {
          try {
            data = JSON.parse(text) as unknown;
          } catch {
            data = null;
          }
        }
        return {
          status: response.status,
          contentType,
          data,
          text: text.slice(0, 800),
        };
      },
      { requestPath: path, requestInit: init },
    );
  }

  private async getJson(path: string): Promise<unknown> {
    const result = await this.browserFetch(path);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`GET ${path} failed with status ${result.status}.`);
    }
    if (result.data === null && !result.contentType.toLowerCase().includes("json")) {
      const blocked = await this.detectBlockedPage(result.text);
      if (blocked) {
        throw new Error(blockedPageMessage(blocked));
      }
    }
    return result.data;
  }

  /**
   * browserFetch keeps only a short, redacted prefix of the response body, so
   * also inspect the live page (title + visible text) that ensureOpenEvidencePage
   * loaded: geo-block and DataDome pages replace the app there as well.
   */
  private async detectBlockedPage(responseText: string): Promise<BlockedPageKind | null> {
    const direct = classifyBlockedPage(responseText);
    if (direct) {
      return direct;
    }
    const page = this.page && !this.page.isClosed() ? this.page : null;
    if (!page) {
      return null;
    }
    const live = await readLivePageText(page);
    return classifyBlockedPage(live);
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.init();
      return await fn();
    } finally {
      release();
    }
  }
}

async function fillQuestion(page: Page, question: string): Promise<void> {
  const input = await findFirstVisible(page, [
    'textarea[aria-label="Ask a medical question"]',
    'textarea[aria-label*="Ask"]',
    'textarea[placeholder*="Ask"]',
    "textarea",
    '[contenteditable="true"]',
  ]);
  if (!input) {
    const html = await page.content().catch(() => "");
    const blocked = classifyBlockedPage(`${html}\n${await readLivePageText(page)}`);
    if (blocked) {
      throw new Error(blockedPageMessage(blocked));
    }
    throw new Error("Could not find the OpenEvidence question input. The OpenEvidence UI may have changed.");
  }
  await input.fill(question);
}

/** Title plus rendered text of the current page, formatted so the blocked-page matchers apply. */
async function readLivePageText(page: Page): Promise<string> {
  return page
    .evaluate(() => `<title>${document.title}</title>\n${document.body?.innerText ?? ""}`)
    .catch(() => "");
}

async function clickSubmit(page: Page): Promise<void> {
  const button = await findFirstVisible(page, [
    'button[aria-label="Submit question"]',
    'button[aria-label*="Submit"]',
    'button[type="submit"]',
  ]);
  if (!button) {
    throw new Error("Could not find the OpenEvidence submit button. The OpenEvidence UI may have changed.");
  }
  await button.click({ timeout: 15_000 });
}

async function findFirstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 2_000 }))) {
        return locator;
      }
    } catch {
      // Try the next selector.
    }
  }
  return null;
}

async function waitForPostArticle(page: Page): Promise<PostArticleResult | null> {
  const response = await page
    .waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === "/api/article",
      { timeout: 60_000 },
    )
    .catch(() => null);
  if (!response) {
    return null;
  }
  return readResponse(response);
}

async function waitForNewArticleId(page: Page, previousArticleId: string | null): Promise<string | null> {
  const handle = await page
    .waitForFunction(
      (previous) => {
        const match = window.location.pathname.match(
          /\/ask\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
        );
        const id = match?.[1] ?? null;
        return id && id !== previous ? id : null;
      },
      previousArticleId,
      { timeout: 60_000 },
    )
    .catch(() => null);
  if (!handle) {
    return null;
  }
  const value = await handle.jsonValue();
  return typeof value === "string" ? value : null;
}

async function readResponse(response: Response): Promise<PostArticleResult> {
  const status = response.status();
  const contentType = response.headers()["content-type"] ?? "";
  const text = await response.text().catch(() => "");
  let data: unknown = null;
  if (text.length > 0 && contentType.toLowerCase().includes("json")) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = null;
    }
  }
  return {
    status,
    contentType,
    data,
    text: text.slice(0, 800),
  };
}

function assertWriteSucceeded(result: PostArticleResult): void {
  if (result.status === 200 || result.status === 201) {
    return;
  }
  throw new Error(classifyWriteFailure(result.status, result.contentType, result.text));
}

function sameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function extractArticleId(url: string): string | null {
  return new URL(url).pathname.match(ARTICLE_ID_RE)?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getCleanUserAgent(): string {
  const os = platform();
  if (os === "darwin") {
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
  }
  if (os === "linux") {
    return "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
  }
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
}
