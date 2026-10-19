"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const L = require("../logic.js");

const ROOT = path.join(__dirname, "..", "..");
const program = JSON.parse(fs.readFileSync(path.join(ROOT, "program.json"), "utf8"));
const ex = (sessionId, id) => program.sessions.find((s) => s.id === sessionId).exercises.find((e) => e.id === id);

test("parseCsv handles quotes, escaped quotes, CRLF and empty trailing fields", () => {
  const text = 'date,note\r\n2026-10-19,"a, b"\r\n2026-10-20,"say ""hi"""\n2026-10-21,\n';
  const { header, records } = L.parseCsv(text);
  assert.deepEqual(header, ["date", "note"]);
  assert.deepEqual(records, [
    { date: "2026-10-19", note: "a, b" },
    { date: "2026-10-20", note: 'say "hi"' },
    { date: "2026-10-21", note: "" },
  ]);
});

test("serializeCsv round-trips through parseCsv", () => {
  const records = [{ date: "2026-10-19", note: 'x, "y"\nz' }];
  const text = L.serializeCsv(["date", "note"], records);
  assert.deepEqual(L.parseCsv(text).records, records);
});

test("mergeCsv appends new records and replaces those with the same key", () => {
  const text = "date,session,exercise,set,weight_kg,reps,rir\n2026-10-19,legs_a,squat,1,60,8,3\n2026-10-21,upper_a,bench_press,1,55,8,\n";
  const fresh = [{ date: "2026-10-19", session: "legs_a", exercise: "squat", set: "1", weight_kg: "62.5", reps: "6", rir: "2" }];
  const res = L.mergeCsv(text, L.LIFTS_HEADER, fresh, L.liftKey);
  assert.equal(res.replaced, 1);
  const recs = L.parseCsv(res.text).records;
  assert.equal(recs.length, 2);
  assert.equal(recs.find((r) => r.session === "legs_a").weight_kg, "62.5");
});

test("mergeCsv works on an empty file and rejects a foreign header", () => {
  const rec = { date: "2026-10-19", weight_kg: "61", waist_cm: "", sleep_h: "", note: "" };
  const res = L.mergeCsv("", L.BODY_HEADER, [rec], L.bodyKey);
  assert.equal(res.text, "date,weight_kg,waist_cm,sleep_h,note\n2026-10-19,61,,,\n");
  assert.throws(() => L.mergeCsv("a,b\n1,2\n", L.BODY_HEADER, [rec], L.bodyKey), /Unexpected CSV header/);
});

test("base64 helpers are UTF-8 safe", () => {
  const s = "заметка: дежурство ✓\n";
  assert.equal(L.b64ToUtf8(L.utf8ToB64(s)), s);
  assert.equal(L.b64ToUtf8(L.utf8ToB64(s).replace(/(.{4})/g, "$1\n")), s);
});

test("sessionsForVariant and exercisesFor respect variants", () => {
  assert.deepEqual(L.sessionsForVariant(program, 3).map((s) => s.id), ["legs_a", "upper_a", "legs_b"]);
  assert.equal(L.sessionsForVariant(program, 4).length, 4);
  const legsA = program.sessions.find((s) => s.id === "legs_a");
  assert.ok(L.exercisesFor(legsA, 3).some((e) => e.id === "lat_pulldown"));
  assert.ok(!L.exercisesFor(legsA, 4).some((e) => e.id === "lat_pulldown"));
});

const history = [
  { date: "2026-10-19", session: "legs_a", exercise: "leg_curl", set: "1", weight_kg: "27", reps: "12", rir: "" },
  { date: "2026-10-19", session: "legs_a", exercise: "leg_curl", set: "2", weight_kg: "27", reps: "12", rir: "4" },
  { date: "2026-10-23", session: "legs_b", exercise: "leg_curl", set: "1", weight_kg: "22", reps: "14", rir: "" },
];

test("lastPerformance prefers the same session and falls back to any", () => {
  assert.equal(L.lastPerformance(history, "legs_a", "leg_curl").sets[0].weight, 27);
  assert.equal(L.lastPerformance(history, "legs_b", "leg_curl").sets[0].weight, 22);
  assert.equal(L.lastPerformance(history, "upper_b", "leg_curl").date, "2026-10-23");
  assert.equal(L.lastPerformance(history, "legs_a", "squat"), null);
});

test("lastPerformance ignores records on or after beforeDate", () => {
  assert.equal(L.lastPerformance(history, "legs_a", "leg_curl", "2026-10-19"), null);
});

test("roundDown snaps to plate steps", () => {
  assert.equal(L.roundDown(58.5, 2.5), 57.5);
  assert.equal(L.roundDown(60, 2.5), 60);
});

const last = (sets) => ({ date: "2026-10-19", sets });

test("top set at top of range with enough RIR earns the increment", () => {
  const plan = L.suggest(ex("legs_a", "squat"), last([{ set: 1, weight: 60, reps: 8, rir: 3 }]));
  assert.deepEqual(plan.sets.map((s) => s.weight), [65, 57.5, 57.5]);
  assert.match(plan.hint, /\+5 кг/);
});

test("top set below range or with RIR under the minimum keeps the weight", () => {
  const squat = ex("legs_a", "squat");
  assert.equal(L.suggest(squat, last([{ set: 1, weight: 60, reps: 7, rir: 3 }])).sets[0].weight, 60);
  assert.equal(L.suggest(squat, last([{ set: 1, weight: 60, reps: 8, rir: 0 }])).sets[0].weight, 60);
});

test("top set uses the heaviest set even if back-offs come first", () => {
  const plan = L.suggest(
    ex("legs_a", "squat"),
    last([
      { set: 1, weight: 50, reps: 10, rir: null },
      { set: 2, weight: 60, reps: 8, rir: 3 },
    ]),
  );
  assert.equal(plan.sets[0].weight, 65);
});

test("straight sets: all at top of range adds the increment, huge RIR doubles it", () => {
  const curl = ex("legs_a", "leg_curl");
  const p1 = L.suggest(curl, last([12, 12, 12].map((r, i) => ({ set: i + 1, weight: 27, reps: r, rir: i === 2 ? 4 : null }))));
  assert.equal(p1.sets[0].weight, 32);
  const calves = ex("legs_a", "calf_raise_standing");
  const p2 = L.suggest(calves, last([12, 12, 12].map((r, i) => ({ set: i + 1, weight: 20, reps: r, rir: i === 2 ? 6 : null }))));
  assert.equal(p2.sets[0].weight, 30);
});

test("straight sets: any set below the top keeps the weight", () => {
  const ext = ex("legs_a", "leg_extension");
  const plan = L.suggest(ext, last([{ set: 1, weight: 43, reps: 12, rir: null }, { set: 2, weight: 43, reps: 17, rir: 0 }]));
  assert.equal(plan.sets[0].weight, 43);
  assert.equal(plan.sets.length, 2);
});

test("no history yields empty weights with the right number of sets", () => {
  assert.deepEqual(L.suggest(ex("upper_a", "bench_press"), null).sets.map((s) => s.weight), [null, null, null]);
  assert.equal(L.suggest(ex("legs_b", "romanian_deadlift"), null).sets.length, 3);
});

test("buildLiftRecords numbers sets, skips empty rows and validates", () => {
  const recs = L.buildLiftRecords("2026-10-19", "legs_a", [
    { exercise: "squat", sets: [{ weight: "65", reps: "7", rir: "2" }, { weight: "", reps: "", rir: "" }, { weight: "57.5", reps: "9", rir: "" }] },
  ]);
  assert.deepEqual(recs.map((r) => [r.set, r.weight_kg, r.reps, r.rir]), [["1", "65", "7", "2"], ["2", "57.5", "9", ""]]);
  assert.throws(() => L.buildLiftRecords("2026-10-19", "legs_a", [{ exercise: "squat", sets: [{ weight: "60", reps: "0", rir: "" }] }]), /повторы/);
  assert.throws(() => L.buildLiftRecords("2026-10-19", "legs_a", [{ exercise: "squat", sets: [{ weight: "-5", reps: "5", rir: "" }] }]), /вес/);
  assert.throws(() => L.buildLiftRecords("2026-10-19", "legs_a", [{ exercise: "squat", sets: [{ weight: "60", reps: "5", rir: "11" }] }]), /запас/);
});

test("buildBodyRecord accepts a comma decimal and validates ranges", () => {
  assert.deepEqual(L.buildBodyRecord({ date: "2026-10-19", weight: "61,4", waist: "", sleep: "7.5", note: " ok " }), {
    date: "2026-10-19",
    weight_kg: "61.4",
    waist_cm: "",
    sleep_h: "7.5",
    note: "ok",
  });
  assert.throws(() => L.buildBodyRecord({ date: "2026-10-19", weight: "" }), /обязательное/);
  assert.throws(() => L.buildBodyRecord({ date: "19.10.2026", weight: "61" }), /Дата/);
  assert.throws(() => L.buildBodyRecord({ date: "2026-10-19", weight: "610" }), /Вес/);
});
