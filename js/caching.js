const CACHE_DURATION = 60 * 60 * 1000 * 24 * 5; // 5 days

export async function setCacheGroup(menuID, groupsData) {
  const cachedGroup = {
    data: groupsData,
    timestamp: Date.now()
  };
  
  await chrome.storage.local.set({ [menuID]: cachedGroup });
  console.log('Cache set successfully');
}

export async function getCacheGroup(menuID) {
  const cachedGroup = await chrome.storage.local.get(menuID);
  
  if (!cachedGroup[menuID]) {
    return null;
  }
  
  const { data, timestamp } = cachedGroup[menuID];
  
  if (Date.now() - timestamp > CACHE_DURATION) {
    await chrome.storage.local.remove(menuID);
    return null;
  }
  
  return data;
}
