// core/share.js
import { StorageAPI } from "./storage.js";

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

// Giải mã Base64 về lại chuỗi UTF-8
function base64ToUtf8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export const ShareCodec = {
  PREFIX: "wsgrp://",

  // 1. Mã hóa một Group đang mở thành chuỗi Base64 gọn nhẹ
  async encodeActiveGroup(groupId) {
    const [group, tabs] = await Promise.all([
      chrome.tabGroups.get(groupId),
      chrome.tabs.query({ groupId })
    ]);

    // Tối giản key (t: title, c: color, items: [title, url, pinned]) để chuỗi Base64 ngắn nhất
    const compactPayload = {
      v: 1,
      t: group.title || "Shared Group",
      c: group.color || "blue",
      items: tabs.map(tab => [
        tab.title || "",
        tab.url || "",
        tab.pinned ? 1 : 0
      ])
    };

    const jsonStr = JSON.stringify(compactPayload);
    return this.PREFIX + utf8ToBase64(jsonStr);
  },

  // 2. Mã hóa một Group đã lưu trong Storage thành chuỗi Base64
  async encodeSavedGroup(savedGroupId) {
    const { savedGroups = {} } = await chrome.storage.local.get("savedGroups");
    const group = savedGroups[savedGroupId];
    if (!group) throw new Error("Không tìm thấy nhóm đã lưu.");

    const compactPayload = {
      v: 1,
      t: group.title,
      c: group.color || "blue",
      items: group.tabs.map(tab => [
        tab.title || "",
        tab.url || "",
        tab.pinned ? 1 : 0
      ])
    };

    return this.PREFIX + utf8ToBase64(JSON.stringify(compactPayload));
  },

  // 3. Giải mã chuỗi Base64 và Mở trực tiếp hoặc Lưu vào Storage
  async importFromBase64(rawString, mode = "open") {
    const cleanStr = rawString.trim();
    const base64Part = cleanStr.startsWith(this.PREFIX)
      ? cleanStr.slice(this.PREFIX.length)
      : cleanStr;

    let payload;
    try {
      payload = JSON.parse(base64ToUtf8(base64Part));
    } catch {
      throw new Error("Mã Base64 không hợp lệ hoặc đã bị cắt xén.");
    }

    if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
      throw new Error("Dữ liệu nhóm tab trống hoặc sai cấu trúc.");
    }

    const tabsData = payload.items
      .filter(([, url]) => url && url.startsWith("http"))
      .map(([title, url, pinned]) => ({
        title: title || url,
        url,
        pinned: Boolean(pinned),
        favIconUrl: ""
      }));

    if (!tabsData.length) {
      throw new Error("Không có URL hợp lệ trong mã chia sẻ.");
    }

    // Chế độ 1: Lưu vào danh sách Saved Groups
    if (mode === "save") {
      const { savedGroups = {} } = await chrome.storage.local.get("savedGroups");
      const id = `grp_${Date.now()}`;
      savedGroups[id] = {
        id,
        title: payload.t || "Imported Group",
        color: payload.c || "blue",
        createdAt: Date.now(),
        tabs: tabsData
      };
      await chrome.storage.local.set({ savedGroups });
      return { mode: "save", title: payload.t, count: tabsData.length };
    }

    // Chế độ 2: Mở ngay lập tức thành Tab Group trên cửa sổ hiện tại
    const currentWin = await chrome.windows.getCurrent();
    const createdTabIds = [];

    for (const item of tabsData) {
      const t = await chrome.tabs.create({
        windowId: currentWin.id,
        url: item.url,
        pinned: item.pinned,
        active: false
      });
      createdTabIds.push(t.id);
    }

    const newGroupId = await chrome.tabs.group({
      createProperties: { windowId: currentWin.id },
      tabIds: createdTabIds
    });

    await chrome.tabGroups.update(newGroupId, {
      title: payload.t || "Imported Group",
      color: payload.c || "blue"
    });

    return { mode: "open", title: payload.t, count: createdTabIds.length };
  }
};

export const BackupManager = {
  async downloadBackupJson() {
    const backupObj = await StorageAPI.exportBackupData();
    const jsonString = JSON.stringify(backupObj, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const dateStr = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = `workspace-backup-${dateStr}.json`;
    a.click();

    URL.revokeObjectURL(url);
  },

  async restoreFromJsonFile(file, merge = false) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const parsed = JSON.parse(e.target.result);
          await StorageAPI.importBackupData(parsed, merge);
          resolve(true);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error("Không thể đọc file."));
      reader.readAsText(file);
    });
  }
};