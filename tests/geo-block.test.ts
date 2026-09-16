import test from "node:test";
import assert from "node:assert/strict";

import {
  BOT_CHALLENGE_MESSAGE,
  GEO_BLOCK_MESSAGE,
  classifyBlockedPage,
  blockedPageMessage,
  isGeoBlockedPage,
} from "../src/browser-session.js";

const GEO_BLOCK_BODY =
  "<html><head><title>Unavailable | OpenEvidence</title></head><body>" +
  "<p>We’re sorry, OpenEvidence is not available in your location at this time.</p>" +
  "<a>Transfer Restriction Notice</a></body></html>";

test("isGeoBlockedPage detects the location-restriction body text", () => {
  assert.equal(isGeoBlockedPage("<p>OpenEvidence is not available in your location at this time.</p>"), true);
});

test("isGeoBlockedPage detects the Transfer Restriction Notice link alone", () => {
  assert.equal(isGeoBlockedPage("<a href=\"/transfer\">Transfer Restriction Notice</a>"), true);
});

test("isGeoBlockedPage detects the Unavailable page title alone", () => {
  assert.equal(isGeoBlockedPage("<title>Unavailable | OpenEvidence</title>"), true);
});

test("isGeoBlockedPage ignores the normal OpenEvidence app page", () => {
  const appHtml =
    '<html><head><title>OpenEvidence</title></head><body><main><textarea aria-label="Ask a medical question"></textarea>' +
    "<p>Latest additions to our library</p></main></body></html>";
  assert.equal(isGeoBlockedPage(appHtml), false);
});

test("isGeoBlockedPage ignores a DataDome interstitial", () => {
  const dd = "<script>var dd={'rt':'c','host':'geo.captcha-delivery.com'}</script>";
  assert.equal(isGeoBlockedPage(dd), false);
});

test("classifyBlockedPage distinguishes geo, bot and normal pages", () => {
  assert.equal(classifyBlockedPage(GEO_BLOCK_BODY), "geo");
  assert.equal(classifyBlockedPage('<iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>'), "bot");
  assert.equal(classifyBlockedPage("<main><textarea></textarea></main>"), null);
});

test("blockedPageMessage maps each kind to its guidance", () => {
  assert.equal(blockedPageMessage("geo"), GEO_BLOCK_MESSAGE);
  assert.equal(blockedPageMessage("bot"), BOT_CHALLENGE_MESSAGE);
});

test("geo block message tells the agent it is a location problem, not a login problem", () => {
  assert.match(GEO_BLOCK_MESSAGE, /not available in your location/i);
  assert.match(GEO_BLOCK_MESSAGE, /not a login problem/i);
  assert.match(GEO_BLOCK_MESSAGE, /VPN/);
  assert.doesNotMatch(GEO_BLOCK_MESSAGE, /run `npm run login:session`/);
});
