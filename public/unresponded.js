(async function () {
  async function apiJson(url, options) {
    const res = await fetch(url, options || {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || ("HTTP " + res.status));
    }
    return data;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function loadUnrespondedAndRender() {
    const panel = document.getElementById("unresponded-panel");
    if (!panel) return; // パネルが無ければ何もしない

    const statusEl = document.getElementById("unresponded-status");
    const tbody = document.getElementById("unresponded-tbody");
    const filter = (document.getElementById("unresponded-filter")?.value ?? "")
      .trim()
      .toLowerCase();

    if (statusEl) statusEl.textContent = "読み込み中…";
    if (tbody) tbody.innerHTML = "";

    const data = await apiJson("/api/unresponded");
    let rows = data.rows || [];

    if (filter) {
rows = rows.filter((r) =>
  String(r.name ?? "").toLowerCase().includes(filter)
);
    }

    for (const r of rows) {
      const name = String(r.name ?? "").trim();
      const email = String(r.email ?? "").trim().toLowerCase();
      const currentSeat =
        r.table_no && r.pos ? `T${r.table_no} / ${r.pos}` : "—";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="border-bottom:1px solid #eee; padding:6px;">${escapeHtml(name)}</td>
        <td style="border-bottom:1px solid #eee; padding:6px;">${escapeHtml(currentSeat)}</td>
        <td style="border-bottom:1px solid #eee; padding:6px; white-space:nowrap;">
          <button data-act="assign" data-pos="左上" data-email="${escapeHtml(email)}" data-name="${escapeHtml(name)}">左上</button>
          <button data-act="assign" data-pos="右上" data-email="${escapeHtml(email)}" data-name="${escapeHtml(name)}">右上</button>
          <button data-act="assign" data-pos="左下" data-email="${escapeHtml(email)}" data-name="${escapeHtml(name)}">左下</button>
          <button data-act="assign" data-pos="右下" data-email="${escapeHtml(email)}" data-name="${escapeHtml(name)}">右下</button>
        </td>
<td style="border-bottom:1px solid #eee; padding:6px;">
  <button data-act="delete" data-email="${escapeHtml(email)}">削除</button>
</td>
        <td style="border-bottom:1px solid #eee; padding:6px;">
          <button data-act="clear" data-email="${escapeHtml(email)}">解除</button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    if (statusEl) statusEl.textContent = `件数: ${rows.length}`;
  }

  async function assignManualSeat(email, name, pos) {
    const tableNoStr = prompt("配置するテーブル番号（数字）", "1");
    if (!tableNoStr) return;

    const tableNo = Number(tableNoStr);
    if (!Number.isFinite(tableNo) || tableNo <= 0) {
      alert("テーブル番号が不正です");
      return;
    }

    await apiJson("/api/manual-seat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name, tableNo, pos }),
    });

    location.reload();
  }

  async function clearManualSeat(email) {
    if (!confirm(`${email} の手動席を解除しますか？`)) return;

    await apiJson(`/api/manual-seat?email=${encodeURIComponent(email)}`, {
      method: "DELETE",
    });

    location.reload();
  }

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  const act = btn.getAttribute("data-act");
  if (!act) return;

  try {
    if (act === "assign") {
      await assignManualSeat(
        btn.getAttribute("data-email"),
        btn.getAttribute("data-name"),
        btn.getAttribute("data-pos")
      );
      return;
    }

    if (act === "delete") {
      const email = btn.getAttribute("data-email");
      if (!confirm(`${email} を名簿から削除しますか？（元に戻せません）`)) return;

      await apiJson(`/api/participant?email=${encodeURIComponent(email)}`, {
        method: "DELETE",
      });

      // 一覧だけ更新
      await loadUnrespondedAndRender();
      return;
    }

    if (act === "clear") {
      await clearManualSeat(btn.getAttribute("data-email"));
      return;
    }
  } catch (err) {
    alert(err?.message || String(err));
  }
});

  document.getElementById("unresponded-reload")?.addEventListener("click", () => {
    loadUnrespondedAndRender().catch((err) => alert(err.message || String(err)));
  });
  document.getElementById("unresponded-filter")?.addEventListener("input", () => {
    loadUnrespondedAndRender().catch(() => {});
  });

document.getElementById("add-participant-btn")?.addEventListener("click", async () => {
  const nameEl = document.getElementById("new-participant-name");
  const statusEl = document.getElementById("add-participant-status");

  const name = (nameEl?.value ?? "").trim();

  if (!name) {
    alert("名前を入力してください");
    return;
  }

  try {
    statusEl.textContent = "登録中…";

    const res = await fetch("/api/participant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })   // ← email は送らない
    });

    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || "登録に失敗しました");
    }

    nameEl.value = "";
    statusEl.textContent = "登録しました";

    // 未入力者一覧を再読込
    if (typeof loadUnrespondedAndRender === "function") {
      loadUnrespondedAndRender();
    } else {
      location.reload();
    }
  } catch (err) {
    alert(err.message || String(err));
    statusEl.textContent = "";
  }
});


  loadUnrespondedAndRender().catch((err) => {
    const statusEl = document.getElementById("unresponded-status");
    if (statusEl) statusEl.textContent = "読み込み失敗: " + (err.message || String(err));
  });
})();
