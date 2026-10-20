import { StorageAPI } from "../core/storage.js";
import { GroupController, GROUP_COLORS } from "../background/group-controller.js";

let currentSpFolderId = "root";

document.addEventListener("DOMContentLoaded", async () => {
  await StorageAPI.init();
  setupTabs();
  setupHeaderAndExplorerActions();
  await renderAll();

  chrome.storage.onChanged.addListener(renderAll);
  chrome.tabGroups.onUpdated.addListener(renderAll);
  chrome.tabGroups.onCreated.addListener(renderAll);
  chrome.tabGroups.onRemoved.addListener(renderAll);
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

function setupHeaderAndExplorerActions() {
  document.getElementById("btn-open-dashboard").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  });

  // Lưu nhanh tab đang mở vào đúng thư mục đang duyệt trên Aside
  document.getElementById("btn-bookmark-active").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    await StorageAPI.addBookmarkNode({
      parentId: currentSpFolderId,
      type: "bookmark",
      title: tab.title,
      url: tab.url,
      favIconUrl: tab.favIconUrl
    });
  });

  // Nút Up lùi về thư mục cha
  document.getElementById("btn-sp-up").addEventListener("click", async () => {
    const { bookmarkNodes } = await StorageAPI.getAllData();
    const curr = bookmarkNodes[currentSpFolderId];
    if (curr && curr.parentId) {
      currentSpFolderId = curr.parentId;
      renderBookmarkExplorer(bookmarkNodes);
    }
  });

  // Tạo thư mục con ngay trong thư mục hiện tại
  document.getElementById("btn-new-folder").addEventListener("click", async () => {
    const title = prompt("Tên thư mục mới:");
    if (title) {
      await StorageAPI.addBookmarkNode({
        parentId: currentSpFolderId,
        type: "folder",
        title: title.trim()
      });
    }
  });
}

async function renderAll() {
  const { settings = {}, savedGroups = {}, bookmarkNodes = {} } = await StorageAPI.getAllData();
  document.documentElement.setAttribute("data-theme", settings.theme || "dark");

  await renderActiveGroups();
  renderSavedGroups(savedGroups);
  renderBookmarkExplorer(bookmarkNodes);
}

// 1. RENDER NHÓM ĐANG MỞ (Hỗ trợ Đổi tên + Đổi màu trực tiếp)
async function renderActiveGroups() {
  const container = document.getElementById("active-groups");
  const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
  container.innerHTML = groups.length ? "" : `<div class="empty-hint">No active tab groups in this window.</div>`;

  for (const g of groups) {
    const tabs = await chrome.tabs.query({ groupId: g.id });
    const card = document.createElement("div");
    card.className = "card";

    card.innerHTML = `
      <div class="card-header">
        <div class="group-title-wrap">
          <button class="color-dot dot-${g.color || 'grey'}" data-act="toggle-color" title="Đổi màu nhóm"></button>
          <span class="group-name">${g.title || "Untitled"}</span>
          <span class="group-count">(${tabs.length})</span>
        </div>
        <div class="actions">
          <button class="btn-text" data-act="rename">Rename</button>
          <button class="btn-text" data-act="suspend">Suspend</button>
          <button class="btn-text" data-act="save">Save</button>
        </div>
      </div>
      <div class="color-popover" hidden>
        ${GROUP_COLORS.map(c => `<button class="swatch-btn dot-${c}${c === g.color ? 'active' : ''}" data-color="${c}" title="${c}"></button>`).join("")}
      </div>
    `;

    // Bật/tắt thanh chọn màu
    const popover = card.querySelector(".color-popover");
    card.querySelector('[data-act="toggle-color"]').addEventListener("click", () => {
      popover.hidden = !popover.hidden;
    });

    // Chọn màu mới
    popover.querySelectorAll(".swatch-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        await GroupController.updateActiveGroup(g.id, { color: btn.dataset.color });
      });
    });

    // Đổi tên nhóm
    card.querySelector('[data-act="rename"]').addEventListener("click", async () => {
      const nextTitle = prompt("Đổi tên nhóm:", g.title || "");
      if (nextTitle !== null) {
        await GroupController.updateActiveGroup(g.id, { title: nextTitle });
      }
    });

    card.querySelector('[data-act="suspend"]').addEventListener("click", () => GroupController.suspendGroup(g.id));
    card.querySelector('[data-act="save"]').addEventListener("click", () => GroupController.saveGroup(g.id, true));

    container.appendChild(card);
  }
}

// 2. RENDER NHÓM ĐÃ LƯU (Hỗ trợ Đổi tên + Đổi màu trực tiếp)
function renderSavedGroups(savedGroups) {
  const container = document.getElementById("saved-groups");
  const list = Object.values(savedGroups);
  container.innerHTML = list.length ? "" : `<div class="empty-hint">No saved tab groups.</div>`;

  list.forEach(g => {
    const card = document.createElement("div");
    card.className = "card";

    card.innerHTML = `
      <div class="card-header">
        <div class="group-title-wrap">
          <button class="color-dot dot-${g.color || 'grey'}" data-act="toggle-color" title="Đổi màu nhóm"></button>
          <span class="group-name">${g.title}</span>
          <span class="group-count">(${g.tabs.length})</span>
        </div>
        <div class="actions">
          <button class="btn-text" data-act="restore">Open</button>
          <button class="btn-text" data-act="rename">Rename</button>
          <button class="btn-text" data-act="delete">Delete</button>
        </div>
      </div>
      <div class="color-popover" hidden>
        ${GROUP_COLORS.map(c => `<button class="swatch-btn dot-${c}${c === g.color ? 'active' : ''}" data-color="${c}" title="${c}"></button>`).join("")}
      </div>
    `;

    const popover = card.querySelector(".color-popover");
    card.querySelector('[data-act="toggle-color"]').addEventListener("click", () => {
      popover.hidden = !popover.hidden;
    });

    popover.querySelectorAll(".swatch-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        await StorageAPI.updateSavedGroup(g.id, { color: btn.dataset.color });
      });
    });

    card.querySelector('[data-act="rename"]').addEventListener("click", async () => {
      const nextTitle = prompt("Đổi tên nhóm đã lưu:", g.title);
      if (nextTitle) {
        await StorageAPI.updateSavedGroup(g.id, { title: nextTitle });
      }
    });

    card.querySelector('[data-act="restore"]').addEventListener("click", () => GroupController.restoreGroup(g.id));
    card.querySelector('[data-act="delete"]').addEventListener("click", () => StorageAPI.deleteSavedGroup(g.id));

    container.appendChild(card);
  });
}

// 3. RENDER BOOKMARK FOLDER EXPLORER TRÊN ASIDE (Không hiển thị trải dài)
function renderBookmarkExplorer(nodes) {
  if (!nodes[currentSpFolderId]) currentSpFolderId = "root";
  const currentFolder = nodes[currentSpFolderId];

  document.getElementById("btn-sp-up").disabled = currentSpFolderId === "root";

  // Render Breadcrumbs gọn nhẹ
  const bc = document.getElementById("sp-breadcrumbs");
  bc.innerHTML = "";
  const path = [];
  let cur = currentFolder;
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? nodes[cur.parentId] : null;
  }

  path.forEach((folder, idx) => {
    if (idx > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "/";
      bc.appendChild(sep);
    }
    const btn = document.createElement("button");
    btn.className = `crumb-link ${folder.id === currentSpFolderId ? "active" : ""}`;
    btn.textContent = folder.id === "root" ? "Root" : folder.title;
    btn.addEventListener("click", () => {
      currentSpFolderId = folder.id;
      renderBookmarkExplorer(nodes);
    });
    bc.appendChild(btn);
  });

  // Render các mục bên trong thư mục hiện tại
  const listEl = document.getElementById("sp-bookmark-list");
  listEl.innerHTML = "";

  const children = (currentFolder.childrenIds || [])
    .map(id => nodes[id])
    .filter(Boolean)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.title.localeCompare(b.title);
    });

  if (children.length === 0) {
    listEl.innerHTML = `<div class="empty-hint">Empty folder</div>`;
    return;
  }

  children.forEach(item => {
    const row = document.createElement("div");
    row.className = "sp-row";
    row.dataset.type = item.type;

    row.innerHTML = `
      <div class="sp-row-main">
        
        ${item.type === "folder" ? `
          <svg width="18px" height="18px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 8.2C3 7.07989 3 6.51984 3.21799 6.09202C3.40973 5.71569 3.71569 5.40973 4.09202 5.21799C4.51984 5 5.0799 5 6.2 5H9.67452C10.1637 5 10.4083 5 10.6385 5.05526C10.8425 5.10425 11.0376 5.18506 11.2166 5.29472C11.4184 5.4184 11.5914 5.59135 11.9373 5.93726L12.0627 6.06274C12.4086 6.40865 12.5816 6.5816 12.7834 6.70528C12.9624 6.81494 13.1575 6.89575 13.3615 6.94474C13.5917 7 13.8363 7 14.3255 7H17.8C18.9201 7 19.4802 7 19.908 7.21799C20.2843 7.40973 20.5903 7.71569 20.782 8.09202C21 8.51984 21 9.0799 21 10.2V15.8C21 16.9201 21 17.4802 20.782 17.908C20.5903 18.2843 20.2843 18.5903 19.908 18.782C19.4802 19 18.9201 19 17.8 19H6.2C5.07989 19 4.51984 19 4.09202 18.782C3.71569 18.5903 3.40973 18.2843 3.21799 17.908C3 17.4802 3 16.9201 3 15.8V8.2Z" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>` 
          : 
          item.favIconUrl != ""?
          `<img class="type-tag-img" src="${item.favIconUrl}"></img>`
          :
          '<span class="type-tag">URL</span>'
        }

        <span class="sp-title">${item.title}</span>
      </div>
      <div class="actions">
        <button class="btn-text" data-act="rename">Rename</button>
        <button class="btn-text" data-act="del">Delete</button>
      </div>
    `;

    // Click vào dòng: Nếu là Thư mục thì mở vào trong, nếu là Bookmark thì mở tab
    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (item.type === "folder") {
        currentSpFolderId = item.id;
        renderBookmarkExplorer(nodes);
      } else if (item.url) {
        chrome.tabs.create({ url: item.url });
      }
    });

    row.querySelector('[data-act="rename"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      const nextTitle = prompt("Đổi tên:", item.title);
      if (nextTitle) await StorageAPI.renameBookmarkNode(item.id, nextTitle);
    });

    row.querySelector('[data-act="del"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      await StorageAPI.deleteBookmarkNode(item.id);
    });

    listEl.appendChild(row);
  });
}