import { test } from "node:test";
import assert from "node:assert/strict";
import { matchHub, voteHub } from "../lib/assign.js";

const hubs = [
  { id: "rec00600000000006", name: "Quad Con 006", nickname: "QC 006" },
  { id: "rec00400000000004", name: "Quad Con 004", nickname: "" },
  { id: "recFat", name: "Fat Mike", nickname: "" },
];
const homes = new Map([["258227", "rec00600000000006"], ["89616", "rec00600000000006"], ["89599", "rec00600000000006"], ["89708", "rec00400000000004"], ["251003", "rec00400000000004"]]);
const P = (t) => t.padStart(24, "0");

test("matchHub: id, name, nickname, compact forms, bare number", () => {
  assert.equal(matchHub("rec00600000000006", hubs).id, "rec00600000000006");
  assert.equal(matchHub("quad con 006", hubs).id, "rec00600000000006");
  assert.equal(matchHub("QC006", hubs).id, "rec00600000000006");
  assert.equal(matchHub("qc 004", hubs).id, "rec00400000000004"); // number form, no nickname needed
  assert.equal(matchHub("QuadCon004", hubs).id, "rec00400000000004");
  assert.equal(matchHub("6", hubs).id, "rec00600000000006");
  assert.equal(matchHub("fat mike", hubs).id, "recFat");
  assert.equal(matchHub("", hubs), null);
  assert.equal(matchHub("nope", hubs), null);
});

test("voteHub: clear majority wins, retail tags ignored", () => {
  const v = voteHub([P("258227"), P("89616"), P("89599"), P("89708"), "30283312D82900D61E7101F7"], homes);
  assert.deepEqual(v, { hubId: "rec00600000000006", votes: 3, known: 4, total: 5 });
});
test("voteHub: tie or thin evidence → null", () => {
  assert.equal(voteHub([P("258227"), P("89708")], homes), null);           // 1–1
  assert.equal(voteHub([P("258227")], homes), null);                        // only one known tag
  assert.equal(voteHub(["30283312D82900D61E7101F7"], homes), null);         // nothing known
  assert.equal(voteHub([P("258227"), P("89616"), P("89708"), P("251003")], homes), null); // 2–2
});
