console.log('menu')

let menu

let choosen

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (message.type == 'MODEUS_MENU_DATA') {
        menu = message.menu
        console.log('Received updated data:', message.data);
        console.log(message.menu)
        createNestedListStructure(message.data);
    }
});

async function setSelectedGroup(group) {
  const menuData = await chrome.storage.local.get(menu);
  console.log(group);
  if (!menuData[menu]["choosen"]) {
    menuData[menu]["choosen"] = [group]
    await chrome.storage.local.set({ [menu]: menuData[menu] });
    disableFieldset(group.subjectId)
  } else {
      menuData[menu]["choosen"] = [...menuData[menu]["choosen"], group]
      await chrome.storage.local.set({ [menu]: menuData[menu] });
      disableFieldset(group.subjectId)
  }
  createResetButton(group.subjectId, group.cycleId, group.teamId)
  console.log('Set group: ', group);
}

function createResetButton(subjectId, cycleId, teamId) {
    const fieldset = document.getElementById(subjectId)
    const parentLi = fieldset.closest('li');
    const btn = document.createElement('button')
    btn.textContent = "Сбросить выбор"
    btn.style = "position:absolute;top:-5px;right:-10px"
    btn.className = "reset-btn"
    btn.type = "button";
    btn.onclick = () => resetChoose(subjectId, cycleId, teamId, btn);
    parentLi.appendChild(btn)
    requestAnimationFrame(() => {
        btn.classList.add('visible');
    });
}

async function resetChoose(subjectId, cycleId, teamId, btn) {
    const select = document.getElementById(cycleId)
    select.value = "undefined"
    enableFieldset(subjectId)
    const menuData = await chrome.storage.local.get(menu);
    let choosen = menuData[menu]["choosen"]
    choosen = choosen.filter((group) => group.teamId !== teamId)
    menuData[menu]["choosen"] = choosen
    await chrome.storage.local.set({ [menu]: menuData[menu] })

    btn.classList.remove('visible');

    setTimeout(() => {
        btn.remove();
    }, 100);
}

function disableFieldset(subjectId) {
    const fieldset = document.getElementById(subjectId)
    if (fieldset) {
        fieldset.classList.add('locked');
        // fieldset.disabled = true; // Убираем или оставляем, если pointer-events достаточно
    }
}

function enableFieldset(subjectId) {
    const fieldset = document.getElementById(subjectId)
    if (fieldset) {
        fieldset.classList.remove('locked');
    }
}

async function restoreChoosen() {
    const menuData = await chrome.storage.local.get(menu)
    let choosen = menuData[menu]["choosen"]
    for (let group of choosen) {
        let select = document.getElementById(group.cycleId)
        select.value = group.teamId
        let fieldset = document.getElementById(group.subjectId)
        fieldset.disabled = true
        createResetButton(group.subjectId, group.cycleId, group.teamId)
    }
}

function createSelect(subjectId, teams, id) {
    const select = document.createElement('select');
    select.id = id;
    select.className = 'group-selector'
    teams.push({
        name: '-'
    })
    teams.sort((a, b) => a.name.localeCompare(b.name));
    teams.forEach(team => {
        const option = document.createElement('option');
        option.value = team.id;
        option.name = team.id;
        option.textContent = team.name;
        select.appendChild(option);
    });
    select.addEventListener('change', (event) => {
        setSelectedGroup({
            subjectId: subjectId,
            cycleId: id,
            teamId: event.target.value,
            title: event.target.selectedOptions[0].textContent,
            status: "waiting"
        })
    });
    return select;
}
            


function createListItem(id, text, children) {
    const li = document.createElement('li');
    
    const textSpan = document.createElement('span');
    textSpan.textContent = text;
    li.appendChild(textSpan);
    
    if (children.length > 0) {
        const fieldset = document.createElement('fieldset')
        fieldset.id = id
        fieldset.style = "border:0"
        const nestedList = createNestedList(id, children, false);
        fieldset.appendChild(nestedList)
        li.className = 'list-item group group-bg';
        li.style = 'position: relative'
        li.appendChild(fieldset);
    } 
    else {
        children.cycles.forEach((cycle) => {
            console.log(cycle.id)
            let select = createSelect(cycle.teams, cycle.id);
            li.className = 'list-item group';
            li.appendChild(select);
        })
    }
    
    return li;
}

function createNestedList(currentSubjectId, items, root) {
    const ul = document.createElement('ul');
    if (root) {
        ul.className = 'nested-list';
    }
    else {
        ul.className = 'nested-list subject';
    }

    items.forEach(item => {
        if (item.children.length > 0) {
            console.log(item.kind)
            if (item.kind == "CourseItem" || item.kind == "CourseGroupItem") {
                currentSubjectId = item.id
            }
            console.log(currentSubjectId)
            const li = createListItem(currentSubjectId, item.name, item.children || []);
            ul.appendChild(li);
        } 
        else {
            const li = document.createElement('li');
            li.className = 'list-item group';
            
            const textSpan = document.createElement('span');
            textSpan.textContent = item.name;
            li.appendChild(textSpan);
            item.cycles.forEach((cycle) => {
                console.log(currentSubjectId)
                let select = createSelect(currentSubjectId, cycle.teams, cycle.id);
                li.appendChild(select);
            })
            ul.appendChild(li);
        }
    });
    
    return ul;
}

function createSubmitButton() {
    const button = document.createElement('button');
    button.textContent = 'Отправить';
    button.id = 'submit-button';
    button.addEventListener('click', submitGroups);
    return button;
}

async function submitGroups() {
    const form = document.getElementById('modeus-groups');
    const formData = new FormData(form);
    for (var pair of formData.entries()) {
        // console.log(pair[0]+ ', ' + pair[1]);
        // const res = await fetch(`https://urfu.modeus.org/learning-path-selection/api/menus/${menu}/elements/select`, {
        //   method: 'POST',
        //   headers: {
        //     'Content-Type': 'application/json'
        //   },
        //   body: pair[0]+ ', ' + pair[1]
        // })
        const res = await simulate();
        showResult("test", res.status == 200)
    }
}

async function simulate() {
  await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 3) * 1000));
  if (Math.random() < 0.2) {
    return {
      status: 500
    };
  }
  return {
    status: 200
  };
}

function showResult(result, status) {
    const results = document.getElementsByClassName('results')[0]
    results.className = 'results';
    resultDisplay = document.createElement('div');
    resultDisplay.className = 'result';
    resultDisplay.textContent = result;
    statusDisplay = document.createElement('span')
    statusDisplay.className = 'status';
    if (status) {
        statusDisplay.textContent = 'Success';
        statusDisplay.className += ' success';
    } else {
        statusDisplay.textContent = 'Error';
        statusDisplay.className += ' error';
    }
    resultDisplay.appendChild(statusDisplay);
    results.appendChild(resultDisplay);
}

function createNestedListStructure(data) {
    let currentSubjectId = ''
    const form = document.createElement('form');
    form.id = 'modeus-groups'
    form.appendChild(createNestedList(currentSubjectId, data.items, true));
    const electivesTree = document.getElementsByClassName('electives-tree-list')[0]
    electivesTree.replaceChildren([]);
    electivesTree.className = 'modeus-helper-container'
    electivesTree.appendChild(form);
    restoreChoosen();
}