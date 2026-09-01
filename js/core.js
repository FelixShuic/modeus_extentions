const MODEUS_ORIGIN = 'https://urfu.modeus.org';
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export const DEFAULT_AUTOMATION_SETTINGS = Object.freeze({
  startAt: null,
  requestTimeoutMs: 10000,
  requestDelayMs: 100,
  roundDelayMs: 1000,
  maxRounds: 0,
  backupAlarm: false,
});

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function normalizeAutomationSettings(settings = {}, now = Date.now()) {
  const requestedStart = Number(settings.startAt);
  return {
    startAt: Number.isFinite(requestedStart) && requestedStart > now ? requestedStart : now,
    requestTimeoutMs: boundedInteger(settings.requestTimeoutMs, 10000, 250, 120000),
    requestDelayMs: boundedInteger(settings.requestDelayMs, 100, 0, 60000),
    roundDelayMs: boundedInteger(settings.roundDelayMs, 1000, 250, 600000),
    maxRounds: boundedInteger(settings.maxRounds, 0, 0, 100000),
    backupAlarm: Boolean(settings.backupAlarm),
  };
}

function extractPathId(rawUrl, prefix, allowSuffix) {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== MODEUS_ORIGIN) return null;

    const parts = url.pathname.split('/').filter(Boolean);
    const prefixParts = prefix.split('/').filter(Boolean);
    const prefixIndex = parts.findIndex((part, index) =>
      prefixParts.every((expected, offset) => parts[index + offset] === expected)
    );
    const idIndex = prefixIndex + prefixParts.length;
    const candidate = prefixIndex >= 0 ? parts[idIndex] : null;
    if (!allowSuffix && parts.length !== idIndex + 1) return null;
    return candidate && UUID_PATTERN.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function extractMenuIdFromPageUrl(url) {
  return extractPathId(url, 'learning-path-selection/menus', true);
}

export function extractPageContext(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== MODEUS_ORIGIN) return { menuId: null, studentId: null };

    const parts = parsed.pathname.split('/').filter(Boolean);
    const menusIndex = parts.indexOf('menus');
    const studentIndex = parts.indexOf('student', menusIndex + 2);
    const menuId = menusIndex >= 0 ? parts[menusIndex + 1] : null;
    const studentId = studentIndex >= 0 ? parts[studentIndex + 1] : null;
    return {
      menuId: menuId && UUID_PATTERN.test(menuId) ? menuId : null,
      studentId: studentId && UUID_PATTERN.test(studentId) ? studentId : null,
    };
  } catch {
    return { menuId: null, studentId: null };
  }
}

export function extractMenuIdFromApiUrl(url) {
  return extractPathId(url, 'learning-path-selection/api/selection/menus', false);
}

export function extractBookingApiContext(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== MODEUS_ORIGIN) return null;

    const parts = parsed.pathname.split('/').filter(Boolean);
    const prefix = ['course-unit-booking', 'api', 'v1', 'students'];
    if (!prefix.every((part, index) => parts[index] === part)) return null;

    const studentId = parts[4];
    const campaignsIndex = 5;
    const menuId = parts[6];
    if (
      parts[campaignsIndex] !== 'campaigns' ||
      parts[7] !== 'student-campaign-menu' ||
      !UUID_PATTERN.test(studentId) ||
      !UUID_PATTERN.test(menuId)
    ) {
      return null;
    }

    const resource = parts[8] ?? null;
    const elementId = parts[9] ?? null;
    return {
      menuId,
      studentId,
      isMenuRequest: parts.length === 8,
      resource,
      elementId,
    };
  } catch {
    return null;
  }
}

export function normalizeMenuPayload(payload) {
  const electives = payload?.electives ?? payload;
  if (!electives || !Array.isArray(electives.items)) {
    throw new Error('Modeus вернул меню в неизвестном формате');
  }
  return { ...electives, items: electives.items };
}

function teacherName(teacher) {
  if (typeof teacher === 'string') return teacher;
  if (!teacher || typeof teacher !== 'object') return '';
  return teacher.name || teacher.fullName || [teacher.lastName, teacher.firstName, teacher.middleName]
    .filter(Boolean)
    .join(' ');
}

export function normalizeBookingMenuPayload(payload, moduleDetails = {}) {
  if (!payload || !Array.isArray(payload.moduleElements) || !Array.isArray(payload.courseElements)) {
    throw new Error('Modeus вернул меню в неизвестном формате');
  }

  const elements = [...payload.moduleElements, ...payload.courseElements];
  const elementsById = new Map(elements.map((element) => [element.id, element]));
  const groups = new Map();

  function rootElement(element) {
    let current = element;
    const visited = new Set();
    while (current?.parentId && elementsById.has(current.parentId) && !visited.has(current.id)) {
      visited.add(current.id);
      current = elementsById.get(current.parentId);
    }
    return current ?? element;
  }

  for (const element of payload.moduleElements) {
    const detail = moduleDetails[element.id];
    if (!detail || !Array.isArray(detail.cycles) || detail.cycles.length === 0) continue;

    const root = rootElement(element);
    const group = groups.get(root.id) ?? {
      id: root.id,
      name: root.name || element.name || 'Модуль',
      children: [],
    };

    group.children.push({
      id: element.id,
      name: element.name || group.name,
      cycles: detail.cycles.map((cycle) => ({
        id: cycle.id,
        name: cycle.name || 'Учебный цикл',
        selectedTeamId: cycle.selectedTeamId ?? null,
        teams: (cycle.teams ?? []).map((team) => ({
          id: team.id,
          name: team.name,
          availableSeats: team.available,
          totalSeats: team.limit,
          professors: (team.teachers ?? []).map((teacher) => ({ name: teacherName(teacher) })),
        })),
      })),
    });
    groups.set(root.id, group);
  }

  return {
    id: payload.campaignId,
    name: payload.campaignName,
    selectionStatus: payload.selectionStatus,
    menuAvailabilityStatus: payload.menuAvailabilityStatus,
    items: [...groups.values()],
  };
}

export function selectTeam(state, selection) {
  const { moduleId, moduleName, lessonId, lessonName, cycleId, cycleName, teamId, teamName } = selection;
  if (![moduleId, lessonId, cycleId, teamId].every(Boolean)) {
    throw new Error('Не удалось определить выбранную группу');
  }

  const currentModule = state.selected[moduleId];
  if (currentModule && currentModule.lessonId !== lessonId) {
    throw new Error('В этом модуле уже выбрана другая дисциплина');
  }

  const nextModule = currentModule ?? {
    moduleId,
    moduleName,
    lessonId,
    lessonName,
    cycles: {},
  };
  nextModule.cycles[cycleId] = {
    cycleId,
    cycleName,
    teamId,
    teamName,
    status: 'selected',
    error: null,
    httpStatus: null,
    responseBody: null,
  };
  state.selected[moduleId] = nextModule;
  return state;
}

export function deselectTeam(state, moduleId, lessonId, cycleId) {
  const selectedModule = state.selected[moduleId];
  if (!selectedModule || selectedModule.lessonId !== lessonId) return state;

  delete selectedModule.cycles[cycleId];
  if (Object.keys(selectedModule.cycles).length === 0) {
    delete state.selected[moduleId];
  }
  return state;
}

export function selectFallbackTeam(state, selection) {
  const { moduleId, moduleName, lessonId, lessonName, cycleId, cycleName, teamId, teamName } = selection;
  if (![moduleId, lessonId, cycleId, teamId].every(Boolean)) {
    throw new Error('Не удалось определить резервную группу');
  }
  const primary = state.selected?.[moduleId];
  if (!primary) throw new Error('Сначала выберите основную дисциплину');
  const fallback = state.fallbacks?.[moduleId];
  if (fallback && fallback.lessonId !== lessonId) {
    throw new Error('В Плане B этого модуля уже выбрана другая дисциплина');
  }
  state.fallbacks ??= {};
  const next = fallback ?? { moduleId, moduleName, lessonId, lessonName, cycles: {} };
  next.cycles[cycleId] = { cycleId, cycleName, teamId, teamName, status: 'selected', error: null };
  state.fallbacks[moduleId] = next;
  return state;
}

export function deselectFallbackTeam(state, moduleId, lessonId, cycleId) {
  const fallback = state.fallbacks?.[moduleId];
  if (!fallback || fallback.lessonId !== lessonId) return state;
  delete fallback.cycles[cycleId];
  if (Object.keys(fallback.cycles).length === 0) delete state.fallbacks[moduleId];
  return state;
}

export function clearFallback(state, moduleId) {
  if (state.fallbacks) delete state.fallbacks[moduleId];
  return state;
}

export function selectedLessonIds(state) {
  return Object.values(state.selected ?? {}).map((selectedModule) => selectedModule.lessonId);
}

export function setSubmissionPriority(state, lessonIds) {
  const selectedIds = selectedLessonIds(state);
  const selectedSet = new Set(selectedIds);
  const seen = new Set();
  const normalized = [];

  for (const lessonId of lessonIds ?? []) {
    if (!selectedSet.has(lessonId) || seen.has(lessonId)) continue;
    seen.add(lessonId);
    normalized.push(lessonId);
  }
  for (const lessonId of selectedIds) {
    if (seen.has(lessonId)) continue;
    seen.add(lessonId);
    normalized.push(lessonId);
  }

  state.priority = normalized;
  return state;
}

export function buildSelectionPayloads(state) {
  const priority = setSubmissionPriority(state, state.priority).priority;
  const priorityIndex = new Map(priority.map((lessonId, index) => [lessonId, index]));

  return Object.values(state.selected).filter((selectedModule) => !selectedModule.fallbackBooked).map((selectedModule) => {
    const fallback = state.planBEnabled ? buildFallbackPayload(state, selectedModule) : null;
    return {
      moduleId: selectedModule.moduleId,
      lessonId: selectedModule.lessonId,
      lessonName: selectedModule.lessonName,
      method: selectedModule.remoteBooked || hasRemoteSelection(state.data, selectedModule.lessonId)
        ? 'PUT'
        : 'POST',
      payload: Object.values(selectedModule.cycles).map((cycle) => cycle.teamId),
      ...(fallback ? { fallback } : {}),
    };
  }).sort((left, right) =>
    (priorityIndex.get(left.lessonId) ?? Number.MAX_SAFE_INTEGER) -
    (priorityIndex.get(right.lessonId) ?? Number.MAX_SAFE_INTEGER)
  );
}

function findLesson(menuData, moduleId, lessonId) {
  const module = (menuData?.items ?? []).find((item) => item.id === moduleId);
  return (module?.children ?? []).find((lesson) => lesson.id === lessonId) ?? null;
}

export function buildFallbackPayload(state, selectedModule) {
  const fallback = state.fallbacks?.[selectedModule.moduleId];
  if (!fallback || fallback.status === 'success') return null;
  const lesson = findLesson(state.data, selectedModule.moduleId, fallback.lessonId);
  const expectedCycles = lesson?.cycles ?? [];
  if (expectedCycles.length === 0) return null;
  const cycles = fallback.cycles ?? {};
  if (!expectedCycles.every((cycle) => cycles[cycle.id]?.teamId)) return null;
  const payload = expectedCycles.map((cycle) => cycles[cycle.id].teamId);
  if (fallback.lessonId === selectedModule.lessonId) {
    const primaryTeams = new Set(Object.values(selectedModule.cycles ?? {}).map((cycle) => cycle.teamId));
    if (payload.every((teamId) => primaryTeams.has(teamId))) return null;
  }
  return {
    moduleId: fallback.moduleId,
    lessonId: fallback.lessonId,
    lessonName: fallback.lessonName,
    method: 'POST',
    payload,
  };
}

export function findTeamLimitExceeded(body, lessonId, attemptedTeamIds) {
  const errors = Array.isArray(body) ? body : (
    body && typeof body === 'object' && 'moduleElementId' in body && Array.isArray(body.errors)
      ? [body]
      : []
  );
  const moduleError = errors.find((entry) => entry?.moduleElementId === lessonId);
  const limitError = moduleError?.errors?.find((entry) => entry?.code === 'TEAM_LIMIT_EXCEEDED');
  const exceeded = limitError?.payload?.teamIdsWithLimitExceeded;
  if (!Array.isArray(exceeded) || exceeded.length === 0) return null;
  const attempted = new Set(attemptedTeamIds ?? []);
  if (!exceeded.every((teamId) => attempted.has(teamId))) return null;
  return { error: limitError, teamIds: exceeded };
}

export function isLessonSubmissionSuccessful(state, lessonId) {
  const selectedModule = Object.values(state.selected ?? {})
    .find((item) => item.lessonId === lessonId);
  const cycles = Object.values(selectedModule?.cycles ?? {});
  return cycles.length > 0 && cycles.every((cycle) => cycle.status === 'success');
}

function hasRemoteSelection(menuData, lessonId) {
  return (menuData?.items ?? []).some((module) =>
    (module.children ?? []).some((lesson) =>
      lesson.id === lessonId &&
      (lesson.cycles ?? []).some((cycle) => Boolean(cycle.selectedTeamId))
    )
  );
}

export function flattenSelections(state) {
  return Object.values(state.selected).flatMap((selectedModule) =>
    Object.values(selectedModule.cycles).map((cycle) => ({
      moduleId: selectedModule.moduleId,
      moduleName: selectedModule.moduleName,
      lessonId: selectedModule.lessonId,
      lessonName: selectedModule.lessonName,
      ...cycle,
    }))
  );
}

export function markLessonResult(state, lessonId, result) {
  for (const selectedModule of Object.values(state.selected)) {
    if (selectedModule.lessonId !== lessonId) continue;
    if (result.success) selectedModule.remoteBooked = true;
    for (const cycle of Object.values(selectedModule.cycles)) {
      cycle.status = result.success ? 'success' : 'error';
      cycle.error = result.success ? null : result.error;
      cycle.httpStatus = result.status ?? null;
      cycle.responseBody = result.body ?? result.response ?? null;
    }
  }
  return state;
}

export function formatModeusResponseBody(body) {
  if (body == null || body === '') return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

export function modeusErrorMessage(status, body = null) {
  const rawBody = formatModeusResponseBody(body);
  if (rawBody) return `HTTP ${status}\n${rawBody}`;

  const messages = {
    400: 'Неправильно выбраны предметы или обнаружен конфликт в расписании.',
    401: 'Сессия Modeus истекла. Обновите страницу и войдите снова.',
    404: 'Меню выбора не найдено.',
    409: 'Меню выбора заблокировано. Выбор сейчас невозможен.',
  };
  if (messages[status]) return `HTTP ${status}\n${messages[status]}`;
  if (status >= 500) return `HTTP ${status}\nModeus временно недоступен.`;
  return `Modeus вернул HTTP ${status}`;
}
