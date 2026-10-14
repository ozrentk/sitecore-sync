import { test } from "node:test";
import { strictEqual, deepStrictEqual, throws } from "node:assert";
import { parseNameValues, serializeNameValues } from "../../src/editor/nameValueList";

test("name/value round trip preserves raw encoding, duplicates, empty values and ordering", () => {
  for (const raw of ["", "a=1&a=2&empty=", "a+b=%26%3d%2B%25&unicode=%C5%BE&literal=雪", "key=a=b"]) {
    strictEqual(serializeNameValues(raw, JSON.stringify(parseNameValues(raw))), raw);
  }
  deepStrictEqual(parseNameValues("a+b=%26%3D%2B%25"), [{ raw: "a+b=%26%3D%2B%25", key: "a b", value: "&=+%" }]);
});
test("name/value changes encode separators and Unicode without rewriting retained entries", () => {
  const raw = "old+key=old%20value&a=%2b&a=2";
  const rows = [...parseNameValues(raw)]; rows[0] = { ...rows[0], value: "&=+% 雪" };
  strictEqual(serializeNameValues(raw, JSON.stringify(rows)), "old+key=%26%3D%2B%25%20%E9%9B%AA&a=%2b&a=2");
  strictEqual(serializeNameValues(raw, "[]"), "");
  strictEqual(serializeNameValues("", JSON.stringify([{ raw: null, key: "a&=+%雪", value: "" }])) , "a%26%3D%2B%25%E9%9B%AA=");
});
test("name/value malformed input, new duplicate keys and forged row identities are rejected", () => {
  for (const raw of ["a", "=x", "a=x&&b=y", "a=%ZZ", "a=%FF", "a=%00", "a=\ud800"]) throws(() => parseNameValues(raw));
  for (const rows of [[{ raw:null,key:"",value:"" }], [{raw:1,key:"a",value:"2"}],  [{raw:"a=1",key:"a",value:"2"},{raw:null,key:"a",value:"3"}]]) {
    throws(() => serializeNameValues("a=1", JSON.stringify(rows)));
  }
  throws(() => parseNameValues(Array(257).fill("a=x").join("&")));
  throws(() => serializeNameValues("a=1", JSON.stringify([{raw:"a=1",key:"a",value:"1"},{raw:null,key:"A",value:"2"}])));
});
