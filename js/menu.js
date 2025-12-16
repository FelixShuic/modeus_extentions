console.log('menu')
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type == 'MODEUS_MENU_DATA') {
        console.log('Received updated data:', message.data);
        createNestedListStructure(message.data);
    }
});

async function setSelectedGroup(group) {
  const groups = await chrome.storage.local.get("groups");
  console.log(groups);
  if (!groups["groups"]) {
    await chrome.storage.local.set({ groups: [group] });
  } else {
    if (group.title == "-") {
      await chrome.storage.local.set({
        groups: groups["groups"].filter((g) => g.teamID != group.teamID),
      });
    } else {
      await chrome.storage.local.set({ groups: [...groups["groups"], group] });
    }
  }
  console.log('Set group: ', group);
}

function createSelect(teams, id) {
            const select = document.createElement('select');
            console.log(id)
            select.name = id;
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
                cycleID: id,
                teamID: event.target.value,
                title: event.target.selectedOptions[0].textContent
              })
            });
            return select;
}
            


function createListItem(text, children) {
    const li = document.createElement('li');
    
    const textSpan = document.createElement('span');
    textSpan.textContent = text;
    li.appendChild(textSpan);
    
    if (children.length > 0) {
        const nestedList = createNestedList(children, false);
        li.className = 'list-item group group-bg';
        li.appendChild(nestedList);
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

function createNestedList(items, root) {
    const ul = document.createElement('ul');
    if (root) {
        ul.className = 'nested-list';
    }
    else {
        ul.className = 'nested-list subject';
    }
    
    items.forEach(item => {
        if (item.children.length > 0) {
            const li = createListItem(item.name, item.children || []);
            ul.appendChild(li);
        } 
        else {
            const li = document.createElement('li');
            li.className = 'list-item group';
            
            const textSpan = document.createElement('span');
            textSpan.textContent = item.name;
            li.appendChild(textSpan);
            item.cycles.forEach((cycle) => {
                console.log(cycle.id)
                let select = createSelect(cycle.teams, cycle.id);
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
    const form = document.createElement('form');
    form.id = 'modeus-groups';
    form.appendChild(createNestedList(data.items, true));
    const electivesTree = document.getElementsByClassName('electives-tree-list')[0]
    electivesTree.replaceChildren([]);
    electivesTree.className = 'modeus-helper-container'
    electivesTree.appendChild(form)
    electivesTree.appendChild(createSubmitButton());
}