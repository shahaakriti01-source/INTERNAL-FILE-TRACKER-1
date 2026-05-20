const els = {
  scopeName: document.getElementById("scopeName"),
  rootPath: document.getElementById("rootPath"),
  scanButton: document.getElementById("scanButton"),
  rootButton: document.getElementById("rootButton"),
  exactMode: document.getElementById("exactMode"),
  relatedMode: document.getElementById("relatedMode"),
  semanticMode: document.getElementById("semanticMode"),
  typeFilters: document.getElementById("typeFilters"),
  searchForm: document.getElementById("searchForm"),
  queryInput: document.getElementById("queryInput"),
  scanLine: document.getElementById("scanLine"),
  indexedMetric: document.getElementById("indexedMetric"),
  scannedMetric: document.getElementById("scannedMetric"),
  resultMetric: document.getElementById("resultMetric"),
  snippetMetric: document.getElementById("snippetMetric"),
  activityText: document.getElementById("activityText"),
  typeBreakdown: document.getElementById("typeBreakdown"),
  notice: document.getElementById("notice"),
  results: document.getElementById("results")
};

let lastQuery = "";
let lastStatus = null;
let supportedTypes = [];

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function post(url, body = {}) {
  return api(url, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

async function init() {
  bindEvents();
  renderEmpty("The scan starts automatically. Search results will appear here.");
  await refreshStatus();
  setInterval(refreshStatus, 1600);
}

function bindEvents() {
  els.searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runSearch();
  });

  document.querySelectorAll("[data-example]").forEach((button) => {
    button.addEventListener("click", async () => {
      els.queryInput.value = button.dataset.example || "";
      await runSearch();
    });
  });

  els.scanButton.addEventListener("click", async () => {
    await post("/api/scan");
    showNotice("Refresh scan started.");
    await refreshStatus();
  });

  els.rootButton.addEventListener("click", async () => {
    await api("/api/root");
    showNotice("Opening the search root folder.");
  });

  for (const input of [els.exactMode, els.relatedMode, els.semanticMode]) {
    input.addEventListener("change", () => {
      if (lastQuery) runSearch(false);
    });
  }
}

async function refreshStatus() {
  try {
    const status = await api("/api/status");
    renderStatus(status);
    if (!supportedTypes.length && status.supportedTypes?.length) renderTypeFilters(status.supportedTypes);
    if (lastStatus?.scanning && !status.scanning && lastQuery) await runSearch(false);
    lastStatus = status;
  } catch (error) {
    showNotice(error.message, "error");
  }
}

function renderStatus(status) {
  const root = status.rootPath || "";
  els.rootPath.textContent = root;
  els.scopeName.textContent = folderName(root) || "Internal file scope";
  els.indexedMetric.textContent = formatNumber(status.indexedFiles || 0);
  els.scannedMetric.textContent = formatNumber(status.scannedFiles || status.totalFiles || 0);

  if (status.scanning) {
    els.scanLine.textContent = `Scanning ${formatNumber(status.scannedFiles)} supported files. Search works while the scan continues.`;
    els.activityText.textContent = compactPath(status.currentFile || status.currentFolder || root);
  } else {
    els.scanLine.textContent = status.lastScanFinished
      ? `Last scan finished ${formatDate(status.lastScanFinished)}.`
      : "Waiting for the first scan to finish.";
    els.activityText.textContent = status.indexedFiles
      ? `${formatNumber(status.indexedFiles)} readable files are ready to search.`
      : "No readable files indexed yet.";
  }

  renderTypeBreakdown(status.typeCounts || {});
  if (status.errors?.length && !status.scanning && !lastQuery) {
    showNotice(`${status.errors.length} files could not be read. Most are protected, very large, or sync placeholders.`, "warn");
  }
}

function renderTypeFilters(types) {
  supportedTypes = types;
  els.typeFilters.innerHTML = "";
  for (const type of types) {
    const label = document.createElement("label");
    label.className = "type-filter";
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(type)}"> ${escapeHtml(type)}`;
    label.querySelector("input").addEventListener("change", () => {
      if (lastQuery) runSearch(false);
    });
    els.typeFilters.appendChild(label);
  }
}

function renderTypeBreakdown(typeCounts) {
  const entries = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  els.typeBreakdown.innerHTML = entries.map(([type, count]) =>
    `<span class="type-pill">${escapeHtml(type)} ${formatNumber(count)}</span>`
  ).join("");
}

async function runSearch(showBusy = true) {
  const query = els.queryInput.value.trim();
  lastQuery = query;
  if (!query) {
    els.resultMetric.textContent = "0";
    els.snippetMetric.textContent = "0";
    renderEmpty("Type a keyword or phrase to search internal files.");
    return;
  }

  if (showBusy) {
    showNotice("Searching indexed files...");
    els.results.innerHTML = "";
  }

  try {
    const result = await post("/api/search", {
      query,
      exact: els.exactMode.checked,
      related: els.relatedMode.checked,
      semantic: els.semanticMode.checked,
      fileTypes: selectedFileTypes()
    });
    els.resultMetric.textContent = formatNumber(result.totalFiles || 0);
    els.snippetMetric.textContent = formatNumber(result.totalSnippets || 0);
    renderResults(result.results || []);
    showNotice(result.totalFiles
      ? `${formatNumber(result.totalFiles)} matching files found.`
      : "No matches in the files indexed so far.");
  } catch (error) {
    showNotice(error.message, "error");
  }
}

function selectedFileTypes() {
  return Array.from(els.typeFilters.querySelectorAll("input:checked")).map((input) => input.value);
}

function renderResults(results) {
  els.results.innerHTML = "";
  if (!results.length) {
    renderEmpty(lastQuery ? "No indexed files matched this search." : "Type a search term to begin.");
    return;
  }

  for (const file of results) {
    const card = document.createElement("article");
    card.className = "result-card";
    card.innerHTML = `
      <div class="result-top">
        <div>
          <div class="file-name">${escapeHtml(file.fileName)}</div>
          <div class="file-meta">
            <span class="badge ${badgeClass(file.matchType)}">${escapeHtml(file.matchType)}</span>
            <span class="badge neutral">${escapeHtml(file.extension)}</span>
            <span class="badge neutral">${escapeHtml(file.folder)}</span>
            <span class="badge neutral">${escapeHtml(file.category)}</span>
            <span class="badge neutral">${formatNumber(file.snippets.length)} snippets</span>
          </div>
        </div>
        <div class="file-actions">
          <button class="file-button" type="button" data-open="${encodeURIComponent(file.id)}">Open file</button>
          <button class="file-button" type="button" data-folder="${encodeURIComponent(file.id)}">Show folder</button>
          <button class="file-button" type="button" data-copy="${encodeURIComponent(file.id)}">Copy path</button>
          <a class="file-button" href="/api/download?id=${encodeURIComponent(file.id)}">Download</a>
        </div>
      </div>
      <div class="path-line">${escapeHtml(file.path)}</div>
      <div class="snippet-list"></div>
    `;

    card.querySelector("[data-open]").addEventListener("click", async () => {
      try {
        await api(`/api/open?id=${encodeURIComponent(file.id)}`);
        showNotice(`Opening ${file.fileName}. If it does not appear, use Show folder and double-click it.`);
      } catch (error) {
        showNotice(error.message, "error");
      }
    });
    card.querySelector("[data-folder]").addEventListener("click", async () => {
      try {
        await api(`/api/reveal?id=${encodeURIComponent(file.id)}`);
        showNotice(`Showing ${file.fileName} in its folder.`);
      } catch (error) {
        showNotice(error.message, "error");
      }
    });
    card.querySelector("[data-copy]").addEventListener("click", async () => {
      try {
        await api(`/api/copy-path?id=${encodeURIComponent(file.id)}`);
        showNotice(`Copied file path. Paste it into File Explorer if Open file is blocked.`);
      } catch (error) {
        showNotice(error.message, "error");
      }
    });

    const snippetList = card.querySelector(".snippet-list");
    for (const snippet of file.snippets) {
      const item = document.createElement("div");
      item.className = "snippet";
      item.innerHTML = `
        <div class="snippet-head">
          <span class="badge ${badgeClass(snippet.matchType)}">${escapeHtml(snippet.matchType)}</span>
          <span class="snippet-location">${escapeHtml(snippet.location)}</span>
          <span class="snippet-term">${escapeHtml(snippet.term || "")}</span>
        </div>
        <div class="snippet-text">${escapeHtml(snippet.text)}</div>
      `;
      snippetList.appendChild(item);
    }
    els.results.appendChild(card);
  }
}

function renderEmpty(message) {
  els.results.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function badgeClass(matchType) {
  const value = String(matchType || "").toLowerCase();
  if (value.includes("exact")) return "exact";
  if (value.includes("related")) return "related";
  if (value.includes("concept")) return "concept";
  return "neutral";
}

function showNotice(message, tone = "") {
  els.notice.className = `notice ${tone}`;
  els.notice.textContent = message || "";
}

function folderName(folderPath) {
  const parts = String(folderPath || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || folderPath;
}

function compactPath(value) {
  const text = String(value || "");
  if (text.length <= 100) return text;
  return `${text.slice(0, 42)}...${text.slice(-48)}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

init();
