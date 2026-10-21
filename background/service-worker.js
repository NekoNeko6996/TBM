import { StorageAPI } from "../core/storage.js";
import { GroupController } from "./group-controller.js";

const domainGroupLocks = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  await StorageAPI.init();
  // Cho phép mở Aside trực tiếp khi click vào icon extension
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// Lắng nghe khi URL của tab thay đổi
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.url.startsWith("http")) return;

  // Nếu tab này đã nằm sẵn trong một Group rồi thì bỏ qua, không tự gom nhóm lại
  if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;

  // Nếu đang trong quá trình Restore Group thì tạm dừng Auto-group để tránh xung đột
  const { isRestoringGroup } = await chrome.storage.session.get("isRestoringGroup");
  if (isRestoringGroup) return;

  const settings = await StorageAPI.getSettings();

  // 1. Kiểm tra chặn tab trùng lặp
  if (settings.autoDeduplicate) {
    const targetNorm = GroupController.normalizeUrlForDedup(tab.url, settings.ignoreUrlHash);
    const allTabs = await chrome.tabs.query({ windowType: "normal" });
    const existingTab = allTabs.find(
      t => t.id !== tabId &&
      GroupController.normalizeUrlForDedup(t.url, settings.ignoreUrlHash) === targetNorm
    );

    if (existingTab) {
      await chrome.windows.update(existingTab.windowId, { focused: true });
      await chrome.tabs.update(existingTab.id, { active: true });
      await chrome.tabs.remove(tabId);
      return;
    }
  }

  // 2. Tự động gom nhóm theo tên miền (Có cơ chế Lock chống tạo 2 group trùng nhau)
  if (!settings.autoGroupByDomain) return;

  try {
    const urlObj = new URL(tab.url);
    const domain = urlObj.hostname.replace(/^www\./, "");
    if (settings.excludeDomains.includes(domain)) return;

    const lockKey = `${tab.windowId}_${domain}`;
    while (domainGroupLocks.get(lockKey)) {
      await domainGroupLocks.get(lockKey);
    }

    const taskPromise = (async () => {
      // Kiểm tra lại trạng thái mới nhất của tab sau khi qua hàng đợi Lock
      const freshTab = await chrome.tabs.get(tabId).catch(() => null);
      if (!freshTab || freshTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) return;

      const existingGroups = await chrome.tabGroups.query({
        windowId: freshTab.windowId,
        title: domain
      });

      if (existingGroups.length > 0) {
        await chrome.tabs.group({ groupId: existingGroups[0].id, tabIds: [tabId] });
      } else {
        const newGroupId = await chrome.tabs.group({
          createProperties: { windowId: freshTab.windowId },
          tabIds: [tabId]
        });
        await chrome.tabGroups.update(newGroupId, {
          title: domain,
          color: getColorFromDomain(domain)
        });
      }
    })();

    domainGroupLocks.set(lockKey, taskPromise);
    await taskPromise;
    domainGroupLocks.delete(lockKey);
  } catch (err) {
    console.error("Auto-group error:", err);
  }
});

const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
function getColorFromDomain(domain) {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = domain.charCodeAt(i) + ((hash << 5) - hash);
  }
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length];
}