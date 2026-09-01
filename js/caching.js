const CACHE_DURATION = 5 * 24 * 60 * 60 * 1000;
const STORAGE_PREFIX = 'modeus-picker:menu:';

function createEmptyState(menuId, studentId = null) {
  return {
    version: 4,
    menuId,
    studentId,
    data: null,
    selected: {},
    priority: [],
    fallbacks: {},
    planBEnabled: false,
    requestLog: [],
    dataTimestamp: 0,
    error: null,
  };
}

export async function readMenuState(menuId, studentId = null) {
  const key = `${STORAGE_PREFIX}${menuId}`;
  const stored = await chrome.storage.local.get(key);
  const state = stored[key];

  if (!state || ![3, 4].includes(state.version) || (studentId && state.studentId !== studentId)) {
    return createEmptyState(menuId, studentId);
  }

  const normalized = {
    ...createEmptyState(menuId, studentId),
    ...state,
    menuId,
    studentId: studentId ?? state.studentId ?? null,
    selected: state.selected ?? {},
    priority: state.priority ?? [],
    fallbacks: state.fallbacks ?? {},
    planBEnabled: Boolean(state.planBEnabled),
    requestLog: state.requestLog ?? [],
    version: 4,
  };
  delete normalized.automation;
  return normalized;
}

export async function writeMenuState(state) {
  const key = `${STORAGE_PREFIX}${state.menuId}`;
  await chrome.storage.local.set({ [key]: state });
  return state;
}

export function hasFreshMenuData(state) {
  return Boolean(
    state.data &&
    state.dataTimestamp &&
    Date.now() - state.dataTimestamp <= CACHE_DURATION
  );
}

export async function storeMenuData(menuId, studentId, data) {
  const state = await readMenuState(menuId, studentId);
  state.data = data;
  state.dataTimestamp = Date.now();
  state.error = null;
  return writeMenuState(state);
}

export async function storeMenuError(menuId, studentId, error) {
  const state = await readMenuState(menuId, studentId);
  state.error = error;
  return writeMenuState(state);
}
