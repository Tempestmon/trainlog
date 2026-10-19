// DOM layer of the logging form. Talks to the GitHub contents API and
// delegates all data handling to TrainLogic (logic.js).
(function () {
  "use strict";

  const L = window.TrainLogic;
  const PATHS = { program: "program.json", lifts: "data/lifts.csv", body: "data/body.csv" };
  const SETTINGS_KEY = "trainlog.settings";
  const DRAFT_KEY = "trainlog.draft";
  const DEFAULT_SETTINGS = {
    apiBase: "https://api.github.com",
    owner: "",
    repo: "",
    branch: "main",
    token: "",
    variant: 3,
  };
  const MAX_CONFLICT_RETRIES = 3;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    program: null,
    liftRecords: [],
    sessionId: null,
  };

  // ---------- storage (may be unavailable in private mode) ----------

  function load(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function save(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      /* storage unavailable: keep working in memory */
    }
  }

  // ---------- helpers ----------

  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children || [])) {
      if (c !== null && c !== undefined) el.append(c);
    }
    return el;
  }

  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function setStatus(id, text, kind) {
    const el = $(id);
    el.textContent = text || "";
    el.dataset.kind = kind || "";
  }

  // ---------- API ----------

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  function configured() {
    const s = state.settings;
    return Boolean(s.owner && s.repo && s.token);
  }

  function contentsUrl(path) {
    const s = state.settings;
    const base = s.apiBase.replace(/\/+$/, "");
    return base + "/repos/" + encodeURIComponent(s.owner) + "/" + encodeURIComponent(s.repo) + "/contents/" + path;
  }

  async function request(url, options) {
    const s = state.settings;
    const res = await fetch(url, {
      cache: "no-store",
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + s.token,
        ...(options && options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).message || "";
      } catch (_) {
        /* non-JSON error body */
      }
      const hints = {
        401: "токен не принят",
        403: "нет прав: токену нужен доступ Contents: read and write",
        404: "репозиторий или файл не найден",
        409: "файл изменился",
      };
      throw new ApiError(res.status, "HTTP " + res.status + ": " + (hints[res.status] || detail || "ошибка"));
    }
    return res.json();
  }

  async function getFile(path) {
    const ref = encodeURIComponent(state.settings.branch);
    const data = await request(contentsUrl(path) + "?ref=" + ref);
    return { text: L.b64ToUtf8(data.content || ""), sha: data.sha };
  }

  async function putFile(path, text, sha, message) {
    return request(contentsUrl(path), {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: L.utf8ToB64(text),
        sha,
        branch: state.settings.branch,
      }),
    });
  }

  // Read-modify-write with optimistic locking: on 409 re-read and retry.
  async function commitMerge(path, header, records, keyFn, message, confirmReplace) {
    for (let attempt = 1; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      const file = await getFile(path);
      const merged = L.mergeCsv(file.text, header, records, keyFn);
      if (merged.replaced > 0 && attempt === 1 && !confirmReplace(merged.replaced)) {
        return { cancelled: true };
      }
      try {
        await putFile(path, merged.text, file.sha, message);
        return { cancelled: false, replaced: merged.replaced, text: merged.text };
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && attempt < MAX_CONFLICT_RETRIES) continue;
        throw err;
      }
    }
    throw new Error("Не удалось записать после " + MAX_CONFLICT_RETRIES + " попыток");
  }

  // ---------- tabs ----------

  function showTab(name) {
    $$(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
    $$(".panel").forEach((p) => (p.hidden = p.id !== "panel-" + name));
  }

  // ---------- workout panel ----------

  function renderVariant() {
    $$("#variant button").forEach((b) =>
      b.setAttribute("aria-pressed", String(Number(b.dataset.variant) === state.settings.variant)),
    );
  }

  function renderSessions() {
    const box = $("#sessions");
    box.textContent = "";
    if (!state.program) return;
    for (const s of L.sessionsForVariant(state.program, state.settings.variant)) {
      box.append(
        h("button", {
          type: "button",
          class: "chip",
          "data-session": s.id,
          "aria-pressed": String(s.id === state.sessionId),
          text: s.name,
          onclick: () => selectSession(s.id),
        }),
      );
    }
  }

  function setRow(set, idx, planned) {
    const lo = planned ? planned.reps[0] : "";
    const hi = planned ? planned.reps[1] : "";
    return h("div", { class: "set" }, [
      h("span", { class: "set-no", text: String(idx + 1) }),
      h("input", {
        class: "w",
        type: "number",
        inputmode: "decimal",
        step: "0.5",
        min: "0",
        "aria-label": "Вес, кг",
        placeholder: "кг",
        value: set.weight === null || set.weight === undefined ? "" : String(set.weight),
      }),
      h("input", {
        class: "r",
        type: "number",
        inputmode: "numeric",
        min: "1",
        "aria-label": "Повторы",
        placeholder: lo !== "" ? lo + "–" + hi : "повт",
        value: set.reps === undefined || set.reps === null ? "" : String(set.reps),
      }),
      h("input", {
        class: "q",
        type: "number",
        inputmode: "numeric",
        min: "0",
        max: "10",
        "aria-label": "Запас",
        placeholder: "зап",
        value: set.rir === undefined || set.rir === null ? "" : String(set.rir),
      }),
      h("button", {
        type: "button",
        class: "icon",
        "aria-label": "Удалить подход",
        text: "×",
        onclick: (ev) => {
          ev.currentTarget.closest(".set").remove();
          renumber();
          saveDraft();
        },
      }),
    ]);
  }

  function renumber() {
    $$(".exercise").forEach((card) => $$(".set-no", card).forEach((el, i) => (el.textContent = String(i + 1))));
  }

  function selectSession(sessionId, draft) {
    state.sessionId = sessionId;
    renderSessions();
    const session = state.program.sessions.find((s) => s.id === sessionId);
    const box = $("#exercises");
    box.textContent = "";
    const date = $("#date").value || today();
    for (const ex of L.exercisesFor(session, state.settings.variant)) {
      const last = L.lastPerformance(state.liftRecords, sessionId, ex.id, date);
      const plan = L.suggest(ex, last);
      const fromDraft = draft && draft.entries && draft.entries[ex.id];
      const sets = fromDraft || plan.sets.map((p) => ({ weight: p.weight, reps: null, rir: null }));
      const list = h("div", { class: "sets" });
      sets.forEach((s, i) => list.append(setRow(s, i, plan.sets[i] || plan.sets[plan.sets.length - 1])));
      box.append(
        h("section", { class: "exercise", "data-exercise": ex.id }, [
          h("header", {}, [
            h("h3", { text: ex.name }),
            h("span", { class: "target", text: ex.reps[0] + "–" + ex.reps[1] }),
          ]),
          ex.note ? h("p", { class: "note", text: ex.note }) : null,
          h("p", { class: "hint", text: plan.hint }),
          h("div", { class: "set head" }, [
            h("span", { text: "#" }),
            h("span", { text: "кг" }),
            h("span", { text: "повт" }),
            h("span", { text: "запас" }),
            h("span", {}),
          ]),
          list,
          h("button", {
            type: "button",
            class: "add",
            text: "+ подход",
            onclick: () => {
              const prev = $$(".set", list).pop();
              const w = prev ? $(".w", prev).value : "";
              list.append(setRow({ weight: w === "" ? null : w }, 0, plan.sets[plan.sets.length - 1]));
              renumber();
            },
          }),
        ]),
      );
    }
    $("#save-workout").hidden = false;
    setStatus("#workout-status", "");
  }

  function collectEntries() {
    return $$(".exercise").map((card) => ({
      exercise: card.dataset.exercise,
      sets: $$(".sets .set", card).map((row) => ({
        weight: $(".w", row).value,
        reps: $(".r", row).value,
        rir: $(".q", row).value,
      })),
    }));
  }

  function saveDraft() {
    if (!state.sessionId) return;
    const entries = {};
    for (const e of collectEntries()) entries[e.exercise] = e.sets;
    save(DRAFT_KEY, { date: $("#date").value, session: state.sessionId, entries });
  }

  async function submitWorkout() {
    const date = $("#date").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setStatus("#workout-status", "Укажи дату", "error");
    let records;
    try {
      records = L.buildLiftRecords(date, state.sessionId, collectEntries());
    } catch (err) {
      return setStatus("#workout-status", err.message, "error");
    }
    if (records.length === 0) return setStatus("#workout-status", "Нет заполненных подходов", "error");

    const btn = $("#save-workout");
    btn.disabled = true;
    setStatus("#workout-status", "Сохраняю…", "busy");
    try {
      const res = await commitMerge(
        PATHS.lifts,
        L.LIFTS_HEADER,
        records,
        L.liftKey,
        "chore(log): " + state.sessionId + " " + date,
        (n) => window.confirm("За " + date + " эта тренировка уже записана (" + n + " строк). Заменить?"),
      );
      if (res.cancelled) {
        setStatus("#workout-status", "Отменено", "");
      } else {
        state.liftRecords = L.parseCsv(res.text).records;
        save(DRAFT_KEY, null);
        setStatus("#workout-status", "Записано: " + records.length + " подходов", "ok");
      }
    } catch (err) {
      setStatus("#workout-status", err.message + ". Черновик сохранён на телефоне.", "error");
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- body panel ----------

  async function submitBody() {
    let record;
    try {
      record = L.buildBodyRecord({
        date: $("#b-date").value,
        weight: $("#b-weight").value,
        waist: $("#b-waist").value,
        sleep: $("#b-sleep").value,
        note: $("#b-note").value,
      });
    } catch (err) {
      return setStatus("#body-status", err.message, "error");
    }
    const btn = $("#save-body");
    btn.disabled = true;
    setStatus("#body-status", "Сохраняю…", "busy");
    try {
      const res = await commitMerge(
        PATHS.body,
        L.BODY_HEADER,
        [record],
        L.bodyKey,
        "chore(log): body " + record.date,
        () => window.confirm("За " + record.date + " уже есть запись. Заменить?"),
      );
      setStatus("#body-status", res.cancelled ? "Отменено" : "Записано", res.cancelled ? "" : "ok");
    } catch (err) {
      setStatus("#body-status", err.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- settings panel ----------

  function fillSettingsForm() {
    const s = state.settings;
    $("#s-owner").value = s.owner;
    $("#s-repo").value = s.repo;
    $("#s-branch").value = s.branch;
    $("#s-api").value = s.apiBase;
    $("#s-token").value = s.token;
  }

  async function saveSettings() {
    state.settings = {
      ...state.settings,
      owner: $("#s-owner").value.trim(),
      repo: $("#s-repo").value.trim(),
      branch: $("#s-branch").value.trim() || "main",
      apiBase: $("#s-api").value.trim() || DEFAULT_SETTINGS.apiBase,
      token: $("#s-token").value.trim(),
    };
    save(SETTINGS_KEY, state.settings);
    setStatus("#settings-status", "Проверяю доступ…", "busy");
    try {
      await loadData();
      setStatus("#settings-status", "Подключено", "ok");
    } catch (err) {
      setStatus("#settings-status", err.message, "error");
    }
  }

  // ---------- bootstrap ----------

  async function loadData() {
    const prog = await getFile(PATHS.program);
    state.program = JSON.parse(prog.text);
    const lifts = await getFile(PATHS.lifts);
    state.liftRecords = L.parseCsv(lifts.text).records;
    renderSessions();
    const draft = load(DRAFT_KEY);
    if (draft && draft.session && state.program.sessions.some((s) => s.id === draft.session)) {
      if (draft.date) $("#date").value = draft.date;
      selectSession(draft.session, draft);
      setStatus("#workout-status", "Восстановлен несохранённый черновик", "");
    }
  }

  function bind() {
    $$(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
    $$("#variant button").forEach((b) =>
      b.addEventListener("click", () => {
        state.settings.variant = Number(b.dataset.variant);
        save(SETTINGS_KEY, state.settings);
        renderVariant();
        const stillValid =
          state.program &&
          L.sessionsForVariant(state.program, state.settings.variant).some((s) => s.id === state.sessionId);
        if (state.sessionId && stillValid) selectSession(state.sessionId);
        else {
          state.sessionId = null;
          $("#exercises").textContent = "";
          $("#save-workout").hidden = true;
          renderSessions();
        }
      }),
    );
    $("#exercises").addEventListener("input", saveDraft);
    $("#date").addEventListener("change", () => {
      if (state.sessionId) selectSession(state.sessionId);
    });
    $("#save-workout").addEventListener("click", submitWorkout);
    $("#save-body").addEventListener("click", submitBody);
    $("#save-settings").addEventListener("click", saveSettings);
  }

  async function init() {
    state.settings = { ...DEFAULT_SETTINGS, ...(load(SETTINGS_KEY) || {}) };
    $("#date").value = today();
    $("#b-date").value = today();
    fillSettingsForm();
    renderVariant();
    bind();
    if (!configured()) {
      showTab("settings");
      setStatus("#settings-status", "Укажи репозиторий и токен", "");
      return;
    }
    showTab("workout");
    try {
      await loadData();
    } catch (err) {
      setStatus("#workout-status", "Не удалось загрузить данные: " + err.message, "error");
    }
  }

  // `ready` resolves once the first load finishes (used by tests).
  window.TrainApp = {
    ready: new Promise((resolve) => {
      const start = () => resolve(init());
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
      else start();
    }),
  };
})();
