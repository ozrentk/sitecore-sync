import { strictEqual, deepStrictEqual, rejects, throws } from "node:assert/strict";
import { test } from "node:test";
import { createFallbackFixtures, planFallbackFixtures } from "../../src/sitecore/fallbackFixtures";

const id = "00000000-0000-0000-0000-000000000001";
const plan = () => planFallbackFixtures(id, "/sitecore/content/Test", id, "Title", ["en-NZ", "en-AU", "en"], "abcdef123456");
test("fallback fixtures create source-only and local controls with bounded new names", () => {
  const fixtures = plan();
  deepStrictEqual(fixtures.map(fixture => fixture.input.language), ["en", "en", "en-NZ", "en-NZ"]);
  deepStrictEqual(fixtures.map(fixture => fixture.input.fields?.["__Enable item fallback"]), ["1", "", "1", "1"]);
  strictEqual(fixtures[3].input.fields?.Title, "");
  strictEqual(new Set(fixtures.map(fixture => fixture.expectedPath)).size, 4);
  for (const fixture of fixtures) { strictEqual(fixture.input.parent, id); }
  throws(() => planFallbackFixtures(id, "/sitecore/templates/Test", id, "Title", ["en", "de"], "abcdef123456"));
  throws(() => planFallbackFixtures(id, "/sitecore/content/Test", id, "__Renderings", ["en", "de"], "abcdef123456"));
  throws(() => planFallbackFixtures(id, "/sitecore/content/Test", id, "Title", ["en"], "abcdef123456"));
});
test("fallback mutations checkpoint before sending and retain unknown outcome without retry", async () => {
  const fixtures = plan();
  const snapshots: string[] = [];
  let calls = 0;
  await rejects(createFallbackFixtures(fixtures, async () => {
    calls++; strictEqual(snapshots.at(-1), "outcome-unknown"); throw new Error("transport failed after send");
  }, async () => { snapshots.push(fixtures[0].status); }, new AbortController().signal));
  strictEqual(calls, 1);
  strictEqual(fixtures[0].status, "outcome-unknown");
  strictEqual(fixtures[1].status, "planned");
  await rejects(createFallbackFixtures(fixtures, async () => { throw new Error("must not replay"); }, async () => {}, new AbortController().signal));
});
test("fallback mutation stops on checkpoint failure, cancellation and wrong returned path", async () => {
  let calls = 0;
  const create = async () => { calls++; return { itemId: id, path: "/wrong" }; };
  await rejects(createFallbackFixtures(plan(), create, async () => { throw new Error("storage unavailable"); }, new AbortController().signal));
  await rejects(createFallbackFixtures(plan(), create, async () => {}, AbortSignal.abort()));
  strictEqual(calls, 0);
  const fixtures = plan();
  await rejects(createFallbackFixtures(fixtures, create, async () => {}, new AbortController().signal));
  strictEqual(calls, 1); strictEqual(fixtures[0].status, "outcome-unknown");
});
test("fallback mutations record confirmed compact IDs and finish each checkpoint", async () => {
  const fixtures = plan(); let checkpoints = 0;
  await createFallbackFixtures(fixtures, async input => ({ itemId: id.replace(/-/gu, ""), path: `/sitecore/content/Test/${input.name}` }),
    async () => { checkpoints++; }, new AbortController().signal);
  strictEqual(checkpoints, 8);
  strictEqual(fixtures.every(fixture => fixture.status === "created" && fixture.itemId), true);
});
