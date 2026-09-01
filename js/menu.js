(() => {
  const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

  function extractMenuId(url) {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      const index = parts.indexOf('menus');
      const candidate = index >= 0 ? parts[index + 1] : null;
      return candidate && UUID_PATTERN.test(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }

  function extractStudentId(url) {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      const index = parts.indexOf('student');
      const candidate = index >= 0 ? parts[index + 1] : null;
      return candidate && UUID_PATTERN.test(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }

  const menuId = extractMenuId(location.href);
  const studentId = extractStudentId(location.href);
  if (!menuId || !studentId) return;

  if (globalThis.__MODEUS_PICKER_MENU_ID__ === menuId) return;
  globalThis.__MODEUS_PICKER_MENU_ID__ = menuId;
  document.getElementById('modeus-picker-root')?.remove();

  let root;
  let state;
  let message = '';
  let messageType = 'info';
  let submitting = false;
  let diagnosing = false;
  let draggingLessonId = null;
  let timerHandle = null;
  let timerState = {
    active: false,
    running: false,
    round: 0,
    nextRunAt: null,
    lastMessage: null,
    settings: null,
  };

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  async function request(payload) {
    const response = await chrome.runtime.sendMessage(payload);
    if (!response?.ok) {
      throw new Error(response?.error || 'Расширение не ответило');
    }
    return response;
  }

  function setMessage(text, type = 'info') {
    message = text;
    messageType = type;
  }

  function waitForMenuContainer(timeoutMs = 12000) {
    const selector = 'app-selection-menu-tree, .electives-tree-list';
    const existing = document.querySelector(selector);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const target = document.querySelector(selector);
        if (!target) return;
        observer.disconnect();
        resolve(target);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  async function mount() {
    root = createElement('section', 'modeus-picker');
    root.id = 'modeus-picker-root';
    root.setAttribute('aria-live', 'polite');

    const target = await waitForMenuContainer();
    if (target) {
      target.replaceWith(root);
      return;
    }

    const fallback = document.querySelector('main, .main-content, .container-fluid, .container') || document.body;
    fallback.prepend(root);
  }

  function selectedCycle(moduleId, lessonId, cycleId) {
    const selectedModule = state.selected?.[moduleId];
    if (!selectedModule || selectedModule.lessonId !== lessonId) return null;
    return selectedModule.cycles?.[cycleId] ?? null;
  }

  function selectedFallbackCycle(moduleId, lessonId, cycleId) {
    const fallback = state.fallbacks?.[moduleId];
    if (!fallback || fallback.lessonId !== lessonId) return null;
    return fallback.cycles?.[cycleId] ?? null;
  }

  async function changeTeam(context, select) {
    select.disabled = true;
    setMessage('Сохраняю выбор…');
    render();
    try {
      const selected = select.value;
      const response = selected
        ? await request({
            type: 'SELECT_TEAM',
            menuId,
            studentId,
            selection: {
              moduleId: context.module.id,
              moduleName: context.module.name,
              lessonId: context.lesson.id,
              lessonName: context.lesson.name,
              cycleId: context.cycle.id,
              cycleName: context.cycle.name,
              teamId: selected,
              teamName: context.cycle.teams.find((team) => team.id === selected)?.name ?? selected,
            },
          })
        : await request({
            type: 'DESELECT_TEAM',
            menuId,
            studentId,
            moduleId: context.module.id,
            lessonId: context.lesson.id,
            cycleId: context.cycle.id,
          });
      state = response.state;
      setMessage(selected ? 'Выбор группы сохранён.' : 'Выбор группы сброшен.', 'success');
    } catch (error) {
      setMessage(error.message, 'error');
    }
    render();
  }

  async function changeFallbackTeam(context, select) {
    select.disabled = true;
    try {
      const teamId = select.value;
      const response = teamId ? await request({
        type: 'SELECT_FALLBACK_TEAM', menuId, studentId,
        selection: {
          moduleId: context.module.id, moduleName: context.module.name,
          lessonId: context.lesson.id, lessonName: context.lesson.name,
          cycleId: context.cycle.id, cycleName: context.cycle.name,
          teamId,
          teamName: context.cycle.teams.find((team) => team.id === teamId)?.name ?? teamId,
        },
      }) : await request({
        type: 'DESELECT_FALLBACK_TEAM', menuId, studentId,
        moduleId: context.module.id, lessonId: context.lesson.id, cycleId: context.cycle.id,
      });
      state = response.state;
      setMessage(teamId ? 'Группа Плана B сохранена.' : 'Группа Плана B сброшена.', 'success');
    } catch (error) {
      setMessage(error.message, 'error');
    }
    render();
  }

  function renderFallbackCycle(module, lesson, cycle, disabled) {
    const row = createElement('div', 'modeus-picker__cycle');
    row.appendChild(createElement('div', 'modeus-picker__cycle-name', cycle.name || 'Учебный цикл'));
    const select = createElement('select', 'modeus-picker__select');
    const placeholder = createElement('option', '', '— Резервная группа —');
    placeholder.value = '';
    select.appendChild(placeholder);
    const primaryTeamId = selectedCycle(module.id, lesson.id, cycle.id)?.teamId;
    for (const team of cycle.teams ?? []) {
      const option = createElement('option', '', `${team.name}${team.id === primaryTeamId ? ' (основная)' : ''}`);
      option.value = team.id;
      select.appendChild(option);
    }
    select.value = selectedFallbackCycle(module.id, lesson.id, cycle.id)?.teamId ?? '';
    select.disabled = disabled || state.fallbacks?.[module.id]?.status === 'success';
    select.addEventListener('change', () => changeFallbackTeam({ module, lesson, cycle }, select));
    row.appendChild(select);
    return row;
  }

  function renderCycle(module, lesson, cycle, lessonDisabled) {
    const row = createElement('div', 'modeus-picker__cycle');
    const header = createElement('div', 'modeus-picker__cycle-name', cycle.name || 'Учебный цикл');
    const selected = selectedCycle(module.id, lesson.id, cycle.id);
    const select = createElement('select', 'modeus-picker__select');
    select.dataset.cycleId = cycle.id;

    const placeholder = createElement('option', '', '— Выберите группу —');
    placeholder.value = '';
    select.appendChild(placeholder);

    [...(cycle.teams ?? [])]
      .sort((left, right) => left.name.localeCompare(right.name, 'ru'))
      .forEach((team) => {
        const professor = team.professors?.map((item) => item.name).filter(Boolean).join(', ');
        const seats = Number.isFinite(team.availableSeats) && Number.isFinite(team.totalSeats)
          ? ` · свободно: ${team.availableSeats} из ${team.totalSeats}`
          : Number.isFinite(team.totalSeats) ? ` · мест: ${team.totalSeats}` : '';
        const option = createElement(
          'option',
          '',
          `${team.name}${professor ? ` · ${professor}` : ''}${seats}`
        );
        option.value = team.id;
        select.appendChild(option);
      });

    select.value = selected?.teamId ?? '';
    select.disabled = lessonDisabled || selected?.status === 'success';
    select.addEventListener('change', () => changeTeam({ module, lesson, cycle }, select));

    row.append(header, select);
    if (selected?.status === 'success') {
      row.appendChild(createElement('span', 'modeus-picker__badge modeus-picker__badge--success', 'Отправлено'));
    } else if (selected?.status === 'error') {
      row.appendChild(createElement('span', 'modeus-picker__badge modeus-picker__badge--error', selected.error || 'Ошибка'));
    }
    return row;
  }

  function renderLesson(module, lesson) {
    const selectedModule = state.selected?.[module.id];
    const disabled = Boolean(selectedModule && selectedModule.lessonId !== lesson.id);
    const card = createElement('section', `modeus-picker__lesson${disabled ? ' modeus-picker__lesson--disabled' : ''}`);
    card.appendChild(createElement('h4', 'modeus-picker__lesson-title', lesson.name));

    if (disabled) {
      card.appendChild(createElement(
        'div',
        'modeus-picker__muted',
        `Сначала сбросьте выбор дисциплины «${selectedModule.lessonName}».`
      ));
    }

    const cycles = lesson.cycles ?? [];
    if (cycles.length === 0) {
      card.appendChild(createElement('div', 'modeus-picker__muted', 'Для дисциплины нет доступных групп.'));
    } else {
      cycles.forEach((cycle) => card.appendChild(renderCycle(module, lesson, cycle, disabled)));
    }
    if (state.planBEnabled && selectedModule && cycles.length > 0) {
      const fallback = state.fallbacks?.[module.id];
      const fallbackDisabled = Boolean(fallback && fallback.lessonId !== lesson.id);
      const details = createElement('details', 'modeus-picker__fallback');
      if (fallback?.lessonId === lesson.id) details.open = true;
      const fallbackComplete = fallback?.lessonId === lesson.id && cycles.every((cycle) => fallback.cycles?.[cycle.id]?.teamId);
      const label = fallback?.lessonId === lesson.id
        ? `План B: ${fallback.status === 'success' ? 'успешно записано' : fallbackComplete ? 'готов' : 'заполнен не полностью'}`
        : 'Настроить эту дисциплину как План B';
      details.appendChild(createElement('summary', '', label));
      if (fallbackDisabled) {
        details.appendChild(createElement('div', 'modeus-picker__muted', `План B уже задан: «${fallback.lessonName}».`));
      } else {
        cycles.forEach((cycle) => details.appendChild(renderFallbackCycle(module, lesson, cycle, false)));
      }
      card.appendChild(details);
    }
    return card;
  }

  function orderedSelectedModules() {
    const selected = Object.values(state.selected ?? {});
    const priority = new Map((state.priority ?? []).map((lessonId, index) => [lessonId, index]));
    return selected.sort((left, right) =>
      (priority.get(left.lessonId) ?? Number.MAX_SAFE_INTEGER) -
      (priority.get(right.lessonId) ?? Number.MAX_SAFE_INTEGER)
    );
  }

  async function savePriority(lessonIds) {
    try {
      const response = await request({
        type: 'SET_SUBMISSION_PRIORITY',
        menuId,
        studentId,
        lessonIds,
      });
      state = response.state;
      setMessage('Приоритеты отправки сохранены.', 'success');
    } catch (error) {
      setMessage(error.message, 'error');
    }
    render();
  }

  function movePriority(lessonId, direction) {
    const lessonIds = orderedSelectedModules().map((item) => item.lessonId);
    const index = lessonIds.indexOf(lessonId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= lessonIds.length) return;
    [lessonIds[index], lessonIds[target]] = [lessonIds[target], lessonIds[index]];
    void savePriority(lessonIds);
  }

  function renderPriorityQueue() {
    const section = createElement('section', 'modeus-picker__priority');
    section.append(
      createElement('h3', 'modeus-picker__section-title', 'Приоритет отправки'),
      createElement(
        'div',
        'modeus-picker__muted',
        'Перетащите дисциплину выше. Запросы отправляются строго сверху вниз.'
      )
    );

    const selected = orderedSelectedModules();
    if (selected.length === 0) {
      section.appendChild(createElement('div', 'modeus-picker__empty-inline', 'Выберите хотя бы одну группу.'));
      return section;
    }

    const list = createElement('div', 'modeus-picker__priority-list');
    selected.forEach((selectedModule, index) => {
      const item = createElement('div', 'modeus-picker__priority-item');
      item.draggable = !timerState.active && !submitting;
      item.dataset.lessonId = selectedModule.lessonId;

      const handle = createElement('span', 'modeus-picker__drag-handle', '☰');
      handle.title = 'Перетащите для изменения приоритета';
      const number = createElement('span', 'modeus-picker__priority-number', String(index + 1));
      const names = createElement('div', 'modeus-picker__priority-names');
      names.append(
        createElement('strong', '', selectedModule.lessonName),
        createElement('span', '', selectedModule.moduleName)
      );
      const controls = createElement('div', 'modeus-picker__priority-controls');
      const up = createElement('button', 'modeus-picker__icon-button', '↑');
      up.type = 'button';
      up.title = 'Поднять приоритет';
      up.disabled = index === 0 || timerState.active;
      up.addEventListener('click', () => movePriority(selectedModule.lessonId, -1));
      const down = createElement('button', 'modeus-picker__icon-button', '↓');
      down.type = 'button';
      down.title = 'Опустить приоритет';
      down.disabled = index === selected.length - 1 || timerState.active;
      down.addEventListener('click', () => movePriority(selectedModule.lessonId, 1));
      controls.append(up, down);

      item.addEventListener('dragstart', (event) => {
        draggingLessonId = selectedModule.lessonId;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', selectedModule.lessonId);
        item.classList.add('modeus-picker__priority-item--dragging');
      });
      item.addEventListener('dragend', () => {
        draggingLessonId = null;
        item.classList.remove('modeus-picker__priority-item--dragging');
      });
      item.addEventListener('dragover', (event) => {
        if (!draggingLessonId || draggingLessonId === selectedModule.lessonId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        item.classList.add('modeus-picker__priority-item--over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('modeus-picker__priority-item--over'));
      item.addEventListener('drop', (event) => {
        event.preventDefault();
        item.classList.remove('modeus-picker__priority-item--over');
        const dragged = draggingLessonId || event.dataTransfer.getData('text/plain');
        const lessonIds = orderedSelectedModules().map((entry) => entry.lessonId);
        const from = lessonIds.indexOf(dragged);
        const to = lessonIds.indexOf(selectedModule.lessonId);
        if (from < 0 || to < 0 || from === to) return;
        lessonIds.splice(from, 1);
        lessonIds.splice(to, 0, dragged);
        void savePriority(lessonIds);
      });

      item.append(handle, number, names, controls);
      list.appendChild(item);
    });
    section.appendChild(list);
    return section;
  }

  function localDateTimeValue(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp + 5 * 60 * 60 * 1000);
    return date.toISOString().slice(0, 19);
  }

  function parseUtcPlus5DateTime(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value ?? '');
    if (!match) return NaN;
    const [, year, month, day, hour, minute, second = '0'] = match;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 5,
      Number(minute),
      Number(second)
    );
  }

  function settingsField(label, name, value, min, max, step = '1') {
    const wrapper = createElement('label', 'modeus-picker__setting');
    wrapper.appendChild(createElement('span', '', label));
    const input = createElement('input', 'modeus-picker__input');
    input.name = name;
    input.type = name === 'startAt' ? 'datetime-local' : 'number';
    input.value = value ?? '';
    if (min != null) input.min = String(min);
    if (max != null) input.max = String(max);
    input.step = step;
    wrapper.appendChild(input);
    return wrapper;
  }

  function pendingLessonCount() {
    return Object.values(state.selected ?? {}).filter((selectedModule) => {
      if (selectedModule.fallbackBooked) return false;
      const cycles = Object.values(selectedModule.cycles ?? {});
      return cycles.length > 0 && cycles.some((cycle) => cycle.status !== 'success');
    }).length;
  }

  function clearPageTimer() {
    if (timerHandle != null) clearTimeout(timerHandle);
    timerHandle = null;
  }

  function finishTimer(message, type = 'info') {
    clearPageTimer();
    timerState.active = false;
    timerState.running = false;
    timerState.nextRunAt = null;
    timerState.lastMessage = message;
    setMessage(message, type);
    void request({ type: 'DISARM_BACKUP_ALARM', menuId }).catch(() => {});
    render();
  }

  async function runTimerRound() {
    if (!timerState.active || timerState.running) return;
    timerState.running = true;
    timerState.round += 1;
    timerState.nextRunAt = null;
    timerState.lastMessage = `Выполняю раунд ${timerState.round}`;
    render();

    try {
      const response = await request({
        type: 'SUBMIT_AUTOMATION_ROUND',
        menuId,
        settings: timerState.settings,
        round: timerState.round,
      });
      state = response.state;
      const pending = pendingLessonCount();
      const successful = response.results.filter((item) => item.success).length;
      if (pending === 0) {
        finishTimer('Все дисциплины успешно отправлены.', 'success');
        return;
      }

      const maxRounds = timerState.settings.maxRounds;
      if (maxRounds > 0 && timerState.round >= maxRounds) {
        finishTimer(`Достигнут лимит ${maxRounds} раундов. Осталось: ${pending}.`, 'error');
        return;
      }

      timerState.lastMessage = `Раунд ${timerState.round}: успешно ${successful}, осталось ${pending}`;
      timerState.nextRunAt = Date.now() + timerState.settings.roundDelayMs;
    } catch (error) {
      const maxRounds = timerState.settings.maxRounds;
      if (maxRounds > 0 && timerState.round >= maxRounds) {
        finishTimer(`Таймер остановлен: ${error.message}`, 'error');
        return;
      }
      timerState.lastMessage = `Ошибка раунда ${timerState.round}: ${error.message}`;
      timerState.nextRunAt = Date.now() + timerState.settings.roundDelayMs;
    } finally {
      timerState.running = false;
    }

    if (!timerState.active) return;
    timerHandle = setTimeout(runTimerRound, Math.max(0, timerState.nextRunAt - Date.now()));
    render();
  }

  function scheduleTargetTick() {
    if (!timerState.active) return;
    const remaining = timerState.nextRunAt - Date.now();
    if (remaining <= 0) {
      void runTimerRound();
      return;
    }

    // Recalculate long waits periodically, then use a direct timeout for the final second.
    const nextCheck = remaining > 1000 ? Math.min(60000, remaining - 750) : remaining;
    timerHandle = setTimeout(scheduleTargetTick, Math.max(1, nextCheck));
  }

  async function startPageTimer(panel) {
    if (timerState.active) return;
    const value = (name) => panel.querySelector(`[name="${name}"]`)?.value;
    const startValue = value('startAt');
    const startAt = startValue ? parseUtcPlus5DateTime(startValue) : Date.now();
    if (!Number.isFinite(startAt)) {
      setMessage('Неверно указано время старта.', 'error');
      render();
      return;
    }

    const backupAlarm = Boolean(panel.querySelector('[name="backupAlarm"]')?.checked);
    try {
      await request({ type: 'DISARM_BACKUP_ALARM', menuId });
    } catch {
      // A stale alarm is harmless when the worker has no saved schedule.
    }
    timerState = {
      active: true,
      running: false,
      round: 0,
      nextRunAt: Math.max(Date.now(), startAt),
      lastMessage: 'Таймер вооружён. Не закрывайте и не обновляйте эту вкладку.',
      settings: {
        startAt,
        requestTimeoutMs: Math.max(250, Math.min(120000, Number(value('requestTimeoutSeconds')) * 1000)),
        requestDelayMs: Math.max(0, Math.min(60000, Number(value('requestDelayMs')))),
        roundDelayMs: Math.max(250, Math.min(600000, Number(value('roundDelayMs')))),
        maxRounds: Math.max(0, Math.min(100000, Math.round(Number(value('maxRounds'))))),
        backupAlarm,
      },
    };
    if (backupAlarm) {
      try {
        await request({ type: 'ARM_BACKUP_ALARM', menuId, settings: timerState.settings });
      } catch (error) {
        timerState.active = false;
        setMessage(`Не удалось вооружить chrome.alarms: ${error.message}`, 'error');
        render();
        return;
      }
    }
    setMessage(timerState.lastMessage, 'success');
    scheduleTargetTick();
    render();
  }

  async function stopPageTimer() {
    clearPageTimer();
    timerState.active = false;
    timerState.running = false;
    timerState.nextRunAt = null;
    timerState.lastMessage = 'Таймер остановлен.';
    try {
      await request({ type: 'STOP_SUBMISSION', menuId });
    } catch {
      // The page timer is already stopped even if the worker was unavailable.
    }
    setMessage(timerState.lastMessage, 'info');
    render();
  }

  function renderAutomationPanel() {
    const settings = timerState.settings ?? {
      startAt: null,
      requestTimeoutMs: 10000,
      requestDelayMs: 100,
      roundDelayMs: 1000,
      maxRounds: 0,
      backupAlarm: false,
    };
    const panel = createElement('section', 'modeus-picker__automation');
    panel.append(
      createElement('h3', 'modeus-picker__section-title', 'Таймер автоотправки'),
      createElement(
        'div',
        'modeus-picker__muted',
        'Точный таймер живёт во вкладке. chrome.alarms можно включить как локальный резерв: он не облачный, не будит компьютер и может сработать позже.'
      )
    );

    const fields = createElement('div', 'modeus-picker__settings');
    fields.append(
      settingsField('Время старта (UTC+5)', 'startAt', localDateTimeValue(timerState.active ? timerState.nextRunAt : settings.startAt)),
      settingsField('Таймаут запроса, с', 'requestTimeoutSeconds', settings.requestTimeoutMs / 1000, 0.25, 120, '0.25'),
      settingsField('Пауза между предметами, мс', 'requestDelayMs', settings.requestDelayMs, 0, 60000),
      settingsField('Пауза между раундами, мс', 'roundDelayMs', settings.roundDelayMs, 250, 600000),
      settingsField('Максимум раундов (0 = без лимита)', 'maxRounds', settings.maxRounds, 0, 100000)
    );
    fields.querySelectorAll('input').forEach((input) => {
      input.disabled = timerState.active;
    });
    panel.appendChild(fields);
    const planBLabel = createElement('label', 'modeus-picker__alarm-option');
    const planBCheckbox = createElement('input');
    planBCheckbox.type = 'checkbox';
    planBCheckbox.name = 'planBEnabled';
    planBCheckbox.checked = Boolean(state.planBEnabled);
    planBCheckbox.disabled = timerState.active || submitting;
    planBCheckbox.addEventListener('change', async () => {
      planBCheckbox.disabled = true;
      try {
        const response = await request({
          type: 'SET_PLAN_B_ENABLED',
          menuId,
          studentId,
          enabled: planBCheckbox.checked,
        });
        state = response.state;
        setMessage(
          state.planBEnabled
            ? 'План B включён: он будет рассматриваться только при TEAM_LIMIT_EXCEEDED.'
            : 'План B выключен: резервные варианты игнорируются.',
          'success'
        );
      } catch (error) {
        setMessage(error.message, 'error');
      }
      render();
    });
    planBLabel.append(planBCheckbox, createElement('span', '', 'Использовать План B при подтверждённой нехватке мест'));
    panel.appendChild(planBLabel);
    const alarmLabel = createElement('label', 'modeus-picker__alarm-option');
    const alarmCheckbox = createElement('input');
    alarmCheckbox.type = 'checkbox';
    alarmCheckbox.name = 'backupAlarm';
    alarmCheckbox.checked = Boolean(settings.backupAlarm);
    alarmCheckbox.disabled = timerState.active;
    alarmLabel.append(alarmCheckbox, createElement('span', '', 'Резервный запуск через chrome.alarms (без двойной отправки)'));
    panel.appendChild(alarmLabel);

    const statusText = timerState.active
      ? `${timerState.lastMessage || 'Активен'}${timerState.nextRunAt ? ` · следующий запуск: ${new Date(timerState.nextRunAt).toLocaleString('ru-RU')}` : ''}`
      : timerState.lastMessage || 'Не запущен';
    panel.appendChild(createElement(
      'div',
      `modeus-picker__automation-status${timerState.active ? ' modeus-picker__automation-status--active' : ''}`,
      statusText
    ));

    const action = createElement(
      'button',
      `modeus-picker__button ${timerState.active ? 'modeus-picker__button--danger' : 'modeus-picker__button--primary'}`,
      timerState.active ? 'Остановить таймер' : 'Запустить таймер'
    );
    action.type = 'button';
    action.disabled = selectionCount() === 0;
    action.addEventListener('click', () => timerState.active ? stopPageTimer() : void startPageTimer(panel));
    panel.appendChild(action);
    return panel;
  }

  function renderRequestLog() {
    const details = createElement('details', 'modeus-picker__request-log');
    const entries = [...(state.requestLog ?? [])].reverse();
    details.appendChild(createElement('summary', '', `Журнал HTTP-запросов (${entries.length})`));
    if (entries.length === 0) {
      details.appendChild(createElement('div', 'modeus-picker__muted', 'Запросов пока нет.'));
      return details;
    }
    const clear = createElement('button', 'modeus-picker__button modeus-picker__button--secondary', 'Очистить журнал');
    clear.type = 'button';
    clear.addEventListener('click', async () => {
      const response = await request({ type: 'CLEAR_REQUEST_LOG', menuId, studentId });
      state = response.state;
      render();
    });
    details.appendChild(clear);
    for (const entry of entries.slice(0, 50)) {
      const status = entry.success ? `HTTP ${entry.status ?? 200}` : entry.status ? `HTTP ${entry.status}` : entry.errorKind;
      const item = createElement('pre', `modeus-picker__log-entry ${entry.success ? 'modeus-picker__log-entry--success' : 'modeus-picker__log-entry--error'}`);
      item.textContent = `${new Date(entry.startedAt ?? entry.completedAt).toLocaleTimeString('ru-RU')}  #${entry.sequence ?? '—'}  P${entry.priority ?? '—'}${entry.fallback ? '  PLAN B' : ''}\n${entry.method ?? ''} ${entry.lessonName ?? ''}  ${status ?? ''}  ${entry.durationMs ?? '—'} мс\n${entry.url ?? ''}\npayload: ${JSON.stringify(entry.payload ?? null)}\nresponse: ${JSON.stringify(entry.responseBody ?? entry.error ?? null)}`;
      details.appendChild(item);
    }
    return details;
  }

  function selectionCount() {
    return Object.values(state.selected ?? {}).reduce(
      (total, selectedModule) => total + Object.keys(selectedModule.cycles ?? {}).length,
      0
    );
  }

  async function submitSelections(button) {
    if (submitting) return;
    submitting = true;
    setMessage('Отправляю выбор в Modeus…');
    render();
    try {
      const response = await request({ type: 'SUBMIT_SELECTIONS', menuId });
      state = response.state;
      const failed = response.results.filter((result) => !result.success);
      setMessage(
        failed.length === 0
          ? 'Выбор успешно отправлен. Можно отправить те же формы повторно.'
          : `Не отправлено дисциплин: ${failed.length}. Ответы Modeus показаны у групп.`,
        failed.length === 0 ? 'success' : 'error'
      );
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      submitting = false;
    }
    render();
  }

  function formatDiagnosticBody(body) {
    if (body == null || body === '') return '<пустое тело>';
    if (typeof body === 'string') return body;
    try {
      return JSON.stringify(body, null, 2);
    } catch {
      return String(body);
    }
  }

  async function diagnoseApi() {
    if (diagnosing || submitting) return;
    diagnosing = true;
    setMessage('Отправляю 4 заведомо невалидных диагностических POST…');
    render();
    try {
      const response = await request({
        type: 'DIAGNOSE_SUBMISSION',
        menuId,
        lessonName: 'Проектирование архитектуры информационных систем',
      });
      const diagnostics = response.diagnostics;
      const lines = diagnostics.results.map((result) => [
        `${result.label}: HTTP ${result.status}${result.ok ? ' (OK — неожиданно)' : ''}`,
        formatDiagnosticBody(result.body),
      ].join('\n'));
      setMessage(
        `Диагностика «${diagnostics.lessonName}»:\n\n${lines.join('\n\n')}`,
        diagnostics.results.some((result) => result.ok) ? 'error' : 'info'
      );
    } catch (error) {
      setMessage(error.message, 'error');
    } finally {
      diagnosing = false;
    }
    render();
  }

  async function refreshMenu(button) {
    button.disabled = true;
    setMessage('Обновляю список групп…');
    render();
    try {
      const response = await request({ type: 'REFRESH_MENU', menuId, studentId });
      state = response.state;
      setMessage('Список групп обновлён.', 'success');
    } catch (error) {
      setMessage(error.message, 'error');
    }
    render();
  }

  function render() {
    if (!root) return;
    root.replaceChildren();

    const heading = createElement('div', 'modeus-picker__heading');
    const titleBlock = createElement('div');
    titleBlock.append(
      createElement('h2', 'modeus-picker__title', 'Modeus Picker'),
      createElement('div', 'modeus-picker__subtitle', 'Выберите группы, расставьте приоритеты и настройте автоотправку.')
    );
    const refresh = createElement('button', 'modeus-picker__button modeus-picker__button--secondary', 'Обновить группы');
    refresh.type = 'button';
    refresh.addEventListener('click', () => refreshMenu(refresh));
    heading.append(titleBlock, refresh);
    root.appendChild(heading);

    if (message) {
      root.appendChild(createElement('div', `modeus-picker__notice modeus-picker__notice--${messageType}`, message));
    }

    if (!state?.data) {
      root.appendChild(createElement(
        'div',
        'modeus-picker__empty',
        state?.error || 'Ожидаю данные меню от Modeus. Обновите страницу, если загрузка не началась.'
      ));
      return;
    }

    const modules = state.data.items ?? [];
    if (modules.length === 0) {
      root.appendChild(createElement('div', 'modeus-picker__empty', 'В меню нет доступных модулей.'));
      return;
    }

    root.append(renderPriorityQueue(), renderAutomationPanel(), renderRequestLog());

    const list = createElement('div', 'modeus-picker__modules');
    modules.forEach((module) => {
      const moduleCard = createElement('section', 'modeus-picker__module');
      moduleCard.appendChild(createElement('h3', 'modeus-picker__module-title', module.name));
      (module.children ?? []).forEach((lesson) => moduleCard.appendChild(renderLesson(module, lesson)));
      list.appendChild(moduleCard);
    });
    root.appendChild(list);

    const footer = createElement('div', 'modeus-picker__footer');
    const count = selectionCount();
    footer.appendChild(createElement('div', 'modeus-picker__summary', `Выбрано групп: ${count}`));
    const actions = createElement('div', 'modeus-picker__actions');
    const diagnose = createElement('button', 'modeus-picker__button modeus-picker__button--secondary', 'Проверить API');
    diagnose.type = 'button';
    diagnose.disabled = count === 0 || submitting || diagnosing || timerState.active;
    diagnose.addEventListener('click', diagnoseApi);
    const submit = createElement('button', 'modeus-picker__button modeus-picker__button--primary', 'Отправить в Modeus');
    submit.type = 'button';
    submit.disabled = count === 0 || submitting || diagnosing || timerState.active;
    submit.addEventListener('click', () => submitSelections(submit));
    actions.append(diagnose, submit);
    footer.appendChild(actions);
    root.appendChild(footer);
  }

  chrome.runtime.onMessage.addListener((incoming) => {
    if (incoming.type === 'MODEUS_MENU_LOADING' && incoming.menuId === menuId) {
      setMessage('Загружаю предметы и группы…');
      render();
    }
    if (incoming.type === 'MODEUS_MENU_STATE' && incoming.state?.menuId === menuId) {
      state = incoming.state;
      render();
    }
    if (incoming.type === 'MODEUS_MENU_ERROR' && incoming.menuId === menuId) {
      setMessage(incoming.error, 'error');
      render();
    }
  });

  async function init() {
    await mount();
    setMessage('Подключаюсь к Modeus…');
    render();
    try {
      const response = await request({ type: 'MODEUS_PAGE_READY', menuId, studentId });
      state = response.state;
      if (response.loading) setMessage('Загружаю предметы и группы…');
      else if (state?.data) setMessage('Группы загружены.', 'success');
      else setMessage(state?.error || 'Ожидаю запрос меню от Modeus.');
    } catch (error) {
      setMessage(error.message, 'error');
    }
    render();
  }

  void init();
})();
