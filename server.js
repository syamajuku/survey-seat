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
  fs.mkdirSync(path.dirname(QUESTIONS_PATH), { recursive: true });
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

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
  const merged = {
    published: typeof next.published === "boolean" ? next.published : cur.published,
    published_at: next.published === true ? new Date().toISOString() : (next.published === false ? null : cur.published_at)
  };
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

function buildTables(rows) {
  const blocks = assignSeats(rows);

  const tables = []; // [{tableNo, seats:[{pos,name,id,blockType,groupMembers}...]}]
  let tableNo = 1;
  let i = 0;

  const posName = ["左上", "右上", "左下", "右下"];

  while (i < blocks.length) {
    const b = blocks[i];

    if (b.type === "triad") {
      // triadは1テーブル（3名 + 空席1）
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

    // pairは2ブロックで1テーブル
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

  // 自分のidから、どのテーブルか逆引き
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
      blockType: block.type, // pair or triad
      // 同じペア/トライアドのメンバー（表示用）
      groupMembers: (block.members || []).map(x => ({ id: x.id, name: x.name }))
    };
  }
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]), "utf-8");
}

function loadResponses() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function saveResponses(rows) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2), "utf-8");
}

function boolize(v) {
  // Accept true/false, "Yes"/"No", "yes"/"no"
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

/**
 * Seat assignment logic
 * - Pair neighbors: [A][B] [C][D] ...
 * - Q3=No: pair "similar" on Q1/Q2 (min Hamming distance)
 * - Q3=Yes: pair "different" on Q1/Q2 (max Hamming distance, prefer at least 1 diff)
 * - Q4 used only for left/right swap: q4=false => talker => left, q4=true => listener => right (best-effort)
 * - If leftover person exists, attach to best pair (triad) based on compatibility score
 */
function hammingQ1Q2(a, b) {
  let d = 0;
  if (a.q1 !== b.q1) d++;
  if (a.q2 !== b.q2) d++;
  return d; // 0..2
}

function makePairsSimilar(list) {
  // Greedy: repeatedly pick a and best match with minimum distance
  const pool = [...list];
  const pairs = [];
  while (pool.length >= 2) {
    const a = pool.shift();
    let bestIdx = 0;
    let bestScore = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i];
      const d = hammingQ1Q2(a, b);
      if (d < bestScore) {
        bestScore = d;
        bestIdx = i;
      }
    }
    const b = pool.splice(bestIdx, 1)[0];
    pairs.push([a, b]);
  }
  return { pairs, leftover: pool[0] ?? null };
}

function makePairsDifferent(list) {
  // Greedy: pick a and best match with maximum distance
  const pool = [...list];
  const pairs = [];
  while (pool.length >= 2) {
    const a = pool.shift();
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i];
      const d = hammingQ1Q2(a, b);
      // Prefer d=2 > d=1 > d=0
      if (d > bestScore) {
        bestScore = d;
        bestIdx = i;
      }
    }
    const b = pool.splice(bestIdx, 1)[0];
    pairs.push([a, b]);
  }
  return { pairs, leftover: pool[0] ?? null };
}

function orderLeftRight(pair) {
  const [a, b] = pair;
  // Q4: true => listener => right; false => talker => left
  // If both same, keep order.
  if (a.q4 === false && b.q4 === true) return [a, b];
  if (a.q4 === true && b.q4 === false) return [b, a];
  return [a, b];
}

function pairCompatibility(pair, x) {
  // Higher is better
  // For Q3=No people, we value similarity; for Q3=Yes, value difference.
  // Here: try to keep "conversation depth" compatible using Q1/Q2 closeness and Q4 balance.
  const [a, b] = pair;
  const da = hammingQ1Q2(a, x);
  const db = hammingQ1Q2(b, x);
  // Prefer attaching where x is not too far from both (avoid friction): (2 - avgDist)
  const base = 2 - (da + db) / 2; // range ~0..2
  // Prefer Q4 mix in the triad (not all listeners or all talkers)
  const q4Vals = [a.q4, b.q4, x.q4];
  const numListeners = q4Vals.filter(v => v === true).length;
  const balanceBonus = (numListeners === 1 || numListeners === 2) ? 0.3 : 0;
  return base + balanceBonus;
}

function assignSeats(responses) {
  const rows = [...responses];

  const noQ3 = rows.filter(r => r.q3 === false);
  const yesQ3 = rows.filter(r => r.q3 === true);

  const pairs = [];

  // ① Q3=No（安心重視）同士でまずペア
  const used = new Set();

  function takePair(a, b) {
    used.add(a.id);
    used.add(b.id);
    pairs.push(orderLeftRight([a, b]));
  }

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

  // ② 残りをまとめる
  const remaining = rows.filter(r => !used.has(r.id));

  // ③ 残りを2人組で作り切る
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

  // ④ 1人だけ余った場合 → 1組だけ3人に
  if (remaining.length === 1 && pairs.length > 0) {
    pairs[0].push(remaining[0]); // 先頭の組に合流
  }

  return pairs.map(p => ({
    type: p.length === 3 ? "triad" : "pair",
    members: p
  }));
}

// --- API ---

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

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/responses", (req, res) => {
  const rows = loadResponses();
  res.json({ ok: true, count: rows.length, rows });
});

app.post("/api/responses", (req, res) => {
  const v = validatePayload(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

  const rows = loadResponses();
  const now = new Date().toISOString();
  const record = { id: cryptoRandomId(), created_at: now, ...v.value };

  // name duplicates allowed, but if you want to overwrite by same name, do it here.
  rows.push(record);
  saveResponses(rows);
  res.json({ ok: true, record });
});

app.post("/api/reset", (req, res) => {
  // Simple reset endpoint (protect with a password if needed)
  saveResponses([]);
  res.json({ ok: true });
});

app.get("/api/assignments", (req, res) => {
  const rows = loadResponses();
  const blocks = assignSeats(rows);

  // Provide CSV-friendly rows
  // SeatIndex increments across blocks, within block left-to-right
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
        q5: m.q5
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

// 自分の座席（参加者）
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
  const mySeat = table.seats.find(s => s.id === String(id));

  res.json({
    ok: true,
    published: true,
    tableNo,
    mySeat,
    tableSeats: table.seats
  });
});

app.post("/api/reset", (req, res) => {
  saveResponses([]);
  writeState({ published: false }); // ←これを追加
  res.json({ ok: true });
});

// --- static pages ---
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  ensureDataFile();
  console.log(`Survey running at http://localhost:${PORT}`);
  console.log(`Admin at http://localhost:${PORT}/admin`);
});

// --- helpers ---
function cryptoRandomId() {
  // Simple random id without extra deps
  return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}
