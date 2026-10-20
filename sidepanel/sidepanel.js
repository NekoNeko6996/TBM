import { StorageAPI } from "../core/storage.js";
import { GroupController } from "../background/group-controller.js";

document.addEventListener("DOMContentLoaded", async () => {
  await StorageAPI.init();
  setupTabs();
  setupHeaderActions();
  await renderAll();

  chrome.storage.onChanged.addListener(renderAll);
  chrome.tabGroups.onUpdated.addListener(renderAll);
  chrome.tabs.onRemoved.addListener(renderAll);
});

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn, .tab-pane").forEach(el => el.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    });
  });
}

function setupHeaderActions() {
  // Mở trang Quản trị nâng cao
  document.getElementById("btn-open-dashboard").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  });

  // Lưu nhanh tab đang mở vào thư mục Bookmark đang chọn
  document.getElementById("btn-bookmark-active").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const parentId = document.getElementById("sp-folder-select").value || "root";
    await StorageAPI.addBookmarkNode({
      parentId,
      type: "bookmark",
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl
    });
  });

  // Tạo thư mục mới
  document.getElementById("btn-new-folder").addEventListener("click", async () => {
    const title = prompt("Nhập tên thư mục mới:");
    if (!title) return;
    const parentId = document.getElementById("sp-folder-select").value || "root";
    await StorageAPI.addBookmarkNode({ parentId, type: "folder", title });
  });
}

async function renderAll() {
  const { savedGroups = {}, bookmarkNodes = {} } = await StorageAPI.getAllData();
  await renderActiveGroups();
  renderSavedGroups(savedGroups);
  renderBookmarks(bookmarkNodes);
}

async function renderActiveGroups() {
  const container = document.getElementById("active-groups");
  const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  container.innerHTML = groups.length ? "" : "<p>Không có nhóm tab nào trong cửa sổ này.</p>";

  for (const g of groups) {
    const tabs = await chrome.tabs.query({ groupId: g.id });
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-header">
        <span class="badge">${g.title || "Untitled"} (${tabs.length})</span>
        <div class="actions">
          <button data-act="suspend" title="Giải phóng RAM">💤</button>
          <button data-act="save" title="Lưu và đóng nhóm">💾</button>
        </div>
      </div>
    `;
    card.querySelector('[data-act="suspend"]').addEventListener("click", () => GroupController.suspendGroup(g.id));
    card.querySelector('[data-act="save"]').addEventListener("click", () => GroupController.saveGroup(g.id, true));
    container.appendChild(card);
  }
}

function renderSavedGroups(savedGroups) {
  const container = document.getElementById("saved-groups");
  const list = Object.values(savedGroups);
  container.innerHTML = list.length ? "" : "<p>Chưa có nhóm tab nào được lưu.</p>";

  list.forEach(g => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-header">
        <span class="badge">${g.title} (${g.tabs.length} tabs)</span>
        <div class="actions">
          <button data-act="restore" title="Mở lại nhóm">📂 Mở</button>
          <button data-act="delete" title="Xóa bản lưu">🗑️</button>
        </div>
      </div>
    `;
    card.querySelector('[data-act="restore"]').addEventListener("click", () => GroupController.restoreGroup(g.id));
    card.querySelector('[data-act="delete"]').addEventListener("click", () => StorageAPI.deleteSavedGroup(g.id));
    container.appendChild(card);
  });
}

function renderBookmarks(nodes) {
  const select = document.getElementById("sp-folder-select");
  const currentVal = select.value || "root";
  select.innerHTML = "";

  Object.values(nodes).filter(n => n.type === "folder").forEach(f => {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.title;
    select.appendChild(opt);
  });
  if (nodes[currentVal]) select.value = currentVal;

  const treeContainer = document.getElementById("sp-bookmark-tree");
  treeContainer.innerHTML = "";
  if (nodes.root) {
    treeContainer.appendChild(buildBookmarkDOM("root", nodes));
  }
}

function buildBookmarkDOM(nodeId, nodes) {
  const node = nodes[nodeId];
  const wrapper = document.createElement("div");
  wrapper.className = "bm-node";

  if (nodeId !== "root") {
    const row = document.createElement("div");
    row.className = "bm-item";
    if (node.type === "folder") {
      row.innerHTML = `<strong>📁 ${node.title}</strong> <button class="del-btn">×</button>`;
    } else {
      row.innerHTML = `<a href="${node.url}" target="_blank" class="bm-link">🔗 ${node.title}</a> <button class="del-btn">×</button>`;
    }
    row.querySelector(".del-btn").addEventListener("click", () => StorageAPI.deleteBookmarkNode(node.id));
    wrapper.appendChild(row);
  }

  if (node.type === "folder" && node.childrenIds) {
    node.childrenIds.forEach(childId => {
      if (nodes[childId]) wrapper.appendChild(buildBookmarkDOM(childId, nodes));
    });
  }
  return wrapper;
}