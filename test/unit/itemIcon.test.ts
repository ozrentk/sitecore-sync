import { rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
  maximumItemIconBytes,
  readItemIconDataUri,
  resolveSitecoreIconUrl,
} from "../../src/sitecore/itemIcon";

test("Sitecore icon identifiers resolve through the same-origin icon handler", () => {
  strictEqual(
    resolveSitecoreIconUrl(
      "https://cm.example.test",
      "Network\\16x16\\home.png",
    )?.href,
    "https://cm.example.test/-/icon/Network/16x16/home.png",
  );
  strictEqual(
    resolveSitecoreIconUrl(
      "https://cm.example.test",
      "~/sitecore/shell/themes/standard/Applications/16x16/document.png",
    )?.href,
    "https://cm.example.test/-/icon/Applications/16x16/document.png",
  );
  strictEqual(
    resolveSitecoreIconUrl(
      "https://cm.example.test",
      "https://cm.example.test/-/icon/Applications/16x16/folder.webp",
    )?.href,
    "https://cm.example.test/-/icon/Applications/16x16/folder.webp",
  );
});

test("Sitecore icon identifiers reject unsafe and unsupported locations", () => {
  for (const configuredIcon of [
    "https://external.example.test/-/icon/Applications/16x16/icon.png",
    "http://cm.example.test/-/icon/Applications/16x16/icon.png",
    "//cm.example.test/sitecore/shell/themes/standard/icon.png",
    "/sitecore/api/authoring/graphql/v1/icon.png",
    "/sitecore/shell/themes/custom/icon.png",
    "../admin/icon.png",
    "/-/icon/%2f..%2fadmin.png",
    "/-/icon/%5c..%5cadmin.png",
    "Network/16x16/icon.svg",
    "Network/16x16/icon.png?token=value",
    "data:image/png;base64,AQID",
  ]) {
    strictEqual(
      resolveSitecoreIconUrl("https://cm.example.test", configuredIcon),
      undefined,
      configuredIcon,
    );
  }
});

test("item icon responses produce bounded raster data URIs", async () => {
  const response = new Response(Uint8Array.from([1, 2, 3]), {
    headers: { "content-type": "image/png", "content-length": "3" },
  });
  strictEqual(await readItemIconDataUri(response), "data:image/png;base64,AQID");

  await rejects(
    readItemIconDataUri(new Response("text", { headers: { "content-type": "text/plain" } })),
    /supported raster image/u,
  );
  await rejects(
    readItemIconDataUri(new Response(null, {
      headers: {
        "content-type": "image/png",
        "content-length": String(maximumItemIconBytes + 1),
      },
    })),
    /size limit/u,
  );
  await rejects(
    readItemIconDataUri(new Response(new Uint8Array(maximumItemIconBytes + 1), {
      headers: { "content-type": "image/png" },
    })),
    /size limit/u,
  );
});

test("item icon responses reject failures, redirects, and empty bodies", async () => {
  await rejects(readItemIconDataUri(new Response(null, { status: 404 })), /failed \(404\)/u);
  await rejects(
    readItemIconDataUri(new Response(null, { headers: { "content-type": "image/png" } })),
    /did not contain image data/u,
  );
  const redirected = new Response(Uint8Array.from([1]), {
    headers: { "content-type": "image/png" },
  });
  Object.defineProperty(redirected, "redirected", { value: true });
  await rejects(readItemIconDataUri(redirected), /redirected/u);
});
