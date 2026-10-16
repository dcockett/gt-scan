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
