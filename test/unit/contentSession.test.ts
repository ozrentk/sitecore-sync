import { test } from "node:test";
import { deepStrictEqual, strictEqual, throws, rejects } from "node:assert/strict";
import { ContentSession, type ContentEndpoint, type ContentSessionState } from "../../src/comparison/contentSession";

const en: ContentEndpoint = { connectionId: "one", language: "en", rootPath: "/sitecore/content", selectedItemId: "item" };
const de: ContentEndpoint = { ...en, language: "de" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("opening one connection creates Browse; explicit Compare preserves independent languages and retained side", () => {
  const session = new ContentSession();
  strictEqual(session.state, undefined);
  session.openConnection(en);
  deepStrictEqual(session.state, { mode: "browse", source: en });
  session.openCompare(en, de);
  deepStrictEqual(session.state, { mode: "compare", left: en, right: de, languagesLocked: false });
  throws(() => session.openCompare(en, de, true), /must match/);
  session.retainSide("right");
  deepStrictEqual(session.state, { mode: "browse", source: de });
  throws(() => session.openConnection({ ...en, connectionId: "" }));
  throws(() => session.openConnection({ ...en, language: "" }));
  throws(() => session.openConnection({ ...en, rootPath: "relative" }));
  strictEqual(Object.isFrozen(session.state), true);
  session.dispose();
});

test("mode and language changes reject stale loads even when a request ignores abort and the old state returns", async () => {
  const session = new ContentSession(); session.openConnection(en);
  const old = deferred<string>(); const published: string[] = []; let signal!: AbortSignal;
  const pending = session.load("tree", async (_state, input) => { signal = input; return old.promise; }, value => published.push(value));
  session.openCompare(en, de); session.openConnection(en);
  strictEqual(signal.aborted, true);
  old.resolve("stale"); strictEqual(await pending, false);
  await session.load("tree", async state => state.mode, value => published.push(value));
  deepStrictEqual(published, ["browse"]);
  session.dispose();
});

test("same-key loads supersede; independent load keys coexist; failures remain observable", async () => {
  const session = new ContentSession(); session.openConnection(en);
  const old = deferred<number>(); const published: number[] = [];
  const pending = session.load("tree", async () => old.promise, value => published.push(value));
  await session.load("tree", async () => 2, value => published.push(value));
  await session.load("details", async () => 3, value => published.push(value));
  old.resolve(1); strictEqual(await pending, false);
  deepStrictEqual(published, [2, 3]);
  await rejects(session.load("tree", async () => { throw new Error("failed"); }, () => {}), /failed/);
  strictEqual(await session.load("tree", async () => 4, () => {}), true);
  session.dispose();
});

test("cancelled and failed transitions preserve Browse; newer transitions win over late results", async () => {
  const session = new ContentSession(); session.openConnection(en);
  strictEqual(await session.transition(async () => undefined), false);
  await rejects(session.transition(async () => { throw new Error("picker failed"); }), /picker failed/);
  deepStrictEqual(session.state, { mode: "browse", source: en });
  const old = deferred<ContentSessionState>();
  const pending = session.transition(async () => old.promise);
  strictEqual(await session.load("tree", async () => 1, () => {}), false);
  await session.transition(async () => ({ mode: "browse", source: de }));
  old.resolve({ mode: "compare", left: en, right: de, languagesLocked: false });
  strictEqual(await pending, false);
  deepStrictEqual(session.state, { mode: "browse", source: de });
  session.dispose();
});

test("cancel and disposal invalidate pending work without requiring cooperative request cancellation", async () => {
  const session = new ContentSession(); session.openConnection(en);
  const response = deferred<number>();
  const pending = session.load("tree", async () => response.promise, () => { throw new Error("stale publication"); });
  session.cancelPending(); response.resolve(1); strictEqual(await pending, false);
  const target = deferred<ContentSessionState>();
  const transition = session.transition(async () => target.promise);
  session.dispose(); session.dispose();
  target.resolve({ mode: "browse", source: en }); strictEqual(await transition, false);
  strictEqual(session.state, undefined);
  throws(() => session.openConnection(en), /disposed/);
  await rejects(session.load("tree", async () => 1, () => {}), /disposed/);
});


test("independent loads coexist, but a language-only change invalidates both", async () => {
  const session = new ContentSession(); session.openCompare(en, de);
  const left = deferred<number>(); const right = deferred<number>(); const seen: number[] = [];
  const first = session.load("left", async () => left.promise, value => seen.push(value));
  const second = session.load("right", async () => right.promise, value => seen.push(value));
  left.resolve(1); right.resolve(2);
  deepStrictEqual(await Promise.all([first, second]), [true, true]);
  deepStrictEqual(seen, [1, 2]);
  const stale = deferred<number>();
  const pending = session.load("right", async () => stale.promise, value => seen.push(value));
  session.openCompare(en, { ...de, language: "fr" });
  stale.resolve(3); strictEqual(await pending, false);
  deepStrictEqual(seen, [1, 2]); session.dispose();
});

test("explicit cancellation of transition retains state and permits fresh work", async () => {
  const session = new ContentSession(); session.openConnection(en);
  const target = deferred<ContentSessionState>(); let signal!: AbortSignal;
  const pending = session.transition(async input => { signal = input; return target.promise; });
  session.cancelPending(); strictEqual(signal.aborted, true);
  target.resolve({ mode: "browse", source: de }); strictEqual(await pending, false);
  deepStrictEqual(session.state, { mode: "browse", source: en });
  strictEqual(await session.load("tree", async () => 1, () => {}), true);
  await rejects(session.transition(async () => ({ mode: "browse", source: { ...en, rootPath: "bad" } })));
  deepStrictEqual(session.state, { mode: "browse", source: en }); session.dispose();
});
