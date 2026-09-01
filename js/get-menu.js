const menuAPIRegEx = /^https:\/\/urfu\.modeus\.org\/learning-path-selection\/api\/selection\/menus\/([a-z0-9-]{35,36})\/?(?:[?#].*)?$/;

console.log("get menu")

function getMenuId(url) {
    return menuAPIRegEx.exec(url)?.[1] ?? null;
}

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    if (message.type == 'GET_GROUPS_HEADERS') {
        const menuId = getMenuId(message.url);
        if (!menuId) return;
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
            data: menuId
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
    loading.classList.add('ext-loader')
    const desc = document.createElement('div')
    desc.textContent = 'Получение информации о группах...'
    desc.classList.add('desc')
    const electivesTree = document.getElementsByClassName('electives-tree-list')[0]
    if (electivesTree) {
        electivesTree.replaceChildren(loading, desc)
    }
}
