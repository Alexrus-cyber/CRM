import {
  apiFetch,
  apiJson,
  consumeSseStream,
  esc,
  formatBytes,
  formatDateTime,
  formatTokens,
  readBrowserFileToAttachment,
  readClipboardImages,
  renderMarkdown,
  showToast,
  withHtQuery,
} from "/app.js";

const TOOL_PROFILES = [
  ["full", "Полный профиль (код, bash, файлы, браузер, QA)"],
  ["restricted", "Ограниченный профиль (без браузера)"],
];

export function mountAgentTab(root, ctx) {
  const bootState = ctx.getState();
  const profile = bootState.profile || {};
  const presets = bootState.presets || {};
  const reasoningModes = bootState.reasoningModes || [];
  const limits = profile.limits || {};

  const st = {
    subtab: "chat",
    agentHealth: bootState.agentHealth || { available: false, running: false, port: 8899, workspace: "" },
    conversations: [],
    activeConvId: 0,
    messages: [],
    pendingFiles: [],
    streaming: false,
    abortCtrl: null,
    approvals: [],

    testerConvs: [],
    activeTesterConvId: 0,
    testerMessages: [],
    testerStreaming: false,

    sandbox: { available: false, files: [], projects: [], processes: [] },
    sandboxProject: "",
    ragFolders: [],
    selectedRagId: 0,
    ragChunks: 8,
    ragFull: false,
    transcripts: [],
    github: { connected: false, repos: [], branches: [], owner: "", repo: "", branch: "main", enabled: false },

    settings: {
      baseUrl: bootState.localSettings?.baseUrl || "http://127.0.0.1:1234/v1",
      apiKey: "",
      model: bootState.localSettings?.model || "",
      maxSteps: 60,
      temperature: null,
      topP: null,
      maxTokens: null,
      reasoning: "default",
      contextLimit: 0,
      trustLevel: "verified",
      systemPrompt: "",
    },

    // Субагенты и Надсмотрщик
    subagentsData: {
      subagents: [],
      runs: [],
      conversations: [],
      routingMode: "linear",
      overseer: { enabled: true, mode: "strict", systemPrompt: "", unlockApi: false, baseUrl: "", model: "", hasApiKey: false, apiKeyHint: "" },
    },
    editingSubagentId: 0,
    selectedSubId: 0,
    activeSubConvId: 0,
    subMessages: [],
    subStreaming: false,
  };

  root.innerHTML = `
    <div class="col">
      <!-- Панель встроенного локального Агента -->
      <div class="card-sm">
        <div class="row-between">
          <div class="row">
            <span id="ag-status-badge" class="badge">
              <span class="dot ${st.agentHealth.available ? "dot-green" : "dot-gray"}"></span>
              Агент: ${st.agentHealth.available ? `готов (порт ${st.agentHealth.port})` : "остановлен (автозапуск при первом запросе)"}
            </span>
            <span class="muted mono" id="ag-workspace-label" style="font-size:11px;">Папка: ${esc(st.agentHealth.workspace || "по умолчанию")}</span>
          </div>
          <div class="row">
            <button type="button" id="ag-pick-ws-btn" class="btn btn-xs">📁 Папка ПК</button>
            <button type="button" id="ag-start-btn" class="btn btn-xs btn-emerald">▶ Запустить</button>
            <button type="button" id="ag-stop-btn" class="btn btn-xs btn-danger">⏹ Остановить</button>
          </div>
        </div>
      </div>

      <!-- Подвкладки Агента -->
      <div class="subtabs-bar" role="tablist">
        <button type="button" class="subtab-btn active" data-ag-subtab="chat">💬 Чат с Агентом</button>
        <button type="button" class="subtab-btn" data-ag-subtab="config">⚙ Модель, Доверие, RAG и GitHub</button>
        <button type="button" class="subtab-btn" data-ag-subtab="sandbox">📦 Рабочий стол (Sandbox) и стенограммы</button>
        <button type="button" class="subtab-btn" data-ag-subtab="subagents">🕸 Субагенты и Надсмотрщик</button>
        <button type="button" class="subtab-btn" data-ag-subtab="tester">🧪 Тестировщик (QA)</button>
      </div>

      <!-- Подвкладка 1: Чат с Агентом -->
      <div id="ag-panel-chat" class="ag-subpanel">
        <div class="split-layout">
          <aside class="sidebar-col">
            <div class="card">
              <div class="row-between mb-2">
                <div style="font-weight:600;">Сессии Агента</div>
                <button type="button" id="ag-new-conv" class="btn btn-xs btn-primary">+ Новый</button>
              </div>
              <div id="ag-conv-list" class="item-list"></div>
              <button type="button" id="ag-summarize-btn" class="btn btn-sm mt-2" style="width:100%;">📑 Summary → Новый чат</button>
            </div>

            <div class="card">
              <div style="font-weight:600;" class="mb-2">Быстрый контекст</div>
              <label class="field-label">Проект Sandbox</label>
              <input id="ag-quick-project" class="input input-sm mb-2" placeholder="например my-site" />
              <label class="field-label">Доверие</label>
              <select id="ag-quick-trust" class="select select-sm mb-2">
                <option value="verified">Проверенные (запрос опасных)</option>
                <option value="full">Полное (без пауз в Sandbox)</option>
                <option value="none">Минимальное (спрашивать всё)</option>
              </select>
              <label class="field-label">RAG-папка</label>
              <select id="ag-quick-rag" class="select select-sm"></select>
            </div>
          </aside>

          <div class="main-col">
            <div class="chat-box">
              <div id="ag-messages" class="chat-messages"></div>
              <div id="ag-approvals-host" style="padding:0 12px;"></div>
              <div id="ag-composer" class="composer">
                <div id="ag-att-chips" class="att-chips"></div>
                <div class="row" style="align-items:flex-end;">
                  <label class="btn btn-sm" style="cursor:pointer;" title="Прикрепить файлы / картинки">
                    📎
                    <input id="ag-file-input" type="file" multiple hidden />
                  </label>
                  <textarea id="ag-input" class="textarea" style="flex:1; min-height:46px; max-height:180px;" placeholder="Поставьте задачу Агенту… (можно просить создать сайт/скрипт, запустить проверки, делегировать субагентам)"></textarea>
                  <button type="button" id="ag-to-operator-btn" class="btn btn-sm" title="Сформулировать и отправить задачу Оператору рабочего стола">🖥 В Оператор</button>
                  <button type="button" id="ag-send-btn" class="btn btn-primary" style="height:42px;">Запустить</button>
                  <button type="button" id="ag-stop-stream-btn" class="btn btn-danger" style="height:42px; display:none;">Стоп</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Подвкладка 2: Модель, Доверие, RAG, GitHub -->
      <div id="ag-panel-config" class="ag-subpanel" hidden>
        <div class="grid-2">
          <div class="card">
            <div style="font-weight:600; font-size:14px;" class="mb-2">⚙ Модель и параметры Агента</div>
            <div class="grid-2">
              <div>
                <label class="field-label">Пресет</label>
                <select id="ag-preset" class="select select-sm">
                  <option value="">— выбрать —</option>
                  ${Object.entries(presets).map(([k, p]) => `<option value="${esc(k)}">${esc(p.label)}</option>`).join("")}
                </select>
              </div>
              <div>
                <label class="field-label">Base URL (/v1)</label>
                <input id="ag-base-url" class="input input-sm" value="${esc(st.settings.baseUrl)}" />
              </div>
            </div>
            <div class="grid-2 mt-2">
              <div>
                <label class="field-label">API Key</label>
                <input id="ag-api-key" type="password" class="input input-sm" placeholder="Пусто — из БД CRM или без ключа" />
              </div>
              <div>
                <label class="field-label">Модель</label>
                <div class="row">
                  <input id="ag-model" class="input input-sm" style="flex:1" list="ag-models-list" value="${esc(st.settings.model)}" />
                  <datalist id="ag-models-list"></datalist>
                  <button type="button" id="ag-fetch-models" class="btn btn-xs">Список</button>
                </div>
              </div>
            </div>
            <div class="grid-3 mt-2">
              <div>
                <label class="field-label">Раздумья</label>
                <select id="ag-reasoning" class="select select-sm">
                  ${reasoningModes.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}
                </select>
              </div>
              <div>
                <label class="field-label">Макс. шагов</label>
                <input id="ag-max-steps" type="number" class="input input-sm" value="60" />
              </div>
              <div>
                <label class="field-label">Temperature</label>
                <input id="ag-temp" type="number" step="0.05" class="input input-sm" placeholder="авто" />
              </div>
            </div>
            <div class="mt-2">
              <label class="field-label">Системная инструкция (добавляется к Агенту)</label>
              <textarea id="ag-system-prompt" class="textarea" rows="3" placeholder="Дополнительные правила работы Агента…"></textarea>
            </div>
            <button type="button" id="ag-save-cfg-btn" class="btn btn-sm btn-primary mt-2">💾 Сохранить в настройки CRM</button>
          </div>

          <div class="col">
            <div class="card">
              <div style="font-weight:600; font-size:14px;" class="mb-2">📚 База знаний (RAG)</div>
              <div class="grid-2">
                <div>
                  <label class="field-label">RAG-папка</label>
                  <select id="ag-cfg-rag" class="select select-sm"></select>
                </div>
                <div>
                  <label class="field-label">Фрагментов (или Вся база)</label>
                  <div class="row">
                    <input id="ag-cfg-rag-chunks" type="number" class="input input-sm" style="width:70px" value="8" />
                    <label class="row" style="font-size:11px;"><input id="ag-cfg-rag-full" type="checkbox" /> Вся база</label>
                  </div>
                </div>
              </div>
            </div>

            <div class="card">
              <div class="row-between mb-2">
                <div style="font-weight:600; font-size:14px;">🐙 GitHub контекст</div>
                <button type="button" id="ag-gh-refresh" class="btn btn-xs">↻</button>
              </div>
              <div id="ag-gh-box" class="muted" style="font-size:12px;">Загрузка статуса GitHub…</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Подвкладка 3: Sandbox и стенограммы -->
      <div id="ag-panel-sandbox" class="ag-subpanel" hidden>
        <div class="grid-2">
          <div class="card">
            <div class="row-between mb-2">
              <div>
                <div style="font-weight:600; font-size:14px;">📦 Проекты и файлы в Sandbox</div>
                <div class="muted" style="font-size:11px;">Изолированная рабочая папка локального Агента</div>
              </div>
              <div class="row">
                <a id="ag-sb-dl-all" class="btn btn-xs" href="#">⬇ Всё (ZIP)</a>
                <button type="button" id="ag-sb-refresh" class="btn btn-xs">↻ Обновить</button>
              </div>
            </div>
            <div id="ag-sb-projects" class="col"></div>
            <div class="mt-3">
              <div style="font-weight:600; font-size:12.5px;" class="mb-1">Запущенные процессы Sandbox</div>
              <div id="ag-sb-processes" class="col"></div>
            </div>
          </div>

          <div class="card">
            <div class="row-between mb-2">
              <div style="font-weight:600; font-size:14px;">📜 Стенограммы чатов (Summary)</div>
              <button type="button" id="ag-tr-refresh" class="btn btn-xs">↻</button>
            </div>
            <div id="ag-transcripts-list" class="col"></div>
          </div>
        </div>
      </div>

      <!-- Подвкладка 4: Субагенты и Надсмотрщик -->
      <div id="ag-panel-subagents" class="ag-subpanel" hidden>
        <div class="col" id="ag-subagents-host"></div>
      </div>

      <!-- Подвкладка 5: Тестировщик -->
      <div id="ag-panel-tester" class="ag-subpanel" hidden>
        <div class="split-layout">
          <aside class="sidebar-col">
            <div class="card">
              <div class="row-between mb-2">
                <div style="font-weight:600;">Сессии QA-Тестировщика</div>
                <button type="button" id="qa-new-conv" class="btn btn-xs btn-primary">+ Новый</button>
              </div>
              <div id="qa-conv-list" class="item-list"></div>
            </div>
          </aside>
          <div class="main-col">
            <div class="chat-box">
              <div id="qa-messages" class="chat-messages"></div>
              <div class="composer">
                <div class="row">
                  <textarea id="qa-input" class="textarea" style="flex:1; min-height:44px;" placeholder="Что проверить в Sandbox или коде?"></textarea>
                  <button type="button" id="qa-send-btn" class="btn btn-primary" style="height:42px;">Проверить</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Переключение подвкладок Агента
  root.querySelectorAll("[data-ag-subtab]").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.getAttribute("data-ag-subtab");
      st.subtab = id;
      root.querySelectorAll("[data-ag-subtab]").forEach((b) => b.classList.toggle("active", b.getAttribute("data-ag-subtab") === id));
      root.querySelectorAll(".ag-subpanel").forEach((p) => { p.hidden = p.id !== `ag-panel-${id}`; });
      if (id === "sandbox") { refreshSandbox(); refreshTranscripts(); }
      if (id === "subagents") { refreshSubagents(); }
      if (id === "tester") { refreshTesterConvs(); }
    };
  });

  function renderAgentHealth(h) {
    st.agentHealth = h;
    ctx.updateHeaderStatuses({ agentRunning: Boolean(h?.available) });
    const badge = root.querySelector("#ag-status-badge");
    const ws = root.querySelector("#ag-workspace-label");
    if (badge) {
      badge.innerHTML = `<span class="dot ${h?.available ? "dot-green" : "dot-gray"}"></span> Агент: ${h?.available ? `готов (порт ${h.port})` : "остановлен (автозапуск при запросе)"}`;
    }
    if (ws && h?.workspace) {
      ws.textContent = `Папка: ${h.workspace}`;
    }
  }

  root.querySelector("#ag-start-btn").onclick = async () => {
    try {
      const h = await apiJson("/api/app/agent/start", { method: "POST", body: "{}" });
      renderAgentHealth(h);
      showToast(h.available ? `Локальный Агент запущен (порт ${h.port})` : "Запускается…", "ok");
    } catch (err) {
      showToast(err.message, "error");
    }
  };
  root.querySelector("#ag-stop-btn").onclick = async () => {
    try {
      const h = await apiJson("/api/app/agent/stop", { method: "POST", body: "{}" });
      renderAgentHealth(h);
      showToast("Агент остановлен", "info");
    } catch (err) {
      showToast(err.message, "error");
    }
  };
  root.querySelector("#ag-pick-ws-btn").onclick = async () => {
    try {
      const res = await apiJson("/api/app/pick-folder", { method: "POST", body: "{}" });
      if (res.ok && res.path) {
        await apiJson("/api/app/agent/stop", { method: "POST", body: "{}" }).catch(() => {});
        const h = await apiJson("/api/app/agent/start", {
          method: "POST",
          body: JSON.stringify({ workspace: res.path }),
        });
        renderAgentHealth(h);
        showToast(`Рабочая папка: ${res.path}`, "ok");
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  // ---- Чаты Агента ----
  const elMsgs = root.querySelector("#ag-messages");
  const elApprovals = root.querySelector("#ag-approvals-host");

  function renderApprovals() {
    if (!st.approvals.length) {
      elApprovals.innerHTML = "";
      return;
    }
    elApprovals.innerHTML = st.approvals.map((ap, i) => `
      <div class="approval-card" data-ap-idx="${i}">
        <div class="row-between">
          <strong class="text-amber">⚠ Требуется подтверждение: ${esc(ap.title || ap.kind || "Действие")}</strong>
          <span class="badge">${esc(ap.kind || "action")}</span>
        </div>
        <div class="mt-1 mono" style="font-size:11.5px; white-space:pre-wrap;">${esc(ap.summary || ap.command || ap.description || JSON.stringify(ap.details || {}))}</div>
        ${ap.kind === "sandbox_export" ? `<input class="input input-sm mt-2" id="ap-dest-${i}" placeholder="Папка назначения на ПК" value="${esc(ap.destination || "")}" />` : ""}
        <input class="input input-sm mt-2" id="ap-note-${i}" placeholder="Комментарий (необязательно)" />
        <div class="row mt-2">
          <button type="button" class="btn btn-sm btn-emerald" data-ap-yes="${i}">✓ Подтвердить</button>
          <button type="button" class="btn btn-sm btn-danger" data-ap-no="${i}">✕ Отклонить</button>
        </div>
      </div>
    `).join("");

    elApprovals.querySelectorAll("[data-ap-yes], [data-ap-no]").forEach((btn) => {
      btn.onclick = async () => {
        const isYes = btn.hasAttribute("data-ap-yes");
        const idx = Number(btn.getAttribute(isYes ? "data-ap-yes" : "data-ap-no"));
        const ap = st.approvals[idx];
        if (!ap) return;
        const note = elApprovals.querySelector(`#ap-note-${idx}`)?.value || "";
        const destination = elApprovals.querySelector(`#ap-dest-${idx}`)?.value || ap.destination || "";
        try {
          await apiJson("/api/ai/agent/approve", {
            method: "POST",
            body: JSON.stringify({
              approvalId: ap.approvalId,
              approved: isYes,
              note,
              destination,
            }),
          });
          st.approvals.splice(idx, 1);
          renderApprovals();
        } catch (err) {
          showToast(err.message, "error");
        }
      };
    });
  }

  function renderAgentMessages() {
    if (!st.messages.length) {
      elMsgs.innerHTML = `
        <div class="card-2" style="padding:18px; text-align:center; margin:auto;">
          <div style="font-weight:600; font-size:14px;">ИИ-Агент CRM с инструментами</div>
          <p class="muted mt-1" style="max-width:500px;">
            Умеет создавать и запускать проекты в изолированной песочнице, работать с файлами, GitHub, браузером,
            вызывать команду Субагентов (и проверяться Надсмотрщиком, если он включён) и передавать задачи Оператору экрана.
          </p>
        </div>
      `;
      return;
    }

    elMsgs.innerHTML = st.messages.map((m) => {
      if (m.role === "user") {
        return `
          <div class="bubble bubble-user">
            <div class="bubble-meta"><span>Вы</span></div>
            <div class="md-content">${esc(m.content).replace(/\n/g, "<br/>")}</div>
          </div>
        `;
      }
      const reasoningHtml = m.reasoning
        ? `<details class="reasoning-box" ${m.streaming && !m.content ? "open" : ""}>
             <summary class="reasoning-toggle"><span>🧠 Раздумья (${m.reasoning.length} симв.)</span>${m.streaming ? '<span class="dot dot-amber dot-pulse"></span>' : ""}</summary>
             <div class="reasoning-body">${esc(m.reasoning)}</div>
           </details>`
        : "";
      const subCards = (m.subagents || []).map((s) => `
        <div class="subagent-card">
          <div class="row-between">
            <div>
              <strong>🕸 ${esc(s.subagentName || s.subagentSlug || "Субагент")}</strong>
              <span class="badge ${s.status === "completed" ? "badge-emerald" : s.status === "error" || s.status === "blocked" ? "badge-red" : "badge-accent"}" style="margin-left:6px;">${esc(s.status || "running")}</span>
            </div>
            ${s.statusText ? `<span class="muted" style="font-size:11px;">${esc(s.statusText)}</span>` : ""}
          </div>
          ${s.text ? `<div class="mt-2 md-content">${renderMarkdown(s.text)}</div>` : ""}
          ${s.outputSummary && !s.text ? `<div class="mt-2 muted" style="font-size:11.5px;">${esc(s.outputSummary)}</div>` : ""}
        </div>
      `).join("");
      const ovCards = (m.overseer || []).map((ov) => `
        <div class="overseer-card">
          <div class="row-between">
            <strong>👁 Надсмотрщик</strong>
            <span class="badge badge-amber">${esc(ov.status || "проверка")}</span>
          </div>
          <div class="mt-1">${esc(ov.text || ov.summary || "")}</div>
        </div>
      `).join("");
      const actCards = (m.actions || []).map((a) => `
        <div class="action-card">
          <div class="row-between">
            <span>🔧 <b>${esc(a.label || a.type || "действие")}</b></span>
            <span class="badge ${a.ok === false ? "badge-red" : "badge-emerald"}">${a.ok === false ? "ошибка" : "ок"}</span>
          </div>
          ${a.summary ? `<div class="muted mt-1">${esc(a.summary)}</div>` : ""}
          ${a.previewUrl ? `<div class="mt-1"><a class="btn btn-xs" target="_blank" href="${esc(withHtQuery(a.previewUrl))}">Открыть превью</a></div>` : ""}
        </div>
      `).join("");
      const filesHtml = (m.files || []).length
        ? `<div class="att-chips mt-2">${m.files.map((f) => `<span class="badge badge-cyan">📄 ${esc(f.name || f.path)}</span>`).join("")}</div>`
        : "";
      return `
        <div class="bubble bubble-assistant ${m.error ? "bubble-error" : ""}">
          <div class="bubble-meta">
            <span>🤖 Агент ${m.status ? `· ${esc(m.status)}` : ""}</span>
            <span>${m.usage ? `${formatTokens(m.usage.total || m.usage.total_tokens || 0)} ток.` : ""}</span>
          </div>
          ${reasoningHtml}
          ${ovCards}
          ${subCards}
          ${actCards}
          <div class="md-content mt-1">${renderMarkdown(m.content || (m.streaming ? "Выполняю…" : ""))}</div>
          ${filesHtml}
        </div>
      `;
    }).join("");
    elMsgs.scrollTop = elMsgs.scrollHeight;
  }

  async function refreshConvs() {
    try {
      const res = await apiJson("/api/agent/conversations?kind=agent");
      st.conversations = res.conversations || [];
      const host = root.querySelector("#ag-conv-list");
      host.innerHTML = st.conversations.length
        ? st.conversations.map((c) => `
            <div class="list-item ${c.id === st.activeConvId ? "active" : ""}" data-ag-conv="${c.id}">
              <div style="min-width:0; flex:1;">
                <div style="font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(c.title)}</div>
                <div class="muted" style="font-size:10px;">${c.messagesCount || 0} сообщ.</div>
              </div>
              <button type="button" class="btn btn-xs btn-ghost text-red" data-del-ag-conv="${c.id}">✕</button>
            </div>
          `).join("")
        : `<div class="muted" style="font-size:11px;">Чатов агента нет</div>`;

      host.querySelectorAll("[data-ag-conv]").forEach((row) => {
        row.onclick = (ev) => {
          if (ev.target.closest("[data-del-ag-conv]")) return;
          loadConv(Number(row.getAttribute("data-ag-conv")));
        };
      });
      host.querySelectorAll("[data-del-ag-conv]").forEach((b) => {
        b.onclick = async (ev) => {
          ev.stopPropagation();
          const id = Number(b.getAttribute("data-del-ag-conv"));
          await apiJson(`/api/agent/conversations/${id}`, { method: "DELETE" });
          if (st.activeConvId === id) { st.activeConvId = 0; st.messages = []; renderAgentMessages(); }
          await refreshConvs();
        };
      });
    } catch {
      /* ignore */
    }
  }

  async function loadConv(id) {
    try {
      const res = await apiJson(`/api/agent/conversations/${id}`);
      st.activeConvId = id;
      st.messages = (res.messages || []).map((m) => ({
        role: m.role,
        content: m.content || "",
        reasoning: m.reasoning || "",
        actions: Array.isArray(m.actions) ? m.actions : [],
        files: Array.isArray(m.files) ? m.files : [],
        error: Boolean(m.error),
      }));
      await refreshConvs();
      renderAgentMessages();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async function ensureConvId(titleHint = "Новый чат") {
    if (st.activeConvId > 0) return st.activeConvId;
    const res = await apiJson("/api/agent/conversations", {
      method: "POST",
      body: JSON.stringify({ kind: "agent", title: titleHint.slice(0, 60) }),
    });
    st.activeConvId = res.conversation.id;
    await refreshConvs();
    return st.activeConvId;
  }

  function syncAgentSettingsFromDom() {
    st.settings.baseUrl = root.querySelector("#ag-base-url").value.trim();
    st.settings.apiKey = root.querySelector("#ag-api-key").value.trim();
    st.settings.model = root.querySelector("#ag-model").value.trim();
    st.settings.reasoning = root.querySelector("#ag-reasoning").value || "default";
    st.settings.maxSteps = Number(root.querySelector("#ag-max-steps").value || 60) || 60;
    const t = root.querySelector("#ag-temp").value.trim();
    st.settings.temperature = t === "" ? null : Number(t);
    st.settings.systemPrompt = root.querySelector("#ag-system-prompt").value;
    st.settings.trustLevel = root.querySelector("#ag-quick-trust").value || "verified";
    st.sandboxProject = root.querySelector("#ag-quick-project").value.trim();
    st.selectedRagId = Number(root.querySelector("#ag-quick-rag").value || 0) || 0;
    st.ragChunks = Number(root.querySelector("#ag-cfg-rag-chunks").value || 8) || 0;
    st.ragFull = Boolean(root.querySelector("#ag-cfg-rag-full").checked);
  }

  async function sendAgentMessage() {
    if (st.streaming) return;
    syncAgentSettingsFromDom();
    const inp = root.querySelector("#ag-input");
    const text = inp.value.trim();
    if (!text && !st.pendingFiles.length) return;

    const convId = await ensureConvId(text || "Запуск с файлами");
    const attachments = st.pendingFiles.map((f) => ({
      name: f.name,
      text: f.text || "",
      note: f.note || "",
      ...(f.preview ? { image: f.preview } : {}),
    }));

    st.messages.push({ role: "user", content: text || "[Вложения]" });
    const historyToSend = st.messages.map((m) => ({ role: m.role, content: m.content }));
    const aMsg = { role: "assistant", content: "", reasoning: "", actions: [], subagents: [], overseer: [], files: [], streaming: true, status: "запуск…" };
    st.messages.push(aMsg);
    inp.value = "";
    st.pendingFiles = [];
    renderPendingAtts();
    renderAgentMessages();

    // Сохраняем сообщение пользователя в БД
    apiJson(`/api/agent/conversations/${convId}/messages`, {
      method: "POST",
      body: JSON.stringify({ role: "user", content: text || "[Вложения]" }),
    }).catch(() => {});

    st.streaming = true;
    st.abortCtrl = new AbortController();
    root.querySelector("#ag-send-btn").style.display = "none";
    root.querySelector("#ag-stop-stream-btn").style.display = "";

    try {
      const res = await apiFetch("/api/ai/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: st.abortCtrl.signal,
        body: JSON.stringify({
          agentRole: "agent",
          agentConversationId: convId,
          messages: historyToSend,
          attachments,
          settings: {
            baseUrl: st.settings.baseUrl,
            apiKey: st.settings.apiKey,
            model: st.settings.model,
          },
          params: {
            temperature: st.settings.temperature,
            reasoning: st.settings.reasoning,
          },
          systemPrompt: st.settings.systemPrompt,
          maxSteps: st.settings.maxSteps,
          trustLevel: st.settings.trustLevel,
          sandboxProject: st.sandboxProject,
          ragFolderId: st.selectedRagId,
          ragChunks: st.ragChunks,
          ragFull: st.ragFull,
          githubEnabled: st.github.enabled,
          githubOwner: st.github.owner,
          githubRepo: st.github.repo,
          githubBranch: st.github.branch,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      await consumeSseStream(res, (ev, data) => {
        if (ev === "__keepalive__" || !data) return;
        if (ev === "status") {
          aMsg.status = data.message || data.stage || "";
        } else if (ev === "reasoning") {
          aMsg.reasoning = typeof data.text === "string" ? data.text : aMsg.reasoning + String(data.delta || "");
        } else if (ev === "text") {
          aMsg.content = typeof data.text === "string" ? data.text : aMsg.content + String(data.delta || "");
        } else if (ev === "action") {
          aMsg.actions.push(data);
        } else if (ev === "approval_required") {
          st.approvals.push(data);
          renderApprovals();
        } else if (ev === "subagent_run") {
          aMsg.subagents.push({
            runKey: data.runKey,
            subagentName: data.subagentName || data.subagentSlug,
            status: "running",
            text: "",
          });
        } else if (ev === "subagent_status") {
          const card = aMsg.subagents.find((s) => s.runKey === data.runKey);
          if (card) card.statusText = data.message || data.stage || "";
        } else if (ev === "subagent_text") {
          const card = aMsg.subagents.find((s) => s.runKey === data.runKey);
          if (card) card.text = data.text || "";
        } else if (ev === "subagent_done") {
          const card = aMsg.subagents.find((s) => s.runKey === data.runKey);
          if (card) {
            card.status = data.status || "completed";
            card.outputSummary = data.outputSummary || "";
            if (data.fullResponse) card.text = data.fullResponse;
          }
        } else if (ev === "overseer_start" || ev === "overseer_status" || ev === "overseer_done") {
          aMsg.overseer.push({
            status: ev === "overseer_done" ? (data.verdict || "ок") : "проверка",
            text: data.message || data.reason || data.summary || "",
          });
        } else if (ev === "done") {
          aMsg.status = "готово";
          if (data.text && !aMsg.content) aMsg.content = data.text;
          if (Array.isArray(data.files)) aMsg.files = data.files;
          if (data.usage) aMsg.usage = data.usage;
        } else if (ev === "error") {
          aMsg.error = true;
          aMsg.content += `\n\nОшибка: ${data.error || data.message || "сбой"}`;
        }
        renderAgentMessages();
      });
    } catch (err) {
      if (err.name !== "AbortError") {
        aMsg.error = true;
        aMsg.content = aMsg.content || `Ошибка: ${err.message}`;
        showToast(err.message, "error");
      }
    } finally {
      aMsg.streaming = false;
      st.streaming = false;
      st.abortCtrl = null;
      root.querySelector("#ag-send-btn").style.display = "";
      root.querySelector("#ag-stop-stream-btn").style.display = "none";
      renderAgentMessages();
      // Сохраняем итоговый ответ ассистента в БД
      if (aMsg.content || aMsg.actions.length) {
        apiJson(`/api/agent/conversations/${convId}/messages`, {
          method: "POST",
          body: JSON.stringify({
            role: "assistant",
            content: aMsg.content || "[Выполнено]",
            reasoning: aMsg.reasoning,
            actions: aMsg.actions,
            files: aMsg.files,
            error: aMsg.error ? aMsg.content : undefined,
          }),
        }).catch(() => {});
      }
      apiJson("/api/ai/agent").then(renderAgentHealth).catch(() => {});
    }
  }

  function renderPendingAtts() {
    const host = root.querySelector("#ag-att-chips");
    host.innerHTML = st.pendingFiles.map((f, i) => `
      <span class="att-chip">
        ${f.preview ? `<img src="${esc(f.preview)}" class="att-thumb" alt="" />` : "📄"}
        <span>${esc(f.name)}</span>
        <button type="button" class="btn btn-xs btn-ghost" data-ag-rm-att="${i}">✕</button>
      </span>
    `).join("");
    host.querySelectorAll("[data-ag-rm-att]").forEach((b) => {
      b.onclick = () => {
        st.pendingFiles.splice(Number(b.getAttribute("data-ag-rm-att")), 1);
        renderPendingAtts();
      };
    });
  }

  async function addAgentFiles(files) {
    for (const f of files) {
      try {
        st.pendingFiles.push(await readBrowserFileToAttachment(f));
      } catch (err) {
        showToast(err.message, "error");
      }
    }
    renderPendingAtts();
  }

  root.querySelector("#ag-file-input").onchange = (ev) => { addAgentFiles(ev.target.files); ev.target.value = ""; };
  root.querySelector("#ag-input").onpaste = async (ev) => {
    const files = await readClipboardImages(ev.clipboardData);
    if (files.length) { ev.preventDefault(); await addAgentFiles(files); }
  };
  root.querySelector("#ag-input").onkeydown = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); sendAgentMessage(); }
  };
  root.querySelector("#ag-send-btn").onclick = sendAgentMessage;
  root.querySelector("#ag-stop-stream-btn").onclick = () => st.abortCtrl?.abort();
  root.querySelector("#ag-new-conv").onclick = async () => {
    st.activeConvId = 0;
    st.messages = [];
    await ensureConvId("Новый чат");
    renderAgentMessages();
  };

  root.querySelector("#ag-summarize-btn").onclick = async () => {
    if (!st.messages.length) return showToast("Переписка пуста", "error");
    syncAgentSettingsFromDom();
    try {
      const activeTitle = st.conversations.find((c) => c.id === st.activeConvId)?.title || "Чат агента";
      const res = await apiJson("/api/ai/agent/summarize", {
        method: "POST",
        body: JSON.stringify({
          title: activeTitle,
          turns: st.messages.map((m) => ({ role: m.role, content: m.content, actions: m.actions, files: m.files })),
          settings: { baseUrl: st.settings.baseUrl, apiKey: st.settings.apiKey, model: st.settings.model },
        }),
      });
      const fullDialog = st.messages
        .map((m) => `### ${m.role === "user" ? "Пользователь" : "Агент"}\n\n${m.content || ""}`)
        .join("\n\n---\n\n");
      await apiJson("/api/agent/transcripts", {
        method: "POST",
        body: JSON.stringify({
          conversationId: st.activeConvId || undefined,
          title: `Summary: ${activeTitle}`,
          summary: res.summary || "",
          content: `${res.summary || ""}\n\n---\n\n## Полная переписка\n\n${fullDialog}`,
        }),
      }).catch(() => {});
      const convRes = await apiJson("/api/agent/conversations", {
        method: "POST",
        body: JSON.stringify({ kind: "agent", title: `Продолжение: ${activeTitle}`.slice(0, 80) }),
      });
      st.activeConvId = convRes.conversation.id;
      st.messages = [{ role: "assistant", content: `### Конспект прошлого чата\n\n${res.summary}` }];
      await refreshConvs();
      renderAgentMessages();
      showToast("Summary сохранён и перенесён в новый чат", "ok");
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  root.querySelector("#ag-to-operator-btn").onclick = async () => {
    const goal = root.querySelector("#ag-input").value.trim() || st.messages.slice(-1)[0]?.content || "";
    if (!goal) return showToast("Опишите задачу для Оператора", "error");
    syncAgentSettingsFromDom();
    try {
      const form = await apiJson("/api/ai/agent/operator", {
        method: "POST",
        body: JSON.stringify({
          action: "formulate",
          goal,
          settings: { baseUrl: st.settings.baseUrl, apiKey: st.settings.apiKey, model: st.settings.model },
        }),
      });
      await apiJson("/api/ai/agent/operator", {
        method: "POST",
        body: JSON.stringify({
          action: "launch",
          prompt: form.prompt || goal,
          taskMode: form.taskMode || "copilot",
          coachMode: form.coachMode || "agent",
          maxSteps: form.maxSteps || 30,
          trustLevel: st.settings.trustLevel,
        }),
      });
      showToast("Задача поставлена в очередь Оператора!", "ok");
      ctx.switchToOperatorTab();
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  // ---- Конфиг / RAG / GitHub ----
  root.querySelector("#ag-preset").onchange = (ev) => {
    const p = presets[ev.target.value];
    if (!p) return;
    if (p.base_url) root.querySelector("#ag-base-url").value = p.base_url;
    if (p.model) root.querySelector("#ag-model").value = p.model;
  };
  root.querySelector("#ag-fetch-models").onclick = async () => {
    syncAgentSettingsFromDom();
    try {
      const res = await apiJson("/api/ai/models", {
        method: "POST",
        body: JSON.stringify({ baseUrl: st.settings.baseUrl, apiKey: st.settings.apiKey, model: st.settings.model }),
      });
      root.querySelector("#ag-models-list").innerHTML = (res.models || []).map((m) => `<option value="${esc(m)}"></option>`).join("");
      showToast(`Найдено моделей: ${(res.models || []).length}`, "ok");
    } catch (err) {
      showToast(err.message, "error");
    }
  };
  root.querySelector("#ag-save-cfg-btn").onclick = async () => {
    syncAgentSettingsFromDom();
    try {
      await apiJson("/api/ai/settings", {
        method: "PUT",
        body: JSON.stringify({
          baseUrl: st.settings.baseUrl,
          model: st.settings.model,
          ...(st.settings.apiKey ? { apiKey: st.settings.apiKey } : {}),
        }),
      });
      showToast("Настройки Агента сохранены в БД CRM", "ok");
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  async function loadRagAndGithub() {
    if (limits.rag !== false) {
      try {
        const r = await apiJson("/api/ai/rag");
        st.ragFolders = r.folders || [];
        const opts = `<option value="0">Без папки (RAG выкл.)</option>` +
          st.ragFolders.map((f) => `<option value="${f.id}">${esc(f.name)} (${f.filesCount})</option>`).join("");
        root.querySelector("#ag-quick-rag").innerHTML = opts;
        root.querySelector("#ag-cfg-rag").innerHTML = opts;
      } catch {}
    }
    try {
      const gh = await apiJson("/api/github/connection");
      st.github.connected = Boolean(gh.connected);
      const box = root.querySelector("#ag-gh-box");
      if (!gh.connected) {
        box.innerHTML = `GitHub не подключён в профиле CRM. Подключите его на сайте CRM, после чего выберите репозиторий здесь.`;
        return;
      }
      st.github.enabled = Boolean(gh.connection?.enabled);
      st.github.owner = gh.connection?.selectedOwner || "";
      st.github.repo = gh.connection?.selectedRepo || "";
      st.github.branch = gh.connection?.selectedBranch || "main";
      const reposRes = await apiJson("/api/github/repos").catch(() => ({ repos: [] }));
      st.github.repos = reposRes.repos || [];
      box.innerHTML = `
        <div class="row mb-2">
          <span class="badge badge-emerald">✓ @${esc(gh.connection?.login || "")}</span>
          <label class="row" style="font-size:11.5px; cursor:pointer;">
            <input id="ag-gh-en" type="checkbox" ${st.github.enabled ? "checked" : ""} /> Включить контекст репозитория
          </label>
        </div>
        <select id="ag-gh-repo" class="select select-sm mb-2">
          <option value="">— выберите репозиторий —</option>
          ${st.github.repos.map((r) => `<option value="${esc(r.fullName)}" ${r.fullName === `${st.github.owner}/${st.github.repo}` ? "selected" : ""}>${esc(r.fullName)}</option>`).join("")}
        </select>
        <input id="ag-gh-branch" class="input input-sm" value="${esc(st.github.branch)}" placeholder="ветка (main)" />
      `;
      box.querySelector("#ag-gh-en").onchange = (ev) => { st.github.enabled = ev.target.checked; };
      box.querySelector("#ag-gh-repo").onchange = (ev) => {
        const [o, r] = String(ev.target.value || "").split("/");
        st.github.owner = o || "";
        st.github.repo = r || "";
      };
      box.querySelector("#ag-gh-branch").onchange = (ev) => { st.github.branch = ev.target.value.trim() || "main"; };
    } catch {}
  }
  root.querySelector("#ag-gh-refresh").onclick = loadRagAndGithub;

  // ---- Sandbox и стенограммы ----
  async function refreshSandbox() {
    try {
      const sb = await apiJson("/api/ai/agent/sandbox");
      st.sandbox = sb;
      root.querySelector("#ag-sb-dl-all").href = withHtQuery("/api/ai/agent/sandbox?download=.");
      const projHost = root.querySelector("#ag-sb-projects");
      const projects = sb.projects || [];
      const files = sb.files || [];
      projHost.innerHTML = projects.length
        ? projects.map((p) => {
            const pUrl = withHtQuery(`/api/ai/agent/sandbox/preview/${encodeURIComponent(p.name)}`);
            const dUrl = withHtQuery(`/api/ai/agent/sandbox?download=${encodeURIComponent(p.name)}`);
            return `
              <div class="card-sm row-between">
                <div>
                  <b>📁 ${esc(p.name)}</b>
                  <div class="muted" style="font-size:10.5px;">${p.filesCount || 0} файлов · ${esc(formatBytes(p.size || 0))}</div>
                </div>
                <div class="row">
                  <a class="btn btn-xs btn-primary" href="${esc(pUrl)}" target="_blank">🌐 Превью</a>
                  <a class="btn btn-xs" href="${esc(dUrl)}">⬇ ZIP</a>
                  <button type="button" class="btn btn-xs" data-sb-export="${esc(p.name)}">📤 На ПК</button>
                  <button type="button" class="btn btn-xs btn-danger" data-sb-del="${esc(p.name)}">✕</button>
                </div>
              </div>
            `;
          }).join("")
        : (files.length
          ? files.slice(0, 30).map((f) => `<div class="card-sm row-between"><span class="mono" style="font-size:11px;">${esc(f.path || f.name)}</span><a class="btn btn-xs" href="${esc(withHtQuery(`/api/ai/agent/sandbox?download=${encodeURIComponent(f.path || f.name)}`))}">⬇</a></div>`).join("")
          : `<div class="muted">Песочница пока пуста</div>`);

      projHost.querySelectorAll("[data-sb-export]").forEach((b) => {
        b.onclick = async () => {
          const src = b.getAttribute("data-sb-export");
          const pick = await apiJson("/api/app/pick-folder", { method: "POST", body: "{}" });
          if (!pick.ok || !pick.path) return;
          try {
            await apiJson("/api/ai/agent/sandbox", {
              method: "POST",
              body: JSON.stringify({ action: "export", source: src, destination: pick.path, mode: "copy", confirmed: true }),
            });
            showToast(`Скопировано в ${pick.path}`, "ok");
          } catch (err) { showToast(err.message, "error"); }
        };
      });
      projHost.querySelectorAll("[data-sb-del]").forEach((b) => {
        b.onclick = async () => {
          const p = b.getAttribute("data-sb-del");
          await apiJson("/api/ai/agent/sandbox", { method: "POST", body: JSON.stringify({ action: "delete", path: p, confirmed: true }) });
          await refreshSandbox();
        };
      });

      const procHost = root.querySelector("#ag-sb-processes");
      const procs = sb.processes || [];
      procHost.innerHTML = procs.length
        ? procs.map((pr) => `
            <div class="card-sm row-between">
              <span class="mono" style="font-size:11px;">PID ${pr.pid}: ${esc(pr.command || pr.title || "")}</span>
              <button type="button" class="btn btn-xs btn-danger" data-sb-stop-pid="${pr.pid}">Стоп</button>
            </div>
          `).join("")
        : `<div class="muted" style="font-size:11px;">Активных фоновых серверов нет</div>`;
      procHost.querySelectorAll("[data-sb-stop-pid]").forEach((b) => {
        b.onclick = async () => {
          await apiJson("/api/ai/agent/sandbox", { method: "POST", body: JSON.stringify({ action: "stop_process", pid: Number(b.getAttribute("data-sb-stop-pid")) }) });
          await refreshSandbox();
        };
      });
    } catch {}
  }

  async function refreshTranscripts() {
    try {
      const res = await apiJson("/api/agent/transcripts");
      st.transcripts = res.transcripts || res.items || [];
      const host = root.querySelector("#ag-transcripts-list");
      host.innerHTML = st.transcripts.length
        ? st.transcripts.map((t) => `
            <div class="card-sm row-between">
              <div style="min-width:0; flex:1;">
                <div style="font-weight:500;">${esc(t.title)}</div>
                <div class="muted" style="font-size:10.5px;">${esc(formatDateTime(t.createdAt))}</div>
              </div>
              <a class="btn btn-xs" href="${esc(withHtQuery(`/api/agent/transcripts/${t.id}`))}">⬇ .md</a>
            </div>
          `).join("")
        : `<div class="muted">Стенограмм пока нет</div>`;
    } catch {}
  }

  root.querySelector("#ag-sb-refresh").onclick = refreshSandbox;
  root.querySelector("#ag-tr-refresh").onclick = refreshTranscripts;

  // ---- Субагенты и Надсмотрщик ----
  async function refreshSubagents() {
    try {
      const qs = st.selectedSubId ? `?subagentId=${st.selectedSubId}${st.activeSubConvId ? `&conversationId=${st.activeSubConvId}` : ""}` : "";
      const data = await apiJson(`/api/agent/subagents${qs}`);
      st.subagentsData = data;
      if (data.selectedConversation?.messages) {
        st.subMessages = data.selectedConversation.messages;
      }
      renderSubagentsPanel();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  function renderTreeSvg(subagents) {
    const active = subagents.filter((s) => s.isActive !== false);
    if (!active.length) return `<div class="muted">Нет активных субагентов. Создайте или включите субагента ниже.</div>`;
    const width = Math.max(660, active.length * 165);
    const height = 210;
    const cx = width / 2;
    const nodes = active.map((s, idx) => {
      const x = ((idx + 1) * width) / (active.length + 1);
      const y = s.parentSubagentId ? 155 : 115;
      return { ...s, x, y };
    });
    const lines = nodes.map((n) => {
      const parent = n.parentSubagentId ? nodes.find((p) => p.id === n.parentSubagentId) : null;
      const sx = parent ? parent.x : cx;
      const sy = parent ? parent.y + 18 : 44;
      return `<line x1="${sx}" y1="${sy}" x2="${n.x}" y2="${n.y - 18}" stroke="rgba(124,92,255,0.45)" stroke-width="2" />`;
    }).join("");
    const boxes = nodes.map((n) => `
      <g>
        <rect x="${n.x - 68}" y="${n.y - 18}" width="136" height="36" rx="10" fill="#171720" stroke="${esc(n.color || "#7c5cff")}" stroke-width="1.6" />
        <text x="${n.x}" y="${n.y + 4}" text-anchor="middle" fill="#f2f2f7" font-size="11.5" font-family="Inter,sans-serif">${esc((n.name || "").slice(0, 18))}</text>
      </g>
    `).join("");
    return `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        ${lines}
        <rect x="${cx - 76}" y="12" width="152" height="32" rx="10" fill="#7c5cff" />
        <text x="${cx}" y="32" text-anchor="middle" fill="#ffffff" font-size="12" font-weight="600" font-family="Inter,sans-serif">Оркестратор (Агент)</text>
        ${boxes}
      </svg>
    `;
  }

  function renderSubagentsPanel() {
    const host = root.querySelector("#ag-subagents-host");
    const subagents = st.subagentsData.subagents || [];
    const runs = st.subagentsData.runs || [];
    const ov = st.subagentsData.overseer || {};
    const routingMode = st.subagentsData.routingMode || "linear";
    const editing = st.editingSubagentId ? subagents.find((s) => s.id === st.editingSubagentId) : null;

    host.innerHTML = `
      <div class="grid-2">
        <!-- Карточка режима маршрутизации и Надсмотрщика -->
        <div class="card">
          <div class="row-between mb-2">
            <div>
              <div style="font-weight:600; font-size:14px;">👁 Надсмотрщик безопасности</div>
              <div class="muted" style="font-size:11px;">При снятии галочки сразу выключается в БД без перехватов и уведомлений</div>
            </div>
            <span id="ov-badge" class="badge ${ov.enabled ? "badge-amber" : ""}">${ov.enabled ? "Надсмотрщик: вкл" : "Надсмотрщик: выкл"}</span>
          </div>

          <div class="grid-2 mb-2">
            <div>
              <label class="field-label">Маршрутизация субагентов</label>
              <select id="sa-routing-mode" class="select select-sm">
                <option value="linear" ${routingMode === "linear" ? "selected" : ""}>Линейный (Оркестратор → субагенты)</option>
                <option value="layered" ${routingMode === "layered" ? "selected" : ""}>Иерархический (уровни дерева)</option>
                <option value="cascade" ${routingMode === "cascade" ? "selected" : ""}>Каскадный (делегирование)</option>
              </select>
            </div>
            <div>
              <label class="field-label">Режим Надсмотрщика</label>
              <select id="ov-mode" class="select select-sm">
                <option value="strict" ${ov.mode === "strict" ? "selected" : ""}>Строгий (strict)</option>
                <option value="advisory" ${ov.mode === "advisory" ? "selected" : ""}>Консультативный (advisory)</option>
              </select>
            </div>
          </div>

          <label class="row mb-2" style="cursor:pointer; font-size:12px;">
            <input id="ov-enabled-chk" type="checkbox" ${ov.enabled ? "checked" : ""} />
            <b>Включить Надсмотрщика</b> (мгновенное сохранение)
          </label>

          <label class="field-label">Системный промпт Надсмотрщика</label>
          <textarea id="ov-system-prompt" class="textarea" rows="2" placeholder="Дополнительные правила проверки…">${esc(ov.systemPrompt || "")}</textarea>

          <label class="row mt-2" style="cursor:pointer; font-size:11.5px;">
            <input id="ov-unlock-api" type="checkbox" ${ov.unlockApi ? "checked" : ""} />
            <span>Отдельный API для Надсмотрщика</span>
          </label>
          <div id="ov-custom-api" class="grid-3 mt-1" style="${ov.unlockApi ? "" : "display:none;"}">
            <input id="ov-base-url" class="input input-sm" value="${esc(ov.baseUrl || "")}" placeholder="Base URL" />
            <input id="ov-model" class="input input-sm" value="${esc(ov.model || "")}" placeholder="Модель" />
            <input id="ov-api-key" type="password" class="input input-sm" placeholder="${ov.hasApiKey ? esc(ov.apiKeyHint) : "API ключ"}" />
          </div>

          <button type="button" id="ov-save-btn" class="btn btn-sm btn-primary mt-2">Сохранить Надсмотрщика</button>
        </div>

        <!-- Схема дерева -->
        <div class="card">
          <div class="row-between mb-2">
            <div style="font-weight:600; font-size:14px;">🕸 Дерево подчинённости</div>
            <button type="button" id="sa-refresh-btn" class="btn btn-xs">↻ Обновить</button>
          </div>
          <div class="tree-canvas-wrap">${renderTreeSvg(subagents)}</div>
        </div>
      </div>

      <div class="grid-2 mt-2">
        <!-- Список + Редактор субагентов -->
        <div class="card">
          <div class="row-between mb-2">
            <div style="font-weight:600; font-size:14px;">Субагенты (${subagents.length})</div>
            <button type="button" id="sa-new-btn" class="btn btn-xs btn-primary">+ Новый субагент</button>
          </div>
          <div class="col mb-3" style="max-height:240px; overflow-y:auto;">
            ${subagents.map((s) => `
              <div class="card-sm row-between">
                <div style="min-width:0; flex:1;">
                  <div class="row">
                    <span class="dot" style="background:${esc(s.color || "#7c5cff")}"></span>
                    <b>${esc(s.name)}</b>
                    <span class="badge">${esc(s.slug)}</span>
                    <span class="badge ${s.isActive !== false ? "badge-emerald" : ""}">${s.isActive !== false ? "активен" : "выкл"}</span>
                  </div>
                  <div class="muted" style="font-size:11px;">${esc(s.roleTitle || s.toolProfile)}</div>
                </div>
                <div class="row">
                  <button type="button" class="btn btn-xs" data-sa-chat="${s.id}">💬 Чат</button>
                  <button type="button" class="btn btn-xs" data-sa-edit="${s.id}">✎</button>
                  <button type="button" class="btn btn-xs btn-danger" data-sa-del="${s.id}">✕</button>
                </div>
              </div>
            `).join("") || `<div class="muted">Субагентов пока нет</div>`}
          </div>

          <div style="border-top:1px solid var(--border); padding-top:10px;">
            <div style="font-weight:600; font-size:12.5px;" class="mb-2">${editing ? `Редактирование: ${esc(editing.name)}` : "Создать субагента"}</div>
            <div class="grid-2">
              <input id="sa-f-name" class="input input-sm" placeholder="Имя (например Кодер)" value="${esc(editing?.name || "")}" />
              <input id="sa-f-role" class="input input-sm" placeholder="Роль / специализация" value="${esc(editing?.roleTitle || "")}" />
            </div>
            <div class="grid-2 mt-1">
              <select id="sa-f-profile" class="select select-sm">
                ${TOOL_PROFILES.map(([v, l]) => `<option value="${v}" ${(editing?.toolProfile || "full") === v ? "selected" : ""}>${esc(l)}</option>`).join("")}
              </select>
              <div class="row">
                <input id="sa-f-color" type="color" value="${esc(editing?.color || "#7c5cff")}" style="width:42px; height:30px; border:0; background:transparent;" />
                <label class="row" style="font-size:11px;"><input id="sa-f-enabled" type="checkbox" ${editing?.isActive !== false ? "checked" : ""} /> Активен</label>
              </div>
            </div>
            <textarea id="sa-f-sys" class="textarea mt-1" rows="2" placeholder="Системный промпт субагента…">${esc(editing?.systemPrompt || "")}</textarea>
            <div class="row mt-2">
              <button type="button" id="sa-save-form" class="btn btn-sm btn-primary">${editing ? "Сохранить" : "Создать субагента"}</button>
              ${editing ? `<button type="button" id="sa-cancel-edit" class="btn btn-sm">Отмена</button>` : ""}
            </div>
          </div>
        </div>

        <!-- Прямой чат с субагентом и журнал запусков -->
        <div class="card col">
          <div class="row-between">
            <div style="font-weight:600; font-size:14px;">Журнал запусков (${runs.length}) и прямой чат</div>
            <select id="sa-chat-select" class="select select-sm" style="width:190px;">
              <option value="0">— выберите субагента —</option>
              ${subagents.map((s) => `<option value="${s.id}" ${s.id === st.selectedSubId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
            </select>
          </div>
          <div class="col" style="max-height:170px; overflow-y:auto;">
            ${runs.slice(0, 15).map((r) => `
              <div class="card-sm row-between">
                <div style="min-width:0; flex:1;">
                  <div><b>${esc(r.subagentName || r.subagentSlug || `#${r.id}`)}</b> <span class="badge">${esc(r.status)}</span></div>
                  <div class="muted" style="font-size:10.5px;">${esc((r.outputSummary || r.inputSummary || "").slice(0, 90))}</div>
                </div>
                <div class="row">
                  ${r.status === "running" ? `<button type="button" class="btn btn-xs btn-danger" data-run-cancel="${r.id}">Стоп</button>` : `<button type="button" class="btn btn-xs" data-run-retry="${r.id}">Повторить</button>`}
                </div>
              </div>
            `).join("") || `<div class="muted" style="font-size:11px;">Запусков ещё не было</div>`}
          </div>

          <div style="border-top:1px solid var(--border); padding-top:8px;">
            <div id="sa-direct-msgs" class="col" style="max-height:200px; overflow-y:auto; margin-bottom:8px;">
              ${st.subMessages.map((m) => `<div class="card-sm"><b>${m.role === "user" ? "Вы" : "Субагент"}:</b> ${renderMarkdown(m.content || "")}</div>`).join("") || `<div class="muted" style="font-size:11px;">Выберите субагента для прямого чата</div>`}
            </div>
            <div class="row">
              <input id="sa-direct-input" class="input input-sm" style="flex:1" placeholder="Написать выбранному субагенту…" ${st.selectedSubId ? "" : "disabled"} />
              <button type="button" id="sa-direct-send" class="btn btn-sm btn-primary" ${st.selectedSubId ? "" : "disabled"}>Отправить</button>
            </div>
          </div>
        </div>
      </div>
    `;

    host.querySelector("#sa-refresh-btn").onclick = refreshSubagents;
    host.querySelector("#sa-routing-mode").onchange = async (ev) => {
      try {
        await apiJson("/api/agent/subagents", { method: "PATCH", body: JSON.stringify({ routingMode: ev.target.value }) });
        showToast("Режим маршрутизации обновлён", "ok");
      } catch (err) { showToast(err.message, "error"); }
    };
    host.querySelector("#ov-unlock-api").onchange = (ev) => {
      host.querySelector("#ov-custom-api").style.display = ev.target.checked ? "grid" : "none";
    };
    // Мгновенное переключение Надсмотрщика
    host.querySelector("#ov-enabled-chk").onchange = async (ev) => {
      const next = Boolean(ev.target.checked);
      try {
        await apiJson("/api/agent/subagents", {
          method: "PATCH",
          body: JSON.stringify({ overseer: { enabled: next } }),
        });
        ov.enabled = next;
        const badge = host.querySelector("#ov-badge");
        badge.textContent = next ? "Надсмотрщик: вкл" : "Надсмотрщик: выкл";
        badge.className = `badge ${next ? "badge-amber" : ""}`;
        showToast(next ? "Надсмотрщик включён" : "Надсмотрщик полностью отключён", "ok");
      } catch (err) {
        ev.target.checked = !next;
        showToast(err.message, "error");
      }
    };
    host.querySelector("#ov-save-btn").onclick = async () => {
      try {
        const keyVal = host.querySelector("#ov-api-key").value.trim();
        await apiJson("/api/agent/subagents", {
          method: "PATCH",
          body: JSON.stringify({
            overseer: {
              enabled: host.querySelector("#ov-enabled-chk").checked,
              mode: host.querySelector("#ov-mode").value,
              systemPrompt: host.querySelector("#ov-system-prompt").value,
              unlockApi: host.querySelector("#ov-unlock-api").checked,
              baseUrl: host.querySelector("#ov-base-url").value.trim(),
              model: host.querySelector("#ov-model").value.trim(),
              ...(keyVal ? { apiKey: keyVal } : {}),
            },
          }),
        });
        showToast("Настройки Надсмотрщика сохранены", "ok");
        await refreshSubagents();
      } catch (err) { showToast(err.message, "error"); }
    };

    host.querySelector("#sa-new-btn").onclick = () => { st.editingSubagentId = 0; renderSubagentsPanel(); };
    if (host.querySelector("#sa-cancel-edit")) {
      host.querySelector("#sa-cancel-edit").onclick = () => { st.editingSubagentId = 0; renderSubagentsPanel(); };
    }
    host.querySelectorAll("[data-sa-edit]").forEach((b) => {
      b.onclick = () => { st.editingSubagentId = Number(b.getAttribute("data-sa-edit")); renderSubagentsPanel(); };
    });
    host.querySelectorAll("[data-sa-del]").forEach((b) => {
      b.onclick = async () => {
        const id = Number(b.getAttribute("data-sa-del"));
        await apiJson(`/api/agent/subagents/${id}`, { method: "DELETE" });
        await refreshSubagents();
      };
    });
    host.querySelector("#sa-save-form").onclick = async () => {
      const payload = {
        name: host.querySelector("#sa-f-name").value.trim(),
        roleTitle: host.querySelector("#sa-f-role").value.trim(),
        toolProfile: host.querySelector("#sa-f-profile").value,
        color: host.querySelector("#sa-f-color").value,
        isActive: host.querySelector("#sa-f-enabled").checked,
        systemPrompt: host.querySelector("#sa-f-sys").value,
      };
      try {
        if (st.editingSubagentId) {
          await apiJson(`/api/agent/subagents/${st.editingSubagentId}`, { method: "PATCH", body: JSON.stringify(payload) });
        } else {
          await apiJson("/api/agent/subagents", { method: "POST", body: JSON.stringify(payload) });
        }
        st.editingSubagentId = 0;
        await refreshSubagents();
        showToast("Субагент сохранён", "ok");
      } catch (err) { showToast(err.message, "error"); }
    };

    host.querySelectorAll("[data-sa-chat]").forEach((b) => {
      b.onclick = () => {
        st.selectedSubId = Number(b.getAttribute("data-sa-chat"));
        st.activeSubConvId = 0;
        st.subMessages = [];
        refreshSubagents();
      };
    });
    host.querySelector("#sa-chat-select").onchange = (ev) => {
      st.selectedSubId = Number(ev.target.value || 0);
      st.activeSubConvId = 0;
      st.subMessages = [];
      refreshSubagents();
    };
    host.querySelectorAll("[data-run-cancel]").forEach((b) => {
      b.onclick = async () => {
        await apiJson(`/api/agent/subagents/runs/${b.getAttribute("data-run-cancel")}/cancel`, { method: "POST", body: "{}" });
        await refreshSubagents();
      };
    });
    host.querySelectorAll("[data-run-retry]").forEach((b) => {
      b.onclick = async () => {
        const res = await apiJson(`/api/agent/subagents/runs/${b.getAttribute("data-run-retry")}/retry`, { method: "POST", body: "{}" });
        showToast("Запуск подготовлен к повтору", "ok");
        const subId = res.run?.subagentId || res.subagentId;
        if (subId) { st.selectedSubId = subId; }
        if (res.conversation?.id) { st.activeSubConvId = res.conversation.id; }
        await refreshSubagents();
      };
    });

    host.querySelector("#sa-direct-send").onclick = async () => {
      const inp = host.querySelector("#sa-direct-input");
      const text = inp.value.trim();
      if (!text || !st.selectedSubId || st.subStreaming) return;
      syncAgentSettingsFromDom();
      inp.value = "";
      st.subStreaming = true;
      try {
        if (!st.activeSubConvId) {
          const conv = await apiJson("/api/agent/conversations", {
            method: "POST",
            body: JSON.stringify({ kind: "subagent", subagentId: st.selectedSubId, title: text.slice(0, 60) }),
          });
          st.activeSubConvId = conv.conversation.id;
        }
        st.subMessages.push({ role: "user", content: text });
        const reply = { role: "assistant", content: "…" };
        st.subMessages.push(reply);
        renderSubagentsPanel();

        const res = await apiFetch("/api/ai/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentRole: "subagent",
            subagentId: st.selectedSubId,
            subagentConversationId: st.activeSubConvId,
            messages: st.subMessages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
            settings: { baseUrl: st.settings.baseUrl, apiKey: st.settings.apiKey, model: st.settings.model },
            trustLevel: st.settings.trustLevel,
            sandboxProject: st.sandboxProject,
          }),
        });
        await consumeSseStream(res, (ev, d) => {
          if (!d) return;
          if ((ev === "text" || ev === "subagent_text") && d.text) reply.content = d.text;
          if (ev === "done" && d.text && reply.content === "…") reply.content = d.text;
          const dm = host.querySelector("#sa-direct-msgs");
          if (dm) dm.innerHTML = st.subMessages.map((m) => `<div class="card-sm"><b>${m.role === "user" ? "Вы" : "Субагент"}:</b> ${renderMarkdown(m.content || "")}</div>`).join("");
        });
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        st.subStreaming = false;
        await refreshSubagents();
      }
    };
  }

  // ---- Тестировщик (QA) ----
  async function refreshTesterConvs() {
    try {
      const res = await apiJson("/api/agent/conversations?kind=tester");
      st.testerConvs = res.conversations || [];
      root.querySelector("#qa-conv-list").innerHTML = st.testerConvs.map((c) => `
        <div class="list-item ${c.id === st.activeTesterConvId ? "active" : ""}" data-qa-conv="${c.id}">
          <div>${esc(c.title)}</div>
        </div>
      `).join("") || `<div class="muted" style="font-size:11px;">Сессий QA нет</div>`;
      root.querySelectorAll("[data-qa-conv]").forEach((row) => {
        row.onclick = async () => {
          const id = Number(row.getAttribute("data-qa-conv"));
          st.activeTesterConvId = id;
          const det = await apiJson(`/api/agent/conversations/${id}`);
          st.testerMessages = det.messages || [];
          renderQaMsgs();
        };
      });
    } catch {}
  }
  function renderQaMsgs() {
    const h = root.querySelector("#qa-messages");
    h.innerHTML = st.testerMessages.map((m) => `
      <div class="bubble ${m.role === "user" ? "bubble-user" : "bubble-assistant"}">
        <div class="bubble-meta"><span>${m.role === "user" ? "Вы" : "🧪 QA"}</span></div>
        ${renderMarkdown(m.content || "")}
      </div>
    `).join("") || `<div class="card-2" style="padding:16px; margin:auto;">Опишите, что протестировать в проекте песочницы.</div>`;
    h.scrollTop = h.scrollHeight;
  }
  root.querySelector("#qa-new-conv").onclick = async () => {
    const c = await apiJson("/api/agent/conversations", { method: "POST", body: JSON.stringify({ kind: "tester", title: "QA проверка" }) });
    st.activeTesterConvId = c.conversation.id;
    st.testerMessages = [];
    await refreshTesterConvs();
    renderQaMsgs();
  };
  root.querySelector("#qa-send-btn").onclick = async () => {
    const inp = root.querySelector("#qa-input");
    const text = inp.value.trim();
    if (!text || st.testerStreaming) return;
    syncAgentSettingsFromDom();
    inp.value = "";
    st.testerStreaming = true;
    try {
      if (!st.activeTesterConvId) {
        const c = await apiJson("/api/agent/conversations", { method: "POST", body: JSON.stringify({ kind: "tester", title: text.slice(0, 60) }) });
        st.activeTesterConvId = c.conversation.id;
      }
      st.testerMessages.push({ role: "user", content: text });
      const ans = { role: "assistant", content: "Проверяю…" };
      st.testerMessages.push(ans);
      renderQaMsgs();
      const res = await apiFetch("/api/ai/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentRole: "tester",
          testerConversationId: st.activeTesterConvId,
          messages: st.testerMessages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
          settings: { baseUrl: st.settings.baseUrl, apiKey: st.settings.apiKey, model: st.settings.model },
          trustLevel: st.settings.trustLevel,
          sandboxProject: st.sandboxProject,
        }),
      });
      await consumeSseStream(res, (ev, d) => {
        if (!d) return;
        if ((ev === "text" || ev === "tester_text") && d.text) ans.content = d.text;
        if (ev === "tester_done" && d.fullResponse && ans.content === "Проверяю…") ans.content = d.fullResponse;
        if (ev === "done" && d.text && ans.content === "Проверяю…") ans.content = d.text;
        renderQaMsgs();
      });
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      st.testerStreaming = false;
      await refreshTesterConvs();
    }
  };

  refreshConvs();
  renderAgentMessages();
  loadRagAndGithub();
  apiJson("/api/ai/agent").then(renderAgentHealth).catch(() => {});

  return { refresh: refreshConvs };
}
