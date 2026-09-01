import test from 'node:test';
import assert from 'node:assert/strict';

const MENU_ID = 'a216efc8-e857-4817-bca0-fb794c509ff6';
const STUDENT_ID = '61f6531d-e1a0-4373-bd9c-991b7c0d8353';

function storageArea(map) {
  return {
    async get(key) {
      if (typeof key === 'string') return { [key]: map.get(key) };
      return Object.fromEntries(map);
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) map.set(key, value);
    },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('background loads groups and mirrors Modeus POST/PUT booking semantics', async () => {
  const local = new Map();
  const session = new Map();
  const listeners = {};
  const sentMessages = [];
  const fetchCalls = [];
  let postStatus = 200;
  let postBody = { accepted: true };
  const selectedResponseQueue = [];
  let remoteSelectedTeamId = null;
  const activeUrl = `https://urfu.modeus.org/learning-path-selection/menus/${MENU_ID}/student/${STUDENT_ID}`;

  globalThis.chrome = {
    storage: {
      local: storageArea(local),
      session: storageArea(session),
    },
    tabs: {
      onUpdated: { addListener(listener) { listeners.tabUpdated = listener; } },
      async query() { return [{ id: 7, url: activeUrl }]; },
      async sendMessage(tabId, message) { sentMessages.push({ tabId, message }); },
    },
    scripting: {
      async insertCSS() {},
      async executeScript() {},
    },
    webRequest: {
      onBeforeSendHeaders: { addListener(listener) { listeners.webRequest = listener; } },
    },
    runtime: {
      onMessage: { addListener(listener) { listeners.runtime = listener; } },
    },
  };

  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, options });
    if (url.endsWith('/module-elements/lesson-1')) {
      return new Response(JSON.stringify({
        cycles: [
          { id: 'cycle-1', name: 'Практика', teams: [{ id: 'team-1', name: 'АТ-01', available: 5, limit: 25, teachers: [] }] },
          { id: 'cycle-2', name: 'Лекция', teams: [{ id: 'team-2', name: 'Л-01', available: 10, limit: 50, teachers: [] }] },
        ],
      }), { status: 200 });
    }
    if (url.endsWith('/module-elements/module-1')) {
      return new Response(JSON.stringify({ cycles: [] }), { status: 200 });
    }
    if (url.endsWith('/module-elements/primary-b') || url.endsWith('/module-elements/fallback-b')) {
      return new Response(JSON.stringify({
        cycles: [{ id: 'cycle-b', selectedTeamId: remoteSelectedTeamId, teams: [] }],
      }), { status: 200 });
    }
    if (url.includes('/selected-teams')) {
      const queued = selectedResponseQueue.shift();
      return new Response(JSON.stringify(queued?.body ?? postBody), { status: queued?.status ?? postStatus });
    }
    return new Response(JSON.stringify({
      campaignId: MENU_ID,
      campaignName: 'Выбор модулей',
      moduleElements: [
        { id: 'module-1', name: 'Модуль', parentId: null },
        { id: 'lesson-1', name: 'Дисциплина', parentId: 'module-1' },
      ],
      courseElements: [],
    }), { status: 200 });
  };

  await import(`../js/background.js?test=${Date.now()}`);
  assert.equal(typeof listeners.webRequest, 'function');
  assert.equal(typeof listeners.runtime, 'function');

  listeners.webRequest({
    tabId: 7,
    method: 'GET',
    url: `https://urfu.modeus.org/course-unit-booking/api/v1/students/${STUDENT_ID}/campaigns/${MENU_ID}/student-campaign-menu`,
    requestHeaders: [{ name: 'Authorization', value: 'Bearer test' }],
  });

  const storageKey = `modeus-picker:menu:${MENU_ID}`;
  await waitFor(() => local.get(storageKey)?.data);
  assert.equal(local.get(storageKey).data.items[0].children[0].cycles.length, 2);

  const send = (message) => new Promise((resolve) => {
    const keepAlive = listeners.runtime(message, {}, resolve);
    assert.equal(keepAlive, true);
  });

  let response = await send({
    type: 'SELECT_TEAM',
    menuId: MENU_ID,
    studentId: STUDENT_ID,
    selection: {
      moduleId: 'module-1', moduleName: 'Модуль',
      lessonId: 'lesson-1', lessonName: 'Дисциплина',
      cycleId: 'cycle-1', cycleName: 'Практика',
      teamId: 'team-1', teamName: 'АТ-01',
    },
  });
  assert.equal(response.ok, true);

  response = await send({
    type: 'SELECT_TEAM',
    menuId: MENU_ID,
    studentId: STUDENT_ID,
    selection: {
      moduleId: 'module-1', moduleName: 'Модуль',
      lessonId: 'lesson-1', lessonName: 'Дисциплина',
      cycleId: 'cycle-2', cycleName: 'Лекция',
      teamId: 'team-2', teamName: 'Л-01',
    },
  });
  assert.equal(response.ok, true);

  response = await send({ type: 'GET_ACTIVE_CONTEXT' });
  assert.equal(response.menuId, MENU_ID);
  assert.equal(response.studentId, STUDENT_ID);
  assert.equal(Object.keys(response.state.selected['module-1'].cycles).length, 2);

  response = await send({ type: 'SUBMIT_SELECTIONS', menuId: MENU_ID });
  assert.equal(response.ok, true);
  assert.equal(response.results[0].success, true);

  const post = fetchCalls.find((call) => call.url.includes('/selected-teams'));
  assert.equal(post.options.method, 'POST');
  assert.match(post.url, /module-elements\/lesson-1\/selected-teams$/);
  assert.deepEqual(JSON.parse(post.options.body), ['team-1', 'team-2']);
  assert.equal(post.options.headers.Authorization, 'Bearer test');
  assert.ok(sentMessages.some(({ message }) => message.type === 'MODEUS_MENU_STATE'));

  response = await send({ type: 'SUBMIT_SELECTIONS', menuId: MENU_ID });
  assert.equal(response.results[0].success, true, 'every click submits all selected lessons again');
  assert.equal(
    fetchCalls.filter((call) => call.url.includes('/selected-teams')).length,
    2
  );
  assert.equal(
    fetchCalls.filter((call) => call.url.includes('/selected-teams'))[1].options.method,
    'PUT',
    'the official Angular client updates an existing booking with PUT'
  );

  await send({
    type: 'SELECT_TEAM',
    menuId: MENU_ID,
    studentId: STUDENT_ID,
    selection: {
      moduleId: 'module-1', moduleName: 'Модуль',
      lessonId: 'lesson-1', lessonName: 'Дисциплина',
      cycleId: 'cycle-1', cycleName: 'Практика',
      teamId: 'team-1', teamName: 'АТ-01',
    },
  });
  postStatus = 400;
  postBody = { code: 'CAMPAIGN_NOT_STARTED', message: 'Выбор пока не начался' };
  response = await send({ type: 'SUBMIT_SELECTIONS', menuId: MENU_ID });
  assert.equal(response.results[0].success, false);
  assert.equal(response.results[0].status, 400);
  assert.deepEqual(response.results[0].body, postBody);
  assert.match(response.results[0].error, /CAMPAIGN_NOT_STARTED/);
  assert.match(response.results[0].error, /Выбор пока не начался/);
  assert.equal(
    response.state.selected['module-1'].cycles['cycle-1'].status,
    'error'
  );
  assert.deepEqual(
    response.state.selected['module-1'].cycles['cycle-1'].responseBody,
    postBody
  );

  response = await send({ type: 'SUBMIT_SELECTIONS', menuId: MENU_ID });
  assert.equal(response.results[0].success, false, 'an error remains an error but can be submitted again');
  assert.equal(
    fetchCalls.filter((call) => call.url.includes('/selected-teams')).length,
    4
  );

  const selectedBeforeDiagnostics = structuredClone(response.state.selected);
  const postsBeforeDiagnostics = fetchCalls.filter((call) => call.url.includes('/selected-teams')).length;
  response = await send({
    type: 'DIAGNOSE_SUBMISSION',
    menuId: MENU_ID,
    lessonName: 'Дисциплина',
  });
  assert.equal(response.ok, true);
  assert.equal(response.diagnostics.lessonId, 'lesson-1');
  assert.equal(response.diagnostics.results.length, 4);
  assert.ok(response.diagnostics.results.every((result) => result.status === 400));

  const diagnosticPosts = fetchCalls
    .filter((call) => call.url.includes('/selected-teams'))
    .slice(postsBeforeDiagnostics);
  assert.deepEqual(diagnosticPosts.map((call) => JSON.parse(call.options.body)), [
    [],
    ['00000000-0000-0000-0000-000000000000'],
    ['cycle-1'],
    { teamIds: [] },
  ]);
  assert.deepEqual(local.get(storageKey).selected, selectedBeforeDiagnostics);

  postStatus = 200;
  postBody = { accepted: true };
  response = await send({
    type: 'SUBMIT_AUTOMATION_ROUND',
    menuId: MENU_ID,
    settings: {
      requestTimeoutMs: 1000,
      requestDelayMs: 0,
    },
  });
  assert.equal(response.results[0].success, true);
  assert.equal(
    fetchCalls.filter((call) => call.url.includes('/selected-teams')).at(-1).options.method,
    'PUT'
  );

  const planBState = local.get(storageKey);
  planBState.data.items = [{
    id: 'module-b', name: 'Спецкурс',
    children: [
      { id: 'primary-b', name: 'Приоритет', cycles: [{ id: 'cycle-b', teams: [{ id: 'team-full' }] }] },
      { id: 'fallback-b', name: 'Резерв', cycles: [{ id: 'cycle-b2', teams: [{ id: 'team-free' }] }] },
    ],
  }];
  planBState.selected = {
    'module-b': {
      moduleId: 'module-b', moduleName: 'Спецкурс', lessonId: 'primary-b', lessonName: 'Приоритет',
      cycles: { 'cycle-b': { cycleId: 'cycle-b', teamId: 'team-full', status: 'selected' } },
    },
  };
  planBState.fallbacks = {
    'module-b': {
      moduleId: 'module-b', moduleName: 'Спецкурс', lessonId: 'fallback-b', lessonName: 'Резерв',
      cycles: { 'cycle-b2': { cycleId: 'cycle-b2', teamId: 'team-free', status: 'selected' } },
    },
  };
  planBState.planBEnabled = true;
  planBState.priority = ['primary-b'];
  await chrome.storage.local.set({ [storageKey]: planBState });
  selectedResponseQueue.push(
    {
      status: 400,
      body: [{
        moduleElementId: 'primary-b',
        errors: [{ code: 'TEAM_LIMIT_EXCEEDED', payload: { teamIdsWithLimitExceeded: ['team-full'] } }],
      }],
    },
    { status: 200, body: { accepted: true } }
  );
  const beforePlanB = fetchCalls.length;
  response = await send({ type: 'SUBMIT_SELECTIONS', menuId: MENU_ID });
  assert.equal(response.results.length, 2);
  assert.equal(response.results[0].success, false);
  assert.equal(response.results[1].success, true);
  const planBCalls = fetchCalls.slice(beforePlanB);
  assert.deepEqual(
    planBCalls.filter((call) => call.url.includes('/selected-teams')).map((call) => ({
      method: call.options.method,
      lesson: call.url.match(/module-elements\/([^/]+)/)?.[1],
      payload: JSON.parse(call.options.body),
    })),
    [
      { method: 'POST', lesson: 'primary-b', payload: ['team-full'] },
      { method: 'POST', lesson: 'fallback-b', payload: ['team-free'] },
    ]
  );
  assert.ok(planBCalls.some((call) => call.options.method === 'GET'), 'перед Планом B сделан контрольный GET');
  assert.ok(planBCalls.every((call) => call.options.method !== 'DELETE'), 'Plan B никогда не отписывает');
  assert.equal(response.state.selected['module-b'].fallbackBooked, true);

  const guardedState = local.get(storageKey);
  delete guardedState.selected['module-b'].fallbackBooked;
  guardedState.selected['module-b'].cycles['cycle-b'].status = 'selected';
  guardedState.fallbacks['module-b'].status = 'selected';
  await chrome.storage.local.set({ [storageKey]: guardedState });
  remoteSelectedTeamId = 'already-booked-team';
  selectedResponseQueue.push({
    status: 400,
    body: [{
      moduleElementId: 'primary-b',
      errors: [{ code: 'TEAM_LIMIT_EXCEEDED', payload: { teamIdsWithLimitExceeded: ['team-full'] } }],
    }],
  });
  const beforeGuardedPlanB = fetchCalls.length;
  response = await send({ type: 'SUBMIT_SELECTIONS', menuId: MENU_ID });
  const guardedCalls = fetchCalls.slice(beforeGuardedPlanB);
  assert.equal(response.results.length, 1, 'План B заблокирован при любом уже выбранном teamId');
  assert.equal(guardedCalls.filter((call) => call.url.includes('/selected-teams')).length, 1);
  assert.ok(guardedCalls.every((call) => call.options.method !== 'DELETE'));
});
