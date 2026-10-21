// Pure logic for the logging form: CSV handling, program lookups and
// progression suggestions. No DOM access here, so it runs in the browser
// (as a classic script exposing `TrainLogic`) and in Node tests (CommonJS).
(function (root) {
  "use strict";

  const LIFTS_HEADER = ["date", "session", "exercise", "set", "weight_kg", "reps", "rir"];
  const BODY_HEADER = ["date", "weight_kg", "waist_cm", "sleep_h", "note"];

  // ---------- CSV ----------

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += c;
      }
    }
    if (field !== "" || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ""));
    if (nonEmpty.length === 0) return { header: [], records: [] };
    const header = nonEmpty[0];
    const records = nonEmpty.slice(1).map((r) => {
      const obj = {};
      header.forEach((h, idx) => {
        obj[h] = r[idx] === undefined ? "" : r[idx];
      });
      return obj;
    });
    return { header, records };
  }

  function csvField(value) {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsvLine(values) {
    return values.map(csvField).join(",");
  }

  function serializeCsv(header, records) {
    const lines = [toCsvLine(header)];
    for (const r of records) lines.push(toCsvLine(header.map((h) => r[h])));
    return lines.join("\n") + "\n";
  }

  // Merge new records into existing CSV text. Existing records whose key
  // matches any new record are dropped (re-submitting a workout replaces it).
  function mergeCsv(text, header, newRecords, keyFn) {
    const parsed = parseCsv(text || "");
    if (parsed.header.length > 0 && parsed.header.join(",") !== header.join(",")) {
      throw new Error("Unexpected CSV header: " + parsed.header.join(","));
    }
    const newKeys = new Set(newRecords.map(keyFn));
    const kept = parsed.records.filter((r) => !newKeys.has(keyFn(r)));
    const replaced = parsed.records.length - kept.length;
    return { text: serializeCsv(header, kept.concat(newRecords)), replaced };
  }

  // ---------- base64 (UTF-8 safe) ----------

  function utf8ToB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64ToUtf8(b64) {
    const bin = atob(b64.replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ---------- program ----------

  function sessionsForVariant(program, variant) {
    return program.sessions.filter((s) => (s.variants || [3, 4]).includes(variant));
  }

  function exercisesFor(session, variant) {
    return session.exercises.filter((e) => (e.variants || [3, 4]).includes(variant));
  }

  // ---------- history ----------

  // Sets from the most recent date the exercise was done. Prefers the same
  // session (Legs A vs Legs B use different loads), falls back to any session.
  function lastPerformance(records, sessionId, exerciseId, beforeDate) {
    const pick = (sameSession) => {
      const rows = records.filter(
        (r) =>
          r.exercise === exerciseId &&
          (!sameSession || r.session === sessionId) &&
          (!beforeDate || r.date < beforeDate),
      );
      if (rows.length === 0) return null;
      const lastDate = rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date);
      const sets = rows
        .filter((r) => r.date === lastDate && (!sameSession || r.session === sessionId))
        .map((r) => ({
          set: Number(r.set),
          weight: Number(r.weight_kg),
          reps: Number(r.reps),
          rir: r.rir === "" || r.rir === undefined ? null : Number(r.rir),
        }))
        .sort((a, b) => a.set - b.set);
      return { date: lastDate, sets };
    };
    return pick(true) || pick(false);
  }

  // ---------- progression ----------

  function roundDown(weight, step) {
    return Math.floor(weight / step + 1e-9) * step;
  }

  function fmt(n) {
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  }

  function describe(last) {
    return last.sets
      .map((s) => fmt(s.weight) + "×" + s.reps + (s.rir === null ? "" : " (" + s.rir + ")"))
      .join(", ");
  }

  const ROLE_LABELS = { top: "Топ", backoff: "Доб" };

  function roleLabel(role) {
    return ROLE_LABELS[role] || null;
  }

  // Order of work for a top + back-off exercise, shown above its sets.
  function orderText(exercise) {
    if (exercise.scheme !== "top_backoff") return null;
    const bo = exercise.backoff;
    return (
      "Порядок: разминка (не записывать) → топ " +
      exercise.reps[0] + "–" + exercise.reps[1] +
      " → " + bo.sets + " добив. по " + Math.round(bo.pct * 100) + "%"
    );
  }

  // Returns planned sets [{weight, reps:[lo,hi], role}] and a short hint.
  // role is "top" | "backoff" for top_backoff exercises, null otherwise.
  // Double progression: reps first, then weight.
  function suggest(exercise, last) {
    const [lo, hi] = exercise.reps;
    const inc = exercise.increment_kg;

    if (exercise.scheme === "top_backoff") {
      const bo = exercise.backoff;
      const plan = (topWeight, backoffWeight) =>
        [{ weight: topWeight, reps: [lo, hi], role: "top" }].concat(
          Array.from({ length: bo.sets }, () => ({ weight: backoffWeight, reps: bo.reps, role: "backoff" })),
        );
      if (!last || last.sets.length === 0) {
        return { sets: plan(null, null), hint: "Первый раз: топ-подход с 2–3 в запасе" };
      }
      const top = last.sets.reduce((a, b) => (b.weight > a.weight ? b : a), last.sets[0]);
      const rirMin = exercise.rir_min === undefined ? 1 : exercise.rir_min;
      const earned = top.reps >= hi && (top.rir === null || top.rir >= rirMin);
      const topWeight = earned ? top.weight + inc : top.weight;
      const backoffWeight = roundDown(topWeight * bo.pct, 2.5);
      const hint = earned
        ? "Прошлый раз " + describe(last) + " → +" + fmt(inc) + " кг"
        : "Прошлый раз " + describe(last) + " → тот же вес, +1 повтор в топе";
      return { sets: plan(topWeight, backoffWeight), hint };
    }

    const n = exercise.sets;
    if (!last || last.sets.length === 0) {
      return {
        sets: Array.from({ length: n }, () => ({ weight: null, reps: [lo, hi], role: null })),
        hint: "Первый раз: вес на " + hi + " повторов с 2–3 в запасе",
      };
    }
    const allAtTop = last.sets.every((s) => s.reps >= hi);
    const lastRir = last.sets[last.sets.length - 1].rir;
    const base = Math.max(...last.sets.map((s) => s.weight));
    let next = base;
    let hint;
    if (allAtTop) {
      const step = lastRir !== null && lastRir >= 5 ? inc * 2 : inc;
      next = base + step;
      hint = "Прошлый раз " + describe(last) + " → +" + fmt(step) + " кг";
    } else {
      hint = "Прошлый раз " + describe(last) + " → тот же вес, добей " + hi + " во всех подходах";
    }
    return {
      sets: Array.from({ length: n }, () => ({ weight: next, reps: [lo, hi], role: null })),
      hint,
    };
  }

  // ---------- records from form input ----------

  // entries: [{exercise, sets:[{weight, reps, rir}]}]; empty sets are skipped.
  function buildLiftRecords(date, sessionId, entries) {
    const out = [];
    for (const e of entries) {
      let n = 0;
      for (const s of e.sets) {
        if (s.weight === "" || s.weight === null || s.reps === "" || s.reps === null) continue;
        const weight = Number(s.weight);
        const reps = Number(s.reps);
        if (!Number.isFinite(weight) || weight < 0) throw new Error(e.exercise + ": неверный вес");
        if (!Number.isInteger(reps) || reps <= 0) throw new Error(e.exercise + ": неверные повторы");
        let rir = "";
        if (s.rir !== "" && s.rir !== null && s.rir !== undefined) {
          rir = Number(s.rir);
          if (!Number.isInteger(rir) || rir < 0 || rir > 10) throw new Error(e.exercise + ": запас 0–10");
        }
        n += 1;
        out.push({
          date,
          session: sessionId,
          exercise: e.exercise,
          set: String(n),
          weight_kg: fmt(weight),
          reps: String(reps),
          rir: rir === "" ? "" : String(rir),
        });
      }
    }
    return out;
  }

  function liftKey(r) {
    return r.date + "|" + r.session;
  }

  function bodyKey(r) {
    return r.date;
  }

  function buildBodyRecord(input) {
    const num = (v, name, lo, hi, required) => {
      if (v === "" || v === null || v === undefined) {
        if (required) throw new Error(name + ": обязательное поле");
        return "";
      }
      const n = Number(String(v).replace(",", "."));
      if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(name + ": " + lo + "–" + hi);
      return fmt(n);
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date || "")) throw new Error("Дата: формат ГГГГ-ММ-ДД");
    return {
      date: input.date,
      weight_kg: num(input.weight, "Вес", 30, 200, true),
      waist_cm: num(input.waist, "Талия", 40, 150, false),
      sleep_h: num(input.sleep, "Сон", 0, 24, false),
      note: (input.note || "").trim(),
    };
  }

  const api = {
    LIFTS_HEADER,
    BODY_HEADER,
    parseCsv,
    toCsvLine,
    serializeCsv,
    mergeCsv,
    utf8ToB64,
    b64ToUtf8,
    sessionsForVariant,
    exercisesFor,
    lastPerformance,
    roundDown,
    suggest,
    roleLabel,
    orderText,
    buildLiftRecords,
    buildBodyRecord,
    liftKey,
    bodyKey,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TrainLogic = api;
})(typeof window !== "undefined" ? window : globalThis);
