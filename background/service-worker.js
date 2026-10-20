import { StorageAPI } from "../core/storage.js";
import { GroupController } from "./group-controller.js";

chrome.runtime.onInstalled.addListener(async () => {
  await StorageAPI.init();
  // Cho phép mở Aside trực tiếp khi click vào icon extension
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// Lắng nghe khi URL của tab thay đổi
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.url.startsWith("http")) return;

  const settings = await StorageAPI.getSettings();

  if (settings.autoDeduplicate) {
    const targetNorm = GroupController.normalizeUrlForDedup(tab.url, settings.ignoreUrlHash);
    const allTabs = await chrome.tabs.query({ windowType: "normal" });

    const existingTab = allTabs.find(
      t => t.id !== tabId &&
      GroupController.normalizeUrlForDedup(t.url, settings.ignoreUrlHash) === targetNorm
    );

    if (existingTab) {
      // Chuyển focus về tab gốc đã mở trước đó và đóng tab mới bị trùng
      await chrome.windows.update(existingTab.windowId, { focused: true });
      await chrome.tabs.update(existingTab.id, { active: true });
      await chrome.tabs.remove(tabId);
      return; // Dừng luôn, không cần chạy auto-group cho tab đã bị đóng
    }
  }

  if (!settings.autoGroupByDomain) return;

  try {
    const urlObj = new URL(tab.url);
    const domain = urlObj.hostname.replace(/^www\./, "");

    if (settings.excludeDomains.includes(domain)) return;

    // Tìm xem trong cửa sổ hiện tại đã có group mang tên domain này chưa
    const existingGroups = await chrome.tabGroups.query({
      windowId: tab.windowId,
      title: domain
    });

    if (existingGroups.length > 0) {
      const targetGroupId = existingGroups[0].id;
      if (tab.groupId !== targetGroupId) {
        await chrome.tabs.group({ groupId: targetGroupId, tabIds: [tabId] });
      }
    } else {
      // Tạo group mới và đặt tên theo domain
      const newGroupId = await chrome.tabs.group({
        createProperties: { windowId: tab.windowId },
        tabIds: [tabId]
      });
      await chrome.tabGroups.update(newGroupId, {
        title: domain,
        color: getColorFromDomain(domain)
      });
    }
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