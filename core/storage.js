// core/storage.js
const DEFAULT_SCHEMA = {
  settings: {
    theme: "light",
    autoGroupByDomain: true,
    autoDeduplicate: false,
    ignoreUrlHash: true,
    excludeDomains: ["localhost", "newtab"],
    suspendExcludePinned: true
  },
  // Lưu các nhóm tab đã đóng hoặc lưu trữ
  savedGroups: {
    "grp_1710001": {
      id: "grp_1710001",
      title: "github.com",
      color: "blue",
      createdAt: 1710000000000,
      tabs: [
        { title: "Repo A", url: "https://github.com/user/repo-a", favIconUrl: "" }
      ]
    }
  },
  // Hệ thống Bookmark độc lập với Chrome
  bookmarkNodes: {
    "root": {
      id: "root",
      parentId: null,
      type: "folder",
      title: "Root",
      childrenIds: []
    }
  }
};

export const StorageAPI = {
  async init() {
    const data = await chrome.storage.local.get(null);
    if (!data.settings) await chrome.storage.local.set(DEFAULT_SCHEMA);
  },

  async getSettings() {
    const { settings } = await chrome.storage.local.get("settings");
    return settings || DEFAULT_SCHEMA.settings;
  },

  async updateSettings(partialSettings) {
    const current = await this.getSettings();
    await chrome.storage.local.set({ settings: { ...current, ...partialSettings } });
  },

  // --- QUẢN LÝ BOOKMARK ĐỘC LẬP ---
  async addBookmarkNode({ parentId = "root", type, title, url = null, favIconUrl = "" }) {
    const { bookmarkNodes } = await chrome.storage.local.get("bookmarkNodes");
    const id = `${type === "folder" ? "fld" : "bm"}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    bookmarkNodes[id] = {
      id,
      parentId,
      type,
      title,
      ...(type === "folder" ? { childrenIds: [] } : { url, favIconUrl })
    };

    if (bookmarkNodes[parentId]) {
      bookmarkNodes[parentId].childrenIds.push(id);
    }

    await chrome.storage.local.set({ bookmarkNodes });
    return bookmarkNodes[id];
  },

  async moveBookmarkNode(nodeId, targetParentId, targetIndex) {
    const { bookmarkNodes } = await chrome.storage.local.get("bookmarkNodes");
    const node = bookmarkNodes[nodeId];
    if (!node) return;

    // Xóa khỏi thư mục cũ
    const oldParent = bookmarkNodes[node.parentId];
    if (oldParent) {
      oldParent.childrenIds = oldParent.childrenIds.filter(id => id !== nodeId);
    }

    // Thêm vào thư mục mới theo vị trí kéo thả
    const newParent = bookmarkNodes[targetParentId];
    if (newParent && newParent.type === "folder") {
      node.parentId = targetParentId;
      newParent.childrenIds.splice(targetIndex, 0, nodeId);
    }

    await chrome.storage.local.set({ bookmarkNodes });
  },

  async getAllData() {
    await this.init();
    return await chrome.storage.local.get(["settings", "savedGroups", "bookmarkNodes"]);
  },

  async deleteSavedGroup(groupId) {
    const { savedGroups = {} } = await chrome.storage.local.get("savedGroups");
    delete savedGroups[groupId];
    await chrome.storage.local.set({ savedGroups });
  },

  async deleteBookmarkNode(nodeId) {
    if (nodeId === "root") return;
    const { bookmarkNodes } = await chrome.storage.local.get("bookmarkNodes");
    const node = bookmarkNodes[nodeId];
    if (!node) return;

    // Xóa tham chiếu ở thư mục cha
    const parent = bookmarkNodes[node.parentId];
    if (parent && parent.childrenIds) {
      parent.childrenIds = parent.childrenIds.filter(id => id !== nodeId);
    }

    // Xóa đệ quy toàn bộ nhánh con nếu là folder
    const removeRecursive = (id) => {
      const target = bookmarkNodes[id];
      if (!target) return;
      if (target.type === "folder" && target.childrenIds) {
        target.childrenIds.forEach(removeRecursive);
      }
      delete bookmarkNodes[id];
    };

    removeRecursive(nodeId);
    await chrome.storage.local.set({ bookmarkNodes });
  },

  async exportBackupData() {
    const data = await this.getAllData();
    return {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      data
    };
  },

  async importBackupData(payload, merge = false) {
    if (!payload || !payload.data || !payload.data.bookmarkNodes) {
      throw new Error("File JSON không đúng định dạng Backup của Extension.");
    }

    const incoming = payload.data;

    if (!merge) {
      // Ghi đè toàn bộ (Overwrite)
      await chrome.storage.local.set({
        settings: incoming.settings || DEFAULT_SCHEMA.settings,
        savedGroups: incoming.savedGroups || {},
        bookmarkNodes: incoming.bookmarkNodes
      });
      return;
    }

    // Chế độ Gộp (Merge): Giữ lại dữ liệu hiện tại và nối thêm dữ liệu mới
    const current = await this.getAllData();
    const mergedGroups = { ...current.savedGroups, ...incoming.savedGroups };
    const mergedNodes = { ...current.bookmarkNodes };

    Object.entries(incoming.bookmarkNodes).forEach(([id, node]) => {
      if (id === "root") {
        const rootChildren = new Set([
          ...(mergedNodes.root?.childrenIds || []),
          ...(node.childrenIds || [])
        ]);
        mergedNodes.root.childrenIds = Array.from(rootChildren);
      } else {
        mergedNodes[id] = node;
      }
    });

    await chrome.storage.local.set({
      settings: { ...current.settings, ...incoming.settings },
      savedGroups: mergedGroups,
      bookmarkNodes: mergedNodes
    });
  },

  getFaviconUrl(pageUrl, size = 32) {
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", pageUrl);
    url.searchParams.set("size", size.toString());
    return url.toString();
  },

  async importChromeBookmarks() {
    const tree = await chrome.bookmarks.getTree();
    const { bookmarkNodes } = await chrome.storage.local.get("bookmarkNodes");
    let importedCount = 0;

    // Tạo một thư mục riêng chứa các bookmark nhập từ Chrome
    const importRootId = `fld_chrome_${Date.now()}`;
    bookmarkNodes[importRootId] = {
      id: importRootId,
      parentId: "root",
      type: "folder",
      title: `Chrome Import (${new Date().toLocaleDateString("vi-VN")})`,
      childrenIds: []
    };
    bookmarkNodes.root.childrenIds.push(importRootId);

    const traverse = (chromeNode, targetParentId) => {
      if (chromeNode.url) {

        const bmId = `bm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        bookmarkNodes[bmId] = {
          id: bmId,
          parentId: targetParentId,
          type: "bookmark",
          title: chromeNode.title || chromeNode.url,
          url: chromeNode.url,
          favIconUrl: this.getFaviconUrl(chromeNode.url)
        };
        bookmarkNodes[targetParentId].childrenIds.push(bmId);
        importedCount++;
      } else if (chromeNode.children && chromeNode.children.length > 0) {
        let nextParentId = targetParentId;
        // Bỏ qua các node gốc mặc định không tên của Chrome
        if (chromeNode.title && chromeNode.id !== "0") {
          const fldId = `fld_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          bookmarkNodes[fldId] = {
            id: fldId,
            parentId: targetParentId,
            type: "folder",
            title: chromeNode.title,
            childrenIds: []
          };
          bookmarkNodes[targetParentId].childrenIds.push(fldId);
          nextParentId = fldId;
        }
        chromeNode.children.forEach(child => traverse(child, nextParentId));
      }
    };

    tree.forEach(rootNode => traverse(rootNode, importRootId));
    await chrome.storage.local.set({ bookmarkNodes });
    return importedCount;
  },

  async importChromeTabGroups() {
    const groups = await chrome.tabGroups.query({});
    if (!groups.length) return 0;

    const { savedGroups = {} } = await chrome.storage.local.get("savedGroups");
    let importedGroups = 0;

    for (const g of groups) {
      const tabs = await chrome.tabs.query({ groupId: g.id });
      if (!tabs.length) continue;

      const id = `grp_chrome_${g.id}_${Date.now()}`;
      savedGroups[id] = {
        id,
        title: g.title || "Chrome Group",
        color: g.color || "grey",
        createdAt: Date.now(),
        tabs: tabs.map(t => ({
          title: t.title || t.url,
          url: t.url,
          favIconUrl: t.favIconUrl || "",
          pinned: t.pinned
        }))
      };
      importedGroups++;
    }

    await chrome.storage.local.set({ savedGroups });
    return importedGroups;
  },

  async renameBookmarkNode(nodeId, newTitle) {
    if (!newTitle || nodeId === "root") return;
    const { bookmarkNodes } = await chrome.storage.local.get("bookmarkNodes");
    if (bookmarkNodes[nodeId]) {
      bookmarkNodes[nodeId].title = newTitle.trim();
      await chrome.storage.local.set({ bookmarkNodes });
    }
  },

  // Sao chép đệ quy (Deep Copy) một Bookmark hoặc cả nhánh Thư mục sang thư mục đích (Dùng cho Copy & Paste)
  async copyBookmarkNode(sourceId, targetParentId) {
    const { bookmarkNodes } = await chrome.storage.local.get("bookmarkNodes");
    const sourceNode = bookmarkNodes[sourceId];
    const targetParent = bookmarkNodes[targetParentId];
    if (!sourceNode || !targetParent || targetParent.type !== "folder") return;

    // Ngăn việc copy thư mục cha dán vào chính thư mục con của nó
    let cursor = targetParent;
    while (cursor) {
      if (cursor.id === sourceId) return;
      cursor = cursor.parentId ? bookmarkNodes[cursor.parentId] : null;
    }

    const cloneRecursive = (nodeToClone, parentId) => {
      const newId = `${nodeToClone.type === "folder" ? "fld" : "bm"}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const cloned = {
        ...nodeToClone,
        id: newId,
        parentId,
        title: parentId === nodeToClone.parentId ? `${nodeToClone.title} (Copy)` : nodeToClone.title,
        ...(nodeToClone.type === "folder" ? { childrenIds: [] } : {})
      };

      bookmarkNodes[newId] = cloned;
      bookmarkNodes[parentId].childrenIds.push(newId);

      if (nodeToClone.type === "folder" && Array.isArray(nodeToClone.childrenIds)) {
        nodeToClone.childrenIds.forEach(childId => {
          if (bookmarkNodes[childId]) cloneRecursive(bookmarkNodes[childId], newId);
        });
      }
    };

    cloneRecursive(sourceNode, targetParentId);
    await chrome.storage.local.set({ bookmarkNodes });
  },

  // Kiểm tra targetId có phải là con/cháu của sourceId hay không (Tránh lỗi Cut & Paste thư mục vào chính nó)
  isDescendant(nodes, sourceId, targetId) {
    let curr = nodes[targetId];
    while (curr) {
      if (curr.id === sourceId) return true;
      curr = curr.parentId ? nodes[curr.parentId] : null;
    }
    return false;
  },

  async updateSavedGroup(groupId, { title, color }) {
    const { savedGroups = {} } = await chrome.storage.local.get("savedGroups");
    const group = savedGroups[groupId];
    if (!group) return;

    if (typeof title === "string" && title.trim()) {
      group.title = title.trim();
    }
    if (typeof color === "string" && color.trim()) {
      group.color = color.trim();
    }

    await chrome.storage.local.set({ savedGroups });
  },

  async addTabToSavedGroup(groupId, { title, url, favIconUrl = "", pinned = false }, targetIndex = -1) {
    const { savedGroups = {} } = await chrome.storage.local.get("savedGroups");
    const group = savedGroups[groupId];
    if (!group) return;

    const newTab = {
      title: (title || url).trim(),
      url: url.trim(),
      favIconUrl,
      pinned: Boolean(pinned)
    };

    if (targetIndex >= 0 && targetIndex <= group.tabs.length) {
      group.tabs.splice(targetIndex, 0, newTab);
    } else {
      group.tabs.push(newTab);
    }

    await chrome.storage.local.set({ savedGroups });
  },

  async updateTabInSavedGroup(groupId, tabIndex, { title, url }) {
    const { savedGroups = {} } = await chrome.storage.local.get("savedGroups");
    const group = savedGroups[groupId];
    if (!group || !group.tabs[tabIndex]) return;

    if (typeof title === "string" && title.trim()) {
      group.tabs[tabIndex].title = title.trim();
    }
    if (typeof url === "string" && url.trim()) {
      group.tabs[tabIndex].url = url.trim();
    }

    await chrome.storage.local.set({ savedGroups });
  },

  // 3. Xóa một tab con khỏi Saved Group
  async removeTabFromSavedGroup(groupId, tabIndex) {
    const { savedGroups = {} } = await chrome.storage.local.get("savedGroups");
    const group = savedGroups[groupId];
    if (!group || !group.tabs[tabIndex]) return;

    group.tabs.splice(tabIndex, 1);
    await chrome.storage.local.set({ savedGroups });
  },

  // 4. Kéo thả đổi thứ tự tab trong cùng một Saved Group hoặc chuyển sang Saved Group khác
  async moveTabBetweenSavedGroups(sourceGroupId, sourceIndex, targetGroupId, targetIndex) {
    const { savedGroups = {} } = await chrome.storage.local.get("savedGroups");
    const srcGroup = savedGroups[sourceGroupId];
    const dstGroup = savedGroups[targetGroupId];
    if (!srcGroup || !dstGroup || !srcGroup.tabs[sourceIndex]) return;

    // Lấy tab ra khỏi vị trí cũ
    const [movedTab] = srcGroup.tabs.splice(sourceIndex, 1);

    // Chèn vào vị trí mới
    const insertIdx = targetIndex < 0 || targetIndex > dstGroup.tabs.length
      ? dstGroup.tabs.length
      : targetIndex;

    dstGroup.tabs.splice(insertIdx, 0, movedTab);
    await chrome.storage.local.set({ savedGroups });
  }
};