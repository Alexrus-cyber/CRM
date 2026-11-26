import { apiJson, esc, formatTokens, showToast } from "/app.js";

export function mountLimitsTab(root, ctx) {
  root.innerHTML = `<div class="col" id="limits-container"><div class="card muted">Загрузка статистики…</div></div>`;
  const container = root.querySelector("#limits-container");

  async function refresh() {
    const bootState = ctx.getState();
    const profile = bootState.profile || {};
    const user = profile.user || {};
    const rolePolicies = profile.rolePolicies || [];
    const canSeeAgent = Boolean(user.canViewAgentUsage);

    let usageData = null;
    let agentUsageData = null;
    let runtimeData = null;
    try {
      const promises = [
        apiJson("/api/ai/usage").catch(() => null),
        apiJson("/api/app/runtime").catch(() => null),
      ];
      if (canSeeAgent) promises.push(apiJson("/api/ai/agent-usage").catch(() => null));
      const [u, rt, au] = await Promise.all(promises);
      usageData = u;
      runtimeData = rt;
      agentUsageData = au || null;
    } catch (err) {
      showToast(err.message, "error");
    }

    const monthUsed = usageData?.monthly?.used ?? profile.limits?.monthlyUsed ?? 0;
    const monthLimit = usageData?.monthly?.limit ?? profile.limits?.monthlyTokens ?? null;
    const allTotal = usageData?.totals?.total ?? profile.limits?.allUsed ?? 0;
    const chatsCount = usageData?.chats?.count ?? profile.limits?.chatsCount ?? 0;
    const perChat = usageData?.policy?.perChatTokens ?? profile.limits?.perChatTokens ?? null;
    const override = usageData?.override ?? profile.limits?.overrideMonthlyLimit ?? null;
    const summary = usageData?.policy?.summary ?? profile.limits?.summary ?? "";

    const left = monthLimit === null ? null : Math.max(monthLimit - monthUsed, 0);
    const percent = monthLimit === null ? 0 : Math.min(100, Math.round((monthUsed / Math.max(monthLimit, 1)) * 100));
    const exhausted = monthLimit !== null && monthUsed >= monthLimit;

    const agentCardHtml = canSeeAgent && agentUsageData ? (() => {
      const m = agentUsageData.totals?.month || { agent: 0, operator: 0, total: 0 };
      const a = agentUsageData.totals?.all || { agent: 0, operator: 0, total: 0 };
      const users = agentUsageData.users || [];
      return `
        <div class="card">
          <div class="row-between mb-2">
            <div>
              <div style="font-weight:600; font-size:14px;">✨ Расход токенов Агента и Оператора</div>
              <div class="muted" style="font-size:11px;">Виден только главному администратору · токены не ограничены и не входят в квоту чата</div>
            </div>
            <span class="badge badge-amber">${esc(formatTokens(m.total))} за месяц</span>
          </div>
          <div class="grid-3">
            <div class="card-sm">
              <div class="muted" style="font-size:11px;">🤖 Агент (месяц)</div>
              <div style="font-size:16px; font-weight:700;">${esc(formatTokens(m.agent))}</div>
              <div class="muted" style="font-size:10.5px;">всего: ${esc(formatTokens(a.agent))}</div>
            </div>
            <div class="card-sm">
              <div class="muted" style="font-size:11px;">🖥️ Оператор (месяц)</div>
              <div style="font-size:16px; font-weight:700;">${esc(formatTokens(m.operator))}</div>
              <div class="muted" style="font-size:10.5px;">всего: ${esc(formatTokens(a.operator))}</div>
            </div>
            <div class="card-sm">
              <div class="muted" style="font-size:11px;">Итого за всё время</div>
              <div style="font-size:16px; font-weight:700;">${esc(formatTokens(a.total))}</div>
              <div class="muted" style="font-size:10.5px;">без лимита токенов</div>
            </div>
          </div>
          ${users.length ? `
            <div style="overflow-x:auto;" class="mt-3">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Сотрудник</th>
                    <th>Доступ</th>
                    <th>Агент (мес / всего)</th>
                    <th>Оператор (мес / всего)</th>
                    <th>Итого</th>
                  </tr>
                </thead>
                <tbody>
                  ${users.map((u) => `
                    <tr>
                      <td><b>${esc(u.name)}</b> <span class="muted">· ${esc(u.role)}</span></td>
                      <td>${u.canUseAgent || u.canUseOperator ? `<span class="text-emerald">${esc([u.canUseAgent ? "Агент" : "", u.canUseOperator ? "Оператор" : ""].filter(Boolean).join(" + "))}</span>` : `<span class="muted">нет</span>`}</td>
                      <td>${esc(formatTokens(u.monthAgent))} / ${esc(formatTokens(u.allAgent))}</td>
                      <td>${esc(formatTokens(u.monthOperator))} / ${esc(formatTokens(u.allOperator))}</td>
                      <td><b>${esc(formatTokens(u.allTotal))}</b></td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          ` : ""}
        </div>
      `;
    })() : "";

    const runtimeCardHtml = runtimeData ? `
      <div class="card">
        <div class="row-between mb-2">
          <div>
            <div style="font-weight:600; font-size:14px;">🧰 Локальная среда приложения (.exe) и журналы</div>
            <div class="muted" style="font-size:11px;">Настройки: <span class="mono">${esc(runtimeData.configPath)}</span> · Рабочая папка: <span class="mono">${esc(runtimeData.workspace)}</span></div>
          </div>
          <button type="button" id="limits-refresh-runtime" class="btn btn-sm">↻ Обновить</button>
        </div>
        <div class="grid-3">
          ${Object.entries(runtimeData.runtime || {}).map(([k, v]) => `
            <div class="card-sm">
              <div class="muted" style="font-size:10.5px;">${esc(k)}</div>
              <div class="mono" style="font-size:11.5px; word-break:break-all;">${esc(v)}</div>
            </div>
          `).join("")}
        </div>
        <div class="row mt-2">
          ${(runtimeData.deps?.operator || []).map((d) => `
            <span class="badge ${d.ok ? "badge-emerald" : "badge-amber"}" title="${esc(d.hint)}">
              ${d.ok ? "✓" : "⚠"} ${esc(d.name)}
            </span>
          `).join("")}
        </div>
        <div class="grid-2 mt-3">
          <div>
            <div class="muted mb-1" style="font-size:11px;">Консоль встроенного Агента</div>
            <div class="log-console">${esc((runtimeData.agentLogs || []).join("\n") || "Лог пока пуст")}</div>
          </div>
          <div>
            <div class="muted mb-1" style="font-size:11px;">Консоль встроенного Оператора</div>
            <div class="log-console">${esc((runtimeData.operatorLogs || []).join("\n") || "Лог пока пуст")}</div>
          </div>
        </div>
      </div>
    ` : "";

    container.innerHTML = `
      <div class="card">
        <div class="row-between mb-2">
          <div>
            <div style="font-weight:600; font-size:14px;">📊 Токены ИИ</div>
            <div class="muted" style="font-size:11px;">Счётчик по всем чатам аккаунта</div>
          </div>
          <span class="badge">${esc(formatTokens(monthUsed))} за месяц</span>
        </div>

        <div class="grid-2">
          <div class="card-sm">
            <div class="muted" style="font-size:11px;">Всего за всё время</div>
            <div style="font-size:16px; font-weight:700;">${esc(formatTokens(allTotal))}</div>
          </div>
          <div class="card-sm">
            <div class="muted" style="font-size:11px;">Чатов</div>
            <div style="font-size:16px; font-weight:700;">${esc(chatsCount)}</div>
          </div>
        </div>

        <div class="mt-3">
          <div class="row-between muted" style="font-size:11px; margin-bottom:5px;">
            <span>Месяц</span>
            <span>${esc(formatTokens(monthUsed))} / ${esc(formatTokens(monthLimit))}</span>
          </div>
          ${monthLimit !== null ? `
            <div class="progress-track">
              <div class="progress-fill ${exhausted ? "danger" : percent > 80 ? "warn" : ""}" style="width:${Math.max(percent, 2)}%"></div>
            </div>
            <div class="mt-1 ${exhausted ? "text-red" : "muted"}" style="font-size:11px;">
              Осталось: ${esc(formatTokens(left))}${override ? " · лимит расширен администратором" : " · расширить лимит может администратор"}
            </div>
          ` : `<div class="muted" style="font-size:11px;">Без месячного лимита</div>`}
        </div>

        <div class="row mt-2">
          <span class="badge">на чат: ${esc(formatTokens(perChat))}</span>
          <span class="badge">чатов без ограничений</span>
        </div>
        ${summary ? `<p class="muted mt-2" style="margin-bottom:0; font-size:11.5px;">${esc(summary)}</p>` : ""}
      </div>

      ${agentCardHtml}

      ${!canSeeAgent && (user.canUseAgent || user.canUseOperator) ? `
        <div class="card">
          <div style="font-weight:600; font-size:14px;">Доступ к Агенту и Оператору</div>
          <p class="muted mt-1" style="margin-bottom:0;">
            Открыт доступ: <b>${esc([user.canUseAgent ? "Агент" : "", user.canUseOperator ? "Оператор" : ""].filter(Boolean).join(", "))}</b>.
            Использование этих инструментов не расходует ваш месячный лимит токенов чата с ИИ.
          </p>
        </div>
      ` : ""}

      <div class="card">
        <div class="row-between mb-2">
          <div>
            <div style="font-weight:600; font-size:14px;">🛡️ Правила по ролям</div>
            <div class="muted" style="font-size:11px;">Политика сервера CRM</div>
          </div>
        </div>
        <div style="overflow-x:auto;">
          <table class="data-table">
            <thead>
              <tr>
                <th>Роль</th>
                <th>На чат</th>
                <th>В месяц</th>
                <th>Шагов</th>
                <th>RAG</th>
                <th>Раздумья</th>
              </tr>
            </thead>
            <tbody>
              ${rolePolicies.map((row) => `
                <tr class="${row.role === user.role ? "row-highlight" : ""}">
                  <td>
                    <b>${esc(row.roleLabel || row.role)}</b>
                    ${row.role === user.role ? `<span class="accent-text" style="font-size:10px; margin-left:4px;">ваша</span>` : ""}
                  </td>
                  <td>${esc(formatTokens(row.perChatTokens))}</td>
                  <td>${esc(formatTokens(row.monthlyTokens))}</td>
                  <td>${row.maxSteps === null || row.maxSteps <= 0 ? "без лимита" : `до ${esc(formatTokens(row.maxSteps))}`}</td>
                  <td>${row.rag ? "да" : "нет"}</td>
                  <td class="muted">${(row.reasoning || []).length > 2 ? "любые" : esc((row.reasoning || []).join(", "))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      ${runtimeCardHtml}
    `;

    const rtBtn = container.querySelector("#limits-refresh-runtime");
    if (rtBtn) rtBtn.onclick = refresh;
  }

  refresh();
  return { refresh };
}
