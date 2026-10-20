import { StorageAPI } from "../core/storage.js";
import { GroupController, GROUP_COLORS } from "../background/group-controller.js";
import { BackupManager, ShareCodec } from "../core/share.js";

let dragPayload = null;
let currentView = "windows-all";

let currentFolderId = "root";
let selectedNodeIds = new Set();
let explorerClipboard = { mode: null, nodeIds: [] }; // mode: "copy" | "cut"

document.addEventListener("DOMContentLoaded", async () => {
  await StorageAPI.init();
  await initUIAndEvents();
  await refreshAll();

  const events = [
    chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onMoved,
    chrome.tabs.onUpdated, chrome.tabs.onDetached, chrome.tabs.onAttached,
    chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated, chrome.tabGroups.onRemoved
  ];
  events.forEach(ev => ev.addListener(refreshAll));
  chrome.storage.onChanged.addListener(refreshAll);
});

function normalizeText(str = "") {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().trim();
}

function isFuzzyMatch(query, ...targets) {
  if (!query) return true;
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  const combined = normalizeText(targets.filter(Boolean).join(" "));
  return tokens.every(t => combined.includes(t));
}

// ==========================================
// 1. QUẢN LÝ THEME, MODAL NỔI & PHÍM TẮT
// ==========================================
async function initUIAndEvents() {
  const settings = await StorageAPI.getSettings();
  const theme = settings.theme || "dark";
  document.documentElement.setAttribute("data-theme", theme);

  const chkTheme = document.getElementById("chk-theme-toggle");
  const chkAutoGroup = document.getElementById("chk-auto-group");
  const chkAutoDedup = document.getElementById("chk-auto-dedup");
  const inpExclude = document.getElementById("inp-exclude-domains");

  chkTheme.checked = theme === "dark";
  chkAutoGroup.checked = Boolean(settings.autoGroupByDomain);
  chkAutoDedup.checked = Boolean(settings.autoDeduplicate);
  inpExclude.value = (settings.excludeDomains || []).join(", ");

  chkTheme.addEventListener("change", async () => {
    const nextTheme = chkTheme.checked ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", nextTheme);
    await StorageAPI.updateSettings({ theme: nextTheme });
  });

  chkAutoGroup.addEventListener("change", () =>
    StorageAPI.updateSettings({ autoGroupByDomain: chkAutoGroup.checked })
  );
  chkAutoDedup.addEventListener("change", () =>
    StorageAPI.updateSettings({ autoDeduplicate: chkAutoDedup.checked })
  );
  inpExclude.addEventListener("change", () => {
    const excludeDomains = inpExclude.value.split(",").map(s => s.trim()).filter(Boolean);
    StorageAPI.updateSettings({ excludeDomains });
  });

  // Chuyển đổi giữa các mục trên Sidebar trái
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentView = btn.dataset.view;
      updateActiveViewPane();
      refreshAll();
    });
  });

  // Bổ sung vào trong hàm initUIAndEvents() của dashboard/dashboard.js
  setupDropzone(document.getElementById("nav-btn-saved-groups"), async (payload) => {
    if (payload.type !== "TAB") return;
    const { savedGroups = {} } = await StorageAPI.getAllData();
    const groupList = Object.values(savedGroups);

    if (groupList.length === 0) {
      // Nếu chưa có nhóm lưu nào, tạo mới một Saved Group chứa tab vừa thả
      const newId = `grp_${Date.now()}`;
      savedGroups[newId] = {
        id: newId,
        title: "Quick Saved",
        color: "blue",
        createdAt: Date.now(),
        tabs: [{ title: payload.title, url: payload.url, favIconUrl: payload.favIconUrl, pinned: false }]
      };
      await chrome.storage.local.set({ savedGroups });
    } else {
      // Thêm vào nhóm đã lưu đầu tiên trong danh sách
      await StorageAPI.addTabToSavedGroup(groupList[0].id, {
        title: payload.title,
        url: payload.url,
        favIconUrl: payload.favIconUrl
      });
    }
  });

  // Cho phép kéo Tab từ Windows View thả thẳng vào nút "Bookmarks" ở Sidebar trái để lưu vào thư mục hiện tại
  setupDropzone(document.getElementById("nav-btn-bookmarks"), async (payload) => {
    if (payload.type === "TAB") {
      await StorageAPI.addBookmarkNode({
        parentId: currentFolderId,
        type: "bookmark",
        title: payload.title,
        url: payload.url,
        favIconUrl: payload.favIconUrl
      });
    }
  });

  setupModals();
  setupExplorerToolbar();
}

function setupModals() {
  const settingsModal = document.getElementById("settings-modal");
  const searchModal = document.getElementById("search-modal");
  const searchInput = document.getElementById("inp-modal-search");

  document.getElementById("btn-open-settings").addEventListener("click", () => (settingsModal.hidden = false));
  document.getElementById("btn-close-settings").addEventListener("click", () => (settingsModal.hidden = true));
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) settingsModal.hidden = true;
  });

  const openSearch = () => {
    searchModal.hidden = false;
    searchInput.value = "";
    searchInput.focus();
    renderSearchModalResults("");
  };

  document.getElementById("btn-open-search").addEventListener("click", openSearch);
  searchModal.addEventListener("click", (e) => {
    if (e.target === searchModal) searchModal.hidden = true;
  });
  searchInput.addEventListener("input", (e) => renderSearchModalResults(e.target.value.trim()));

  window.addEventListener("keydown", (e) => {
    const isTyping = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
    if ((e.key === "/" && !isTyping) || (e.altKey && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      openSearch();
    } else if (e.key === "Escape") {
      searchModal.hidden = true;
      settingsModal.hidden = true;
    }
  });

  document.getElementById("btn-import-chrome-bm").addEventListener("click", async () => {
    const count = await StorageAPI.importChromeBookmarks();
    alert(`Đã nhập ${count} bookmarks từ Chrome.`);
    await refreshAll();
  });

  document.getElementById("btn-import-chrome-groups").addEventListener("click", async () => {
    const count = await StorageAPI.importChromeTabGroups();
    alert(`Đã nhập ${count} nhóm tab từ Chrome.`);
    await refreshAll();
  });

  document.getElementById("btn-export-json").addEventListener("click", () => BackupManager.downloadBackupJson());
  const fileInput = document.getElementById("inp-import-file");
  document.getElementById("btn-import-json").addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const merge = confirm("OK để GỘP (Merge), Cancel để GHI ĐÈ (Overwrite).");
    await BackupManager.restoreFromJsonFile(file, merge);
    await refreshAll();
  });

  document.getElementById("btn-clean-duplicates").addEventListener("click", async () => {
    const s = await StorageAPI.getSettings();
    const closed = await GroupController.cleanDuplicateTabs(s.ignoreUrlHash);
    alert(`Đã đóng ${closed} tab trùng lặp.`);
    await refreshAll();
  });

  document.getElementById("btn-import-base64").addEventListener("click", async () => {
    const code = prompt("Dán mã Base64 (wsgrp://...):");
    if (!code) return;
    const openNow = confirm("OK để mở ngay trên cửa sổ, Cancel để lưu vào Saved Groups.");
    await ShareCodec.importFromBase64(code, openNow ? "open" : "save");
    await refreshAll();
  });
}

function updateActiveViewPane() {
  const isWindows = currentView.startsWith("windows-");
  document.getElementById("view-windows").hidden = !isWindows;
  document.getElementById("view-saved-groups").hidden = currentView !== "saved-groups";
  document.getElementById("view-bookmarks").hidden = currentView !== "bookmarks";
}

function setupExplorerToolbar() {
  // Lên thư mục cha
  document.getElementById("btn-bm-up").addEventListener("click", async () => {
    const { bookmarkNodes } = await StorageAPI.getAllData();
    const curr = bookmarkNodes[currentFolderId];
    if (curr && curr.parentId) {
      currentFolderId = curr.parentId;
      selectedNodeIds.clear();
      await refreshAll();
    }
  });

  // Tạo thư mục mới trong thư mục đang mở
  document.getElementById("btn-bm-new-folder").addEventListener("click", async () => {
    const title = prompt("Tên thư mục mới:");
    if (title) {
      await StorageAPI.addBookmarkNode({ parentId: currentFolderId, type: "folder", title: title.trim() });
    }
  });

  // Tạo Bookmark mới trong thư mục đang mở
  document.getElementById("btn-bm-new-link").addEventListener("click", async () => {
    const title = prompt("Tiêu đề Bookmark:");
    if (!title) return;
    const url = prompt("URL (bắt đầu bằng https://):", "https://");
    if (url) {
      await StorageAPI.addBookmarkNode({ parentId: currentFolderId, type: "bookmark", title: title.trim(), url: url.trim() });
    }
  });

  // Checkbox Chọn tất cả trong thư mục hiện tại
  document.getElementById("chk-bm-select-all").addEventListener("change", async (e) => {
    const { bookmarkNodes } = await StorageAPI.getAllData();
    const folder = bookmarkNodes[currentFolderId];
    selectedNodeIds.clear();
    if (e.target.checked && folder?.childrenIds) {
      folder.childrenIds.forEach(id => selectedNodeIds.add(id));
    }
    renderBookmarkExplorer(bookmarkNodes);
  });

  // Các nút Copy / Cut / Paste / Delete
  document.getElementById("btn-bm-copy").addEventListener("click", () => setClipboard("copy"));
  document.getElementById("btn-bm-cut").addEventListener("click", () => setClipboard("cut"));
  document.getElementById("btn-bm-paste").addEventListener("click", executePaste);
  document.getElementById("btn-bm-delete").addEventListener("click", executeDeleteSelected);

  // Phím tắt chuẩn File Explorer khi đang ở màn hình Bookmarks
  window.addEventListener("keydown", async (e) => {
    const isTyping = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
    if (isTyping || currentView !== "bookmarks") return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      if (selectedNodeIds.size > 0) {
        e.preventDefault();
        setClipboard("copy");
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x") {
      if (selectedNodeIds.size > 0) {
        e.preventDefault();
        setClipboard("cut");
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      if (explorerClipboard.nodeIds.length > 0) {
        e.preventDefault();
        await executePaste();
      }
    } else if (e.key === "Delete" && selectedNodeIds.size > 0) {
      e.preventDefault();
      await executeDeleteSelected();
    } else if (e.key === "Backspace") {
      e.preventDefault();
      document.getElementById("btn-bm-up").click();
    }
  });
}

async function executeDeleteSelected() {
  if (selectedNodeIds.size === 0) return;
  const ok = confirm(`Xóa ${selectedNodeIds.size} mục đã chọn?`);
  if (!ok) return;

  for (const id of selectedNodeIds) {
    await StorageAPI.deleteBookmarkNode(id);
  }
  selectedNodeIds.clear();
  await refreshAll();
}

async function setClipboard(mode) {
  if (selectedNodeIds.size === 0) return;
  explorerClipboard = {
    mode,
    nodeIds: Array.from(selectedNodeIds)
  };
  const { bookmarkNodes } = await StorageAPI.getAllData();
  renderBookmarkExplorer(bookmarkNodes);
}

async function executePaste() {
  if (!explorerClipboard.nodeIds.length) return;
  const { bookmarkNodes } = await StorageAPI.getAllData();

  for (const id of explorerClipboard.nodeIds) {
    if (!bookmarkNodes[id]) continue;
    if (explorerClipboard.mode === "copy") {
      await StorageAPI.copyBookmarkNode(id, currentFolderId);
    } else if (explorerClipboard.mode === "cut") {
      // Đảm bảo không di chuyển thư mục cha vào chính thư mục con của nó
      if (!StorageAPI.isDescendant(bookmarkNodes, id, currentFolderId)) {
        await StorageAPI.moveBookmarkNode(id, currentFolderId, 999999);
      }
    }
  }

  // Nếu là Cut thì xóa clipboard sau khi đã di chuyển xong
  if (explorerClipboard.mode === "cut") {
    explorerClipboard = { mode: null, nodeIds: [] };
  }
  selectedNodeIds.clear();
  await refreshAll();
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

function renderBookmarkExplorer(nodes) {
  if (!nodes[currentFolderId]) currentFolderId = "root";
  const currentFolder = nodes[currentFolderId];

  // 1. Render thanh đường dẫn Breadcrumbs (hỗ trợ kéo thả vào từng bậc đường dẫn để di chuyển nhanh)
  const bcContainer = document.getElementById("bm-breadcrumbs");
  bcContainer.innerHTML = "";
  const path = [];
  let cursor = currentFolder;
  while (cursor) {
    path.unshift(cursor);
    cursor = cursor.parentId ? nodes[cursor.parentId] : null;
  }

  path.forEach((folderNode, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "/";
      bcContainer.appendChild(sep);
    }
    const btn = document.createElement("button");
    btn.className = `crumb-btn ${folderNode.id === currentFolderId ? "active" : ""}`;
    btn.textContent = folderNode.id === "root" ? "Root" : folderNode.title;
    btn.addEventListener("click", () => {
      currentFolderId = folderNode.id;
      selectedNodeIds.clear();
      renderBookmarkExplorer(nodes);
    });

    // Cho phép kéo mục trong Explorer thả thẳng lên Breadcrumb để chuyển thư mục
    setupDropzone(btn, async (payload) => {
      if (payload.type === "EXPLORER_ITEMS") {
        for (const id of payload.nodeIds) {
          if (!StorageAPI.isDescendant(nodes, id, folderNode.id)) {
            await StorageAPI.moveBookmarkNode(id, folderNode.id, 999999);
          }
        }
        selectedNodeIds.clear();
      }
    });

    bcContainer.appendChild(btn);
  });

  // 2. Cập nhật trạng thái nút trên Toolbar
  const hasSelection = selectedNodeIds.size > 0;
  document.getElementById("btn-bm-up").disabled = currentFolderId === "root";
  document.getElementById("btn-bm-copy").disabled = !hasSelection;
  document.getElementById("btn-bm-cut").disabled = !hasSelection;
  document.getElementById("btn-bm-delete").disabled = !hasSelection;
  document.getElementById("btn-bm-paste").disabled = explorerClipboard.nodeIds.length === 0;

  const clipBadge = document.getElementById("clipboard-status");
  if (explorerClipboard.nodeIds.length > 0) {
    clipBadge.hidden = false;
    clipBadge.textContent = `${explorerClipboard.mode.toUpperCase()}: ${explorerClipboard.nodeIds.length} item(s)`;
  } else {
    clipBadge.hidden = true;
  }

  // 3. Render danh sách các mục trong thư mục hiện tại (Sắp xếp: Thư mục lên trên, Bookmark ở dưới)
  const body = document.getElementById("bm-explorer-body");
  body.innerHTML = "";

  const children = (currentFolder.childrenIds || [])
    .map(id => nodes[id])
    .filter(Boolean)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.title.localeCompare(b.title);
    });

  document.getElementById("chk-bm-select-all").checked =
    children.length > 0 && children.every(c => selectedNodeIds.has(c.id));

  if (children.length === 0) {
    body.innerHTML = `<div class="empty-folder-state">This folder is empty. Use New Folder, New Link, or Paste (Ctrl+V) here.</div>`;
    return;
  }

  children.forEach(item => {
    const row = document.createElement("div");
    const isSelected = selectedNodeIds.has(item.id);
    const isCut = explorerClipboard.mode === "cut" && explorerClipboard.nodeIds.includes(item.id);

    row.className = `explorer-row ${isSelected ? "selected" : ""} ${isCut ? "is-cut" : ""}`;
    row.dataset.type = item.type;
    row.draggable = true;

    const childCount = item.type === "folder" ? (item.childrenIds?.length || 0) : 0;

    row.innerHTML = `
      <div class="col-check">
        <input type="checkbox" class="row-chk" ${isSelected ? "checked" : ""}>
      </div>
      ${item?.favIconUrl? `<img class="col-fav-img" src="${item.favIconUrl != ""? item.favIconUrl : ""}"></img>` : 
          `<svg width="20px" height="20px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 8.2C3 7.07989 3 6.51984 3.21799 6.09202C3.40973 5.71569 3.71569 5.40973 4.09202 5.21799C4.51984 5 5.0799 5 6.2 5H9.67452C10.1637 5 10.4083 5 10.6385 5.05526C10.8425 5.10425 11.0376 5.18506 11.2166 5.29472C11.4184 5.4184 11.5914 5.59135 11.9373 5.93726L12.0627 6.06274C12.4086 6.40865 12.5816 6.5816 12.7834 6.70528C12.9624 6.81494 13.1575 6.89575 13.3615 6.94474C13.5917 7 13.8363 7 14.3255 7H17.8C18.9201 7 19.4802 7 19.908 7.21799C20.2843 7.40973 20.5903 7.71569 20.782 8.09202C21 8.51984 21 9.0799 21 10.2V15.8C21 16.9201 21 17.4802 20.782 17.908C20.5903 18.2843 20.2843 18.5903 19.908 18.782C19.4802 19 18.9201 19 17.8 19H6.2C5.07989 19 4.51984 19 4.09202 18.782C3.71569 18.5903 3.40973 18.2843 3.21799 17.908C3 17.4802 3 16.9201 3 15.8V8.2Z" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>`}
      <div class="col-name">${item.title}</div>
      <div class="col-type">${item.type === "folder" ? "Folder" : "Bookmark"}</div>
      <div class="col-url">${item.type === "folder" ? `${childCount} item(s)` : item.url}</div>
      <div class="col-actions">
        <button class="btn-text" data-act="open">Open</button>
        <button class="btn-text" data-act="rename">Rename</button>
        <button class="btn-text" data-act="del">Delete</button>
      </div>
    `;

    // Chọn dòng bằng Checkbox hoặc Click
    const chk = row.querySelector(".row-chk");
    chk.addEventListener("click", (e) => {
      e.stopPropagation();
      if (chk.checked) selectedNodeIds.add(item.id);
      else selectedNodeIds.delete(item.id);
      renderBookmarkExplorer(nodes);
    });

    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (e.ctrlKey || e.metaKey) {
        if (selectedNodeIds.has(item.id)) selectedNodeIds.delete(item.id);
        else selectedNodeIds.add(item.id);
      } else {
        selectedNodeIds.clear();
        selectedNodeIds.add(item.id);
      }
      renderBookmarkExplorer(nodes);
    });

    // Double-click: Nếu là Folder thì đi vào bên trong; nếu là Bookmark thì mở tab mới
    row.addEventListener("dblclick", () => {
      if (item.type === "folder") {
        currentFolderId = item.id;
        selectedNodeIds.clear();
        renderBookmarkExplorer(nodes);
      } else if (item.url) {
        chrome.tabs.create({ url: item.url });
      }
    });

    // Kéo (Drag) một hoặc nhiều mục đang chọn
    row.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      if (!selectedNodeIds.has(item.id)) {
        selectedNodeIds.clear();
        selectedNodeIds.add(item.id);
      }
      dragPayload = {
        type: "EXPLORER_ITEMS",
        nodeIds: Array.from(selectedNodeIds)
      };
      row.classList.add("dragging");
    });

    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      dragPayload = null;
    });

    // Nếu dòng này là Folder, cho phép thả các mục khác vào bên trong nó
    if (item.type === "folder") {
      setupDropzone(row, async (payload) => {
        if (payload.type === "EXPLORER_ITEMS") {
          for (const id of payload.nodeIds) {
            if (id !== item.id && !StorageAPI.isDescendant(nodes, id, item.id)) {
              await StorageAPI.moveBookmarkNode(id, item.id, 999999);
            }
          }
          selectedNodeIds.clear();
        }
      });
    }

    // Các nút hành động nhanh trên từng dòng
    row.querySelector('[data-act="open"]').addEventListener("click", () => {
      if (item.type === "folder") {
        currentFolderId = item.id;
        selectedNodeIds.clear();
        renderBookmarkExplorer(nodes);
      } else {
        chrome.tabs.create({ url: item.url });
      }
    });

    row.querySelector('[data-act="rename"]').addEventListener("click", async () => {
      const newTitle = prompt("Đổi tên:", item.title);
      if (newTitle) await StorageAPI.renameBookmarkNode(item.id, newTitle);
    });

    row.querySelector('[data-act="del"]').addEventListener("click", async () => {
      await StorageAPI.deleteBookmarkNode(item.id);
      selectedNodeIds.delete(item.id);
    });

    body.appendChild(row);
  });
}

// ==========================================
// 2. RENDER KẾT QUẢ TRONG HỘP THOẠI TÌM KIẾM NỔI
// ==========================================
async function renderSearchModalResults(query) {
  const container = document.getElementById("search-modal-results");
  container.innerHTML = "";
  const [allTabs, { bookmarkNodes = {}, savedGroups = {} }] = await Promise.all([
    chrome.tabs.query({ windowType: "normal" }),
    StorageAPI.getAllData()
  ]);

  const results = [];
  allTabs.forEach(t => {
    if (isFuzzyMatch(query, t.title, t.url)) {
      results.push({
        label: t.title || t.url,
        tag: "Open Tab",
        action: async () => {
          await chrome.windows.update(t.windowId, { focused: true });
          await chrome.tabs.update(t.id, { active: true });
          document.getElementById("search-modal").hidden = true;
        }
      });
    }
  });

  Object.values(bookmarkNodes).forEach(node => {
    if (node.id !== "root" && isFuzzyMatch(query, node.title, node.url)) {
      results.push({
        label: node.title,
        tag: node.type === "folder" ? "Folder" : "Bookmark",
        action: () => {
          if (node.type === "folder") {
            currentFolderId = node.id;
            document.getElementById("nav-btn-bookmarks").click();
          } else {
            chrome.tabs.create({ url: node.url });
          }
          document.getElementById("search-modal").hidden = true;
        }
      });
    }
  });

  Object.values(savedGroups).forEach(g => {
    if (isFuzzyMatch(query, g.title)) {
      results.push({
        label: `${g.title} (${g.tabs.length} tabs)`,
        tag: "Saved Group",
        action: async () => {
          await GroupController.restoreGroup(g.id);
          document.getElementById("search-modal").hidden = true;
        }
      });
    }
  });

  results.slice(0, 30).forEach(item => {
    const row = document.createElement("div");
    row.className = "search-result-item";
    row.innerHTML = `<span>${item.label}</span><span class="result-type-tag">${item.tag}</span>`;
    row.addEventListener("click", item.action);
    container.appendChild(row);
  });
}

// ==========================================
// 3. RENDER SIDEBAR & WINDOWS TREE (CLEAN TEXT, KHÔNG ICON)
// ==========================================
async function refreshAll() {
  const { settings = {}, savedGroups = {}, bookmarkNodes = {} } = await StorageAPI.getAllData();

  // Đếm tổng số lượng Bookmark và Saved Groups hiển thị lên Sidebar
  const totalBookmarks = Object.values(bookmarkNodes).filter(n => n.type === "bookmark").length;
  const totalGroups = Object.keys(savedGroups).length;
  document.getElementById("nav-count-bookmarks").textContent = totalBookmarks;
  document.getElementById("nav-count-groups").textContent = totalGroups;

  renderBookmarkExplorer(bookmarkNodes);
  renderSavedGroupsView(savedGroups);
  await renderWindowsTree();

  const { totalDuplicates } = await GroupController.findDuplicateTabs(settings.ignoreUrlHash ?? true);
  document.getElementById("dup-count").textContent = totalDuplicates;
}

// Thay thế hàm renderSavedGroupsView(savedGroups) trong dashboard/dashboard.js
function renderSavedGroupsView(savedGroups) {
  const container = document.getElementById("saved-groups-grid");
  container.innerHTML = "";
  const list = Object.values(savedGroups);

  if (list.length === 0) {
    container.innerHTML = `<div class="empty-folder-state">No saved tab groups yet.</div>`;
    return;
  }

  list.forEach(g => {
    const card = document.createElement("div");
    card.className = "window-box";
    card.innerHTML = `
      <div class="window-header">
        <div class="group-title-wrap">
          <button class="color-dot dot-${g.color || 'grey'}" data-act="toggle-color" title="Đổi màu nhóm"></button>
          <h3>${g.title} (${g.tabs.length})</h3>
        </div>
        <div class="actions">
          <button class="btn-text" data-act="add-tab">+ Add Link</button>
          <button class="btn-text" data-act="restore">Restore</button>
          <button class="btn-text" data-act="rename">Rename</button>
          <button class="btn-text" data-act="share">Share</button>
          <button class="btn-text" data-act="del">Delete</button>
        </div>
      </div>
      <div class="color-popover" hidden>
        ${GROUP_COLORS.map(c => `<button class="swatch-btn dot-${c}${c === g.color ? 'active' : ''}" data-color="${c}" title="${c}"></button>`).join("")}
      </div>
      <div class="tab-list"></div>
    `;

    // 1. Đổi màu nhóm đã lưu
    const popover = card.querySelector(".color-popover");
    card.querySelector('[data-act="toggle-color"]').addEventListener("click", () => {
      popover.hidden = !popover.hidden;
    });
    popover.querySelectorAll(".swatch-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        await StorageAPI.updateSavedGroup(g.id, { color: btn.dataset.color });
      });
    });

    // 2. Thêm tab mới trực tiếp vào nhóm đã lưu
    card.querySelector('[data-act="add-tab"]').addEventListener("click", async () => {
      const title = prompt("Nhập tiêu đề trang web:");
      if (!title) return;
      const url = prompt("Nhập URL (bắt đầu bằng https://):", "https://");
      if (!url || !url.startsWith("http")) return;
      await StorageAPI.addTabToSavedGroup(g.id, { title, url });
    });

    // 3. Khôi phục, Đổi tên, Chia sẻ, Xóa nhóm
    card.querySelector('[data-act="restore"]').addEventListener("click", () => GroupController.restoreGroup(g.id));
    card.querySelector('[data-act="rename"]').addEventListener("click", async () => {
      const nextTitle = prompt("Đổi tên nhóm đã lưu:", g.title);
      if (nextTitle) await StorageAPI.updateSavedGroup(g.id, { title: nextTitle });
    });
    card.querySelector('[data-act="share"]').addEventListener("click", async () => {
      const code = await ShareCodec.encodeSavedGroup(g.id);
      await navigator.clipboard.writeText(code);
      alert("Đã copy mã Base64 vào Clipboard.");
    });
    card.querySelector('[data-act="del"]').addEventListener("click", () => StorageAPI.deleteSavedGroup(g.id));

    // 4. Render danh sách các tab con bên trong nhóm (Hỗ trợ Drag & Drop, Edit, Remove)
    const tabList = card.querySelector(".tab-list");
    if (g.tabs.length === 0) {
      tabList.innerHTML = `<div class="empty-folder-state" style="padding: 16px;">Empty group. Click "+ Add Link" or drag tabs here.</div>`;
    }

    g.tabs.forEach((t, tabIdx) => {
      const row = document.createElement("div");
      row.className = "tab-item";
      row.draggable = true;

      row.innerHTML = `
        <div class="tab-info" title="${t.url}">
          <img src="${t.favIconUrl || ""}" alt="">
          <span class="tab-title">${t.title}</span>
        </div>
        <div class="actions">
          <button class="btn-text" data-act="open-single">Open</button>
          <button class="btn-text" data-act="edit-tab">Edit</button>
          <button class="btn-text" data-act="remove-tab">Remove</button>
        </div>
      `;

      // Bắt đầu kéo một tab con trong Saved Group
      row.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        dragPayload = {
          type: "SAVED_TAB",
          sourceGroupId: g.id,
          sourceIndex: tabIdx,
          title: t.title,
          url: t.url,
          favIconUrl: t.favIconUrl || ""
        };
        row.classList.add("dragging");
      });

      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        dragPayload = null;
      });

      // Thả một tab khác đè lên dòng này để chèn đúng vị trí thứ tự (Reorder)
      setupDropzone(row, async (payload) => {
        if (payload.type === "SAVED_TAB") {
          if (payload.sourceGroupId === g.id && payload.sourceIndex === tabIdx) return;
          await StorageAPI.moveTabBetweenSavedGroups(
            payload.sourceGroupId,
            payload.sourceIndex,
            g.id,
            tabIdx
          );
        } else if (payload.type === "TAB") {
          await StorageAPI.addTabToSavedGroup(g.id, {
            title: payload.title,
            url: payload.url,
            favIconUrl: payload.favIconUrl
          }, tabIdx);
        }
      });

      // Mở lẻ 1 tab
      row.querySelector('[data-act="open-single"]').addEventListener("click", () => {
        chrome.tabs.create({ url: t.url });
      });

      // Sửa tiêu đề và URL của tab con
      row.querySelector('[data-act="edit-tab"]').addEventListener("click", async () => {
        const newTitle = prompt("Sửa tiêu đề tab:", t.title);
        if (newTitle === null) return;
        const newUrl = prompt("Sửa URL tab:", t.url);
        if (newUrl === null) return;
        await StorageAPI.updateTabInSavedGroup(g.id, tabIdx, { title: newTitle, url: newUrl });
      });

      // Xóa lẻ 1 tab khỏi nhóm đã lưu
      row.querySelector('[data-act="remove-tab"]').addEventListener("click", async () => {
        await StorageAPI.removeTabFromSavedGroup(g.id, tabIdx);
      });

      tabList.appendChild(row);
    });

    // Dropzone cho cả khung Card của Saved Group (Khi thả vào vùng trống cuối danh sách)
    setupDropzone(card, async (payload) => {
      if (payload.type === "SAVED_TAB") {
        await StorageAPI.moveTabBetweenSavedGroups(
          payload.sourceGroupId,
          payload.sourceIndex,
          g.id,
          g.tabs.length
        );
      } else if (payload.type === "TAB") {
        await StorageAPI.addTabToSavedGroup(g.id, {
          title: payload.title,
          url: payload.url,
          favIconUrl: payload.favIconUrl
        });
      }
    });

    container.appendChild(card);
  });
}

function renderBookmarkTree(nodes) {
  const container = document.getElementById("db-bookmark-tree");
  container.innerHTML = "";
  if (nodes.root) container.appendChild(createBookmarkNodeDOM("root", nodes));
}

function createBookmarkNodeDOM(nodeId, nodes) {
  const node = nodes[nodeId];
  const wrapper = document.createElement("div");
  wrapper.className = nodeId === "root" ? "" : "bm-folder";

  if (nodeId !== "root") {
    const row = document.createElement("div");
    row.className = "bm-row";
    row.draggable = true;

    if (node.type === "folder") {
      row.innerHTML = `
        <strong>${node.title}</strong>
        <div class="actions">
          <button class="btn-text" data-act="sub">+Sub</button>
          <button class="btn-text" data-act="del">Delete</button>
        </div>
      `;
      setupDropzone(row, async (payload) => {
        if (payload.type === "TAB") {
          await StorageAPI.addBookmarkNode({
            parentId: node.id,
            type: "bookmark",
            title: payload.title,
            url: payload.url,
            favIconUrl: payload.favIconUrl
          });
        } else if (payload.type === "BOOKMARK_NODE" && payload.id !== node.id) {
          await StorageAPI.moveBookmarkNode(payload.id, node.id, 0);
        }
      });
      row.querySelector('[data-act="sub"]').addEventListener("click", async () => {
        const t = prompt("Tên thư mục con:");
        if (t) await StorageAPI.addBookmarkNode({ parentId: node.id, type: "folder", title: t });
      });
    } else {
      row.innerHTML = `
        <a href="${node.url}" target="_blank" class="bm-link">${node.title}</a>
        <button class="btn-text" data-act="del">Delete</button>
      `;
    }

    row.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      dragPayload = { type: "BOOKMARK_NODE", id: node.id };
    });
    row.querySelector('[data-act="del"]').addEventListener("click", () => StorageAPI.deleteBookmarkNode(node.id));
    wrapper.appendChild(row);
  }

  if (node.type === "folder" && node.childrenIds) {
    node.childrenIds.forEach(cid => {
      if (nodes[cid]) wrapper.appendChild(createBookmarkNodeDOM(cid, nodes));
    });
  }
  return wrapper;
}

function renderSavedGroups(savedGroups) {
  const container = document.getElementById("db-saved-groups");
  container.innerHTML = "";
  Object.values(savedGroups).forEach(g => {
    const row = document.createElement("div");
    row.className = "bm-row";
    row.innerHTML = `
      <span><strong>${g.title}</strong> (${g.tabs.length})</span>
      <div class="actions">
        <button class="btn-text" data-act="restore">Restore</button>
        <button class="btn-text" data-act="del">Delete</button>
      </div>
    `;
    row.querySelector('[data-act="restore"]').addEventListener("click", () => GroupController.restoreGroup(g.id));
    row.querySelector('[data-act="del"]').addEventListener("click", () => StorageAPI.deleteSavedGroup(g.id));
    container.appendChild(row);
  });
}

async function renderWindowsTree() {
  const tree = await GroupController.getWindowsTree();
  const container = document.getElementById("windows-tree-container");
  container.innerHTML = "";

  let openCount = 0;
  let suspendedCount = 0;
  const onlySuspended = currentView === "windows-suspended";

  tree.forEach((win, idx) => {
    const winBox = document.createElement("div");
    winBox.className = "window-box";
    winBox.innerHTML = `
      <div class="window-header">
        <h3>Window ${idx + 1} ${win.focused ? "(Current)" : ""}</h3>
        <button class="btn-text" data-act="new-group">+ Group</button>
      </div>
      <div class="groups-container"></div>
      <div class="group-box ungrouped-zone">
        <div class="group-header">
          <span class="group-title">Ungrouped</span>
        </div>
        <div class="tab-list ungrouped-list"></div>
      </div>
    `;

    winBox.querySelector('[data-act="new-group"]').addEventListener("click", async () => {
      const title = prompt("Tên nhóm mới:");
      if (!title || !win.ungroupedTabs.length) return;
      const gId = await chrome.tabs.group({
        createProperties: { windowId: win.windowId },
        tabIds: [win.ungroupedTabs[0].id]
      });
      await chrome.tabGroups.update(gId, { title, color: "blue" });
    });

    const groupsContainer = winBox.querySelector(".groups-container");
    win.groups.forEach(group => {
      group.tabs.forEach(t => {
        openCount++;
        if (t.discarded) suspendedCount++;
      });
      const visibleTabs = onlySuspended ? group.tabs.filter(t => t.discarded) : group.tabs;
      if (visibleTabs.length > 0 || !onlySuspended) {
        groupsContainer.appendChild(createGroupDOM({ ...group, tabs: visibleTabs }, win.windowId));
      }
    });

    const ungroupedList = winBox.querySelector(".ungrouped-list");
    win.ungroupedTabs.forEach(tab => {
      openCount++;
      if (tab.discarded) suspendedCount++;
      if (!onlySuspended || tab.discarded) {
        ungroupedList.appendChild(createTabDOM(tab, win.windowId, -1));
      }
    });

    setupDropzone(winBox.querySelector(".ungrouped-zone"), async (payload) => {
      if (payload.type !== "TAB") return;
      await chrome.tabs.ungroup([payload.tabId]);
      if (payload.windowId !== win.windowId) {
        await chrome.tabs.move(payload.tabId, { windowId: win.windowId, index: -1 });
      }
    });

    container.appendChild(winBox);
  });

  const openBadge = document.getElementById("nav-count-open");
  if (openBadge) {
    openBadge.textContent = suspendedCount > 0 ? `${openCount} (${suspendedCount} zzz)` : openCount;
    openBadge.title = `${openCount} tab đang mở, trong đó ${suspendedCount} tab đã giải phóng RAM`;
  }
}

function createGroupDOM(group, windowId) {
  const box = document.createElement("div");
  box.className = "group-box";
  box.innerHTML = `
    <div class="group-header">
      <div class="group-title-wrap">
        <button class="color-dot dot-${group.color || 'grey'}" data-act="toggle-color" title="Đổi màu nhóm"></button>
        <span class="group-title">${group.title || "Untitled"} (${group.tabs.length})</span>
      </div>
      <div class="actions">
        <button class="btn-text" data-act="rename">Rename</button>
        <button class="btn-text" data-act="suspend">Suspend</button>
        <button class="btn-text" data-act="save">Save</button>
        <button class="btn-text" data-act="share">Share</button>
        <button class="btn-text" data-act="ungroup">Ungroup</button>
        <button class="btn-text" data-act="delete">Delete</button>
      </div>
    </div>
    <div class="color-popover" hidden>
      ${GROUP_COLORS.map(c => `<button class="swatch-btn dot-${c}${c === group.color ? 'active' : ''}" data-color="${c}" title="${c}"></button>`).join("")}
    </div>
    <div class="tab-list"></div>
  `;

  const popover = box.querySelector(".color-popover");
  box.querySelector('[data-act="toggle-color"]').addEventListener("click", () => {
    popover.hidden = !popover.hidden;
  });

  popover.querySelectorAll(".swatch-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      await GroupController.updateActiveGroup(group.id, { color: btn.dataset.color });
    });
  });

  box.querySelector('[data-act="rename"]').addEventListener("click", async () => {
    const nextTitle = prompt("Nhập tên mới cho nhóm tab:", group.title || "");
    if (nextTitle !== null) {
      await GroupController.updateActiveGroup(group.id, { title: nextTitle });
    }
  });

  box.querySelector('[data-act="suspend"]').addEventListener("click", () => GroupController.suspendGroup(group.id));
  box.querySelector('[data-act="save"]').addEventListener("click", () => GroupController.saveGroup(group.id, false));
  box.querySelector('[data-act="share"]').addEventListener("click", async () => {
    const code = await ShareCodec.encodeActiveGroup(group.id);
    await navigator.clipboard.writeText(code);
    alert("Đã copy mã chia sẻ Base64 vào Clipboard.");
  });
  box.querySelector('[data-act="ungroup"]').addEventListener("click", () => GroupController.ungroup(group.id));
  box.querySelector('[data-act="delete"]').addEventListener("click", () => GroupController.deleteGroup(group.id));

  const tabList = box.querySelector(".tab-list");
  group.tabs.forEach(tab => tabList.appendChild(createTabDOM(tab, windowId, group.id)));

  setupDropzone(box, async (payload) => {
    if (payload.type !== "TAB") return;
    if (payload.windowId !== windowId) {
      await chrome.tabs.move(payload.tabId, { windowId, index: -1 });
    }
    await chrome.tabs.group({ groupId: group.id, tabIds: [payload.tabId] });
  });

  return box;
}

function createTabDOM(tab, windowId, groupId) {
  const row = document.createElement("div");
  row.className = `tab-item ${tab.discarded ? "discarded" : ""}`;
  row.draggable = true;

  row.innerHTML = `
    <div class="tab-info">
      <img src="${tab.favIconUrl || ""}" alt="">
      <span class="tab-title">${tab.title}</span>
    </div>
    <div class="actions">
      <button class="btn-text" data-act="focus">Open</button>
      <button class="btn-text" data-act="bm">Bookmark</button>
      <button class="btn-text" data-act="close">Close</button>
    </div>
  `;

  row.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    dragPayload = {
      type: "TAB",
      tabId: tab.id,
      windowId,
      groupId,
      index: tab.index,
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl || ""
    };
    row.classList.add("dragging");
  });

  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    dragPayload = null;
  });

  setupDropzone(row, async (payload) => {
    if (payload.type !== "TAB" || payload.tabId === tab.id) return;
    await chrome.tabs.move(payload.tabId, { windowId, index: tab.index });
    if (groupId !== -1) {
      await chrome.tabs.group({ groupId, tabIds: [payload.tabId] });
    } else {
      await chrome.tabs.ungroup([payload.tabId]);
    }
  });

  row.querySelector('[data-act="focus"]').addEventListener("click", async () => {
    await chrome.windows.update(windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  });
  row.querySelector('[data-act="bm"]').addEventListener("click", async () => {
    await StorageAPI.addBookmarkNode({
      parentId: currentFolderId,
      type: "bookmark",
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl
    });
  });
  row.querySelector('[data-act="close"]').addEventListener("click", () => chrome.tabs.remove(tab.id));

  return row;
}

function setupDropzone(element, onDropCallback) {
  element.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    element.classList.add("drag-over");
  });
  element.addEventListener("dragleave", (e) => {
    e.stopPropagation();
    element.classList.remove("drag-over");
  });
  element.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    element.classList.remove("drag-over");
    if (dragPayload) {
      await onDropCallback(dragPayload);
      dragPayload = null;
    }
  });
}