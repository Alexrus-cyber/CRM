import {
  apiFetch,
  apiJson,
  confirmDialog,
  consumeSseStream,
  esc,
  formatBytes,
  formatDateTime,
  formatTokens,
  promptDialog,
  readBrowserFileToAttachment,
  readClipboardImages,
  renderMarkdown,
  showToast,
  subscribeAppEvents,
  triggerFileDownload,
  withHtQuery,
} from "/app.js";

const TOOL_PROFILES = [
  ["full", "Полный профиль (код, bash, файлы, браузер)"],
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
    convSearch: "",
    activeConvId: 0,
    messages: [],
    openDetails: new Set(),
    pendingFiles: [],
    streaming: false,
    abortCtrl: null,
    approvals: [],

    sandbox: { available: false, files: [], items: [], rootFiles: [], projects: [], processes: [], totalProjects: 0, totalFiles: 0, totalSize: 0, root: "" },
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
              <div class="search-wrap">
                <input id="ag-conv-search" class="input input-sm" placeholder="🔍 Поиск по чатам…" />
                <button type="button" id="ag-conv-search-clear" class="search-clear" title="Очистить" style="display:none;">✕</button>
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
            <div class="card-sm row-between" style="margin-bottom:8px;">
              <div class="row">
                <span id="ag-conv-title" style="font-weight:600; font-size:13px;">Новый чат Агента</span>
                <button type="button" id="ag-rename-conv" class="btn btn-xs btn-ghost" title="Переименовать чат" style="display:none;">✎</button>
              </div>
              <span id="ag-sb-quick-badge" class="muted" style="font-size:11px;">Sandbox: —</span>
            </div>
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
                <div id="ag-sb-stats" class="muted" style="font-size:11px;">Изолированная рабочая папка локального Агента</div>
                <div id="ag-sb-root-path" class="muted mono" style="font-size:10.5px;"></div>
              </div>
              <div class="row">
                <a id="ag-sb-dl-all" class="btn btn-xs" href="#">⬇ Всё (ZIP)</a>
                <button type="button" id="ag-sb-refresh" class="btn btn-xs">↻ Обновить</button>
              </div>
            </div>
            <div id="ag-sb-projects" class="col"></div>
            <div id="ag-sb-files-wrap" class="mt-3"></div>
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
    </div>
  `;

  // Переключение подвкладок Агента
  root.querySelectorAll("[data-ag-subtab]").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.getAttribute("data-ag-subtab");
      st.subtab = id;
      root.querySelectorAll("[data-ag-subtab]").forEach((b) => b.classList.toggle("active", b.getAttribute("data-ag-subtab") === id));
      root.querySelectorAll(".ag-subpanel").forEach((p) => { p.hidden = p.id !== `ag-panel-${id}`; });
      if (id === "chat") { refreshConvs({ background: true, syncActive: true }); }
      if (id === "config") { loadRagAndGithub(); }
      if (id === "sandbox") { refreshSandbox(); refreshTranscripts(); }
      if (id === "subagents") { refreshSubagents(); }
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
        await refreshSandbox();
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

  function resolveSandboxPathForFile(f) {
    if (!f) return "";
    if (f.sandboxPath || f.path) return String(f.sandboxPath || f.path);
    const items = st.sandbox?.items || st.sandbox?.files || [];
    const fname = String(f.name || "").trim();
    if (!fname) return "";
    const exactDl = items.find((it) => it.type === "file" && it.path === `downloads/${fname}`);
    if (exactDl) return exactDl.path;
    const byName = items.find((it) => it.type === "file" && (it.name === fname || String(it.path || "").endsWith(`/${fname}`) || it.path === fname));
    return byName ? String(byName.path) : "";
  }

  function upsertFileEntry(targetArr, rawFile) {
    if (!rawFile || !rawFile.name) return;
    const norm = {
      name: String(rawFile.name),
      mime: String(rawFile.mime || "application/octet-stream"),
      size: Number(rawFile.size || 0) || 0,
      ...(rawFile.data ? { data: String(rawFile.data) } : {}),
      ...(rawFile.sandboxPath ? { sandboxPath: String(rawFile.sandboxPath) } : {}),
      ...(rawFile.path ? { path: String(rawFile.path) } : {}),
    };
    const idx = targetArr.findIndex((x) => x.name === norm.name);
    if (idx >= 0) targetArr[idx] = { ...targetArr[idx], ...norm };
    else targetArr.push(norm);
  }

  let sbRefreshTimer = null;
  function scheduleRefreshSandbox() {
    if (sbRefreshTimer) return;
    sbRefreshTimer = setTimeout(() => {
      sbRefreshTimer = null;
      refreshSandbox();
    }, 300);
  }

  function renderAgentMessages() {
    const activeConv = st.conversations.find((c) => c.id === st.activeConvId);
    const titleEl = root.querySelector("#ag-conv-title");
    const renBtn = root.querySelector("#ag-rename-conv");
    if (titleEl) titleEl.textContent = activeConv ? activeConv.title : "Новый чат Агента";
    if (renBtn) renBtn.style.display = activeConv ? "" : "none";

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

    const detailOpen = (key, autoOpen) => (st.openDetails.has(key) ? "open" : (autoOpen ? "open" : ""));

    elMsgs.innerHTML = st.messages.map((m, msgIdx) => {
      if (m.role === "user") {
        return `
          <div class="bubble bubble-user">
            <div class="bubble-meta"><span>Вы</span></div>
            <div class="md-content">${esc(m.content).replace(/\n/g, "<br/>")}</div>
          </div>
        `;
      }
      const rKey = `ag-r-${msgIdx}`;
      const reasoningHtml = m.reasoning
        ? `<details class="reasoning-box" data-detail-key="${rKey}" ${detailOpen(rKey, m.streaming && !m.content)}>
             <summary class="reasoning-toggle"><span>🧠 Раздумья (${m.reasoning.length} симв.)</span>${m.streaming ? '<span class="dot dot-amber dot-pulse"></span>' : ""}</summary>
             <div class="reasoning-body">${esc(m.reasoning)}</div>
           </details>`
        : "";
      const subCards = (m.subagents || []).map((s, subIdx) => {
        const srKey = `ag-sub-r-${msgIdx}-${subIdx}`;
        const saKey = `ag-sub-a-${msgIdx}-${subIdx}`;
        const isRunning = s.status === "running";
        const badgeCls = s.status === "completed" ? "badge-emerald" : (s.status === "error" || s.status === "blocked" ? "badge-red" : "badge-accent");
        const subReason = s.reasoning
          ? `<details class="reasoning-box mt-2" data-detail-key="${srKey}" ${detailOpen(srKey, isRunning && !s.text)}>
               <summary class="reasoning-toggle"><span>🧠 Рассуждения субагента (${s.reasoning.length} симв.)</span>${isRunning ? '<span class="dot dot-amber dot-pulse"></span>' : ""}</summary>
               <div class="reasoning-body">${esc(s.reasoning)}</div>
             </details>`
          : "";
        const subSteps = (s.actions || []).length
          ? `<details class="mt-2" data-detail-key="${saKey}" ${detailOpen(saKey, false)}>
               <summary class="muted" style="cursor:pointer; font-size:11px;">🔧 Шаги субагента (${s.actions.length})</summary>
               <div class="subagent-steps">
                 ${s.actions.slice(-20).map((act) => `<div>• <b>${esc(act.label || act.tool || act.type || "шаг")}</b>${act.summary ? `: <span class="muted">${esc(act.summary)}</span>` : ""}</div>`).join("")}
               </div>
             </details>`
          : "";
        const subFiles = (s.files || []).length
          ? `<div class="file-dl-list">${s.files.map((sf, sfIdx) => {
              const canDl = Boolean(sf.data || resolveSandboxPathForFile(sf));
              return `<button type="button" class="file-dl-btn" data-dl-subfile="${msgIdx}:${subIdx}:${sfIdx}" ${canDl ? "" : "disabled"}>⬇ ${esc(sf.name || sf.path)} ${sf.size ? `<span class="muted">(${esc(formatBytes(sf.size))})</span>` : ""}</button>`;
            }).join("")}</div>`
          : "";
        return `
          <div class="subagent-card">
            <div class="row-between">
              <div class="row">
                ${s.color ? `<span class="dot" style="background:${esc(s.color)}"></span>` : ""}
                <strong>🕸 ${esc(s.subagentName || s.subagentSlug || "Субагент")}</strong>
                <span class="badge ${badgeCls}">${esc(s.status || "running")}</span>
                ${isRunning ? '<span class="dot dot-amber dot-pulse"></span>' : ""}
              </div>
              ${s.statusText ? `<span class="muted" style="font-size:11px;">${esc(s.statusText)}</span>` : ""}
            </div>
            ${subReason}
            ${subSteps}
            ${s.text ? `<div class="mt-2 md-content">${renderMarkdown(s.text)}</div>` : ""}
            ${s.outputSummary && !s.text ? `<div class="mt-2 muted" style="font-size:11.5px;">${esc(s.outputSummary)}</div>` : ""}
            ${s.error ? `<div class="mt-2 text-red" style="font-size:11.5px;">Ошибка: ${esc(s.error)}</div>` : ""}
            ${subFiles}
          </div>
        `;
      }).join("");
      const ovCards = (m.overseer || []).map((ov, ovIdx) => {
        const ovKey = `ag-ov-r-${msgIdx}-${ovIdx}`;
        const ovReason = ov.reasoning
          ? `<details class="reasoning-box mt-1" data-detail-key="${ovKey}" ${detailOpen(ovKey, ov.status === "проверка")}>
               <summary class="reasoning-toggle"><span>🧠 Раздумья Надсмотрщика (${ov.reasoning.length} симв.)</span></summary>
               <div class="reasoning-body">${esc(ov.reasoning)}</div>
             </details>`
          : "";
        return `
          <div class="overseer-card">
            <div class="row-between">
              <strong>👁 Надсмотрщик</strong>
              <span class="badge badge-amber">${esc(ov.status || "проверка")}</span>
            </div>
            ${ovReason}
            ${ov.text || ov.summary ? `<div class="mt-1">${esc(ov.text || ov.summary || "")}</div>` : ""}
          </div>
        `;
      }).join("");
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
        ? `<div class="file-dl-list">${m.files.map((f, fIdx) => {
            const resolvedPath = resolveSandboxPathForFile(f);
            const canDl = Boolean(f.data || resolvedPath);
            return `<button type="button" class="file-dl-btn" data-dl-msgfile="${msgIdx}:${fIdx}" title="${canDl ? "Скачать файл" : "Файл не найден на диске"}">⬇ ${esc(f.name || f.path)} ${f.size ? `<span class="muted">(${esc(formatBytes(f.size))})</span>` : ""}</button>`;
          }).join("")}</div>`
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

    elMsgs.querySelectorAll("details[data-detail-key]").forEach((det) => {
      det.ontoggle = () => {
        const key = det.getAttribute("data-detail-key");
        if (det.open) st.openDetails.add(key);
        else st.openDetails.delete(key);
      };
    });
    elMsgs.querySelectorAll("[data-dl-msgfile]").forEach((btn) => {
      btn.onclick = () => {
        const [mIdx, fIdx] = btn.getAttribute("data-dl-msgfile").split(":").map(Number);
        const f = st.messages[mIdx]?.files?.[fIdx];
        if (!f) return;
        const resolved = resolveSandboxPathForFile(f);
        if (!f.data && !resolved) {
          showToast("Файл отсутствует на диске Sandbox (возможно, был удалён)", "error");
          return;
        }
        triggerFileDownload(resolved ? { ...f, sandboxPath: resolved } : f);
      };
    });
    elMsgs.querySelectorAll("[data-dl-subfile]").forEach((btn) => {
      btn.onclick = () => {
        const [mIdx, sIdx, fIdx] = btn.getAttribute("data-dl-subfile").split(":").map(Number);
        const f = st.messages[mIdx]?.subagents?.[sIdx]?.files?.[fIdx];
        if (!f) return;
        const resolved = resolveSandboxPathForFile(f);
        if (!f.data && !resolved) {
          showToast("Файл отсутствует на диске Sandbox", "error");
          return;
        }
        triggerFileDownload(resolved ? { ...f, sandboxPath: resolved } : f);
      };
    });
    elMsgs.scrollTop = elMsgs.scrollHeight;
  }

  function renderConvList() {
    const host = root.querySelector("#ag-conv-list");
    if (!host) return;
    const q = (st.convSearch || "").trim().toLowerCase();
    const visible = q
      ? st.conversations.filter((c) => String(c.title || "Чат агента").toLowerCase().includes(q))
      : st.conversations;
    host.innerHTML = visible.length
      ? visible.map((c) => `
          <div class="list-item ${c.id === st.activeConvId ? "active" : ""}" data-ag-conv="${c.id}">
            <div style="min-width:0; flex:1;">
              <div style="font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(c.title)}</div>
              <div class="muted" style="font-size:10px;">${c.messagesCount || 0} сообщ.</div>
            </div>
            <div class="list-item-actions">
              <button type="button" class="btn btn-xs btn-ghost" data-rename-ag-conv="${c.id}" title="Переименовать чат">✎</button>
              <button type="button" class="btn btn-xs btn-ghost text-red" data-del-ag-conv="${c.id}" title="Удалить чат">✕</button>
            </div>
          </div>
        `).join("")
      : `<div class="muted" style="font-size:11px;">${q ? "По запросу ничего не найдено" : "Чатов агента нет"}</div>`;

    host.querySelectorAll("[data-ag-conv]").forEach((row) => {
      row.onclick = (ev) => {
        if (ev.target.closest("[data-del-ag-conv], [data-rename-ag-conv]")) return;
        loadConv(Number(row.getAttribute("data-ag-conv")));
      };
    });
    host.querySelectorAll("[data-rename-ag-conv]").forEach((b) => {
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const id = Number(b.getAttribute("data-rename-ag-conv"));
        const c = st.conversations.find((x) => x.id === id);
        await renameAgentConv(id, c?.title || "");
      };
    });
    host.querySelectorAll("[data-del-ag-conv]").forEach((b) => {
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const id = Number(b.getAttribute("data-del-ag-conv"));
        const c = st.conversations.find((x) => x.id === id);
        const ok = await confirmDialog({
          title: "Удалить чат Агента?",
          message: `Удалить сессию «${c?.title || `#${id}`}» и всю историю сообщений?`,
          confirmLabel: "Удалить",
        });
        if (!ok) return;
        try {
          await apiJson(`/api/agent/conversations/${id}`, { method: "DELETE" });
          if (st.activeConvId === id) { st.activeConvId = 0; st.messages = []; renderAgentMessages(); }
          await refreshConvs();
          showToast("Чат Агента удалён", "ok");
        } catch (err) {
          showToast(err.message, "error");
        }
      };
    });
  }

  async function renameAgentConv(convId, currentTitle) {
    const nextTitle = await promptDialog({
      title: "Переименовать чат Агента",
      defaultValue: currentTitle || "Новый чат",
      placeholder: "Название чата",
      confirmLabel: "Сохранить",
    });
    if (nextTitle === null) return;
    const clean = nextTitle.trim();
    if (!clean) {
      showToast("Название чата не может быть пустым", "error");
      return;
    }
    try {
      await apiJson(`/api/agent/conversations/${convId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: clean }),
      });
      const target = st.conversations.find((c) => c.id === convId);
      if (target) target.title = clean;
      renderConvList();
      renderAgentMessages();
      showToast("Название чата обновлено", "ok");
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async function refreshConvs(opts = {}) {
    try {
      const res = await apiJson("/api/agent/conversations?kind=agent");
      const nextConvs = res.conversations || [];
      const prevActive = st.conversations.find((c) => c.id === st.activeConvId);
      const nextActive = nextConvs.find((c) => c.id === st.activeConvId);
      st.conversations = nextConvs;
      renderConvList();
      if (
        opts.syncActive &&
        !st.streaming &&
        st.activeConvId &&
        nextActive &&
        prevActive &&
        (prevActive.messagesCount !== nextActive.messagesCount || prevActive.updatedAt !== nextActive.updatedAt)
      ) {
        await loadConv(st.activeConvId, { quiet: true });
      }
    } catch {
      /* ignore */
    }
  }

  async function loadConv(id, opts = {}) {
    try {
      const res = await apiJson(`/api/agent/conversations/${id}`);
      const prevCount = st.messages.length;
      const incoming = (res.messages || []).map((m) => {
        let acts = [];
        try { acts = typeof m.actions === "string" ? JSON.parse(m.actions || "[]") : (Array.isArray(m.actions) ? m.actions : []); } catch {}
        let fls = [];
        try { fls = typeof m.files === "string" ? JSON.parse(m.files || "[]") : (Array.isArray(m.files) ? m.files : []); } catch {}
        const subagents = [];
        const visibleActs = [];
        for (const a of acts) {
          if (!a || typeof a !== "object") continue;
          if (a.type === "subagent_report") {
            subagents.push({
              runKey: a.runKey || String(a.runId || subagents.length),
              subagentName: a.subagentName || a.subagentSlug || "Субагент",
              status: a.status || "completed",
              statusText: a.statusText || "",
              reasoning: a.reasoning || "",
              text: a.text || a.fullResponse || "",
              outputSummary: a.outputSummary || a.summary || "",
              actions: Array.isArray(a.actions) ? a.actions : [],
              files: Array.isArray(a.files) ? a.files : [],
            });
          } else {
            visibleActs.push(a);
          }
        }
        return {
          role: m.role,
          content: m.content || "",
          reasoning: m.reasoning || "",
          actions: visibleActs,
          subagents,
          files: fls,
          error: Boolean(m.error),
        };
      });
      if (opts.quiet && st.activeConvId === id && prevCount === incoming.length) return;
      st.activeConvId = id;
      st.messages = incoming;
      renderConvList();
      renderAgentMessages();
    } catch (err) {
      if (!opts.quiet) showToast(err.message, "error");
    }
  }

  async function ensureConvId(titleHint = "Новый чат") {
    if (st.activeConvId > 0) return st.activeConvId;
    const res = await apiJson("/api/agent/conversations", {
      method: "POST",
      body: JSON.stringify({ kind: "agent", title: titleHint.slice(0, 80) }),
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

  function sanitizeActionForDb(a) {
    if (!a || typeof a !== "object") return null;
    const out = {};
    for (const [k, v] of Object.entries(a)) {
      if (k === "data" || k === "preview" || k === "_image" || k === "_images") continue;
      if (typeof v === "string" && v.startsWith("data:image/")) continue;
      out[k] = v;
    }
    return out;
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

      const findSubCard = (d) => {
        const rk = d.runKey || d.subagentRunKey;
        if (rk) {
          const byRk = aMsg.subagents.find((s) => s.runKey === rk);
          if (byRk) return byRk;
        }
        if (d.runId) {
          const byId = aMsg.subagents.find((s) => s.runId && s.runId === d.runId);
          if (byId) return byId;
        }
        return aMsg.subagents.length ? aMsg.subagents[aMsg.subagents.length - 1] : null;
      };

      await consumeSseStream(res, (ev, data) => {
        if (ev === "__keepalive__" || !data) return;
        if (ev === "status") {
          aMsg.status = data.message || data.stage || data.text || "";
        } else if (ev === "reasoning") {
          aMsg.reasoning = typeof data.text === "string" ? data.text : aMsg.reasoning + String(data.delta || "");
        } else if (ev === "text") {
          aMsg.content = typeof data.text === "string" ? data.text : aMsg.content + String(data.delta || "");
        } else if (ev === "action") {
          if (data.type === "file") {
            upsertFileEntry(aMsg.files, data);
            scheduleRefreshSandbox();
          } else {
            aMsg.actions.push(data);
            if (data.type === "sandbox_update" || data.type === "sandbox_write_file" || data.type === "sandbox_create_project") {
              if (data.path && data.kind !== "dir") {
                upsertFileEntry(aMsg.files, {
                  name: data.name || String(data.path).split("/").pop(),
                  size: data.size || 0,
                  sandboxPath: data.path,
                });
              }
              scheduleRefreshSandbox();
            }
          }
        } else if (ev === "approval_required") {
          st.approvals.push(data);
          renderApprovals();
        } else if (ev === "subagent_run") {
          const existing = findSubCard(data);
          if (existing) {
            if (data.runId) existing.runId = data.runId;
            if (data.subagentName) existing.subagentName = data.subagentName;
            if (data.color) existing.color = data.color;
          } else {
            aMsg.subagents.push({
              runKey: data.runKey || String(data.runId || Date.now()),
              runId: data.runId || null,
              subagentId: data.subagentId || null,
              subagentName: data.subagentName || data.subagentSlug || "Субагент",
              subagentSlug: data.subagentSlug || "",
              color: data.color || "#7c5cff",
              status: "running",
              statusText: "запуск…",
              reasoning: "",
              actions: [],
              files: [],
              text: "",
              outputSummary: "",
            });
          }
        } else if (ev === "subagent_status") {
          const card = findSubCard(data);
          if (card) card.statusText = data.text || data.message || data.stage || "";
        } else if (ev === "subagent_reasoning") {
          const card = findSubCard(data);
          if (card) {
            card.reasoning = typeof data.text === "string"
              ? data.text
              : (card.reasoning || "") + String(data.delta || "");
          }
        } else if (ev === "subagent_text") {
          const card = findSubCard(data);
          if (card) {
            card.text = typeof data.text === "string"
              ? data.text
              : (card.text || "") + String(data.delta || "");
          }
        } else if (ev === "subagent_action") {
          const card = findSubCard(data);
          const act = data.action || data;
          if (card && act) {
            if (act.type === "file") {
              upsertFileEntry(card.files, act);
              upsertFileEntry(aMsg.files, act);
              scheduleRefreshSandbox();
            } else {
              card.actions.push(act);
              if (act.type === "sandbox_update") {
                if (act.path && act.kind !== "dir") {
                  const fObj = { name: act.name || String(act.path).split("/").pop(), size: act.size || 0, sandboxPath: act.path };
                  upsertFileEntry(card.files, fObj);
                  upsertFileEntry(aMsg.files, fObj);
                }
                scheduleRefreshSandbox();
              }
            }
          }
        } else if (ev === "subagent_handoff" || ev === "subagent_chat_rotated" || ev === "subagent_handoff_new_chat") {
          const card = findSubCard(data);
          if (card) {
            card.statusText = data.message || data.reason || "передача задачи";
          }
        } else if (ev === "subagent_done") {
          const card = findSubCard(data);
          if (card) {
            card.status = data.status || "completed";
            card.statusText = card.status === "completed" ? "готово" : card.status;
            card.outputSummary = data.outputSummary || data.reportSummary || card.outputSummary || "";
            if (data.fullResponse) card.text = data.fullResponse;
            if (data.reasoning && !card.reasoning) card.reasoning = data.reasoning;
            if (Array.isArray(data.actions) && !card.actions.length) card.actions = data.actions;
            if (Array.isArray(data.files)) {
              for (const sf of data.files) {
                upsertFileEntry(card.files, sf);
                upsertFileEntry(aMsg.files, sf);
              }
            }
            if (data.error) card.error = data.error;
          }
        } else if (ev === "subagent_error") {
          const card = findSubCard(data);
          if (card) {
            card.status = "error";
            card.error = data.message || data.error || "Ошибка субагента";
          }
        } else if (ev === "overseer_start" || ev === "overseer_status" || ev === "overseer_reasoning" || ev === "overseer_done") {
          let ov = aMsg.overseer.find((o) => o.subagentRunKey && data.subagentRunKey && o.subagentRunKey === data.subagentRunKey);
          if (!ov && aMsg.overseer.length && ev !== "overseer_start") {
            ov = aMsg.overseer[aMsg.overseer.length - 1];
          }
          if (!ov) {
            ov = { subagentRunKey: data.subagentRunKey || "", status: "проверка", reasoning: "", text: "", summary: "" };
            aMsg.overseer.push(ov);
          }
          if (ev === "overseer_reasoning") {
            ov.reasoning = typeof data.text === "string" ? data.text : (ov.reasoning || "") + String(data.delta || "");
          } else {
            ov.status = ev === "overseer_done" ? (data.verdict || "проверено") : (data.status || "проверка");
            const msgTxt = data.text || data.message || data.reason || data.summary;
            if (msgTxt) ov.text = msgTxt;
          }
        } else if (ev === "done") {
          aMsg.status = "готово";
          if (data.text && !aMsg.content) aMsg.content = data.text;
          if (Array.isArray(data.files)) {
            for (const df of data.files) upsertFileEntry(aMsg.files, df);
          }
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
      await refreshSandbox();
      renderAgentMessages();
      const subReportsForDb = (aMsg.subagents || []).map((s) => ({
        type: "subagent_report",
        runKey: s.runKey,
        subagentName: s.subagentName,
        subagentSlug: s.subagentSlug,
        status: s.status,
        outputSummary: s.outputSummary || "",
        text: (s.text || "").slice(0, 8000),
        reasoning: (s.reasoning || "").slice(0, 8000),
      }));
      const cleanActsForDb = [
        ...aMsg.actions.map(sanitizeActionForDb).filter(Boolean),
        ...subReportsForDb,
      ];
      const cleanFilesForDb = (aMsg.files || []).map((f) => ({
        name: f.name || "file",
        mime: f.mime || "application/octet-stream",
        size: Number(f.size || 0) || 0,
        ...(f.sandboxPath ? { sandboxPath: f.sandboxPath } : {}),
      }));
      if (aMsg.content || cleanActsForDb.length || cleanFilesForDb.length) {
        apiJson(`/api/agent/conversations/${convId}/messages`, {
          method: "POST",
          body: JSON.stringify({
            role: "assistant",
            content: aMsg.content || "[Выполнено]",
            reasoning: aMsg.reasoning,
            actions: cleanActsForDb,
            files: cleanFilesForDb,
            error: aMsg.error ? aMsg.content : undefined,
          }),
        }).catch(() => {});
      }
      refreshConvs();
      if (aMsg.subagents.length) refreshSubagents();
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

  const elAgSearch = root.querySelector("#ag-conv-search");
  const elAgSearchClear = root.querySelector("#ag-conv-search-clear");
  elAgSearch.oninput = () => {
    st.convSearch = elAgSearch.value;
    elAgSearchClear.style.display = st.convSearch ? "" : "none";
    renderConvList();
  };
  elAgSearchClear.onclick = () => {
    st.convSearch = "";
    elAgSearch.value = "";
    elAgSearchClear.style.display = "none";
    renderConvList();
  };
  root.querySelector("#ag-rename-conv").onclick = () => {
    if (!st.activeConvId) return;
    const active = st.conversations.find((c) => c.id === st.activeConvId);
    renameAgentConv(st.activeConvId, active?.title || "");
  };

  root.querySelector("#ag-new-conv").onclick = async () => {
    const chosen = await promptDialog({
      title: "Новый чат Агента",
      defaultValue: "",
      placeholder: "Название чата (можно оставить пустым)",
      confirmLabel: "Создать",
    });
    if (chosen === null) return;
    st.activeConvId = 0;
    st.messages = [];
    await ensureConvId(chosen.trim() || "Новый чат");
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
    await apiJson("/api/app/prefs", {
      method: "POST",
      body: JSON.stringify({
        localModel: { baseUrl: st.settings.baseUrl, model: st.settings.model, apiKey: st.settings.apiKey },
      }),
    }).catch(() => {});
    try {
      const saved = await apiJson("/api/ai/settings", {
        method: "PUT",
        body: JSON.stringify({
          baseUrl: st.settings.baseUrl,
          model: st.settings.model,
          ...(st.settings.apiKey ? { apiKey: st.settings.apiKey } : {}),
        }),
      });
      const s = saved?.settings || {};
      const keyInp = root.querySelector("#ag-api-key");
      if (keyInp) {
        keyInp.placeholder = s.hasApiKey ? `В БД CRM: ${s.apiKeyHint || "сохранён"} (оставьте пустым чтобы использовать)` : "Пусто — из БД CRM или без ключа";
      }
      showToast("Настройки Агента сохранены в БД CRM", "ok");
    } catch (err) {
      if (err.status === 400 && /127\.0\.0\.1|localhost|запрещ/i.test(err.message || "")) {
        showToast("Локальные настройки Агента сохранены в приложении", "ok");
      } else {
        showToast(err.message, "error");
      }
    }
  };

  async function loadSavedAgentSettings() {
    try {
      const res = await apiJson("/api/ai/settings");
      const s = res?.settings || {};
      if (s.baseUrl) {
        st.settings.baseUrl = s.baseUrl;
        const el = root.querySelector("#ag-base-url");
        if (el) el.value = s.baseUrl;
      }
      if (s.model) {
        st.settings.model = s.model;
        const el = root.querySelector("#ag-model");
        if (el) el.value = s.model;
      }
      const keyInp = root.querySelector("#ag-api-key");
      if (keyInp && s.hasApiKey) {
        keyInp.placeholder = `В БД CRM: ${s.apiKeyHint || "сохранён"} (оставьте пустым чтобы использовать)`;
      }
    } catch {
      /* ignore */
    }
  }

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
      const acc = gh.account || gh.connection || {};
      st.github.enabled = Boolean(acc.enabled);
      st.github.owner = acc.selectedOwner || "";
      st.github.repo = acc.selectedRepo || "";
      st.github.branch = acc.selectedBranch || "main";
      const reposRes = await apiJson("/api/github/repos").catch(() => ({ repos: [] }));
      st.github.repos = reposRes.repos || [];
      box.innerHTML = `
        <div class="row mb-2">
          <span class="badge badge-emerald">✓ @${esc(acc.login || "")}</span>
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

      const projects = sb.projects || [];
      const allItems = (sb.items || sb.files || []).filter((it) => it && it.path);
      const fileItems = allItems.filter((it) => it.type === "file" || (!it.type && !projects.some((p) => p.name === it.path)));
      const totalProjects = sb.totalProjects ?? projects.length;
      const totalFiles = sb.totalFiles ?? (fileItems.length || projects.reduce((sum, p) => sum + Number(p.files ?? p.filesCount ?? 0), 0));
      const totalSize = sb.totalSize ?? (fileItems.reduce((sum, f) => sum + Number(f.size || 0), 0) || projects.reduce((sum, p) => sum + Number(p.size || 0), 0));

      const statsEl = root.querySelector("#ag-sb-stats");
      if (statsEl) {
        statsEl.textContent = `Проектов: ${totalProjects} · Файлов: ${totalFiles} · Размер: ${formatBytes(totalSize)}${sb.agentRunning ? "" : " (чтение с диска)"}`;
      }
      const rootEl = root.querySelector("#ag-sb-root-path");
      if (rootEl) rootEl.textContent = sb.root ? `📁 ${sb.root}` : "";
      const quickBadge = root.querySelector("#ag-sb-quick-badge");
      if (quickBadge) quickBadge.textContent = `Sandbox: ${totalProjects} проект. · ${totalFiles} файл.`;

      const projHost = root.querySelector("#ag-sb-projects");
      projHost.innerHTML = projects.length
        ? projects.map((p) => {
            const pUrl = withHtQuery(`/api/ai/agent/sandbox/preview/${encodeURIComponent(p.name)}`);
            const dUrl = withHtQuery(`/api/ai/agent/sandbox?download=${encodeURIComponent(p.name)}`);
            const cnt = Number(p.files ?? p.filesCount ?? 0) || 0;
            return `
              <div class="card-sm row-between">
                <div>
                  <b>📁 ${esc(p.name)}</b>
                  <div class="muted" style="font-size:10.5px;">${cnt} файл. · ${esc(formatBytes(p.size || 0))}${p.hasIndex ? " · HTML" : ""}</div>
                </div>
                <div class="row">
                  ${p.hasIndex ? `<a class="btn btn-xs btn-primary" href="${esc(pUrl)}" target="_blank">🌐 Превью</a>` : ""}
                  <a class="btn btn-xs" href="${esc(dUrl)}">⬇ ZIP</a>
                  <button type="button" class="btn btn-xs" data-sb-export="${esc(p.name)}">📤 На ПК</button>
                  <button type="button" class="btn btn-xs btn-danger" data-sb-del="${esc(p.name)}" title="Удалить проект">✕</button>
                </div>
              </div>
            `;
          }).join("")
        : `<div class="muted" style="font-size:11.5px;">Папок проектов пока нет</div>`;

      const filesWrap = root.querySelector("#ag-sb-files-wrap");
      const rootFiles = sb.rootFiles?.length
        ? sb.rootFiles
        : fileItems.filter((f) => !String(f.path).includes("/") || String(f.path).startsWith("downloads/"));
      const treeOpen = st.openDetails.has("sb-all-files") ? "open" : "";
      filesWrap.innerHTML = `
        ${rootFiles.length ? `
          <div style="font-weight:600; font-size:12.5px;" class="mb-1">Файлы (${rootFiles.length})</div>
          <div class="col mb-2" style="max-height:190px; overflow-y:auto;">
            ${rootFiles.map((f) => `
              <div class="card-sm row-between">
                <div style="min-width:0; flex:1;">
                  <div class="mono" style="font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">📄 ${esc(f.path || f.name)}</div>
                  <div class="muted" style="font-size:10px;">${esc(formatBytes(f.size || 0))}</div>
                </div>
                <div class="row">
                  <a class="btn btn-xs btn-primary" href="${esc(withHtQuery(`/api/ai/agent/sandbox?download=${encodeURIComponent(f.path || f.name)}`))}">⬇ Скачать</a>
                  <button type="button" class="btn btn-xs" data-sb-export="${esc(f.path || f.name)}" title="Сохранить на ПК">📤</button>
                  <button type="button" class="btn btn-xs btn-danger" data-sb-del="${esc(f.path || f.name)}" title="Удалить файл">✕</button>
                </div>
              </div>
            `).join("")}
          </div>
        ` : ""}
        ${fileItems.length ? `
          <details data-sb-detail="sb-all-files" ${treeOpen}>
            <summary class="muted" style="cursor:pointer; font-size:11.5px;">📂 Все файлы в Sandbox (${fileItems.length})</summary>
            <div class="col mt-1" style="max-height:220px; overflow-y:auto;">
              ${fileItems.slice(0, 200).map((f) => `
                <div class="card-sm row-between" style="padding:4px 8px;">
                  <span class="mono" style="font-size:10.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(f.path)} <span class="muted">(${esc(formatBytes(f.size || 0))})</span></span>
                  <div class="row">
                    <a class="btn btn-xs btn-ghost" href="${esc(withHtQuery(`/api/ai/agent/sandbox?download=${encodeURIComponent(f.path)}`))}">⬇</a>
                    <button type="button" class="btn btn-xs btn-ghost text-red" data-sb-del="${esc(f.path)}">✕</button>
                  </div>
                </div>
              `).join("")}
            </div>
          </details>
        ` : (!projects.length ? `<div class="muted" style="font-size:11.5px;">Файлов в Sandbox пока нет</div>` : "")}
      `;

      const treeDet = filesWrap.querySelector("details[data-sb-detail='sb-all-files']");
      if (treeDet) {
        treeDet.ontoggle = () => {
          if (treeDet.open) st.openDetails.add("sb-all-files");
          else st.openDetails.delete("sb-all-files");
        };
      }

      const bindSbActions = (scope) => {
        scope.querySelectorAll("[data-sb-export]").forEach((b) => {
          b.onclick = async () => {
            const src = b.getAttribute("data-sb-export");
            const pick = await apiJson("/api/app/pick-folder", { method: "POST", body: "{}" });
            if (!pick.ok || !pick.path) return;
            try {
              await apiJson("/api/ai/agent/sandbox", {
                method: "POST",
                body: JSON.stringify({ action: "export", path: src, source: src, destination: pick.path, mode: "copy", confirmed: true }),
              });
              showToast(`Скопировано в ${pick.path}`, "ok");
            } catch (err) { showToast(err.message, "error"); }
          };
        });
        scope.querySelectorAll("[data-sb-del]").forEach((b) => {
          b.onclick = async () => {
            const p = b.getAttribute("data-sb-del");
            const ok = await confirmDialog({
              title: "Удалить из Sandbox?",
              message: `Удалить «${p}» из песочницы? Это действие необратимо.`,
              confirmLabel: "Удалить",
            });
            if (!ok) return;
            try {
              await apiJson("/api/ai/agent/sandbox", { method: "POST", body: JSON.stringify({ action: "delete", path: p, confirmed: true }) });
              await refreshSandbox();
              showToast(`Удалено: ${p}`, "ok");
            } catch (err) { showToast(err.message, "error"); }
          };
        });
      };
      bindSbActions(projHost);
      bindSbActions(filesWrap);

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
          const pid = Number(b.getAttribute("data-sb-stop-pid"));
          const ok = await confirmDialog({
            title: "Остановить процесс Sandbox?",
            message: `Завершить фоновый процесс PID ${pid}?`,
            confirmLabel: "Остановить",
          });
          if (!ok) return;
          try {
            await apiJson("/api/ai/agent/sandbox", { method: "POST", body: JSON.stringify({ action: "stop_process", pid }) });
            await refreshSandbox();
          } catch (err) { showToast(err.message, "error"); }
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
              <div class="row">
                <a class="btn btn-xs" href="${esc(withHtQuery(`/api/agent/transcripts/${t.id}`))}">⬇ .md</a>
                <button type="button" class="btn btn-xs btn-danger" data-tr-del="${t.id}" title="Удалить стенограмму">✕</button>
              </div>
            </div>
          `).join("")
        : `<div class="muted">Стенограмм пока нет</div>`;
      host.querySelectorAll("[data-tr-del]").forEach((b) => {
        b.onclick = async () => {
          const id = Number(b.getAttribute("data-tr-del"));
          const tr = st.transcripts.find((x) => x.id === id);
          const ok = await confirmDialog({
            title: "Удалить стенограмму?",
            message: `Удалить стенограмму «${tr?.title || `#${id}`}»?`,
            confirmLabel: "Удалить",
          });
          if (!ok) return;
          try {
            await apiJson(`/api/agent/transcripts/${id}`, { method: "DELETE" });
            await refreshTranscripts();
            showToast("Стенограмма удалена", "ok");
          } catch (err) { showToast(err.message, "error"); }
        };
      });
    } catch {}
  }

  root.querySelector("#ag-sb-refresh").onclick = refreshSandbox;
  root.querySelector("#ag-tr-refresh").onclick = refreshTranscripts;

  // ---- Субагенты и Надсмотрщик ----
  async function refreshSubagents() {
    const host = root.querySelector("#ag-subagents-host");
    try {
      const qs = st.selectedSubId ? `?subagentId=${st.selectedSubId}${st.activeSubConvId ? `&conversationId=${st.activeSubConvId}` : ""}` : "";
      const data = await apiJson(`/api/agent/subagents${qs}`);
      st.subagentsData = data;
      if (data.selectedConversation?.messages) {
        st.subMessages = data.selectedConversation.messages;
      }
      renderSubagentsPanel();
    } catch (err) {
      if (host) {
        host.innerHTML = `
          <div class="card">
            <div class="alert-box alert-error" style="display:block;">
              <b>Не удалось загрузить субагентов и Надсмотрщика:</b> ${esc(err.message || "Неизвестная ошибка")}
              <div class="muted mt-1" style="font-size:11.5px;">
                Если вы подключены к локальному серверу CRM (<code>${esc(bootState.crmUrl || "")}</code>), убедитесь, что сервер обновлён и запущен с актуальной веткой/сборкой.
              </div>
            </div>
            <div class="row mt-2">
              <button type="button" id="sa-retry-load" class="btn btn-sm btn-primary">↻ Повторить</button>
            </div>
          </div>
        `;
        const btn = host.querySelector("#sa-retry-load");
        if (btn) btn.onclick = refreshSubagents;
      }
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
    const fallbackBanner = st.subagentsData?.localFallback
      ? `<div class="alert-box mb-2" style="display:block; border-color:rgba(245,158,11,0.45); background:rgba(245,158,11,0.08); color:var(--text);">
           <b>Автономный локальный режим:</b> ${esc(st.subagentsData.fallbackNotice || "Сервер CRM не поддерживает /api/agent/subagents (HTTP 404). Субагенты и Надсмотрщик сохраняются локально и работают со встроенным Агентом.")}
         </div>`
      : "";

    host.innerHTML = `
      ${fallbackBanner}
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
        const sa = subagents.find((x) => x.id === id);
        const ok = await confirmDialog({
          title: "Удалить субагента?",
          message: `Удалить субагента «${sa?.name || `#${id}`}»?`,
          confirmLabel: "Удалить",
        });
        if (!ok) return;
        try {
          await apiJson(`/api/agent/subagents/${id}`, { method: "DELETE" });
          if (st.editingSubagentId === id) st.editingSubagentId = 0;
          if (st.selectedSubId === id) { st.selectedSubId = 0; st.activeSubConvId = 0; st.subMessages = []; }
          await refreshSubagents();
          showToast("Субагент удалён", "ok");
        } catch (err) { showToast(err.message, "error"); }
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
        try {
          await apiJson(`/api/agent/subagents/runs/${b.getAttribute("data-run-cancel")}/cancel`, { method: "POST", body: "{}" });
          await refreshSubagents();
        } catch (err) { showToast(err.message, "error"); }
      };
    });
    host.querySelectorAll("[data-run-retry]").forEach((b) => {
      b.onclick = async () => {
        try {
          const res = await apiJson(`/api/agent/subagents/runs/${b.getAttribute("data-run-retry")}/retry`, { method: "POST", body: "{}" });
          showToast("Запуск подготовлен к повтору", "ok");
          const subId = res.run?.subagentId || res.subagentId;
          if (subId) { st.selectedSubId = subId; }
          if (res.conversation?.id) { st.activeSubConvId = res.conversation.id; }
          await refreshSubagents();
        } catch (err) { showToast(err.message, "error"); }
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
          if ((ev === "reasoning" || ev === "subagent_reasoning") && (typeof d.text === "string" || d.delta)) {
            reply.reasoning = typeof d.text === "string" ? d.text : (reply.reasoning || "") + String(d.delta || "");
          }
          if ((ev === "text" || ev === "subagent_text") && (typeof d.text === "string" || d.delta)) {
            reply.content = typeof d.text === "string" ? d.text : (reply.content === "…" ? "" : reply.content) + String(d.delta || "");
          }
          if (ev === "done" && d.text && reply.content === "…") reply.content = d.text;
          const dm = host.querySelector("#sa-direct-msgs");
          if (dm) {
            dm.innerHTML = st.subMessages.map((m) => `
              <div class="card-sm">
                <b>${m.role === "user" ? "Вы" : "Субагент"}:</b>
                ${m.reasoning ? `<details class="reasoning-box mt-1"><summary class="reasoning-toggle"><span>🧠 Раздумья (${m.reasoning.length})</span></summary><div class="reasoning-body">${esc(m.reasoning)}</div></details>` : ""}
                <div class="mt-1">${renderMarkdown(m.content || "")}</div>
              </div>
            `).join("");
            dm.scrollTop = dm.scrollHeight;
          }
        });
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        st.subStreaming = false;
        await refreshSubagents();
      }
    };
  }

  async function refreshAll(opts = {}) {
    apiJson("/api/ai/agent").then(renderAgentHealth).catch(() => {});
    if (st.streaming || st.subStreaming) return;
    if (st.subtab === "chat") {
      await refreshConvs({ background: Boolean(opts.background), syncActive: true });
      await refreshSandbox();
    } else if (st.subtab === "sandbox") {
      await Promise.all([refreshSandbox(), refreshTranscripts()]);
    } else if (st.subtab === "subagents") {
      const saPanel = root.querySelector("#ag-panel-subagents");
      const activeEl = document.activeElement;
      const userTyping = Boolean(
        opts.background &&
        saPanel &&
        activeEl &&
        saPanel.contains(activeEl) &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(activeEl.tagName)
      );
      if (!userTyping) {
        await refreshSubagents();
      }
    } else if (st.subtab === "config" && !opts.background) {
      await loadRagAndGithub();
    }
  }

  subscribeAppEvents(() => {
    refreshAll({ background: true });
  });

  refreshConvs();
  refreshSandbox();
  renderAgentMessages();
  loadSavedAgentSettings();
  loadRagAndGithub();
  apiJson("/api/ai/agent").then(renderAgentHealth).catch(() => {});

  return { refresh: refreshAll };
}
