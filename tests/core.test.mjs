import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSelectionPayloads,
  buildFallbackPayload,
  deselectTeam,
  extractBookingApiContext,
  extractMenuIdFromApiUrl,
  extractMenuIdFromPageUrl,
  extractPageContext,
  findTeamLimitExceeded,
  flattenSelections,
  formatModeusResponseBody,
  markLessonResult,
  modeusErrorMessage,
  normalizeAutomationSettings,
  normalizeBookingMenuPayload,
  normalizeMenuPayload,
  selectTeam,
  selectFallbackTeam,
  setSubmissionPriority,
} from '../js/core.js';

const MENU_ID = 'a216efc8-e857-4817-bca0-fb794c509ff6';
const STUDENT_ID = '61f6531d-e1a0-4373-bd9c-991b7c0d8353';

function emptyState() {
  return { menuId: MENU_ID, selected: {} };
}

function selection(overrides = {}) {
  return {
    moduleId: 'module-1',
    moduleName: 'Модуль',
    lessonId: 'lesson-1',
    lessonName: 'Дисциплина',
    cycleId: 'cycle-1',
    cycleName: 'Практика',
    teamId: 'team-1',
    teamName: 'Группа 1',
    ...overrides,
  };
}

test('extracts menu ID from every supported page URL shape', () => {
  assert.equal(
    extractMenuIdFromPageUrl(`https://urfu.modeus.org/learning-path-selection/menus/${MENU_ID}`),
    MENU_ID
  );
  assert.equal(
    extractMenuIdFromPageUrl(
      `https://urfu.modeus.org/learning-path-selection/menus/${MENU_ID}/student/${STUDENT_ID}/details?tab=groups`
    ),
    MENU_ID
  );
  assert.equal(
    extractMenuIdFromPageUrl('https://urfu.modeus.org/learning-path-selection/menus'),
    null
  );
  assert.equal(
    extractMenuIdFromPageUrl(`https://example.org/learning-path-selection/menus/${MENU_ID}`),
    null
  );
});

test('extracts student and campaign IDs from current page and booking API URLs', () => {
  const pageUrl = `https://urfu.modeus.org/learning-path-selection/menus/${MENU_ID}/student/${STUDENT_ID}`;
  assert.deepEqual(extractPageContext(pageUrl), { menuId: MENU_ID, studentId: STUDENT_ID });

  const apiUrl = `https://urfu.modeus.org/course-unit-booking/api/v1/students/${STUDENT_ID}/campaigns/${MENU_ID}/student-campaign-menu`;
  assert.deepEqual(extractBookingApiContext(apiUrl), {
    menuId: MENU_ID,
    studentId: STUDENT_ID,
    isMenuRequest: true,
    resource: null,
    elementId: null,
  });
  assert.equal(
    extractBookingApiContext(`${apiUrl}/module-elements/module-1`).isMenuRequest,
    false
  );
});

test('extracts menu ID only from selection API URLs', () => {
  assert.equal(
    extractMenuIdFromApiUrl(
      `https://urfu.modeus.org/learning-path-selection/api/selection/menus/${MENU_ID}/?student=${STUDENT_ID}`
    ),
    MENU_ID
  );
  assert.equal(
    extractMenuIdFromApiUrl(`https://urfu.modeus.org/learning-path-selection/api/menus/${MENU_ID}`),
    null
  );
  assert.equal(
    extractMenuIdFromApiUrl(
      `https://urfu.modeus.org/learning-path-selection/api/selection/menus/${MENU_ID}/items/lesson-1`
    ),
    null
  );
});

test('normalizes the Modeus electives envelope', () => {
  const items = [{ id: 'module-1', children: [] }];
  assert.deepEqual(normalizeMenuPayload({ electives: { items } }).items, items);
  assert.deepEqual(normalizeMenuPayload({ items }).items, items);
  assert.throws(() => normalizeMenuPayload({}), /неизвестном формате/);
});

test('normalizes current booking menu and module cycles', () => {
  const menu = normalizeBookingMenuPayload({
    campaignId: MENU_ID,
    campaignName: 'Выбор модулей',
    moduleElements: [
      { id: 'module-1', name: 'Модуль', parentId: null },
      { id: 'lesson-1', name: 'Дисциплина', parentId: 'module-1' },
    ],
    courseElements: [],
  }, {
    'lesson-1': {
      cycles: [{
        id: 'cycle-1',
        name: 'Практика',
        teams: [{ id: 'team-1', name: 'АТ-01', available: 5, limit: 25, teachers: [{ name: 'Иванов И.И.' }] }],
      }],
    },
  });

  assert.equal(menu.items[0].children[0].id, 'lesson-1');
  assert.equal(menu.items[0].children[0].cycles[0].teams[0].availableSeats, 5);
  assert.equal(menu.items[0].children[0].cycles[0].teams[0].professors[0].name, 'Иванов И.И.');
});

test('selection follows module → lesson → cycle → team model', () => {
  const state = emptyState();
  selectTeam(state, selection());
  selectTeam(state, selection({ cycleId: 'cycle-2', teamId: 'team-2', teamName: 'Группа 2' }));

  assert.deepEqual(buildSelectionPayloads(state), [{
    moduleId: 'module-1',
    lessonId: 'lesson-1',
    lessonName: 'Дисциплина',
    method: 'POST',
    payload: ['team-1', 'team-2'],
  }]);
  assert.equal(flattenSelections(state).length, 2);

  assert.throws(
    () => selectTeam(state, selection({ lessonId: 'lesson-2', cycleId: 'cycle-3' })),
    /другая дисциплина/
  );
});

test('replacing and removing a cycle keeps state consistent', () => {
  const state = emptyState();
  selectTeam(state, selection());
  selectTeam(state, selection({ teamId: 'team-2', teamName: 'Группа 2' }));
  assert.equal(flattenSelections(state)[0].teamId, 'team-2');

  deselectTeam(state, 'module-1', 'lesson-1', 'cycle-1');
  assert.deepEqual(state.selected, {});
});

test('submission results update every cycle of a lesson', () => {
  const state = emptyState();
  selectTeam(state, selection());
  selectTeam(state, selection({ cycleId: 'cycle-2', teamId: 'team-2' }));
  const body = { code: 'CAMPAIGN_NOT_STARTED', message: 'Выбор пока не начался' };
  markLessonResult(state, 'lesson-1', {
    success: false,
    status: 400,
    body,
    error: 'HTTP 400',
  });

  assert.ok(flattenSelections(state).every((item) => item.status === 'error'));
  assert.ok(flattenSelections(state).every((item) => item.error === 'HTTP 400'));
  assert.ok(flattenSelections(state).every((item) => item.httpStatus === 400));
  assert.ok(flattenSelections(state).every((item) => item.responseBody === body));
});

test('uses PUT after a successful booking and for selections reported by Modeus', () => {
  const state = emptyState();
  selectTeam(state, selection());
  assert.equal(buildSelectionPayloads(state)[0].method, 'POST');

  markLessonResult(state, 'lesson-1', { success: true, response: { accepted: true } });
  assert.equal(buildSelectionPayloads(state)[0].method, 'PUT');

  const loadedState = emptyState();
  loadedState.data = {
    items: [{
      children: [{
        id: 'lesson-1',
        cycles: [{ id: 'cycle-1', selectedTeamId: 'team-old' }],
      }],
    }],
  };
  selectTeam(loadedState, selection());
  assert.equal(buildSelectionPayloads(loadedState)[0].method, 'PUT');
});

test('submission payloads follow the saved drag-and-drop priority', () => {
  const state = emptyState();
  selectTeam(state, selection());
  selectTeam(state, selection({
    moduleId: 'module-2',
    moduleName: 'Модуль 2',
    lessonId: 'lesson-2',
    lessonName: 'Математика',
    cycleId: 'cycle-2',
    teamId: 'team-2',
  }));

  setSubmissionPriority(state, ['lesson-2', 'lesson-1', 'unknown', 'lesson-2']);
  assert.deepEqual(state.priority, ['lesson-2', 'lesson-1']);
  assert.deepEqual(
    buildSelectionPayloads(state).map((item) => item.lessonId),
    ['lesson-2', 'lesson-1']
  );
});

test('Plan B is complete, POST-only, and capacity detection is exact', () => {
  const state = emptyState();
  state.planBEnabled = true;
  state.data = {
    items: [{
      id: 'module-1',
      children: [{
        id: 'lesson-1', name: 'Дисциплина',
        cycles: [
          { id: 'cycle-1', teams: [{ id: 'team-1' }, { id: 'team-b1' }] },
          { id: 'cycle-2', teams: [{ id: 'team-2' }, { id: 'team-b2' }] },
        ],
      }],
    }],
  };
  selectTeam(state, selection());
  selectTeam(state, selection({ cycleId: 'cycle-2', teamId: 'team-2' }));
  selectFallbackTeam(state, selection({ teamId: 'team-b1' }));
  assert.equal(buildFallbackPayload(state, state.selected['module-1']), null, 'неполный резерв не отправляется');
  selectFallbackTeam(state, selection({ cycleId: 'cycle-2', teamId: 'team-2' }));
  assert.deepEqual(buildSelectionPayloads(state)[0].fallback, {
    moduleId: 'module-1', lessonId: 'lesson-1', lessonName: 'Дисциплина',
    method: 'POST', payload: ['team-b1', 'team-2'],
  });

  const body = [{
    moduleElementId: 'lesson-1',
    errors: [{
      code: 'TEAM_LIMIT_EXCEEDED', message: 'Нет мест',
      payload: { teamIdsWithLimitExceeded: ['team-1'] },
    }],
  }];
  assert.deepEqual(findTeamLimitExceeded(body, 'lesson-1', ['team-1', 'team-2']).teamIds, ['team-1']);
  assert.equal(findTeamLimitExceeded(body, 'lesson-2', ['team-1']), null);
  assert.equal(findTeamLimitExceeded(body, 'lesson-1', ['another-team']), null);
  assert.equal(findTeamLimitExceeded({ message: 'нет мест' }, 'lesson-1', ['team-1']), null);

  state.planBEnabled = false;
  assert.equal('fallback' in buildSelectionPayloads(state)[0], false, 'выключенный План B даже не попадает в очередь');
});

test('automation settings clamp unsafe timeout values', () => {
  assert.deepEqual(normalizeAutomationSettings({
    startAt: 1,
    requestTimeoutMs: 1,
    requestDelayMs: -10,
    roundDelayMs: 9999999,
    maxRounds: -5,
  }, 1000), {
    startAt: 1000,
    requestTimeoutMs: 250,
    requestDelayMs: 0,
    roundDelayMs: 600000,
    maxRounds: 0,
    backupAlarm: false,
  });
});

test('shows the raw Modeus error body before fallback messages', () => {
  const body = { code: 'CAMPAIGN_NOT_STARTED', message: 'Выбор пока не начался' };
  assert.equal(formatModeusResponseBody(body), JSON.stringify(body, null, 2));
  assert.equal(modeusErrorMessage(400, body), `HTTP 400\n${JSON.stringify(body, null, 2)}`);
  assert.match(modeusErrorMessage(400), /конфликт/);
  assert.match(modeusErrorMessage(401), /Сессия/);
  assert.match(modeusErrorMessage(409), /заблокировано/);
  assert.match(modeusErrorMessage(503), /недоступен/);
});
