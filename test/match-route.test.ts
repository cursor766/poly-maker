import assert from "node:assert/strict";
import test from "node:test";
import { eventSlugFromPolymarketUrl, matchConfigPath } from "../web/lib/match-route.js";

test("extracts the Polymarket event slug from an honor-of-kings URL", () => {
  assert.equal(
    eventSlugFromPolymarketUrl(
      "https://polymarket.com/esports/honor-of-kings/king-pro-league/hok-edg-lgd-2026-08-27",
    ),
    "hok-edg-lgd-2026-08-27",
  );
});

test("builds a match detail path with encoded source and Polymarket URLs", () => {
  const path = matchConfigPath("hok-edg-lgd-2026-08-27", {
    sourceUrl: "https://example.com/markets/123",
    polymarketUrl:
      "https://polymarket.com/esports/honor-of-kings/king-pro-league/hok-edg-lgd-2026-08-27",
  });
  assert.ok(path.startsWith("/matches/hok-edg-lgd-2026-08-27?"));
  const params = new URLSearchParams(path.split("?")[1]);
  assert.equal(params.get("sourceUrl"), "https://example.com/markets/123");
  assert.equal(
    params.get("polymarketUrl"),
    "https://polymarket.com/esports/honor-of-kings/king-pro-league/hok-edg-lgd-2026-08-27",
  );
});

test("rejects a Polymarket URL without a hyphenated event slug", () => {
  assert.equal(eventSlugFromPolymarketUrl("https://polymarket.com/esports"), null);
  assert.equal(eventSlugFromPolymarketUrl("not-a-url"), null);
});
