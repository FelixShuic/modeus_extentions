console.log("EXTENSION-----------------")
import { getCacheGroup, setCacheGroup } from './caching.js';
const menuAPIRegEx = /^https:\/\/urfu\.modeus\.org\/learning-path-selection\/api\/selection\/menus\/[a-z0-9-]{35,36}$/;
const menuRegEx = /^https:\/\/urfu\.modeus\.org\/learning-path-selection\/menus\/[a-z0-9-]{35,36}$/;


const headers = new Headers();

let menu;

let electives;

let currentUrl = '';

async function getCurrentTab() {
    let queryOptions = { active: true, lastFocusedWindow: true };
    let [tab] = await chrome.tabs.query(queryOptions);
    return tab;
}

async function getGroups(electives) {
    for (const item of electives.items) {
        for (const child of item.children) {
            console.log(`https://urfu.modeus.org/learning-path-selection/api/selection/menus/${menu}/items/${child.id}`)
            console.log(headers.get('Authorization'))
            const response = await fetch(`https://urfu.modeus.org/learning-path-selection/api/selection/menus/${menu}/items/${child.id}`, {
                method: "GET",
                headers: headers,
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            child.cycles = data.cycles;
            console.log("ГРУППЫ:", child.cycles);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    console.log("navigated! id:", tab)
    if (menuRegEx.test(tab.url)) {
      const cachedGroup = await getCacheGroup(tab.url.slice(-36))
      if (cachedGroup) {
        chrome.tabs.sendMessage(tabId, {
          type: 'MODEUS_MENU_DATA',
          menu: menu,
          data: cachedGroup
        })
      }
    }
  }
})

chrome.webRequest.onBeforeSendHeaders.addListener(
    async function (details) {
        console.log('in listener')
        console.log(currentUrl)
        console.log(details.url)
        const cachedGroup = await getCacheGroup(details.url.slice(-36))
        if (menuAPIRegEx.test(details.url) && details.url != currentUrl && !cachedGroup) {
            currentUrl = details.url
            if (!headers.has('Authorization')){
                for (let i = 0; i < details.requestHeaders.length; i++) {
                    headers.append(details.requestHeaders[i].name, details.requestHeaders[i].value)
                }
            }
            console.log(details.requestHeaders)
            let tab = await getCurrentTab().then(response => response)
            chrome.tabs.sendMessage(tab.id, {
                type: 'GET_GROUPS_HEADERS',
                data: details.requestHeaders,
                url: details.url
            })
            menu = details.url.slice(-36)
        }
    },
    { urls: ["<all_urls>"] },
    ["requestHeaders"]
)

chrome.runtime.onMessage.addListener(
    async function (message, sender, sendResponse) {
        if (message.type == 'MODEUS_MENU_ID') {
            menu = message.data
        }
        if (message.type == 'MODEUS_GROUPS_DATA') {
          const cachedGroup = await getCacheGroup(menu);
          console.log(cachedGroup)
          if (cachedGroup) {
            let tab = await getCurrentTab().then(response => response)
            chrome.tabs.sendMessage(tab.id, {
              type: 'MODEUS_MENU_DATA',
              data: cachedGroup
            })
          } else {
              console.log('Background: получил данные о меню:', message.data);
              const electives = message.data;
              await getGroups(electives);
              console.log("ГРУППЫ ПОЛУЧЕНЫ:", electives)
              await setCacheGroup(menu, electives);
              let tab = await getCurrentTab().then(response => response)
              chrome.tabs.sendMessage(tab.id, {
                type: 'MODEUS_MENU_DATA',
                menu: menu,
                data: electives
              })
          }
        }
    }
);