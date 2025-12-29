import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "responses.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const QUESTIONS_PATH = path.join(__dirname, "data", "questions.json");
const STATE_PATH = path.join(__dirname, "data", "state.json");

/* =========================
   File helpers
========================= */
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function ensureDataFile() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]), "utf-8");
}

function loadResponses() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveResponses(rows) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2), "utf-8");
}

/* =========================
   Questions (Q1~Q4)
========================= */
function readQuestions() {
  try {
    const raw = fs.readFileSync(QUESTIONS_PATH, "utf-8");
    const q = JSON.parse(raw);
    return {
      q1: q.q1 ?? "Q1の質問文",
      q2: q.q2 ?? "Q2の質問文",
      q3: q.q3 ?? "Q3の質問文",
      q4: q.q4 ?? "Q4の質問文",
    };
  } catch (e) {
    return { q1: "Q1の質問文", q2: "Q2の質問文", q3: "Q3の質問文", q4: "Q4の質問文" };
  }
}

function writeQuestions(q) {
  const next = {
    q1: String(q.q1 ?? ""),
    q2: String(q.q2 ?? ""),
    q3: String(q.q3 ?? ""),
    q4: String(q.q4 ?? ""),
  };
  ensureDir(path.dirname(QUESTIONS_PATH));
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

/* =========================
   Publish state
========================= */
function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const s = JSON.parse(raw);
    return { published: !!s.published, published_at: s.published_at ?? null };
  } catch (e) {
    return { published: false, published_at: null };
  }
}

function writeState(next) {
  const cur = readState();
  const published =
    typeof next.published === "boolean" ? next.published : cur.published;

  const merged = {
    published,
    published_at: published ? new Date().toISOString() : null,
  };

  ensureDir(path.dirname(STATE_PATH));
  fs.writeFileSync(STATE_PATH, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
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

  if (!name) return { ok: false, error: "名前（ニックネーム）を入力してください。" };
  if ([q1, q2, q3, q4].some(v => v === null)) return { ok: false, error: "Q1〜Q4はYes/Noで回答してください。" };
  if (!q5) return { ok: false, error: "Q5（自慢）を入力してください。" };

  return { ok: true, value: { name, q1, q2, q3, q4, q5 } };
}

/* =========================
   Seat assignment logic
========================= */
/**
 * Logic:
 * - Q3=No は「同じ傾向（Q1/Q2が近い）」同士でペアにしやすい
 * - Q3=Yes は「違い傾向（Q1/Q2が遠い）」同士でペアにしやすい
 * - ただし全体として必ず2人組に寄せ、余りが出たら1組だけ3人（triad）
 * - Q4: false(話し手)は左、true(聞き手)は右（できる範囲で入れ替え）
 */
function hammingQ1Q2(a, b) {
  let d = 0;
  if (a.q1 !== b.q1) d++;
  if (a.q2 !== b.q2) d++;
  return d; // 0..2
}

function orderLeftRight(pair) {
  const [a, b] = pair;
  // Q4: true => listener => right; false => talker => left
  if (a.q4 === false && b.q4 === true) return [a, b];
  if (a.q4 === true && b.q4 === false) return [b, a];
  return [a, b];
}

function assignSeats(responses) {
  const rows = [...responses];

  const noQ3 = rows.filter(r => r.q3 === false);
  const used = new Set();
  const pairs = [];

  function takePair(a, b) {
    used.add(a.id);
    used.add(b.id);
    pairs.push(orderLeftRight([a, b]));
  }

  // ① Q3=No 同士は「近い」者同士で先にペア化
  for (let i = 0; i < noQ3.length; i++) {
    const a = noQ3[i];
    if (used.has(a.id)) continue;

    let best = null;
    let bestScore = Infinity;

    for (let j = i + 1; j < noQ3.length; j++) {
      const b = noQ3[j];
      if (used.has(b.id)) continue;
      const d = hammingQ1Q2(a, b);
      if (d < bestScore) {
        bestScore = d;
        best = b;
      }
    }
    if (best) takePair(a, best);
  }

  // ② 残りをまとめる（Q3=Yesや未ペアのNo含む）
  const remaining = rows.filter(r => !used.has(r.id));

  // ③ 残りは「遠い」者同士で2人組を作り切る
  while (remaining.length >= 2) {
    const a = remaining.shift();
    let bestIdx = 0;
    let bestScore = -1;

    for (let i = 0; i < remaining.length; i++) {
      const b = remaining[i];
      const d = hammingQ1Q2(a, b);
      if (d > bestScore) {
        bestScore = d;
        bestIdx = i;
      }
    }
    const b = remaining.splice(bestIdx, 1)[0];
    pairs.push(orderLeftRight([a, b]));
  }

  // ④ 1人だけ余った場合 → 1組だけ3人に（先頭のペアに合流）
  if (remaining.length === 1 && pairs.length > 0) {
    pairs[0].push(remaining[0]);
  }

  return pairs.map(p => ({
    type: p.length === 3 ? "triad" : "pair",
    members: p
  }));
}

/* =========================
   Q5 summary (<=5 chars)
========================= */
function summarizeQ5(text, maxLen = 5) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  const compact = s.replace(/\s+/g, "");
  if (compact.length <= maxLen) return compact;
  return compact.slice(0, maxLen);
}

/* =========================
   Build tables for participant view
   - returns tables (each has 4 positions)
   - also idToTable map
========================= */
function buildTables(rows) {
  const blocks = assignSeats(rows);

  const tables = []; // [{tableNo, seats:[{pos,id,name,q5,blockType,empty}...]}]
  let tableNo = 1;
  let i = 0;

  while (i < blocks.length) {
    const b = blocks[i];

    if (b.type === "triad") {
      // triad: 1テーブル（3名+空席1）
      const seats = [
        seatObj(b, 0, "左上"),
        seatObj(b, 1, "右上"),
        seatObj(b, 2, "左下"),
        { pos: "右下", empty: true }
      ];
      tables.push({ tableNo, seats });
      tableNo++;
      i += 1;
      continue;
    }

    // pair: 2ブロックで1テーブル
    const top = blocks[i];
    const bottom = blocks[i + 1];

    const seats = [
      seatObj(top, 0, "左上"),
      seatObj(top, 1, "右上"),
      seatObj(bottom, 0, "左下"),
      seatObj(bottom, 1, "右下"),
    ];

    tables.push({ tableNo, seats });
    tableNo++;
    i += 2;
  }

  const idToTable = new Map();
  for (const t of tables) {
    for (const s of t.seats) {
      if (s && s.id) idToTable.set(s.id, t.tableNo);
    }
  }

  return { tables, idToTable };

  function seatObj(block, idx, pos) {
    if (!block || !Array.isArray(block.members) || !block.members[idx]) {
      return { pos, empty: true };
    }
    const m = block.members[idx];
    return {
      pos,
      id: m.id,
      name: m.name,
      q5: summarizeQ5(m.q5, 5), // 参加者表示用（5文字以内）
      blockType: block.type,
    };
  }
}

/* =========================
   API
========================= */

// 質問文 取得
app.get("/api/questions", (req, res) => {
  res.json({ ok: true, questions: readQuestions() });
});

// 質問文 更新（運営用）
app.post("/api/questions", (req, res) => {
  const { q1, q2, q3, q4 } = req.body || {};
  const saved = writeQuestions({ q1, q2, q3, q4 });
  res.json({ ok: true, questions: saved });
});

// ヘルス
app.get("/api/health", (req, res) => res.json({ ok: true }));

// 回答取得
app.get("/api/responses", (req, res) => {
  const rows = loadResponses();
  res.json({ ok: true, count: rows.length, rows });
});

// 回答登録
app.post("/api/responses", (req, res) => {
  const v = validatePayload(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

  const rows = loadResponses();
  const now = new Date().toISOString();
  const record = { id: cryptoRandomId(), created_at: now, ...v.value };

  rows.push(record);
  saveResponses(rows);

  res.json({ ok: true, record });
});

// リセット（回答全削除＋座席非公開に戻す）
app.post("/api/reset", (req, res) => {
  saveResponses([]);
  writeState({ published: false });
  res.json({ ok: true });
});

// 座席割り当て（運営用：blocks/seatRows を返す）
app.get("/api/assignments", (req, res) => {
  const rows = loadResponses();
  const blocks = assignSeats(rows);

  // CSV向け
  const seatRows = [];
  let seatIndex = 1;
  for (const block of blocks) {
    for (const m of block.members) {
      seatRows.push({
        seat: seatIndex++,
        blockType: block.type,
        name: m.name,
        q1: m.q1 ? "Yes" : "No",
        q2: m.q2 ? "Yes" : "No",
        q3: m.q3 ? "Yes" : "No",
        q4: m.q4 ? "Yes" : "No",
        q5: m.q5,
      });
    }
  }

  res.json({ ok: true, count: rows.length, blocks, seatRows });
});

// 公開状態 取得
app.get("/api/state", (req, res) => {
  res.json({ ok: true, ...readState() });
});

// 座席を公開（運営）
app.post("/api/publish", (req, res) => {
  const s = writeState({ published: true });
  res.json({ ok: true, ...s });
});

// 公開を解除（必要なら）
app.post("/api/unpublish", (req, res) => {
  const s = writeState({ published: false });
  res.json({ ok: true, ...s });
});

// 参加者：自分の席（公開後のみ）
app.get("/api/myseat", (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ ok: false, error: "id is required" });

  const state = readState();
  if (!state.published) {
    return res.json({ ok: true, published: false });
  }

  const rows = loadResponses();
  const { tables, idToTable } = buildTables(rows);

  const tableNo = idToTable.get(String(id));
  if (!tableNo) return res.status(404).json({ ok: false, published: true, error: "seat not found" });

  const table = tables.find(t => t.tableNo === tableNo);
  const mySeat = table?.seats?.find(s => s.id === String(id)) || null;

  res.json({
    ok: true,
    published: true,
    tableNo,
    mySeat,
    tableSeats: table?.seats || [],
  });
});

/* =========================
   Static pages
========================= */
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

/* =========================
   Start server
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  ensureDataFile();
  // stateファイルが無くてもOK（readStateがデフォルト返す）
  console.log(`Survey running at http://localhost:${PORT}`);
  console.log(`Admin at http://localhost:${PORT}/admin`);
});

/* =========================
   helpers
========================= */
function cryptoRandomId() {
  // 依存なしの簡易ID（十分）
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}
