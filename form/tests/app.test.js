"use strict";
// Smoke test of the page wiring: loads index.html into jsdom with a fake
// GitHub contents API and drives the form like a user would.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const FORM = path.join(__dirname, "..");
const ROOT = path.join(FORM, "..");

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

function fakeApi(files, { conflictsOnce = false } = {}) {
  const calls = [];
  let shaCounter = 1;
  const shas = Object.fromEntries(Object.keys(files).map((p) => [p, "sha" + shaCounter++]));
  let conflictPending = conflictsOnce;
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, ""));
    calls.push({ method: opts.method || "GET", path: p, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (!(p in files)) return json(404, { message: "Not Found" });
    if ((opts.method || "GET") === "GET") return json(200, { content: b64(files[p]), sha: shas[p], encoding: "base64" });
    const body = JSON.parse(opts.body);
    if (conflictPending) {
      conflictPending = false;
      files[p] = files[p] + "2026-10-20,upper_a,bench_press,1,55,8,\n";
      shas[p] = "sha" + shaCounter++;
      return json(409, { message: "conflict" });
    }
    if (body.sha !== shas[p]) return json(409, { message: "sha mismatch" });
    files[p] = Buffer.from(body.content, "base64").toString("utf8");
    shas[p] = "sha" + shaCounter++;
    return json(200, { content: { sha: shas[p] } });
  };
  return { fetch, calls, files };
}

async function boot(api, { settings, confirm = () => true } = {}) {
  const html = fs.readFileSync(path.join(FORM, "index.html"), "utf8").replace(/<script src="[^"]+"><\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://example.test/" });
  const w = dom.window;
  w.fetch = api.fetch;
  w.confirm = confirm;
  w.TextEncoder = TextEncoder;
  w.TextDecoder = TextDecoder;
  if (settings) w.localStorage.setItem("trainlog.settings", JSON.stringify(settings));
  w.eval(fs.readFileSync(path.join(FORM, "logic.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(FORM, "app.js"), "utf8"));
  await w.TrainApp.ready;
  return w;
}

const SETTINGS = { owner: "me", repo: "trainlog", branch: "main", token: "t0k", apiBase: "https://api.github.com", variant: 3 };

function repoFiles() {
  return {
    "program.json": fs.readFileSync(path.join(ROOT, "program.json"), "utf8"),
    "data/lifts.csv": fs.readFileSync(path.join(ROOT, "data", "lifts.csv"), "utf8"),
    "data/body.csv": "date,weight_kg,waist_cm,sleep_h,note\n",
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("without settings the settings tab is shown and nothing is fetched", async () => {
  const api = fakeApi(repoFiles());
  const w = await boot(api);
  assert.equal(w.document.getElementById("panel-settings").hidden, false);
  assert.equal(api.calls.length, 0);
});

test("selecting a session prefills weights from history and saves a commit", async () => {
  const api = fakeApi(repoFiles());
  const w = await boot(api, { settings: SETTINGS });
  const doc = w.document;
  assert.equal(doc.querySelectorAll("#sessions .chip").length, 3);

  doc.getElementById("date").value = "2026-10-22";
  doc.querySelector('[data-session="legs_a"]').click();
  const squat = doc.querySelector('[data-exercise="squat"]');
  assert.deepEqual([...squat.querySelectorAll(".sets .w")].map((i) => i.value), ["65", "57.5", "57.5"]);
  assert.match(squat.querySelector(".hint").textContent, /60×8 \(3\)/);
  assert.ok(doc.querySelector('[data-exercise="lat_pulldown"]'), "variant 3 shows the extra pulldown");

  for (const [i, row] of [...squat.querySelectorAll(".sets .set")].entries()) {
    row.querySelector(".r").value = i === 0 ? "7" : "9";
    if (i === 0) row.querySelector(".q").value = "2";
  }
  doc.getElementById("save-workout").click();
  await flush();
  await flush();

  const put = api.calls.find((c) => c.method === "PUT");
  assert.ok(put, "a PUT was sent");
  assert.equal(put.path, "data/lifts.csv");
  assert.equal(put.body.message, "chore(log): legs_a 2026-10-22");
  assert.equal(put.headers.Authorization, "Bearer t0k");
  const saved = api.files["data/lifts.csv"];
  assert.match(saved, /2026-10-22,legs_a,squat,1,65,7,2\n2026-10-22,legs_a,squat,2,57.5,9,\n/);
  assert.match(saved, /^date,session,exercise,set,weight_kg,reps,rir\n2026-10-19,legs_a,squat,1,60,8,3/);
  assert.match(doc.getElementById("workout-status").textContent, /Записано: 3/);
  assert.equal(w.localStorage.getItem("trainlog.draft"), null);
});

test("a 409 conflict is retried against the fresh file", async () => {
  const api = fakeApi(repoFiles(), { conflictsOnce: true });
  const w = await boot(api, { settings: SETTINGS });
  const doc = w.document;
  doc.getElementById("date").value = "2026-10-22";
  doc.querySelector('[data-session="legs_a"]').click();
  doc.querySelector('[data-exercise="squat"] .sets .r').value = "6";
  doc.getElementById("save-workout").click();
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(api.calls.filter((c) => c.method === "PUT").length, 2);
  const saved = api.files["data/lifts.csv"];
  assert.match(saved, /2026-10-20,upper_a,bench_press/, "concurrent change kept");
  assert.match(saved, /2026-10-22,legs_a,squat,1,65,6,/);
});

test("re-submitting the same day asks before replacing", async () => {
  const api = fakeApi(repoFiles());
  let asked = 0;
  const w = await boot(api, { settings: SETTINGS, confirm: () => (asked++, false) });
  const doc = w.document;
  doc.getElementById("date").value = "2026-10-19";
  doc.querySelector('[data-session="legs_a"]').click();
  // No history before 2026-10-19, so the weight field starts empty.
  assert.equal(doc.querySelector('[data-exercise="squat"] .sets .w').value, "");
  doc.querySelector('[data-exercise="squat"] .sets .w').value = "60";
  doc.querySelector('[data-exercise="squat"] .sets .r').value = "8";
  doc.getElementById("save-workout").click();
  await flush();
  await flush();
  assert.equal(asked, 1);
  assert.equal(api.calls.filter((c) => c.method === "PUT").length, 0);
  assert.equal(doc.getElementById("workout-status").textContent, "Отменено");
});

test("body weight is saved to body.csv", async () => {
  const api = fakeApi(repoFiles());
  const w = await boot(api, { settings: SETTINGS });
  const doc = w.document;
  doc.getElementById("b-date").value = "2026-10-20";
  doc.getElementById("b-weight").value = "61.4";
  doc.getElementById("b-note").value = "дежурство, ночь";
  doc.getElementById("save-body").click();
  await flush();
  await flush();
  assert.equal(api.files["data/body.csv"], 'date,weight_kg,waist_cm,sleep_h,note\n2026-10-20,61.4,,,"дежурство, ночь"\n');
});

test("an API error keeps the draft and reports it", async () => {
  const api = fakeApi(repoFiles());
  const w = await boot(api, { settings: SETTINGS });
  const doc = w.document;
  doc.getElementById("date").value = "2026-10-22";
  doc.querySelector('[data-session="legs_a"]').click();
  const r = doc.querySelector('[data-exercise="squat"] .sets .r');
  r.value = "6";
  r.dispatchEvent(new w.Event("input", { bubbles: true }));
  w.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: "Bad credentials" }) });
  doc.getElementById("save-workout").click();
  await flush();
  await flush();
  assert.match(doc.getElementById("workout-status").textContent, /токен не принят/);
  const draft = JSON.parse(w.localStorage.getItem("trainlog.draft"));
  assert.equal(draft.entries.squat[0].reps, "6");
});

test("top and back-off sets are labelled and keep labels after edits", async () => {
  const api = fakeApi(repoFiles());
  const w = await boot(api, { settings: SETTINGS });
  const doc = w.document;
  doc.getElementById("date").value = "2026-10-22";
  doc.querySelector('[data-session="legs_a"]').click();
  const squat = doc.querySelector('[data-exercise="squat"]');
  const labels = () => [...squat.querySelectorAll(".sets .set-no")].map((e) => e.textContent);
  assert.deepEqual(labels(), ["Топ", "Доб", "Доб"]);
  assert.match(squat.querySelector(".order").textContent, /разминка .* → топ 5–8 → 2 добив\. по 90%/);

  squat.querySelector(".add").click();
  assert.deepEqual(labels(), ["Топ", "Доб", "Доб", "Доб"]);
  squat.querySelectorAll(".sets .set")[1].querySelector(".icon").click();
  assert.deepEqual(labels(), ["Топ", "Доб", "Доб"]);

  const press = doc.querySelector('[data-exercise="leg_press"]');
  assert.deepEqual([...press.querySelectorAll(".sets .set-no")].map((e) => e.textContent), ["1", "2", "3"]);
  assert.equal(press.querySelector(".order"), null);
});
