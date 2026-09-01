import {
  hasFreshMenuData,
  readMenuState,
  storeMenuData,
  storeMenuError,
  writeMenuState,
} from './caching.js';
import {
  buildSelectionPayloads,
  clearFallback,
  deselectFallbackTeam,
  deselectTeam,
  extractBookingApiContext,
  extractMenuIdFromPageUrl,
  extractPageContext,
  findTeamLimitExceeded,
  isLessonSubmissionSuccessful,
  markLessonResult,
  modeusErrorMessage,
  normalizeAutomationSettings,
  normalizeBookingMenuPayload,
  selectTeam,
  selectFallbackTeam,
  setSubmissionPriority,
} from './core.js';

const API_ROOT = 'https://urfu.modeus.org/course-unit-booking/api/v1';
const AUTH_STORAGE_PREFIX = 'modeus-picker:auth:';
const loadingMenus = new Map();
const memoryHeaders = new Map();
const activeSubmissions = new Set();
const requestControllers = new Map();
const cancelledSubmissions = new Set();
const AUTOMATION_PREFIX = 'modeus-picker:automation:';
const ALARM_PREFIX = 'modeus-picker:alarm:';

function delay(timeoutMs) {
  return timeoutMs > 0
    ? new Promise((resolve) => setTimeout(resolve, timeoutMs))
    : Promise.resolve();
}

function sanitizeRequestHeaders(requestHeaders = []) {
  const allowed = {};
  for (const { name, value } of requestHeaders) {
    if (!name || value == null) continue;
    const normalized = name.toLowerCase();
    if (
      normalized === 'authorization' ||
      normalized === 'accept' ||
      normalized === 'accept-language' ||
      normalized.startsWith('x-')
    ) {
      allowed[name] = value;
    }
  }
  return allowed;
}

async function rememberHeaders(menuId, headers) {
  memoryHeaders.set(menuId, headers);
  if (chrome.storage.session) {
    await chrome.storage.session.set({ [`${AUTH_STORAGE_PREFIX}${menuId}`]: headers });
  }
}

async function getRememberedHeaders(menuId) {
  if (memoryHeaders.has(menuId)) return memoryHeaders.get(menuId);
  if (!chrome.storage.session) return {};

  const key = `${AUTH_STORAGE_PREFIX}${menuId}`;
  const stored = await chrome.storage.session.get(key);
  const headers = stored[key] ?? {};
  memoryHeaders.set(menuId, headers);
  return headers;
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestModeus(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
  });
  const body = await readResponseBody(response);
  if (!response.ok) {
    const error = new Error(modeusErrorMessage(response.status, body));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function requestLogEntry(result, context) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    source: context.source ?? 'manual',
    round: context.round ?? null,
    sequence: context.sequence,
    priority: context.priority,
    fallback: Boolean(context.fallback),
    lessonId: context.lessonId,
    lessonName: context.lessonName,
    method: context.method,
    url: context.url,
    payload: context.payload,
    startedAt: context.startedAt,
    completedAt: Date.now(),
    durationMs: Date.now() - context.startedAt,
    success: result.success,
    status: result.status ?? (result.success ? 200 : null),
    responseBody: result.body ?? result.response ?? null,
    error: result.error ?? null,
    errorKind: result.errorKind ?? null,
  };
}

function appendRequestLog(state, entry) {
  state.requestLog = [...(state.requestLog ?? []), entry].slice(-200);
  return state;
}

async function probeModeus(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await readResponseBody(response),
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function menuApiUrl(menuId, studentId) {
  return `${API_ROOT}/students/${studentId}/campaigns/${menuId}/student-campaign-menu`;
}

async function fetchCompleteMenu(menuId, studentId, headers) {
  const rootUrl = menuApiUrl(menuId, studentId);
  const payload = await requestModeus(rootUrl, { method: 'GET', headers });
  const moduleDetails = {};

  await mapWithConcurrency(payload?.moduleElements ?? [], 4, async (module) => {
    moduleDetails[module.id] = await requestModeus(
      `${rootUrl}/module-elements/${module.id}`,
      { method: 'GET', headers }
    );
  });

  return normalizeBookingMenuPayload(payload, moduleDetails);
}

async function loadMenu(menuId, studentId, headers, force = false) {
  if (!studentId) throw new Error('Не удалось определить студента для этого меню');

  const state = await readMenuState(menuId, studentId);
  if (!force && hasFreshMenuData(state)) return state;
  if (loadingMenus.has(menuId)) return loadingMenus.get(menuId);

  const promise = (async () => {
    try {
      const data = await fetchCompleteMenu(menuId, studentId, headers);
      return await storeMenuData(menuId, studentId, data);
    } catch (error) {
      await storeMenuError(menuId, studentId, error.message);
      throw error;
    } finally {
      loadingMenus.delete(menuId);
    }
  })();
  loadingMenus.set(menuId, promise);
  return promise;
}

async function safeSend(tabId, message) {
  if (tabId == null || tabId < 0) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The content script may not be ready yet. It will request state on startup.
  }
}

async function ensureMenuContentScript(tabId, url) {
  const menuId = extractMenuIdFromPageUrl(url);
  if (!menuId || tabId == null || tabId < 0) return null;

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['css/menu.css'],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['js/menu.js'],
  });
  return menuId;
}

async function broadcastMenuState(menuId, state) {
  const tabs = await chrome.tabs.query({ url: 'https://urfu.modeus.org/learning-path-selection/menus/*' });
  await Promise.all(tabs
    .filter((tab) => extractMenuIdFromPageUrl(tab.url) === menuId)
    .map((tab) => safeSend(tab.id, { type: 'MODEUS_MENU_STATE', state }))
  );
}

async function handleCapturedMenuRequest(details, context) {
  const { menuId, studentId, isMenuRequest } = context;
  const headers = sanitizeRequestHeaders(details.requestHeaders);
  await rememberHeaders(menuId, headers);
  if (!isMenuRequest || details.method !== 'GET') return;

  const cached = await readMenuState(menuId, studentId);
  if (hasFreshMenuData(cached)) {
    await safeSend(details.tabId, { type: 'MODEUS_MENU_STATE', state: cached });
    return;
  }

  await safeSend(details.tabId, { type: 'MODEUS_MENU_LOADING', menuId });
  try {
    const state = await loadMenu(menuId, studentId, headers);
    await safeSend(details.tabId, { type: 'MODEUS_MENU_STATE', state });
  } catch (error) {
    await safeSend(details.tabId, {
      type: 'MODEUS_MENU_ERROR',
      menuId,
      error: error.message,
    });
  }
}

async function submitQueue(menuId, options = {}) {
  let state = await readMenuState(menuId);
  const requestTimeoutMs = options.requestTimeoutMs ?? 10000;
  const requestDelayMs = options.requestDelayMs ?? 0;
  const selections = buildSelectionPayloads(state).filter((selection) =>
    !options.pendingOnly || !isLessonSubmissionSuccessful(state, selection.lessonId)
  );
  if (selections.length === 0) {
    return { state, results: [] };
  }
  if (!state.studentId) throw new Error('Не удалось определить студента для отправки выбора');

  const headers = await getRememberedHeaders(menuId);
  const results = [];
  let sequence = 0;
  for (const [priority, selection] of selections.entries()) {
    const { moduleId, lessonId, lessonName, method, payload, fallback } = selection;
    if (options.cancellable && cancelledSubmissions.has(menuId)) break;
    sequence += 1;
    let result = await submitOne(menuId, state.studentId, headers, {
      lessonId, lessonName, method, payload, priority: priority + 1,
    }, { ...options, requestTimeoutMs, sequence });

    results.push(result);
    state = await readMenuState(menuId);
    markLessonResult(state, result.lessonId, result);
    appendRequestLog(state, result.log);
    state = await writeMenuState(state);
    await broadcastMenuState(menuId, state);

    const capacity = !result.success && method === 'POST'
      ? findTeamLimitExceeded(result.body, lessonId, payload)
      : null;
    if (capacity && fallback && !cancelledSubmissions.has(menuId)) {
      const safe = await verifyModuleHasNoRemoteSelection(state, moduleId, headers);
      if (safe) {
        sequence += 1;
        const fallbackResult = await submitOne(menuId, state.studentId, headers, {
          ...fallback,
          priority: priority + 1,
        }, { ...options, requestTimeoutMs, sequence, fallback: true });
        results.push(fallbackResult);
        state = await readMenuState(menuId);
        appendRequestLog(state, fallbackResult.log);
        const configuredFallback = state.fallbacks?.[moduleId];
        if (configuredFallback) {
          configuredFallback.status = fallbackResult.success ? 'success' : 'error';
          configuredFallback.error = fallbackResult.error ?? null;
          configuredFallback.responseBody = fallbackResult.body ?? fallbackResult.response ?? null;
        }
        if (fallbackResult.success && state.selected?.[moduleId]) {
          state.selected[moduleId].fallbackBooked = true;
        }
        state = await writeMenuState(state);
        await broadcastMenuState(menuId, state);
      } else {
        result.fallbackBlocked = 'План B заблокирован: не удалось доказать отсутствие уже записанной группы.';
      }
    }

    if (priority < selections.length - 1) await delay(requestDelayMs);
  }

  return { state, results };
}

async function submitOne(menuId, studentId, headers, selection, options) {
  const { lessonId, lessonName, method, payload, priority } = selection;
  const url = `${menuApiUrl(menuId, studentId)}/module-elements/${lessonId}/selected-teams`;
  const controller = new AbortController();
  requestControllers.set(menuId, controller);
  let abortKind = null;
  const timeoutId = setTimeout(() => {
    abortKind = 'timeout';
    controller.abort('timeout');
  }, options.requestTimeoutMs);
  const startedAt = Date.now();
  let result;
  try {
    const httpResponse = await fetch(url, {
      credentials: 'include',
      method,
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const response = await readResponseBody(httpResponse);
    if (!httpResponse.ok) {
      const error = new Error(modeusErrorMessage(httpResponse.status, response));
      error.status = httpResponse.status;
      error.body = response;
      throw error;
    }
    result = { lessonId, lessonName, method, priority, success: true, status: httpResponse.status, response };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    const stopped = aborted && (abortKind === 'stopped' || cancelledSubmissions.has(menuId));
    result = {
      lessonId, lessonName, method, priority, success: false,
      status: error.status ?? null,
      body: error.body ?? null,
      errorKind: stopped ? 'stopped' : aborted ? 'timeout' : 'http',
      error: stopped ? 'Остановлено пользователем' : aborted
        ? `Таймаут запроса через ${options.requestTimeoutMs} мс`
        : error.message,
    };
  } finally {
    clearTimeout(timeoutId);
    if (requestControllers.get(menuId) === controller) requestControllers.delete(menuId);
  }
  result.log = requestLogEntry(result, {
    ...selection,
    source: options.source,
    round: options.round,
    sequence: options.sequence,
    fallback: options.fallback,
    url,
    startedAt,
  });
  return result;
}

async function verifyModuleHasNoRemoteSelection(state, moduleId, headers) {
  const module = (state.data?.items ?? []).find((item) => item.id === moduleId);
  if (!module?.children?.length) return false;
  try {
    const details = await Promise.all(module.children.map((lesson) => requestModeus(
      `${menuApiUrl(state.menuId, state.studentId)}/module-elements/${lesson.id}`,
      { method: 'GET', headers }
    )));
    return details.every((detail) => (detail?.cycles ?? []).every((cycle) => !cycle.selectedTeamId));
  } catch {
    return false;
  }
}

async function submitAll(menuId) {
  if (activeSubmissions.has(menuId)) {
    throw new Error('Отправка для этого меню уже выполняется');
  }
  cancelledSubmissions.delete(menuId);
  activeSubmissions.add(menuId);
  try {
    return await submitQueue(menuId);
  } finally {
    activeSubmissions.delete(menuId);
  }
}

async function submitAutomationRound(menuId, rawSettings) {
  if (activeSubmissions.has(menuId)) {
    throw new Error('Отправка для этого меню уже выполняется');
  }
  const settings = normalizeAutomationSettings(rawSettings);
  cancelledSubmissions.delete(menuId);
  activeSubmissions.add(menuId);
  try {
    return await submitQueue(menuId, {
      pendingOnly: true,
      cancellable: true,
      requestTimeoutMs: settings.requestTimeoutMs,
      requestDelayMs: settings.requestDelayMs,
      source: rawSettings?.source ?? 'page',
      round: rawSettings?.round ?? null,
    });
  } finally {
    activeSubmissions.delete(menuId);
  }
}

async function automationRecord(menuId) {
  const key = `${AUTOMATION_PREFIX}${menuId}`;
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? null;
}

async function armBackupAlarm(menuId, settings) {
  cancelledSubmissions.delete(menuId);
  const normalized = normalizeAutomationSettings(settings);
  const key = `${AUTOMATION_PREFIX}${menuId}`;
  await chrome.storage.local.set({
    [key]: { active: true, owner: null, menuId, settings: normalized, round: 0, armedAt: Date.now() },
  });
  await chrome.alarms.create(`${ALARM_PREFIX}${menuId}`, { when: normalized.startAt });
  return normalized;
}

async function stopAutomation(menuId) {
  const key = `${AUTOMATION_PREFIX}${menuId}`;
  const record = await automationRecord(menuId);
  await chrome.storage.local.set({ [key]: { ...(record ?? {}), active: false, owner: null } });
  await chrome.alarms.clear(`${ALARM_PREFIX}${menuId}`);
}

async function claimAutomation(menuId, owner) {
  const record = await automationRecord(menuId);
  if (!record?.active) return owner === 'page';
  if (record.owner && record.owner !== owner) return false;
  record.owner = owner;
  await chrome.storage.local.set({ [`${AUTOMATION_PREFIX}${menuId}`]: record });
  return true;
}

async function runAlarmAutomation(menuId) {
  if (!await claimAutomation(menuId, 'alarm')) return;
  const record = await automationRecord(menuId);
  if (!record?.active) return;
  const settings = normalizeAutomationSettings(record.settings);
  let round = Number(record.round) || 0;
  while (!cancelledSubmissions.has(menuId)) {
    round += 1;
    const result = await submitAutomationRound(menuId, { ...settings, source: 'alarm', round });
    const pending = Object.values(result.state.selected ?? {}).some((selectedModule) => {
      if (selectedModule.fallbackBooked) return false;
      const cycles = Object.values(selectedModule.cycles ?? {});
      return cycles.length > 0 && cycles.some((cycle) => cycle.status !== 'success');
    });
    const current = await automationRecord(menuId);
    await chrome.storage.local.set({
      [`${AUTOMATION_PREFIX}${menuId}`]: { ...(current ?? {}), round, active: pending },
    });
    if (!pending || (settings.maxRounds > 0 && round >= settings.maxRounds)) {
      const finalRecord = await automationRecord(menuId);
      await chrome.storage.local.set({
        [`${AUTOMATION_PREFIX}${menuId}`]: { ...(finalRecord ?? {}), active: false, owner: null, round },
      });
      break;
    }
    await delay(settings.roundDelayMs);
  }
}

async function diagnoseSubmission(menuId, preferredLessonName = null) {
  const state = await readMenuState(menuId);
  if (!state.studentId) throw new Error('Не удалось определить студента для диагностики');

  const selectedModules = Object.values(state.selected ?? {});
  const selectedModule = selectedModules.find(
    (item) => preferredLessonName && item.lessonName === preferredLessonName
  ) ?? selectedModules[0];
  if (!selectedModule) throw new Error('Для диагностики сначала выберите хотя бы одну дисциплину');

  const firstCycleId = Object.values(selectedModule.cycles ?? {})[0]?.cycleId;
  if (!firstCycleId) throw new Error('Не удалось определить учебный цикл для диагностики');

  const tests = [
    { id: 'empty-array', label: 'Пустой массив', payload: [] },
    {
      id: 'unknown-team',
      label: 'Несуществующий teamId',
      payload: ['00000000-0000-0000-0000-000000000000'],
    },
    { id: 'cycle-as-team', label: 'cycleId вместо teamId', payload: [firstCycleId] },
    { id: 'object-body', label: 'Объект вместо массива', payload: { teamIds: [] } },
  ];

  const headers = await getRememberedHeaders(menuId);
  const url = `${menuApiUrl(menuId, state.studentId)}/module-elements/${selectedModule.lessonId}/selected-teams`;
  const results = [];
  for (const diagnostic of tests) {
    const result = await probeModeus(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(diagnostic.payload),
    });
    results.push({ ...diagnostic, ...result });
  }

  return {
    lessonId: selectedModule.lessonId,
    lessonName: selectedModule.lessonName,
    results,
  };
}

async function getActiveContext() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const { menuId, studentId } = extractPageContext(tab?.url);
  return {
    menuId,
    studentId,
    state: menuId ? await readMenuState(menuId, studentId) : null,
  };
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'MODEUS_PAGE_READY': {
      const state = await readMenuState(message.menuId, message.studentId);
      const headers = await getRememberedHeaders(message.menuId);
      if (!state.data && !loadingMenus.has(message.menuId) && Object.keys(headers).length > 0) {
        void loadMenu(message.menuId, message.studentId, headers)
          .then((loadedState) => broadcastMenuState(message.menuId, loadedState))
          .catch(() => {});
      }
      return {
        state,
        loading: loadingMenus.has(message.menuId),
      };
    }
    case 'GET_ACTIVE_CONTEXT':
      return getActiveContext();
    case 'SELECT_TEAM': {
      let state = await readMenuState(message.menuId, message.studentId);
      state = selectTeam(state, message.selection);
      state = await writeMenuState(state);
      await broadcastMenuState(message.menuId, state);
      return { state };
    }
    case 'SELECT_FALLBACK_TEAM': {
      let state = await readMenuState(message.menuId, message.studentId);
      state = selectFallbackTeam(state, message.selection);
      state = await writeMenuState(state);
      await broadcastMenuState(message.menuId, state);
      return { state };
    }
    case 'DESELECT_FALLBACK_TEAM': {
      let state = await readMenuState(message.menuId, message.studentId);
      state = deselectFallbackTeam(state, message.moduleId, message.lessonId, message.cycleId);
      state = await writeMenuState(state);
      await broadcastMenuState(message.menuId, state);
      return { state };
    }
    case 'CLEAR_FALLBACK': {
      let state = await readMenuState(message.menuId, message.studentId);
      state = clearFallback(state, message.moduleId);
      state = await writeMenuState(state);
      await broadcastMenuState(message.menuId, state);
      return { state };
    }
    case 'DESELECT_TEAM': {
      let state = await readMenuState(message.menuId, message.studentId);
      state = deselectTeam(
        state,
        message.moduleId,
        message.lessonId,
        message.cycleId
      );
      state = await writeMenuState(state);
      await broadcastMenuState(message.menuId, state);
      return { state };
    }
    case 'SET_SUBMISSION_PRIORITY': {
      let state = await readMenuState(message.menuId, message.studentId);
      state = setSubmissionPriority(state, message.lessonIds);
      state = await writeMenuState(state);
      await broadcastMenuState(message.menuId, state);
      return { state };
    }
    case 'SET_PLAN_B_ENABLED': {
      let state = await readMenuState(message.menuId, message.studentId);
      state.planBEnabled = Boolean(message.enabled);
      state = await writeMenuState(state);
      await broadcastMenuState(message.menuId, state);
      return { state };
    }
    case 'SUBMIT_SELECTIONS':
      return submitAll(message.menuId);
    case 'SUBMIT_AUTOMATION_ROUND': {
      if (!await claimAutomation(message.menuId, 'page')) {
        return { state: await readMenuState(message.menuId), results: [], skipped: true, owner: 'alarm' };
      }
      return submitAutomationRound(message.menuId, { ...message.settings, source: 'page', round: message.round });
    }
    case 'ARM_BACKUP_ALARM':
      return { settings: await armBackupAlarm(message.menuId, message.settings) };
    case 'DISARM_BACKUP_ALARM':
      await stopAutomation(message.menuId);
      return { stopped: true };
    case 'STOP_SUBMISSION':
      cancelledSubmissions.add(message.menuId);
      requestControllers.get(message.menuId)?.abort();
      await stopAutomation(message.menuId);
      return { stopped: true };
    case 'CLEAR_REQUEST_LOG': {
      let state = await readMenuState(message.menuId, message.studentId);
      state.requestLog = [];
      state = await writeMenuState(state);
      await broadcastMenuState(message.menuId, state);
      return { state };
    }
    case 'DIAGNOSE_SUBMISSION':
      return {
        diagnostics: await diagnoseSubmission(message.menuId, message.lessonName),
      };
    case 'REFRESH_MENU': {
      const headers = await getRememberedHeaders(message.menuId);
      const state = await loadMenu(message.menuId, message.studentId, headers, true);
      await broadcastMenuState(message.menuId, state);
      return { state };
    }
    default:
      return null;
  }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const context = extractBookingApiContext(details.url);
    if (!context) return;
    void handleCapturedMenuRequest(details, context);
  },
  { urls: ['https://urfu.modeus.org/course-unit-booking/api/v1/students/*/campaigns/*/student-campaign-menu*'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' && !changeInfo.url) return;
  const menuId = extractMenuIdFromPageUrl(tab.url);
  if (!menuId) return;
  const { studentId } = extractPageContext(tab.url);
  void ensureMenuContentScript(tabId, tab.url)
    .then(() => readMenuState(menuId, studentId))
    .then((state) => safeSend(tabId, { type: 'MODEUS_MENU_STATE', state }))
    .catch(() => {
      // Static content-script registration remains the primary injection path.
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const menuId = alarm.name.slice(ALARM_PREFIX.length);
  void runAlarmAutomation(menuId).catch(async (error) => {
    const state = await readMenuState(menuId);
    appendRequestLog(state, {
      id: `${Date.now()}-alarm`, source: 'alarm', completedAt: Date.now(), success: false,
      errorKind: 'alarm', error: error.message,
    });
    await writeMenuState(state);
  });
});
