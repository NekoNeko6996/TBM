export const GROUP_COLORS = [
  "grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"
];

export const GroupController = {
  async updateActiveGroup(groupId, { title, color }) {
    const updateProps = {};
    if (typeof title === "string") updateProps.title = title.trim();
    if (typeof color === "string" && GROUP_COLORS.includes(color)) {
      updateProps.color = color;
    }
    return await chrome.tabGroups.update(groupId, updateProps);
  },

  // 1. Lấy toàn bộ cây Cửa sổ -> Nhóm -> Tab (Windows Tree)
  async getWindowsTree() {
    const [windows, groups] = await Promise.all([
      chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }),
      chrome.tabGroups.query({})
    ]);

    const groupMap = Object.fromEntries(groups.map(g => [g.id, { ...g, tabs: [] }]));

    return windows.map(win => {
      const ungroupedTabs = [];
      const winGroups = new Map();

      for (const tab of win.tabs) {
        if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && groupMap[tab.groupId]) {
          if (!winGroups.has(tab.groupId)) {
            winGroups.set(tab.groupId, { ...groupMap[tab.groupId], tabs: [] });
          }
          winGroups.get(tab.groupId).tabs.push(tab);
        } else {
          ungroupedTabs.push(tab);
        }
      }

      return {
        windowId: win.id,
        focused: win.focused,
        groups: Array.from(winGroups.values()),
        ungroupedTabs
      };
    });
  },

  // 2. Tạm ngưng nhóm tab (Suspend Group) để giải phóng RAM
  async suspendGroup(groupId) {
    const tabs = await chrome.tabs.query({ groupId });
    if (!tabs.length) return;

    const activeTab = tabs.find(t => t.active);
    if (activeTab) {
      // Tìm một tab ngoài nhóm trong cùng cửa sổ để chuyển focus
      const allWindowTabs = await chrome.tabs.query({ windowId: activeTab.windowId });
      const fallbackTab = allWindowTabs.find(t => t.groupId !== groupId);
      if (fallbackTab) {
        await chrome.tabs.update(fallbackTab.id, { active: true });
      } else {
        // Nếu cả cửa sổ chỉ có group này, mở 1 tab newtab để nhường focus
        await chrome.tabs.create({ windowId: activeTab.windowId, active: true });
      }
    }

    await Promise.all(
      tabs.map(t => (!t.discarded ? chrome.tabs.discard(t.id) : Promise.resolve()))
    );
  },

  // 3. Lưu nhóm tab vào Storage (Save Group)
  async saveGroup(groupId, closeAfterSave = false) {
    const [group, tabs] = await Promise.all([
      chrome.tabGroups.get(groupId),
      chrome.tabs.query({ groupId })
    ]);

    const { savedGroups = {} } = await chrome.storage.local.get("savedGroups");
    const groupTitle = (group.title || "Untitled Group").trim();

    // Tìm xem đã có nhóm lưu nào trùng tên chưa để ghi đè, tránh nhân bản
    const existingEntry = Object.values(savedGroups).find(
      g => g.title.toLowerCase() === groupTitle.toLowerCase()
    );
    const savedId = existingEntry ? existingEntry.id : `grp_${Date.now()}`;

    savedGroups[savedId] = {
      id: savedId,
      title: groupTitle,
      color: group.color,
      createdAt: existingEntry ? existingEntry.createdAt : Date.now(),
      tabs: tabs.map(t => ({
        title: t.title,
        url: t.url,
        favIconUrl: t.favIconUrl || "",
        pinned: t.pinned
      }))
    };

    await chrome.storage.local.set({ savedGroups });

    if (closeAfterSave) {
      await chrome.tabs.remove(tabs.map(t => t.id));
    }
    return savedGroups[savedId];
  },

  // 4. Khôi phục nhóm tab đã lưu (Bật cờ chặn Auto-group xung đột & chống mở trùng nhóm)
  async restoreGroup(savedGroupId, targetWindowId = chrome.windows.WINDOW_ID_CURRENT) {
    const { savedGroups = {} } = await chrome.storage.local.get("savedGroups");
    const groupData = savedGroups[savedGroupId];
    if (!groupData || !groupData.tabs.length) return;

    // Bật cờ báo hiệu đang Restore để service-worker không tự ý cắt lẻ tab ra tạo group riêng
    await chrome.storage.session.set({ isRestoringGroup: true });

    try {
      const win = targetWindowId === chrome.windows.WINDOW_ID_CURRENT
        ? await chrome.windows.getCurrent()
        : { id: targetWindowId };

      // Kiểm tra xem trên cửa sổ hiện tại đã có sẵn Group nào mang tên này chưa
      const existingGroups = await chrome.tabGroups.query({
        windowId: win.id,
        title: groupData.title
      });

      const createdTabIds = [];
      for (const tabInfo of groupData.tabs) {
        const newTab = await chrome.tabs.create({
          windowId: win.id,
          url: tabInfo.url,
          pinned: tabInfo.pinned || false,
          active: false
        });
        createdTabIds.push(newTab.id);
      }

      if (existingGroups.length > 0) {
        // Nếu nhóm đã mở sẵn trên thanh tab, gộp vào nhóm đó thay vì tạo nhóm trùng
        await chrome.tabs.group({
          groupId: existingGroups[0].id,
          tabIds: createdTabIds
        });
      } else {
        const newGroupId = await chrome.tabs.group({
          createProperties: { windowId: win.id },
          tabIds: createdTabIds
        });
        await chrome.tabGroups.update(newGroupId, {
          title: groupData.title,
          color: groupData.color
        });
      }
    } finally {
      // Mở lại cờ sau khi hoàn tất gom nhóm
      setTimeout(() => {
        chrome.storage.session.set({ isRestoringGroup: false });
      }, 300);
    }
  },

  // 5. Hủy nhóm (Ungroup) - Giữ lại các tab nhưng bỏ khung group
  async ungroup(groupId) {
    const tabs = await chrome.tabs.query({ groupId });
    if (tabs.length) {
      await chrome.tabs.ungroup(tabs.map(t => t.id));
    }
  },

  // 6. Xóa nhóm (Delete Group) - Đóng toàn bộ tab trong nhóm
  async deleteGroup(groupId) {
    const tabs = await chrome.tabs.query({ groupId });
    if (tabs.length) {
      await chrome.tabs.remove(tabs.map(t => t.id));
    }
  },

  // 7. Chia sẻ nhóm (Share Group) - Xuất Markdown hoặc JSON
  async exportGroupToMarkdown(groupId) {
    const [group, tabs] = await Promise.all([
      chrome.tabGroups.get(groupId),
      chrome.tabs.query({ groupId })
    ]);
    const lines = [`### Nhóm: ${group.title || "Untitled"}`, ""];
    tabs.forEach(t => lines.push(`- [${t.title}](${t.url})`));
    return lines.join("\n");
  },

  normalizeUrlForDedup(rawUrl = "", ignoreHash = true) {
    if (!rawUrl || !rawUrl.startsWith("http")) return rawUrl;
    try {
      const u = new URL(rawUrl);
      if (ignoreHash) u.hash = "";

      // Xóa các query tracking phổ biến
      const trackingParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];
      trackingParams.forEach(param => u.searchParams.delete(param));

      // Bỏ dấu '/' dư ở cuối pathname
      const cleanPath = u.pathname.replace(/\/+$/, "") || "/";
      return `${u.protocol}//${u.host}${cleanPath}${u.search}`;
    } catch {
      return rawUrl.trim();
    }
  },

  // Quét toàn bộ trình duyệt để tìm các Tab bị trùng lặp
  async findDuplicateTabs(ignoreHash = true) {
    const allTabs = await chrome.tabs.query({ windowType: "normal" });
    const urlMap = new Map();

    for (const tab of allTabs) {
      if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
        continue;
      }
      const normUrl = this.normalizeUrlForDedup(tab.url, ignoreHash);
      if (!urlMap.has(normUrl)) {
        urlMap.set(normUrl, []);
      }
      urlMap.get(normUrl).push(tab);
    }

    const tabsToClose = [];
    const duplicateGroups = [];

    for (const [normUrl, tabs] of urlMap.entries()) {
      if (tabs.length <= 1) continue;

      // Sắp xếp để chọn ra 1 tab tốt nhất giữ lại: Pinned -> Active -> Mở sớm nhất
      const sorted = [...tabs].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (a.active !== b.active) return a.active ? -1 : 1;
        return a.id - b.id;
      });

      const [keepTab, ...redundantTabs] = sorted;
      tabsToClose.push(...redundantTabs.map(t => t.id));
      duplicateGroups.push({
        url: normUrl,
        keptTabId: keepTab.id,
        redundantTabs
      });
    }

    return {
      totalDuplicates: tabsToClose.length,
      tabsToClose,
      duplicateGroups
    };
  },

  // Thực thi đóng toàn bộ các tab dư thừa
  async cleanDuplicateTabs(ignoreHash = true) {
    const { tabsToClose } = await this.findDuplicateTabs(ignoreHash);
    if (tabsToClose.length > 0) {
      await chrome.tabs.remove(tabsToClose);
    }
    return tabsToClose.length;
  }
};