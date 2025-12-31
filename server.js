import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));

/* =========================
   Paths
========================= */
const DATA_DIR = path.join(__dirname, "data");
const RESPONSES_PATH = path.join(DATA_DIR, "responses.json");
const QUESTIONS_PATH = path.join(DATA_DIR, "questions.json");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const PUBLIC_DIR = path.join(__dirname, "public");

/* =========================
   OpenAI
========================= */
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* =========================
   File helpers
========================= */
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}
function writeJSON(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
}

/* =========================
   Questions (Q1~Q5)
========================= */
function readQuestions() {
  // デフォルト（未設定でも画面が空にならない）
  const defaults = {
    q1: "Q1の質問文",
    q2: "Q2の質問文",
    q3: "Q3の質問文",
    q4: "Q4の質問文",
    q5: "Q5（自慢できること）を教えてください",
  };

  try {
    const raw = fs.readFileSync(QUESTIONS_PATH, "utf-8");
    const q = JSON.parse(raw);

    const merged = {
      q1: q.q1 ?? defaults.q1,
      q2: q.q2 ?? defaults.q2,
      q3: q.q3 ?? defaults.q3,
      q4: q.q4 ?? defaults.q4,
      q5: q.q5 ?? defaults.q5,
    };

    // ★q5が無かった場合は自動補完して保存（次回以降も安定）
    if (q.q5 === undefined) {
      writeQuestions(merged);
    }

    return merged;
  } catch (e) {
    // questions.json が無い/壊れている場合も、デフォルトを保存して返す
    writeQuestions(defaults);
    return defaults;
  }
}


function writeQuestions(q) {
  const next = {
    q1: String(q.q1 ?? ""),
    q2: String(q.q2 ?? ""),
    q3: String(q.q3 ?? ""),
    q4: String(q.q4 ?? ""),
    q5: String(q.q5 ?? ""),
  };
  writeJSON(QUESTIONS_PATH, next);
  return next;
}

/* =========================
   Publish state
========================= */
function readState() {
  const s = readJSON(STATE_PATH, {});
  return {
    published: !!s.published,
    published_at: s.published_at ?? null,
  };
}
function writeState(published) {
  const next = {
    published: !!published,
    published_at: published ? new Date().toISOString() : null,
  };
  writeJSON(STATE_PATH, next);
  return next;
}

/* =========================
   Validation helpers
========================= */
function boolize(v) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").toLowerCase().trim();
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
}
function validatePayload(p) {
  const name = String(p.name ?? "").trim();
  const q1 = boolize(p.q1);
  const q2 = boolize(p.q2);
  const q3 = boolize(p.q3);
  const q4 = boolize(p.q4);
  const q5 = String(p.q5 ?? "").trim();

  if (!name) return { ok: false, error: "名前を入力してください。" };
  if ([q1, q2, q3, q4].some(v => v === null))
    return { ok: false, error: "Q1〜Q4はYes/Noで回答してください。" };
  if (!q5) return { ok: false, error: "Q5を入力してください。" };

  return { ok: true, value: { name, q1, q2, q3, q4, q5 } };
}

/* =========================
   Q5 summary (AI + fallback)
========================= */
function summarizeFallback(text, maxLen = 5) {
  const s = String(text ?? "").replace(/\s+/g, "");
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}
async function summarizeAI(text, maxLen = 5) {
  if (!openai) throw new Error("OPENAI_API_KEY not set");
  const input = `次の文章を日本語で${maxLen}文字以内に要約。出力は要約文字列のみ。\n文章:${text}`;
  const r = await openai.responses.create({
    model: "gpt-4.1-mini",
    input,
    max_output_tokens: 40,
  });
  const out = String(r.output_text ?? "").replace(/\s+/g, "");
  return out.length <= maxLen ? out : out.slice(0, maxLen);
}

/* =========================
   Seat logic
========================= */
function hammingQ1Q2(a, b) {
  let d = 0;
  if (a.q1 !== b.q1) d++;
  if (a.q2 !== b.q2) d++;
  return d;
}
function orderLeftRight([a, b]) {
  if (a.q4 === false && b.q4 === true) return [a, b];
  if (a.q4 === true && b.q4 === false) return [b, a];
  return [a, b];
}
function assignSeats(rows) {
  const used = new Set();
  const pairs = [];
  const noQ3 = rows.filter(r => r.q3 === false);

  for (let i = 0; i < noQ3.length; i++) {
    const a = noQ3[i];
    if (used.has(a.id)) continue;
    let best = null, bestScore = Infinity;
    for (let j = i + 1; j < noQ3.length; j++) {
      const b = noQ3[j];
      if (used.has(b.id)) continue;
      const d = hammingQ1Q2(a, b);
      if (d < bestScore) { bestScore = d; best = b; }
    }
    if (best) {
      used.add(a.id); used.add(best.id);
      pairs.push(orderLeftRight([a, best]));
    }
  }

  const remaining = rows.filter(r => !used.has(r.id));
  while (remaining.length >= 2) {
    const a = remaining.shift();
    let bestIdx = 0, bestScore = -1;
    for (let i = 0; i < remaining.length; i++) {
      const d = hammingQ1Q2(a, remaining[i]);
      if (d > bestScore) { bestScore = d; bestIdx = i; }
    }
    const b = remaining.splice(bestIdx, 1)[0];
    pairs.push(orderLeftRight([a, b]));
  }
  if (remaining.length === 1 && pairs.length > 0) {
    pairs[0].push(remaining[0]);
  }
  return pairs.map(p => ({ type: p.length === 3 ? "triad" : "pair", members: p }));
}

/* =========================
   Build tables (4 seats)
========================= */
function buildTables(rows) {
  const blocks = assignSeats(rows);
  const tables = [];
  let tableNo = 1;
  let i = 0;

  while (i < blocks.length) {
    const b = blocks[i];
    if (b.type === "triad") {
      tables.push({
        tableNo,
        seats: [
          seat(b, 0, "左上"), seat(b, 1, "右上"),
          seat(b, 2, "左下"), { pos: "右下", empty: true }
        ]
      });
      tableNo++; i += 1; continue;
    }
    const top = blocks[i];
    const bottom = blocks[i + 1];
    tables.push({
      tableNo,
      seats: [
        seat(top, 0, "左上"), seat(top, 1, "右上"),
        seat(bottom, 0, "左下"), seat(bottom, 1, "右下"),
      ]
    });
    tableNo++; i += 2;
  }

  const idToTable = new Map();
  tables.forEach(t => t.seats.forEach(s => s.id && idToTable.set(s.id, t.tableNo)));
  return { tables, idToTable };

  function seat(block, idx, pos) {
    const m = block.members[idx];
    if (!m) return { pos, empty: true };
    return {
      pos, id: m.id, name: m.name,
      q5: m.q5_short ?? summarizeFallback(m.q5, 5),
      blockType: block.type
    };
  }
}

/* =========================
   API
========================= */
// 質問文取得
app.get("/api/questions", (req, res) => {
  res.json({ ok: true, questions: readQuestions() });
});

// 質問文更新（Q1〜Q5）
// 質問文 更新（運営用）★Q1〜Q5を確実に保存
app.post("/api/questions", (req, res) => {
  const { q1, q2, q3, q4, q5 } = req.body || {};

  // 空文字で上書き事故を避ける（未入力は既存値を維持）
  const cur = readQuestions();
  const next = {
    q1: String(q1 ?? cur.q1),
    q2: String(q2 ?? cur.q2),
    q3: String(q3 ?? cur.q3),
    q4: String(q4 ?? cur.q4),
    q5: String(q5 ?? cur.q5),
  };

  const saved = writeQuestions(next);
  res.json({ ok: true, questions: saved });
});

// 回答取得
app.get("/api/responses", (req, res) => {
  const rows = readJSON(RESPONSES_PATH, []);
  res.json({ ok: true, count: rows.length, rows });
});

// 回答登録（Q5をAIで5文字要約）
app.post("/api/responses", async (req, res) => {
  const v = validatePayload(req.body);
  if (!v.ok) return res.status(400).json(v);

  const rows = readJSON(RESPONSES_PATH, []);
  let q5_short = "";
  try { q5_short = await summarizeAI(v.value.q5, 5); }
  catch { q5_short = summarizeFallback(v.value.q5, 5); }

  const record = {
    id: Math.random().toString(16).slice(2),
    created_at: new Date().toISOString(),
    ...v.value,
    q5_short
  };
  rows.push(record);
  writeJSON(RESPONSES_PATH, rows);
  res.json({ ok: true, record });
});

// 座席割当（運営）
app.get("/api/assignments", (req, res) => {
  const rows = readJSON(RESPONSES_PATH, []);
  const blocks = assignSeats(rows);
  res.json({ ok: true, count: rows.length, blocks });
});

// 公開状態
app.get("/api/state", (req, res) => {
  res.json({ ok: true, ...readState() });
});
app.post("/api/publish", (req, res) => {
  res.json({ ok: true, ...writeState(true) });
});
app.post("/api/unpublish", (req, res) => {
  res.json({ ok: true, ...writeState(false) });
});

// 参加者：自分の席
app.get("/api/myseat", (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ ok: false });

  const state = readState();
  if (!state.published) return res.json({ ok: true, published: false });

  const rows = readJSON(RESPONSES_PATH, []);
  const { tables, idToTable } = buildTables(rows);
  const tableNo = idToTable.get(id);
  if (!tableNo) return res.status(404).json({ ok: false });

  const table = tables.find(t => t.tableNo === tableNo);
  const mySeat = table.seats.find(s => s.id === id);
  res.json({ ok: true, published: true, tableNo, mySeat, tableSeats: table.seats });
});

/* =========================
   Static & Start
========================= */
app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Survey running at http://localhost:${PORT}`);
});
