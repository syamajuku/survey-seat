// server.js (PostgreSQL 対応 完成版)
// - Render Postgres の DATABASE_URL を使用（process.env.DATABASE_URL）
// - questions / responses / publish state を全てDB永続化
// - 既存UI想定：/api/questions, /api/responses, /api/assignments, /api/publish, /api/myseat, /api/reset
// - Q5要約：OPENAI_API_KEY があればAI要約、無ければフォールバック
// - 運営で要約Q5を編集：POST /api/q5short
// - ★追加：email を入力してもらい、同一 email は同一人物として UPSERT で更新する

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";
import OpenAI from "openai";
import crypto from "crypto";


const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();
app.use(express.json({ limit: "1mb" }));

function getEventId(req) {
  // どこから来ても拾えるように：query > header > body
  const q = req.query?.event_id || req.query?.eventId;
  const h = req.headers["x-event-id"];
  const b = req.body?.event_id || req.body?.eventId;

  const raw = String(q || h || b || "default").trim();
  // 事故防止：記号をある程度制限（必要なら緩めてOK）
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(raw)) return "default";
  return raw;
}

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

function defaultQuestions() {
  return {
    q1: "自分から話題を出して会話をリードすることが好き",
    q2: "会話では、過去の話よりも未来の夢の話をする方が好き",
    q3: "今日は、価値観や考え方が違う人と話してみたい",
    q4: "会話では、聞き役になることが多い",
    q5: "自慢できること（短く）を書いてください",
  };
}

async function initDb() {
  // 回答テーブル（既存）
  await pool.query(`
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  q1 BOOLEAN NOT NULL,
  q2 BOOLEAN NOT NULL,
  q3 BOOLEAN NOT NULL,
  q4 BOOLEAN NOT NULL,
  q5 TEXT NOT NULL,
  q5_short TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  is_absent BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT responses_event_email_unique UNIQUE (event_id, email)
);
  `);


  // 参加者マスタ（未入力者含む）
  await pool.query(`
CREATE TABLE IF NOT EXISTS participants (
   event_id TEXT NOT NULL DEFAULT 'default',
   email TEXT NOT NULL,
   name TEXT NOT NULL,
   created_at TIMESTAMPTZ DEFAULT now()
  ,PRIMARY KEY (event_id, email)
);
  `);

  // 管理者による手動座席指定
  await pool.query(`
CREATE TABLE IF NOT EXISTS manual_seats (
  event_id TEXT NOT NULL DEFAULT 'default',
  email TEXT NOT NULL,
   table_no INTEGER NOT NULL,
   pos TEXT NOT NULL,
   created_at TIMESTAMPTZ DEFAULT now()
  ,PRIMARY KEY (event_id, email)
);
  `);

  // 公開状態（published）を保存する state
  await pool.query(`
CREATE TABLE IF NOT EXISTS state (
  event_id TEXT NOT NULL DEFAULT 'default',
  key TEXT NOT NULL,
   value TEXT NOT NULL
  ,PRIMARY KEY (event_id, key)
);
  `);

  // 質問文を保存する questions
  await pool.query(`
CREATE TABLE IF NOT EXISTS questions (
  event_id TEXT NOT NULL DEFAULT 'default',
  key TEXT NOT NULL,
   value TEXT NOT NULL
  ,PRIMARY KEY (event_id, key)
);
  `);

  // published が未設定なら false で作る（defaultイベント）
  await pool.query(`
    INSERT INTO state(event_id, key, value)
    VALUES ('default', 'published', 'false')
    ON CONFLICT (event_id, key) DO NOTHING;
  `);

  // questions が空ならデフォルト投入（defaultイベント）
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM questions WHERE event_id='default'`
  );
  if ((rows?.[0]?.n ?? 0) === 0) {
    const defaults = defaultQuestions();
    await writeQuestions("default", defaults);
  }
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
  const emailRaw = String(p.email ?? "").trim();              // ★追加
  const email = emailRaw ? emailRaw.toLowerCase() : "";       // ★追加（同一判定を安定化）

  const q1 = boolize(p.q1);
  const q2 = boolize(p.q2);
  const q3 = boolize(p.q3);
  const q4 = boolize(p.q4);
  const q5 = String(p.q5 ?? "").trim();

  if (!name) return { ok: false, error: "名前（ニックネーム）を入力してください。" };

  // ★追加：email必須（同一人物判定のキー）
  if (!email) return { ok: false, error: "メールアドレスを入力してください。" };
  // 厳密すぎない最低限の形式チェック
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return { ok: false, error: "メールアドレスの形式が正しくありません。" };

  if ([q1, q2, q3, q4].some((v) => v === null))
    return { ok: false, error: "Q1〜Q4はYes/Noで回答してください。" };
  if (!q5) return { ok: false, error: "Q5（自慢）を入力してください。" };

  return { ok: true, value: { name, email, q1, q2, q3, q4, q5 } }; // ★emailを含める
}

function summarizeFallback(text, maxLen = 5) {
  const s = String(text ?? "").replace(/\s+/g, "");
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

async function summarizeByAI(text, maxLen = 5) {
  const original = String(text ?? "").trim();

  // ★追加：5文字以内ならAI要約せず、そのまま返す
  if (original.length <= maxLen) return original;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return summarizeFallback(original, maxLen);

  const openai = new OpenAI({ apiKey });

  // ※ 長文でも maxLen 以内へ。失敗時はフォールバック。
  try {
    const input = `次の文章を日本語で${maxLen}文字以内に要約。出力は要約文字列のみ。\n文章:${original}`;
    const r = await openai.responses.create({
      model: "gpt-4.1-mini",
      input,
      max_output_tokens: 40,
    });
    const out = String(r.output_text ?? "").replace(/\s+/g, "");
    return out.length <= maxLen ? out : out.slice(0, maxLen);
  } catch {
    return summarizeFallback(original, maxLen);
  }
}

/* =========================
   DB accessors
========================= */
async function readQuestions(eventId) {
  const { rows } = await pool.query(
    `SELECT key, value FROM questions WHERE event_id = $1`,
    [eventId]
  );

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

async function writeQuestions(eventId, q) {
  const next = {
    q1: String(q.q1 ?? ""),
    q2: String(q.q2 ?? ""),
    q3: String(q.q3 ?? ""),
    q4: String(q.q4 ?? ""),
    q5: String(q.q5 ?? ""),
  };

  const d = defaultQuestions();
  for (const k of ["q1", "q2", "q3", "q4", "q5"]) {
    if (!next[k] || !next[k].trim()) next[k] = d[k];
  }

  for (const [key, value] of Object.entries(next)) {
    await pool.query(
      `
      INSERT INTO questions(event_id, key, value)
      VALUES ($1, $2, $3)
      ON CONFLICT (event_id, key) DO UPDATE SET value = EXCLUDED.value
      `,
      [eventId, key, value]
    );
  }
  return next;
}

async function readState(eventId) {
  const { rows } = await pool.query(
    `SELECT value FROM state WHERE event_id = $1 AND key='published' LIMIT 1`,
    [eventId]
  );
  const published = rows?.[0]?.value === "true";
  return { published };
}

async function setPublished(eventId, published) {
  await pool.query(
    `
    INSERT INTO state(event_id, key, value)
    VALUES ($1, 'published', $2)
    ON CONFLICT (event_id, key) DO UPDATE SET value = EXCLUDED.value
    `,
    [eventId, published ? "true" : "false"]
  );
  return { published };
}

async function loadParticipants(eventId) {
  const { rows } = await pool.query(
    `SELECT email, name, created_at
     FROM participants
     WHERE event_id = $1
     ORDER BY created_at ASC`,
    [eventId]
  );
  return rows;
}

async function loadUnresponded(eventId) {
  const { rows } = await pool.query(
    `
    SELECT
      p.email,
      p.name,
      p.created_at,
      ms.table_no,
      ms.pos
    FROM participants p
    LEFT JOIN responses r
      ON r.event_id = p.event_id AND r.email = p.email
    LEFT JOIN manual_seats ms
      ON ms.event_id = p.event_id AND ms.email = p.email
    WHERE p.event_id = $1
      AND r.email IS NULL
    ORDER BY p.created_at ASC
    `,
    [eventId]
  );
  return rows;
}

async function upsertParticipantOnly(eventId, { email, name }) {
  await pool.query(
    `
    INSERT INTO participants(event_id, email, name, created_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (event_id, email) DO UPDATE
      SET name = EXCLUDED.name
    `,
    [eventId, String(email).toLowerCase(), String(name).trim()]
  );
}


async function deleteSeatOverrideByEmail(eventId, email) {
  await pool.query(
    `DELETE FROM manual_seats WHERE event_id = $1 AND email = $2`,
    [eventId, String(email).toLowerCase()]
  );
}

async function deleteParticipantByEmail(eventId, email) {
  await pool.query(
    `DELETE FROM participants WHERE event_id = $1 AND email = $2`,
    [eventId, String(email).toLowerCase()]
  );
}

async function loadSeatOverrides(eventId) {
  const { rows } = await pool.query(
    `SELECT email, table_no, pos
     FROM manual_seats
     WHERE event_id = $1`,
    [eventId]
  );
  return rows;
}

async function upsertParticipant(eventId, { email, name }) {
  await pool.query(
    `
    INSERT INTO participants(event_id, email, name)
    VALUES ($1, $2, $3)
    ON CONFLICT (event_id, email) DO UPDATE
      SET name = EXCLUDED.name
    `,
    [eventId, String(email).toLowerCase(), String(name).trim()]
  );
}


function normalizeManualBase(name) {
  // 既存仕様に合わせて：lower + 空白→_
  const base = String(name ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  return base || "guest";
}

// 同名でも上書きされないように、eventId 内で衝突しない manual email を採番して作る
async function createParticipantWithUniqueEmail(eventId, name) {
  const base = normalizeManualBase(name);

  for (let i = 1; i <= 999; i++) {
    const suffix = i === 1 ? "" : `-${i}`;
    const email = `manual-${base}${suffix}@local`;

    // 衝突したら DO NOTHING → rowCount=0 なので次へ
    const r = await pool.query(
      `
      INSERT INTO participants(event_id, email, name, created_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (event_id, email) DO NOTHING
      RETURNING email
      `,
      [String(eventId), String(email).toLowerCase(), String(name).trim()]
    );

    if (r.rowCount === 1) return r.rows[0].email;
  }

  throw new Error("email_allocation_failed");
}

async function upsertSeatOverride(eventId, { email, tableNo, pos }) {
  await pool.query(
    `
    INSERT INTO manual_seats(event_id, email, table_no, pos, created_at)
    VALUES ($1, $2, $3, $4, now())
    ON CONFLICT (event_id, email) DO UPDATE
      SET table_no = EXCLUDED.table_no,
          pos = EXCLUDED.pos,
          created_at = now()
    `,
    [eventId, String(email).toLowerCase(), Number(tableNo), String(pos)]
  );
}

async function loadResponses(eventId) {
  const { rows } = await pool.query(
    `SELECT id, email, name, q1, q2, q3, q4, q5, q5_short, is_absent, created_at
     FROM responses
     WHERE event_id = $1
     ORDER BY created_at ASC`,
    [eventId]
  );
  return rows;
}

// ★変更：email基準で UPSERT（同一メールは同一人物として更新）
async function upsertResponseByEmail(eventId, record) {
  const { rows } = await pool.query(
    `
    INSERT INTO responses(
      id, event_id, email, name,
      q1, q2, q3, q4, q5, q5_short, created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (event_id, email) DO UPDATE
      SET
        name = EXCLUDED.name,
        q1 = EXCLUDED.q1,
        q2 = EXCLUDED.q2,
        q3 = EXCLUDED.q3,
        q4 = EXCLUDED.q4,
        q5 = EXCLUDED.q5,
        q5_short = EXCLUDED.q5_short,
        created_at = EXCLUDED.created_at
    RETURNING id
    `,
    [
      record.id,
      eventId,          // ★event_id
      record.email,     // ★email
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
  return rows?.[0]?.id;
}

async function resetResponses(eventId) {
  await pool.query(`DELETE FROM responses WHERE event_id = $1`, [eventId]
  );
}

async function updateQ5Short(eventId, id, q5_short) {
  const short = String(q5_short ?? "").trim();
  const r = await pool.query(
    `UPDATE responses
        SET q5_short = $1
      WHERE event_id = $2
        AND id = $3`,
    [short, String(eventId), String(id)]
  );
  return r.rowCount;
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
        seats: [
          seat(b, 0, "左上"),
          seat(b, 1, "右上"),
          seat(b, 2, "左下"),
          { pos: "右下", empty: true },
        ],
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
        seats: [
          seat(b, 0, "左上"),
          seat(b, 1, "右上"),
          seat(next, 0, "左下"),
          seat(next, 1, "右下"),
        ],
      });
      tableNo++;
      i += 2;
      continue;
    }

    // pairのみ残った場合（片側空席）
    tables.push({
      tableNo,
      seats: [
        seat(b, 0, "左上"),
        seat(b, 1, "右上"),
        { pos: "左下", empty: true },
        { pos: "右下", empty: true },
      ],
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
  const eventId = getEventId(req);
  const questions = await readQuestions(eventId);
  res.json({ ok: true, eventId, questions });
});

app.post("/api/questions", async (req, res) => {
  const eventId = getEventId(req);
  const saved = await writeQuestions(eventId, req.body || {});
  res.json({ ok: true, eventId, questions: saved });
});

// 回答一覧
app.get("/api/responses", async (req, res) => {
  const eventId = getEventId(req);
  const rows = await loadResponses(eventId);
  res.json({ ok: true, eventId, count: rows.length, rows });
});

// 名簿だけ登録（未入力者）
app.post("/api/participant", async (req, res) => {
  const eventId = getEventId(req);
  const name = String(req.body?.name ?? "").trim();

  if (!name) {
    return res.status(400).json({ ok: false, error: "name is required" });
  }

  // ✅ 同名でも上書きしない：eventId 内で email を衝突回避しながら採番
  const email = await createParticipantWithUniqueEmail(eventId, name);

  res.json({ ok: true, eventId, email });
});


// 未入力者（participants）を削除（回答済みは削除不可）
app.delete("/api/participant", async (req, res) => {
  const eventId = getEventId(req);
  const email = String(req.query?.email ?? "").trim().toLowerCase();
  if (!email) return res.status(400).json({ ok: false, error: "email is required" });

  // 回答済みなら削除禁止（event_id で絞る）
  const r1 = await pool.query(
    `SELECT 1 FROM responses WHERE event_id = $1 AND email = $2 LIMIT 1`,
    [eventId, email]
  );
  if (r1.rowCount > 0) {
    return res.status(400).json({ ok: false, error: "回答済みのため削除できません" });
  }

  // 手動席があれば消す
  await deleteSeatOverrideByEmail(eventId, email);

  // participants を削除
  await deleteParticipantByEmail(eventId, email);

  res.json({ ok: true, eventId });
});


// 回答登録（参加者）
// ★変更：email基準 UPSERT
app.post("/api/responses", async (req, res) => {
  const eventId = getEventId(req);

  const st = await readState(eventId);
  if (st.published) {
    return res.status(403).json({
      ok: false,
      error: "座席が公開されたため、回答の入力はできません。",
    });
  }

  const v = validatePayload(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });

  const now = new Date().toISOString();
  const q5_short = summarizeFallback(v.value.q5, 5);

  const record = {
    id: cryptoRandomId(),
    created_at: now,
    q5_short,
    ...v.value,
  };

  const id = await upsertResponseByEmail(eventId, record);
  record.id = id || record.id;

  res.json({ ok: true, eventId, record });
});

// 不参加フラグ更新
app.patch("/api/responses/absent", async (req, res) => {
  try {
    const eventId = getEventId(req);
    const { id, is_absent } = req.body;

    if (!id || typeof is_absent !== "boolean") {
      return res.status(400).json({
        ok: false,
        error: "id and is_absent(boolean) are required",
      });
    }

    await pool.query(
      `
      UPDATE responses
         SET is_absent = $3
       WHERE event_id = $1
         AND id = $2
      `,
      [eventId, id, is_absent]
    );

    res.json({ ok: true, eventId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 要約Q5を運営が編集
app.post("/api/q5short", async (req, res) => {
  const eventId = getEventId(req);

  const id = String(req.body?.id ?? "");
  const q5_short = String(req.body?.q5_short ?? "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "id is required" });

  const n = await updateQ5Short(eventId, id, q5_short);
  if (n === 0) {
    return res.status(404).json({ ok: false, error: "not_found_in_this_event", eventId });
  }

  res.json({ ok: true, eventId });
});

app.post("/api/manual-seat", async (req, res) => {
  const eventId = getEventId(req);

  let email = String(req.body?.email ?? "").trim().toLowerCase();
  const name  = String(req.body?.name ?? "").trim();
  const tableNo = Number(req.body?.tableNo);
  const pos = String(req.body?.pos ?? "").trim();

  if (!email) email = `manual-${crypto.randomUUID()}@local`;
  if (/\s/.test(email) || !email.includes("@")) {
    return res.status(400).json({ ok:false, error:"email is invalid" });
  }
  if (!name) return res.status(400).json({ ok:false, error:"name is required" });
  if (!Number.isFinite(tableNo) || tableNo <= 0) {
    return res.status(400).json({ ok:false, error:"tableNo is invalid" });
  }
  if (!["左上","右上","左下","右下"].includes(pos)) {
    return res.status(400).json({ ok:false, error:"pos is invalid" });
  }

  await upsertParticipant(eventId, { email, name });
  await upsertSeatOverride(eventId, { email, tableNo, pos });

  res.json({ ok:true, eventId, email });
});

// 未回答者一覧（運営）
app.get("/api/unresponded", async (req, res) => {
  const eventId = getEventId(req);
  const rows = await loadUnresponded(eventId);
  res.json({ ok: true, eventId, count: rows.length, rows });
});


// 手動席の解除（運営）
app.delete("/api/manual-seat", async (req, res) => {
  const eventId = getEventId(req);
  const email = String(req.query?.email ?? "").trim().toLowerCase();

  if (!email || /\s/.test(email) || !email.includes("@")) {
    return res.status(400).json({ ok: false, error: "email is invalid" });
  }

  await deleteSeatOverrideByEmail(eventId, email);
  res.json({ ok: true, eventId });
});


// 座席割り当て（運営）
app.get("/api/assignments", async (req, res) => {
  const eventId = getEventId(req);

  const responses = await loadResponses(eventId);
  const participants = await loadParticipants(eventId);
  const overrides = await loadSeatOverrides(eventId);

  const activeResponses = responses.filter(r => r.is_absent !== true);
  const auto = buildTables(activeResponses);

  const tables = JSON.parse(JSON.stringify(auto.tables));
  const tableMap = new Map(tables.map(t => [t.tableNo, t]));

  // ② 手動座席を上書き（不参加は座席に入れない）
  for (const o of overrides) {
    const email = String(o.email).toLowerCase();
    const p = participants.find(x => x.email === email);
    const r = activeResponses.find(x => x.email === email); // ★ここ重要（responses→activeResponses）

    const t = tableMap.get(Number(o.table_no));
    if (!t) continue;

    const s = t.seats.find(x => x.pos === o.pos);
    if (!s) continue;

    s.empty = false;
    s.id = r?.id ?? `manual:${email}`;
    s.name = p?.name ?? r?.name ?? email;
    s.q5 = r?.q5_short ?? (r?.q5 ? summarizeFallback(r.q5, 5) : "未回答");
    s.blockType = "manual";
  }

  // ③ idToTable を再構築
  const idToTable = new Map();
  for (const t of tables) {
    for (const s of t.seats) {
      if (!s.empty) idToTable.set(String(s.id), t.tableNo);
    }
  }

  res.json({
    ok: true,
    count: responses.length,
    blocks: auto.blocks,
    tables,
  });
});

// 座席公開（運営）
app.post("/api/publish", async (req, res) => {
  const eventId = getEventId(req);
  const publish = Boolean(req.body?.publish);
  const st = await setPublished(eventId, publish);
  res.json({ ok: true, eventId, ...st });
});

app.get("/api/publish", async (req, res) => {
  const eventId = getEventId(req);
  const st = await readState(eventId);
  res.json({ ok: true, eventId, ...st });
});

// 自分の席（参加者）
// published=false の間は published:false を返す
app.get("/api/myseat", async (req, res) => {
  const eventId = getEventId(req);

  const st = await readState(eventId);
  if (!st.published) return res.json({ ok: true, eventId, published: false });

  const id = String(req.query.id ?? "").trim();
  const name = String(req.query.name ?? "").trim();
  if (!id && !name) {
    return res.status(400).json({ ok: false, error: "id or name is required" });
  }

  const rowsAll = await loadResponses(eventId);
  const rows = rowsAll.filter(r => r.is_absent !== true);

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
  const mySeat = table.seats.find(
    (s) => !s.empty && String(s.id) === String(targetId)
  );

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
  const eventId = getEventId(req);
  await resetResponses(eventId);
  await setPublished(eventId, false);
  res.json({ ok: true, eventId });
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
