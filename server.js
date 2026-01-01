// server.js (PostgreSQL 対応 完成版)
// - Render Postgres の DATABASE_URL を使用（process.env.DATABASE_URL）
// - questions / responses / publish state を全てDB永続化
// - 既存UI想定：/api/questions, /api/responses, /api/assignments, /api/publish, /api/myseat, /api/reset
// - Q5要約：OPENAI_API_KEY があればAI要約、無ければフォールバック
// - 運営で要約Q5を編集：POST /api/q5short

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";
import OpenAI from "openai";

const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();
app.use(express.json({ limit: "1mb" }));

/* =========================
   DB
========================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

async function initDb() {
  // 初回起動でも自動でテーブルが揃う（手動SQL不要）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      q1 BOOLEAN NOT NULL,
      q2 BOOLEAN NOT NULL,
      q3 BOOLEAN NOT NULL,
      q4 BOOLEAN NOT NULL,
      q5 TEXT NOT NULL,
      q5_short TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS questions (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // published が未設定なら false で作る
  await pool.query(`
    INSERT INTO state(key, value)
    VALUES ('published', 'false')
    ON CONFLICT (key) DO NOTHING
  `);

  // questions が空ならデフォルト投入
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM questions`);
  if ((rows?.[0]?.n ?? 0) === 0) {
    const defaults = defaultQuestions();
    await writeQuestions(defaults);
  }
}

function defaultQuestions() {
  return {
    q1: "自分から話題を出して会話をリードすることが好き",
    q2: "会話では、過去の話よりも未来の夢の話をする方が好き",
    q3: "今日は、価値観や考え方が違う人と話してみたい",
    q4: "会話では、聞き役になることが多い",
    q5: "自慢できること（短く）を書いてください",
  };
}

/* =========================
   Helpers
========================= */
function cryptoRandomId() {
  return (
    Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
  );
}

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
  if ([q1, q2, q3, q4].some((v) => v === null))
    return { ok: false, error: "Q1〜Q4はYes/Noで回答してください。" };
  if (!q5) return { ok: false, error: "Q5（自慢）を入力してください。" };

  return { ok: true, value: { name, q1, q2, q3, q4, q5 } };
}

function summarizeFallback(text, maxLen = 5) {
  const s = String(text ?? "").replace(/\s+/g, "");
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

async function summarizeByAI(text, maxLen = 5) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return summarizeFallback(text, maxLen);

  const openai = new OpenAI({ apiKey });

  // ※ 長文でも maxLen 以内へ。失敗時はフォールバック。
  try {
    const input = `次の文章を日本語で${maxLen}文字以内に要約。出力は要約文字列のみ。\n文章:${text}`;
    const r = await openai.responses.create({
      model: "gpt-4.1-mini",
      input,
      max_output_tokens: 40,
    });
    const out = String(r.output_text ?? "").replace(/\s+/g, "");
    return out.length <= maxLen ? out : out.slice(0, maxLen);
  } catch {
    return summarizeFallback(text, maxLen);
  }
}

/* =========================
   DB accessors
========================= */
async function readQuestions() {
  const { rows } = await pool.query(`SELECT key, value FROM questions`);
  const map = {};
  for (const r of rows) map[r.key] = r.value;

  const d = defaultQuestions();
  return {
    q1: map.q1 ?? d.q1,
    q2: map.q2 ?? d.q2,
    q3: map.q3 ?? d.q3,
    q4: map.q4 ?? d.q4,
    q5: map.q5 ?? d.q5,
  };
}

async function writeQuestions(q) {
  const next = {
    q1: String(q.q1 ?? ""),
    q2: String(q.q2 ?? ""),
    q3: String(q.q3 ?? ""),
    q4: String(q.q4 ?? ""),
    q5: String(q.q5 ?? ""),
  };

  // 空文字防止（未入力ならデフォルトに戻す）
  const d = defaultQuestions();
  for (const k of ["q1", "q2", "q3", "q4", "q5"]) {
    if (!next[k] || !next[k].trim()) next[k] = d[k];
  }

  for (const [key, value] of Object.entries(next)) {
    await pool.query(
      `
      INSERT INTO questions(key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `,
      [key, value]
    );
  }
  return next;
}

async function readState() {
  const { rows } = await pool.query(
    `SELECT value FROM state WHERE key='published' LIMIT 1`
  );
  const published = rows?.[0]?.value === "true";
  return { published };
}

async function setPublished(published) {
  await pool.query(
    `
    INSERT INTO state(key, value)
    VALUES ('published', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `,
    [published ? "true" : "false"]
  );
  return { published };
}

async function loadResponses() {
  const { rows } = await pool.query(
    `SELECT id, name, q1, q2, q3, q4, q5, q5_short, created_at
     FROM responses
     ORDER BY created_at ASC`
  );
  return rows;
}

async function insertResponse(record) {
  await pool.query(
    `
    INSERT INTO responses(id, name, q1, q2, q3, q4, q5, q5_short, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `,
    [
      record.id,
      record.name,
      record.q1,
      record.q2,
      record.q3,
      record.q4,
      record.q5,
      record.q5_short,
      record.created_at,
    ]
  );
}

async function resetResponses() {
  await pool.query(`TRUNCATE TABLE responses`);
}

async function updateQ5Short(id, q5_short) {
  const short = String(q5_short ?? "").trim();
  await pool.query(
    `UPDATE responses SET q5_short = $1 WHERE id = $2`,
    [short, String(id)]
  );
}

/* =========================
   Seat logic
========================= */
function hammingQ1Q2(a, b) {
  let d = 0;
  if (a.q1 !== b.q1) d++;
  if (a.q2 !== b.q2) d++;
  return d; // 0..2
}

function orderLeftRight([a, b]) {
  // Q4: true => listener => right; false => talker => left
  if (a.q4 === false && b.q4 === true) return [a, b];
  if (a.q4 === true && b.q4 === false) return [b, a];
  return [a, b];
}

// 2人組を基本。1人余りが出る場合のみ1組だけ3人(triad)
function assignSeats(rows) {
  const used = new Set();
  const pairs = [];

  const noQ3 = rows.filter((r) => r.q3 === false);

  // ① Q3=No 同士は「似ている」優先（最小距離）
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

    if (best) {
      used.add(a.id);
      used.add(best.id);
      pairs.push(orderLeftRight([a, best]));
    }
  }

  // ② 残り（主に Q3=Yes 含む）を「違い」優先（最大距離）
  const remaining = rows.filter((r) => !used.has(r.id));
  while (remaining.length >= 2) {
    const a = remaining.shift();
    let bestIdx = 0;
    let bestScore = -1;

    for (let i = 0; i < remaining.length; i++) {
      const d = hammingQ1Q2(a, remaining[i]);
      if (d > bestScore) {
        bestScore = d;
        bestIdx = i;
      }
    }

    const b = remaining.splice(bestIdx, 1)[0];
    pairs.push(orderLeftRight([a, b]));
  }

  // ③ 1人余り → 1組だけ3人
  if (remaining.length === 1 && pairs.length > 0) {
    pairs[0].push(remaining[0]);
  }

  return pairs.map((p) => ({
    type: p.length === 3 ? "triad" : "pair",
    members: p,
  }));
}

// 4人がけテーブル化：ペア2組で1テーブル、triadは1テーブルに3席＋空席
function buildTables(rows) {
  const blocks = assignSeats(rows);

  // ★追加：回答が1名などで blocks が空になる場合でもテーブルを作る
  if (rows.length > 0 && blocks.length === 0) {
    const m = rows[0];
    const one = {
      tableNo: 1,
      seats: [
        {
          pos: "左上",
          id: m.id,
          name: m.name,
          q5: m.q5_short ?? summarizeFallback(m.q5, 5),
          blockType: "solo",
        },
        { pos: "右上", empty: true },
        { pos: "左下", empty: true },
        { pos: "右下", empty: true },
      ],
    };

    const idToTable = new Map([[String(m.id), 1]]);
    return { tables: [one], idToTable, blocks: [] };
  }


  function seat(block, idx, pos) {
    const m = block.members[idx];
    if (!m) return { pos, empty: true };
    return {
      pos,
      id: m.id,
      name: m.name,
      q5: m.q5_short ?? summarizeFallback(m.q5, 5),
      blockType: block.type,
    };
  }

  const tables = [];
  let tableNo = 1;
  let i = 0;

  while (i < blocks.length) {
    const b = blocks[i];

    if (b.type === "triad") {
      tables.push({
        tableNo,
        seats: [seat(b, 0, "左上"), seat(b, 1, "右上"), seat(b, 2, "左下"), { pos: "右下", empty: true }],
      });
      tableNo++;
      i++;
      continue;
    }

    // pair
    const next = blocks[i + 1];
    if (next && next.type === "pair") {
      tables.push({
        tableNo,
        seats: [seat(b, 0, "左上"), seat(b, 1, "右上"), seat(next, 0, "左下"), seat(next, 1, "右下")],
      });
      tableNo++;
      i += 2;
      continue;
    }

    // pairのみ残った場合（片側空席）
    tables.push({
      tableNo,
      seats: [seat(b, 0, "左上"), seat(b, 1, "右上"), { pos: "左下", empty: true }, { pos: "右下", empty: true }],
    });
    tableNo++;
    i++;
  }

  const idToTable = new Map();
  for (const t of tables) {
    for (const s of t.seats) {
      if (s && !s.empty && s.id) idToTable.set(String(s.id), t.tableNo);
    }
  }
  return { tables, idToTable, blocks };
}

/* =========================
   API
========================= */

// 質問文 取得
app.get("/api/questions", async (req, res) => {
  const questions = await readQuestions();
  res.json({ ok: true, questions });
});

// 質問文 更新（運営）
app.post("/api/questions", async (req, res) => {
  const saved = await writeQuestions(req.body || {});
  res.json({ ok: true, questions: saved });
});

// 回答一覧
app.get("/api/responses", async (req, res) => {
  const rows = await loadResponses();
  res.json({ ok: true, count: rows.length, rows });
});

// 回答登録（参加者）
app.post("/api/responses", async (req, res) => {
  const v = validatePayload(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

  const now = new Date().toISOString();
  const q5_short = await summarizeByAI(v.value.q5, 5);

  const record = {
    id: cryptoRandomId(),
    created_at: now,
    q5_short,
    ...v.value,
  };

  await insertResponse(record);
  res.json({ ok: true, record });
});

// 要約Q5を運営が編集
app.post("/api/q5short", async (req, res) => {
  const id = String(req.body?.id ?? "");
  const q5_short = String(req.body?.q5_short ?? "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "id is required" });

  await updateQ5Short(id, q5_short);
  res.json({ ok: true });
});

// 座席割り当て（運営）
app.get("/api/assignments", async (req, res) => {
  const rows = await loadResponses();
  const { blocks, tables } = buildTables(rows);

  // CSV向け（任意）
  const seatRows = [];
  let seatIndex = 1;
  for (const t of tables) {
    for (const s of t.seats) {
      if (s.empty) {
        seatRows.push({
          seat: seatIndex++,
          tableNo: t.tableNo,
          pos: s.pos,
          empty: true,
        });
      } else {
        const m = rows.find((r) => String(r.id) === String(s.id));
        seatRows.push({
          seat: seatIndex++,
          tableNo: t.tableNo,
          pos: s.pos,
          name: s.name,
          q1: m?.q1 ? "Yes" : "No",
          q2: m?.q2 ? "Yes" : "No",
          q3: m?.q3 ? "Yes" : "No",
          q4: m?.q4 ? "Yes" : "No",
          q5: m?.q5 ?? "",
          q5_short: m?.q5_short ?? summarizeFallback(m?.q5 ?? "", 5),
        });
      }
    }
  }

  res.json({ ok: true, count: rows.length, blocks, tables, seatRows });
});

// 座席公開（運営）
app.post("/api/publish", async (req, res) => {
  const publish = Boolean(req.body?.publish);
  const st = await setPublished(publish);
  res.json({ ok: true, ...st });
});

// 自分の席（参加者）
// published=false の間は published:false を返す
app.get("/api/myseat", async (req, res) => {
  const st = await readState();
  if (!st.published) return res.json({ ok: true, published: false });

  const id = String(req.query.id ?? "").trim();
  const name = String(req.query.name ?? "").trim();

  if (!id && !name) {
    return res.status(400).json({ ok: false, error: "id or name is required" });
  }

  const rows = await loadResponses();

  // id優先。無ければ name で最新を救済（イベント運用での事故対策）
  let targetId = id;

  if (!rows.some((r) => String(r.id) === targetId) && name) {
    const same = rows
      .filter((r) => String(r.name ?? "").trim() === name)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    if (same.length > 0) targetId = String(same[0].id);
  }

  const { tables, idToTable } = buildTables(rows);
  const tableNo = idToTable.get(String(targetId));

  if (!tableNo) {
    // 404にせず found:false（参加者UIで案内しやすい）
    return res.json({ ok: true, published: true, found: false });
  }

  const table = tables.find((t) => t.tableNo === tableNo);
  const mySeat = table.seats.find((s) => !s.empty && String(s.id) === String(targetId));

  res.json({
    ok: true,
    published: true,
    found: true,
    tableNo,
    mySeat,
    tableSeats: table.seats,
    resolvedId: targetId,
  });
});

// 全回答リセット（運営）
app.post("/api/reset", async (req, res) => {
  await resetResponses();
  // 必要なら公開も解除
  await setPublished(false);
  res.json({ ok: true });
});

// ヘルスチェック
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false });
  }
});

/* =========================
   Static & Start
========================= */
app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Survey running at http://localhost:${PORT}`);
      console.log(`Admin at http://localhost:${PORT}/admin`);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
