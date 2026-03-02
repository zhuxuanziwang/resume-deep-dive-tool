const state = {
  documentId: null,
  pages: [],
  qaItems: [],
  selectedQaId: null,
  selectedDocText: "",
};

const el = {
  pdfInput: document.getElementById("pdfInput"),
  uploadBtn: document.getElementById("uploadBtn"),
  generateBtn: document.getElementById("generateBtn"),
  createQaBtn: document.getElementById("createQaBtn"),
  selectionHint: document.getElementById("selectionHint"),
  docViewer: document.getElementById("docViewer"),
  qaList: document.getElementById("qaList"),
  followupList: document.getElementById("followupList"),
  qaCardTpl: document.getElementById("qaCardTpl"),
  followCardTpl: document.getElementById("followCardTpl"),
};

el.uploadBtn.addEventListener("click", uploadPdf);
el.generateBtn.addEventListener("click", generateQaByLlm);
el.createQaBtn.addEventListener("click", createQaFromSelection);
document.addEventListener("selectionchange", trackDocSelection);

async function uploadPdf() {
  const file = el.pdfInput.files?.[0];
  if (!file) {
    alert("请选择 PDF 文件");
    return;
  }
  const form = new FormData();
  form.append("file", file);

  const resp = await fetch("/api/upload-pdf", { method: "POST", body: form });
  if (!resp.ok) {
    alert(`上传失败: ${await resp.text()}`);
    return;
  }
  const data = await resp.json();
  state.documentId = data.document_id;
  state.pages = data.pages || [];
  state.qaItems = [];
  state.selectedQaId = null;
  state.selectedDocText = "";
  el.generateBtn.disabled = false;
  el.createQaBtn.disabled = true;
  el.selectionHint.textContent = "PDF 已解析，可执行 LLM 扫描，或手工选中文本创建 QA。";
  renderAll();
}

async function generateQaByLlm() {
  if (!state.documentId) return;
  const resp = await fetch("/api/generate-qa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document_id: state.documentId, max_items: 8 }),
  });
  if (!resp.ok) {
    alert(`生成失败: ${await resp.text()}`);
    return;
  }
  const data = await resp.json();
  state.qaItems = (data.qa_items || []).map((item) => ({ ...item, followups: [] }));
  state.selectedQaId = state.qaItems[0]?.id || null;
  renderAll();
}

function renderAll() {
  renderDocument();
  renderQaList();
  renderFollowups();
}

function renderDocument() {
  el.docViewer.innerHTML = "";
  if (!state.pages.length) return;

  state.pages.forEach((pageText, idx) => {
    const pageEl = document.createElement("section");
    pageEl.className = "page";
    pageEl.dataset.page = String(idx);

    const title = document.createElement("h3");
    title.textContent = `Page ${idx + 1}`;
    pageEl.appendChild(title);

    const p = document.createElement("p");
    p.className = "page-text";
    p.innerHTML = renderHighlightedText(pageText, idx);
    pageEl.appendChild(p);
    el.docViewer.appendChild(pageEl);
  });

  el.docViewer.querySelectorAll("mark[data-qa-id]").forEach((node) => {
    node.addEventListener("click", () => {
      const qaId = node.getAttribute("data-qa-id");
      if (!qaId) return;
      state.selectedQaId = qaId;
      renderQaList();
      renderFollowups();
    });
  });
}

function renderHighlightedText(text, pageIndex) {
  const ranges = [];
  state.qaItems.forEach((qa) => {
    const needles = [qa.quote, qa.keyword].filter(Boolean);
    for (const needle of needles) {
      const idx = indexOfInsensitive(text, needle);
      if (idx >= 0) {
        ranges.push({
          start: idx,
          end: idx + needle.length,
          qaId: qa.id,
          page: pageIndex,
        });
        break;
      }
    }
  });

  if (!ranges.length) return escapeHtml(text).replace(/\n/g, "<br/>");

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue;
    merged.push(r);
    cursor = r.end;
  }

  let out = "";
  let pos = 0;
  merged.forEach((r) => {
    out += escapeHtml(text.slice(pos, r.start));
    const body = escapeHtml(text.slice(r.start, r.end));
    const cls = r.qaId === state.selectedQaId ? "hl active" : "hl";
    out += `<mark class="${cls}" data-qa-id="${r.qaId}">${body}</mark>`;
    pos = r.end;
  });
  out += escapeHtml(text.slice(pos));
  return out.replace(/\n/g, "<br/>");
}

function renderQaList() {
  el.qaList.innerHTML = "";
  if (!state.qaItems.length) {
    el.qaList.innerHTML = `<p class="hint">暂无 QA。请先执行 LLM 扫描或手工创建。</p>`;
    return;
  }

  state.qaItems.forEach((qa) => {
    const frag = el.qaCardTpl.content.cloneNode(true);
    const card = frag.querySelector(".qa-card");
    const jumpBtn = frag.querySelector(".jump-btn");
    const keyword = frag.querySelector(".keyword");
    const quote = frag.querySelector(".quote");
    const question = frag.querySelector(".question");
    const answer = frag.querySelector(".answer");
    const genBtn = frag.querySelector(".gen-followup-btn");
    const manualBtn = frag.querySelector(".manual-followup-btn");
    const answerHl = frag.querySelector(".answer-highlight");

    keyword.textContent = qa.keyword || "Key Topic";
    quote.value = qa.quote || "";
    question.value = qa.question || "";
    answer.value = qa.answer || "";

    if (qa.id === state.selectedQaId) {
      card.classList.add("selected");
    }

    card.addEventListener("click", () => {
      state.selectedQaId = qa.id;
      renderDocument();
      renderQaList();
      renderFollowups();
    });

    jumpBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      state.selectedQaId = qa.id;
      renderDocument();
      renderQaList();
      renderFollowups();
      const marker = document.querySelector(`mark[data-qa-id="${qa.id}"]`);
      if (marker) marker.scrollIntoView({ behavior: "smooth", block: "center" });
    });

    quote.addEventListener("input", () => {
      qa.quote = quote.value;
      renderDocument();
    });
    question.addEventListener("input", () => {
      qa.question = question.value;
    });
    answer.addEventListener("input", () => {
      qa.answer = answer.value;
      renderAnswerAnchors(qa, answerHl);
    });

    genBtn.addEventListener("click", async (evt) => {
      evt.stopPropagation();
      await generateFollowupsByLlm(qa);
    });

    manualBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const start = answer.selectionStart;
      const end = answer.selectionEnd;
      if (start === end) {
        alert("先在回答文本中选中一段内容，再创建追问。");
        return;
      }
      const anchor = answer.value.slice(start, end).trim();
      if (!anchor) return;
      qa.followups = qa.followups || [];
      qa.followups.push({
        id: crypto.randomUUID(),
        anchor,
        question: `你在回答里提到 "${anchor}"，具体是怎么实现的？`,
        answer: "",
      });
      state.selectedQaId = qa.id;
      renderQaList();
      renderFollowups();
    });

    renderAnswerAnchors(qa, answerHl);
    el.qaList.appendChild(frag);
  });
}

function renderAnswerAnchors(qa, container) {
  const followups = qa.followups || [];
  const anchors = followups.map((f) => f.anchor).filter(Boolean);
  if (!qa.answer || !anchors.length) {
    container.innerHTML = "";
    return;
  }
  let html = escapeHtml(qa.answer);
  anchors.forEach((anchor) => {
    const re = new RegExp(escapeRegExp(anchor), "g");
    html = html.replace(re, `<mark class="answer-anchor">${escapeHtml(anchor)}</mark>`);
  });
  container.innerHTML = `<div class="answer-preview">${html}</div>`;
}

function renderFollowups() {
  el.followupList.innerHTML = "";
  const qa = state.qaItems.find((item) => item.id === state.selectedQaId);
  if (!qa) {
    el.followupList.innerHTML = `<p class="hint">选中一个 QA 后显示追问。</p>`;
    return;
  }
  qa.followups = qa.followups || [];
  if (!qa.followups.length) {
    el.followupList.innerHTML = `<p class="hint">当前 QA 暂无追问。可用 LLM 生成，或在回答里手工选中创建。</p>`;
    return;
  }

  qa.followups.forEach((f) => {
    const frag = el.followCardTpl.content.cloneNode(true);
    const card = frag.querySelector(".follow-card");
    const anchor = frag.querySelector(".anchor");
    const question = frag.querySelector(".question");
    const answer = frag.querySelector(".answer");

    anchor.value = f.anchor || "";
    question.value = f.question || "";
    answer.value = f.answer || "";

    anchor.addEventListener("input", () => {
      f.anchor = anchor.value;
      renderQaList();
    });
    question.addEventListener("input", () => {
      f.question = question.value;
    });
    answer.addEventListener("input", () => {
      f.answer = answer.value;
    });

    el.followupList.appendChild(card);
  });
}

async function generateFollowupsByLlm(qa) {
  const resp = await fetch("/api/generate-followups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: qa.question || "",
      answer: qa.answer || "",
      max_items: 5,
    }),
  });
  if (!resp.ok) {
    alert(`追问生成失败: ${await resp.text()}`);
    return;
  }
  const data = await resp.json();
  qa.followups = (data.followups || []).map((x) => ({ ...x }));
  state.selectedQaId = qa.id;
  renderQaList();
  renderFollowups();
}

function trackDocSelection() {
  const sel = window.getSelection();
  if (!sel || !sel.toString()) {
    state.selectedDocText = "";
    el.createQaBtn.disabled = true;
    return;
  }
  const text = sel.toString().trim();
  if (!text) {
    state.selectedDocText = "";
    el.createQaBtn.disabled = true;
    return;
  }
  const anchorNode = sel.anchorNode;
  if (!anchorNode) return;
  const inDoc = el.docViewer.contains(anchorNode.nodeType === 3 ? anchorNode.parentElement : anchorNode);
  if (!inDoc) {
    state.selectedDocText = "";
    el.createQaBtn.disabled = true;
    return;
  }
  state.selectedDocText = text.slice(0, 500);
  el.createQaBtn.disabled = false;
  el.selectionHint.textContent = `已选中: "${state.selectedDocText.slice(0, 80)}"`;
}

function createQaFromSelection() {
  if (!state.selectedDocText) return;
  const snippet = state.selectedDocText;
  const keyword = snippet.split(/\s+/)[0].slice(0, 30) || "Selected Topic";
  const qa = {
    id: crypto.randomUUID(),
    keyword,
    quote: snippet,
    question: `你在这里提到 "${keyword}"，能讲讲具体技术细节吗？`,
    answer: "",
    followups: [],
  };
  state.qaItems.unshift(qa);
  state.selectedQaId = qa.id;
  el.createQaBtn.disabled = true;
  state.selectedDocText = "";
  el.selectionHint.textContent = "已创建 QA。可继续编辑或生成追问。";
  renderAll();
}

function indexOfInsensitive(haystack, needle) {
  if (!needle) return -1;
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

function escapeHtml(str) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
