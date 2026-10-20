import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEpcs, epcFromTagId, displayTag } from "../lib/epc.js";

const A = "000000000000000000258227";
const B = "000000000000000000089581";
const GS1 = "303404721813519B0224B7E7";

test("one tag with Enter", () => {
  const r = extractEpcs(A + "\n");
  assert.deepEqual(r, { epcs: [A], pending: "" });
});

test("two tags on separate lines", () => {
  const r = extractEpcs(A + "\n" + B + "\n");
  assert.deepEqual(r.epcs, [A, B]);
  assert.equal(r.pending, "");
});

test("run-on string with no Enter (Sept 13 bug) splits every 24", () => {
  const r = extractEpcs(A + B + GS1 + "\n");
  assert.deepEqual(r.epcs, [A, B, GS1]);
});

test("partial tail is held as pending", () => {
  const r = extractEpcs(A + "\n" + B.slice(0, 10));
  assert.deepEqual(r.epcs, [A]);
  assert.equal(r.pending, B.slice(0, 10));
});

test("tail without newline but complete is consumed", () => {
  const r = extractEpcs(A + B);
  assert.deepEqual(r.epcs, [A, B]);
  assert.equal(r.pending, "");
});

test("lowercase hex and stray chars are normalized", () => {
  const r = extractEpcs(GS1.toLowerCase() + "\r\n");
  assert.deepEqual(r.epcs, [GS1]);
});

test("manual tag id pads to 24", () => {
  assert.equal(epcFromTagId("258227"), A);
  assert.equal(epcFromTagId(" 89581 "), B);
  assert.equal(epcFromTagId(""), null);
});

test("displayTag strips zeros", () => {
  assert.equal(displayTag(A), "258227");
  assert.equal(displayTag(GS1), GS1);
});

import { readFileSync } from "node:fs";
import { parseTagList } from "../lib/epc.js";

test("parseTagList: real 123RFID Mobile Share File CSV (10/19)", () => {
  const csv = readFileSync(new URL("./fixtures/123rfid-taglist.csv", import.meta.url), "utf8");
  assert.deepEqual(parseTagList(csv), [
    "30283312D82900D61E7101F7",
    "000000000000000000258227",
    "000000000000000000251038",
  ]);
});

test("parseTagList: plain list, mixed separators, dupes, junk", () => {
  const t = parseTagList("000000000000000000089599,000000000000000000089599\n303404721813519B0224B7E7; 12345 ,\"000000000000000000089708\"");
  assert.deepEqual(t, ["000000000000000000089599", "303404721813519B0224B7E7", "000000000000000000089708"]);
});

test("parseTagList: empty / nonsense → []", () => {
  assert.deepEqual(parseTagList(""), []);
  assert.deepEqual(parseTagList("INVENTORY SUMMARY\nUNIQUE COUNT:,3\n\"READ TIME:\",\"00:12\""), []);
});
