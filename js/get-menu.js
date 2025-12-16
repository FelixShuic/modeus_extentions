const menuRegEx = /^https:\/\/urfu\.modeus\.org\/learning-path-selection\/menus\/[a-z0-9-]{35,36}$/;

console.log("get menu")

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (message.type == 'GET_GROUPS_HEADERS') {
        let headers = new Headers();
        for (let i = 0; i < message.data.length; i++) {
                headers.append(message.data[i].name, message.data[i].value)
            }
        console.log(headers)
        console.log('Modeus Helper: Intercepted menu request to:', headers);
        groups = await fetch(message.url, {
            method: "GET",
            headers: headers,
        }).then(response => response.json())
        console.log('Modeus Helper: Intercepted data:', groups);
        await chrome.runtime.sendMessage({
            type: 'MODEUS_MENU_ID',
            data: menu = message.url.slice(-36)
        })
        await chrome.runtime.sendMessage({
            type: 'MODEUS_GROUPS_DATA',
            data: groups.electives
        });
    }
    load();
});

function load() {
    const loading = document.createElement('span')
    loading.classList.add('loader')
    const desc = document.createElement('div')
    desc.textContent = 'Получение информации о группах...'
    desc.classList.add('desc')
    const electivesTree = document.getElementsByClassName('electives-tree-list')[0]
    electivesTree.replaceChildren(loading, desc)
}
