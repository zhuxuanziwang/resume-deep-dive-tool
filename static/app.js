const state = {
  documentId: null,
  pages: [],
  blocks: [],
  qaItems: [],
  selectedQaId: null,
  selectedBlockId: null,
  selectedDocText: "",
};

const el = {
  pdfInput: document.getElementById("pdfInput"),
  uploadBtn: document.getElementById("uploadBtn"),
  parseBtn: document.getElementById("parseBtn"),
  generateBtn: document.getElementById("generateBtn"),
  createQaBtn: document.getElementById("createQaBtn"),
  addFollowupSetBtn: document.getElementById("addFollowupSetBtn"),
  selectionHint: document.getElementById("selectionHint"),
  docViewer: document.getElementById("docViewer"),
  qaList: document.getElementById("qaList"),
  followupList: document.getElementById("followupList"),
  qaCardTpl: document.getElementById("qaCardTpl"),
  followCardTpl: document.getElementById("followCardTpl"),
};

el.uploadBtn.addEventListener("click", uploadPdf);
el.parseBtn.addEventListener("click", () => parseResumeBlocks(false));
el.generateBtn.addEventListener("click", generateQaByLlm);
el.createQaBtn.addEventListener("click", createQaFromSelection);
el.addFollowupSetBtn.addEventListener("click", addEmptyFollowupSetToSelectedQa);
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
  state.blocks = [];
  state.qaItems = [];
  state.selectedQaId = null;
  state.selectedBlockId = null;
  state.selectedDocText = "";

  el.parseBtn.disabled = false;
  el.generateBtn.disabled = true;
  el.createQaBtn.disabled = true;
  el.addFollowupSetBtn.disabled = true;
  el.selectionHint.textContent = "PDF 已上传，正在调用 LLM 结构化解析经历...";
  renderAll();

  await parseResumeBlocks(true);
}

async function parseResumeBlocks(isAuto) {
  if (!state.documentId) return;
  const resp = await fetch("/api/parse-resume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document_id: state.documentId }),
  });
  if (!resp.ok) {
    if (!isAuto) alert(`解析失败: ${await resp.text()}`);
    return;
  }

  const data = await resp.json();
  state.blocks = data.blocks || [];
  state.selectedBlockId = state.blocks[0]?.id || null;
  el.generateBtn.disabled = false;
  const modeText = data.parse_mode === "llm" ? "LLM API" : "fallback";
  el.selectionHint.textContent = state.blocks.length
    ? `已按经历分块（${modeText}），可选中块后生成 QA，或手工选中文本建 QA。`
    : `解析完成（${modeText}），但未识别到经历块，可直接手工选中创建 QA。`;
  renderAll();
}

async function generateQaByLlm() {
  if (!state.documentId) return;
  const resp = await fetch("/api/generate-qa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      document_id: state.documentId,
      block_id: state.selectedBlockId,
      max_items: 8,
    }),
  });
  if (!resp.ok) {
    alert(`生成失败: ${await resp.text()}`);
    return;
  }
  const data = await resp.json();
  const incoming = (data.qa_items || []).map((item) => ({
    ...item,
    followup_sets: item.followup_sets || [],
  }));
  if (state.selectedBlockId) {
    state.qaItems = state.qaItems.filter((q) => q.block_id !== state.selectedBlockId);
    state.qaItems = [...incoming, ...state.qaItems];
  } else {
    state.qaItems = incoming;
  }
  state.selectedQaId = incoming[0]?.id || state.selectedQaId;
  el.addFollowupSetBtn.disabled = !state.selectedQaId;
  renderAll();
}

function renderAll() {
  renderDocument();
  renderQaList();
  renderFollowups();
}

function renderDocument() {
  el.docViewer.innerHTML = "";
  if (state.blocks.length) {
    state.blocks.forEach((block) => {
      const card = document.createElement("article");
      card.className = "exp-block";
      if (block.id === state.selectedBlockId) card.classList.add("selected");
      card.dataset.blockId = block.id;

      const header = document.createElement("div");
      header.className = "exp-header";
      header.innerHTML = `
        <h3>${escapeHtml(block.title || "Experience")}</h3>
        <div class="exp-meta">
          <span>${escapeHtml(block.organization || "")}</span>
          <span>${escapeHtml(block.role || "")}</span>
          <span>${escapeHtml(block.period || "")}</span>
          <span>${escapeHtml(block.location || "")}</span>
        </div>
      `;
      card.appendChild(header);

      const content = document.createElement("p");
      content.className = "exp-content";
      content.innerHTML = renderHighlightedText(block.content || "", block.id);
      card.appendChild(content);

      const bullets = block.bullets || [];
      if (bullets.length) {
        const ul = document.createElement("ul");
        ul.className = "exp-bullets";
        bullets.forEach((b) => {
          const li = document.createElement("li");
          li.innerHTML = renderHighlightedText(b, block.id);
          ul.appendChild(li);
        });
        card.appendChild(ul);
      }

      card.addEventListener("click", () => {
        state.selectedBlockId = block.id;
        renderDocument();
      });
      el.docViewer.appendChild(card);
    });
  } else if (state.pages.length) {
    state.pages.forEach((pageText, idx) => {
      const pageEl = document.createElement("section");
      pageEl.className = "page";
      const title = document.createElement("h3");
      title.textContent = `Page ${idx + 1}`;
      pageEl.appendChild(title);
      const p = document.createElement("p");
      p.className = "page-text";
      p.innerHTML = renderHighlightedText(pageText, null);
      pageEl.appendChild(p);
      el.docViewer.appendChild(pageEl);
    });
  }

  el.docViewer.querySelectorAll("mark[data-qa-id]").forEach((node) => {
    node.addEventListener("click", () => {
      const qaId = node.getAttribute("data-qa-id");
      if (!qaId) return;
      state.selectedQaId = qaId;
      const qa = state.qaItems.find((item) => item.id === qaId);
      if (qa?.block_id) state.selectedBlockId = qa.block_id;
      renderAll();
    });
  });
}

function renderHighlightedText(text, blockId) {
  if (!text) return "";
  const ranges = [];
  const scoped = state.qaItems.filter((qa) => !qa.block_id || qa.block_id === blockId);
  scoped.forEach((qa) => {
    const needles = [qa.quote, qa.keyword].filter(Boolean);
    for (const needle of needles) {
      const idx = indexOfInsensitive(text, needle);
      if (idx >= 0) {
        ranges.push({ start: idx, end: idx + needle.length, qaId: qa.id });
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
    el.qaList.innerHTML = `<p class="hint">暂无 QA。选中经历块后点“生成 QA”或手工创建。</p>`;
    return;
  }

  state.qaItems.forEach((qa) => {
    const frag = el.qaCardTpl.content.cloneNode(true);
    const card = frag.querySelector(".qa-card");
    const jumpBtn = frag.querySelector(".jump-btn");
    const keyword = frag.querySelector(".keyword");
    const blockTag = frag.querySelector(".qa-block-tag");
    const quote = frag.querySelector(".quote");
    const question = frag.querySelector(".question");
    const answer = frag.querySelector(".answer");
    const genBtn = frag.querySelector(".gen-followup-btn");
    const manualBtn = frag.querySelector(".manual-followup-btn");
    const answerHl = frag.querySelector(".answer-highlight");

    keyword.textContent = qa.keyword || "Key Topic";
    blockTag.textContent = qa.block_title ? `来源: ${qa.block_title}` : "来源: 全文";
    quote.value = qa.quote || "";
    question.value = qa.question || "";
    answer.value = qa.answer || "";

    if (qa.id === state.selectedQaId) card.classList.add("selected");

    card.addEventListener("click", () => {
      state.selectedQaId = qa.id;
      if (qa.block_id) state.selectedBlockId = qa.block_id;
      el.addFollowupSetBtn.disabled = false;
      renderAll();
    });

    jumpBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      state.selectedQaId = qa.id;
      if (qa.block_id) state.selectedBlockId = qa.block_id;
      renderAll();
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
      await addFollowupSetByLlm(qa, qa.question || "", qa.answer || "");
    });

    manualBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const start = answer.selectionStart;
      const end = answer.selectionEnd;
      if (start === end) {
        alert("先在回答中选中一段文字。");
        return;
      }
      const anchor = answer.value.slice(start, end).trim();
      if (!anchor) return;
      qa.followup_sets = qa.followup_sets || [];
      qa.followup_sets.push({
        id: crypto.randomUUID(),
        title: `Deep Dive ${qa.followup_sets.length + 1}`,
        items: [
          {
            id: crypto.randomUUID(),
            anchor,
            question: `你提到 "${anchor}"，请展开实现细节和取舍。`,
            answer: "",
          },
        ],
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
  const anchors = flattenFollowups(qa)
    .map((f) => f.anchor)
    .filter(Boolean);
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
  el.addFollowupSetBtn.disabled = !qa;
  if (!qa) {
    el.followupList.innerHTML = `<p class="hint">选中一个 QA 后显示追问栏。</p>`;
    return;
  }
  qa.followup_sets = qa.followup_sets || [];
  if (!qa.followup_sets.length) {
    el.followupList.innerHTML = `<p class="hint">暂无追问栏。可新建多个 deep-dive 栏并继续追问。</p>`;
    return;
  }

  qa.followup_sets.forEach((set, setIndex) => {
    const setWrap = document.createElement("section");
    setWrap.className = "followup-set";

    const header = document.createElement("div");
    header.className = "followup-set-header";
    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = set.title || `Deep Dive ${setIndex + 1}`;
    titleInput.addEventListener("input", () => {
      set.title = titleInput.value;
    });
    const addItemBtn = document.createElement("button");
    addItemBtn.textContent = "添加问题";
    addItemBtn.addEventListener("click", () => {
      set.items = set.items || [];
      set.items.push({
        id: crypto.randomUUID(),
        anchor: "",
        question: "",
        answer: "",
      });
      renderFollowups();
    });
    header.appendChild(titleInput);
    header.appendChild(addItemBtn);
    setWrap.appendChild(header);

    set.items = set.items || [];
    set.items.forEach((f) => {
      const frag = el.followCardTpl.content.cloneNode(true);
      const card = frag.querySelector(".follow-card");
      const anchor = frag.querySelector(".anchor");
      const question = frag.querySelector(".question");
      const answer = frag.querySelector(".answer");
      const deepBtn = frag.querySelector(".deep-dive-btn");

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
      deepBtn.addEventListener("click", async () => {
        if (!f.answer?.trim()) {
          alert("先填写这条追问的回答，再继续 deep dive。");
          return;
        }
        await deepDiveWithinSet(set, f);
      });

      setWrap.appendChild(card);
    });
    el.followupList.appendChild(setWrap);
  });
}

function addEmptyFollowupSetToSelectedQa() {
  const qa = state.qaItems.find((item) => item.id === state.selectedQaId);
  if (!qa) return;
  qa.followup_sets = qa.followup_sets || [];
  qa.followup_sets.push({
    id: crypto.randomUUID(),
    title: `Deep Dive ${qa.followup_sets.length + 1}`,
    items: [],
  });
  renderFollowups();
}

async function addFollowupSetByLlm(qa, question, answer) {
  const resp = await fetch("/api/generate-followups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      answer,
      max_items: 4,
    }),
  });
  if (!resp.ok) {
    alert(`追问生成失败: ${await resp.text()}`);
    return;
  }
  const data = await resp.json();
  const items = (data.followups || []).map((x) => ({ ...x }));
  qa.followup_sets = qa.followup_sets || [];
  qa.followup_sets.push({
    id: crypto.randomUUID(),
    title: `Deep Dive ${qa.followup_sets.length + 1}`,
    items,
  });
  state.selectedQaId = qa.id;
  renderQaList();
  renderFollowups();
}

async function deepDiveWithinSet(set, item) {
  const resp = await fetch("/api/generate-followups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: item.question || "",
      answer: item.answer || "",
      max_items: 3,
    }),
  });
  if (!resp.ok) {
    alert(`继续追问失败: ${await resp.text()}`);
    return;
  }
  const data = await resp.json();
  const newItems = (data.followups || []).map((x) => ({ ...x }));
  set.items = set.items || [];
  set.items.push(...newItems);
  renderFollowups();
}

function flattenFollowups(qa) {
  const sets = qa.followup_sets || [];
  const result = [];
  sets.forEach((set) => {
    (set.items || []).forEach((item) => result.push(item));
  });
  return result;
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
  const node = anchorNode.nodeType === 3 ? anchorNode.parentElement : anchorNode;
  const inDoc = el.docViewer.contains(node);
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
  const block = state.blocks.find((b) => b.id === state.selectedBlockId);
  const qa = {
    id: crypto.randomUUID(),
    keyword,
    quote: snippet,
    question: `你在这里提到 "${keyword}"，能讲讲具体技术细节吗？`,
    answer: "",
    block_id: block?.id || null,
    block_title: block?.title || null,
    followup_sets: [],
  };
  state.qaItems.unshift(qa);
  state.selectedQaId = qa.id;
  state.selectedDocText = "";
  el.createQaBtn.disabled = true;
  el.addFollowupSetBtn.disabled = false;
  el.selectionHint.textContent = "已创建 QA。可继续编辑并创建多个追问栏。";
  renderAll();
}

function indexOfInsensitive(haystack, needle) {
  if (!needle) return -1;
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
