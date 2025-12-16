function createSubmitButton() {
  const button = document.createElement("button");
  button.textContent = "Отправить";
  button.id = "submit-button";
  button.addEventListener("click", submitGroups);
  return button;
}

async function submitGroups() {
  const g = await chrome.storage.local.get("groups");
  for (var group of g["groups"]) {
    // console.log(pair[0]+ ', ' + pair[1]);
    // const res = await fetch(`https://urfu.modeus.org/learning-path-selection/api/menus/${menu}/elements/select`, {
    //   method: 'POST',
    //   headers: {
    //     'Content-Type': 'application/json'
    //   },
    //   body: pair[0]+ ', ' + pair[1]
    // })
    const res = await simulate();
    showResult(`${group.title}: `, res.status == 200);
  }
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

async function createResults() {
  const g = await chrome.storage.local.get("groups");
  const results = document.createElement("div");
  results.className = "results";
  for (const group of g["groups"]) {
    const result = document.createElement("div");
    result.className = "result";
    result.textContent = `${group.title}: `;
    result.id = group.teamID;
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = "Wait for fetching";
    result.appendChild(status);
    results.appendChild(result);
  }
  return results;
}

function showResult(group, status) {
  const result = document.getElementById(group.teamID);
  if (status) {
    result.textContent = "Success";
    result.className = "success";
  } else {
    result.textContent = "Error";
    result.className = "error";
  }
}
async function setupPage() {
    const resultsElement = await createResults();
    const container = document.getElementById("container");
    container.appendChild(resultsElement);
}

setupPage();
