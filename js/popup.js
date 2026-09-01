let menuId = null;
let state = null;
let notice = '';
let noticeType = 'info';
let submitting = false;

const container = document.getElementById('container');

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

async function request(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (!response?.ok) throw new Error(response?.error || 'Расширение не ответило');
  return response;
}

function selections() {
  return Object.values(state?.selected ?? {}).flatMap((selectedModule) =>
    Object.values(selectedModule.cycles ?? {}).map((cycle) => ({
      lessonName: selectedModule.lessonName,
      ...cycle,
    }))
  );
}

function statusLabel(selection) {
  if (selection.status === 'success') return 'Отправлено';
  if (selection.status === 'error') return selection.error || 'Ошибка';
  return 'Выбрано';
}

async function submit(button) {
  if (submitting) return;
  submitting = true;
  notice = 'Отправляю выбор…';
  noticeType = 'info';
  render();
  try {
    const response = await request({ type: 'SUBMIT_SELECTIONS', menuId });
    state = response.state;
    const failed = response.results.filter((result) => !result.success);
    notice = failed.length === 0
      ? 'Выбор успешно отправлен. Повторная отправка доступна.'
      : `Не отправлено дисциплин: ${failed.length}. Ответ Modeus показан ниже.`;
    noticeType = failed.length === 0 ? 'success' : 'error';
  } catch (error) {
    notice = error.message;
    noticeType = 'error';
  } finally {
    submitting = false;
  }
  render();
}

function render() {
  container.replaceChildren();
  container.appendChild(createElement('h1', 'popup__title', 'Modeus Picker'));

  if (!menuId) {
    container.appendChild(createElement(
      'div',
      'popup__notice popup__notice--info',
      'Откройте конкретное меню выбора Modeus. Страница со списком кампаний не подходит.'
    ));
    return;
  }

  if (notice) {
    container.appendChild(createElement('div', `popup__notice popup__notice--${noticeType}`, notice));
  }

  if (!state?.data) {
    container.appendChild(createElement(
      'div',
      'popup__notice popup__notice--info',
      state?.error || 'Данные групп ещё загружаются. Не закрывая страницу Modeus, обновите её.'
    ));
    return;
  }

  const selected = selections();
  if (selected.length === 0) {
    container.appendChild(createElement(
      'div',
      'popup__notice popup__notice--info',
      'На странице Modeus выберите группы в панели Modeus Picker.'
    ));
    return;
  }

  const results = createElement('div', 'popup__results');
  selected.forEach((selection) => {
    const row = createElement('div', 'popup__result');
    const names = createElement('div', 'popup__result-names');
    names.append(
      createElement('strong', '', selection.teamName),
      createElement('span', '', `${selection.lessonName} · ${selection.cycleName}`)
    );
    const status = createElement(
      'span',
      `popup__status popup__status--${selection.status}`,
      statusLabel(selection)
    );
    row.append(names, status);
    results.appendChild(row);
  });
  container.appendChild(results);

  const button = createElement('button', 'popup__submit', 'Отправить в Modeus');
  button.type = 'button';
  button.disabled = submitting;
  button.addEventListener('click', () => submit(button));
  container.appendChild(button);
}

async function init() {
  try {
    const response = await request({ type: 'GET_ACTIVE_CONTEXT' });
    menuId = response.menuId;
    state = response.state;
  } catch (error) {
    notice = error.message;
    noticeType = 'error';
  }
  render();
}

void init();
