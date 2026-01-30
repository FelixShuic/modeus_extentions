let menu

console.log('popup')

function createSubmitButton() {
  const button = document.createElement("button");
  button.textContent = "Отправить";
  button.id = "submit-button";
  button.addEventListener("click", submitGroups);
  return button;
}

async function submitGroups() {
  const menuData = await chrome.storage.local.get(menu);
  const choosen = menuData[menu]["choosen"]
  let flag = false
  while (!flag) {
    flag = true
    for (var group of choosen) {
      if (group.status != "success") {
        // console.log(pair[0]+ ', ' + pair[1]);
        // const res = await fetch(`https://urfu.modeus.org/learning-path-selection/api/menus/${menu}/elements/select`, {
        //   method: 'POST',
        //   headers: {
        //     'Content-Type': 'application/json'
        //   },
        //   body: pair[0]+ ', ' + pair[1]
        // })
        const res = await simulate();
        showResult(group, res.status == 200);
        if (res.status == 200) {
          group.status = "success"
        } else {
          group.status = "error"
          flag = false
        }
      }
    }
  }
  menuData[menu]["choosen"] = choosen
  const btn = document.getElementById("submit-button")
  btn.textContent = "Отправить повторно"
  await chrome.storage.local.set({[menu]: menuData[menu]})
}

async function simulate() {
  await new Promise((resolve) =>
    setTimeout(resolve, Math.floor(Math.random() * 3) * 1000),
  );
  if (Math.random() < 0.33) {
    return {
      status: 500,
    };
  }
  return {
    status: 200,
  };
}

async function getCurrentMenuId() {
    let queryOptions = { active: true, lastFocusedWindow: true };
    let [tab] = await chrome.tabs.query(queryOptions);
    menu = tab.url.slice(-36)
}

async function createResults() {
  console.log('GET_MENU_ID request sent')
  const menuData = await chrome.storage.local.get(menu);
  const choosen = menuData[menu]["choosen"]
  const results = document.createElement("div");
  results.className = "results";
  for (const group of choosen) {
    const result = document.createElement("div");
    result.className = "result";
    result.textContent = `${group.title}: `;
    result.id = group.teamId;
    const status = document.createElement("span");
    console.log(group.status)
    switch (group.status) {
      case "waiting":
        status.className = "status";
        status.textContent = "Wait for fetching";
        break;
      case "success":
        status.className = "status success";
        status.textContent = "Success";
        break;
      case "error":
        status.className = "status error";
        status.textContent = "Error";
        break;
      default:
        status.className = "status";
        status.textContent = "Unknown status";
    }
    result.appendChild(status);
    results.appendChild(result);
  }
  return results;
}

function showResult(group, status) {
  console.log(group.teamId)
  const result = document.getElementById(group.teamId);
  const span = result.lastChild
  if (status) {
    span.textContent = "Success";
    span.className = "status success";
  } else {
    span.textContent = "Error";
    span.className = "status error";
  }
}


async function setupPage() {
  await getCurrentMenuId();
  const resultsElement = await createResults();
  const container = document.getElementById("container");
  container.appendChild(resultsElement);
  container.appendChild(createSubmitButton());
}

setupPage();
