import { describe, expect, it } from "vitest";
import { frontendAssetNeedsRevalidation } from "./app.js";

describe("frontend cache policy", () => {
  it("revalidates the app shell and service worker metadata", () => {
    for (const fileName of [
      "index.html",
      "sw.js",
      "sw-assets.js",
    ]) {
      expect(frontendAssetNeedsRevalidation(`/srv/eduri/dist/${fileName}`))
        .toBe(true);
    }

    expect(frontendAssetNeedsRevalidation("/srv/eduri/dist/theme-init.js"))
      .toBe(false);
    expect(frontendAssetNeedsRevalidation("/srv/eduri/dist/assets/index-abc.js"))
      .toBe(false);
  });
});
