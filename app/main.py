from __future__ import annotations

import json
import os
import re
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pypdf import PdfReader
from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
load_dotenv(BASE_DIR / ".env")

app = FastAPI(title="Resume Deep Dive Tool")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# In-memory store for MVP use.
DOC_STORE: dict[str, dict[str, Any]] = {}


class UploadResponse(BaseModel):
    document_id: str
    pages: list[str]
    full_text: str


class ParseResumeRequest(BaseModel):
    document_id: str


class ResumeBlock(BaseModel):
    id: str
    block_type: str = "experience"
    title: str
    organization: str = ""
    role: str = ""
    period: str = ""
    location: str = ""
    content: str
    bullets: list[str] = Field(default_factory=list)


class ParseResumeResponse(BaseModel):
    blocks: list[ResumeBlock]
    parse_mode: str


class GenerateQaRequest(BaseModel):
    document_id: str
    block_id: str | None = None
    max_items: int = Field(default=8, ge=1, le=20)


class QaItem(BaseModel):
    id: str
    keyword: str
    quote: str
    question: str
    answer: str = ""
    block_id: str | None = None
    block_title: str | None = None


class GenerateQaResponse(BaseModel):
    qa_items: list[QaItem]


class GenerateFollowupsRequest(BaseModel):
    question: str
    answer: str
    max_items: int = Field(default=5, ge=1, le=10)


class FollowupItem(BaseModel):
    id: str
    anchor: str
    question: str
    answer: str = ""


class GenerateFollowupsResponse(BaseModel):
    followups: list[FollowupItem]


@app.get("/")
def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/upload-pdf", response_model=UploadResponse)
async def upload_pdf(file: UploadFile = File(...)) -> UploadResponse:
    if file.content_type not in {"application/pdf", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Please upload a PDF file.")

    raw = await file.read()
    pages, full_text = _extract_pdf_text(raw)
    if not full_text.strip():
        raise HTTPException(status_code=400, detail="No extractable text found in PDF.")

    document_id = str(uuid4())
    DOC_STORE[document_id] = {"pages": pages, "full_text": full_text, "blocks": []}
    return UploadResponse(document_id=document_id, pages=pages, full_text=full_text)


@app.post("/api/parse-resume", response_model=ParseResumeResponse)
async def parse_resume(payload: ParseResumeRequest) -> ParseResumeResponse:
    doc = DOC_STORE.get(payload.document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found.")

    full_text = doc["full_text"]
    llm_blocks = await _parse_resume_blocks_by_llm(full_text)
    parse_mode = "llm"
    if llm_blocks:
        blocks = [
            ResumeBlock(
                id=str(uuid4()),
                block_type=item.get("block_type", "experience").strip()[:40] or "experience",
                title=item.get("title", "").strip()[:120] or "Experience",
                organization=item.get("organization", "").strip()[:120],
                role=item.get("role", "").strip()[:120],
                period=item.get("period", "").strip()[:120],
                location=item.get("location", "").strip()[:120],
                content=item.get("content", "").strip()[:2000],
                bullets=[
                    str(x).strip()[:400]
                    for x in item.get("bullets", [])
                    if isinstance(x, str) and x.strip()
                ][:10],
            )
            for item in llm_blocks
            if isinstance(item, dict) and item.get("title")
        ]
    else:
        parse_mode = "fallback"
        blocks = _fallback_resume_blocks(full_text)

    doc["blocks"] = [b.model_dump() for b in blocks]
    return ParseResumeResponse(blocks=blocks, parse_mode=parse_mode)


@app.post("/api/generate-qa", response_model=GenerateQaResponse)
async def generate_qa(payload: GenerateQaRequest) -> GenerateQaResponse:
    doc = DOC_STORE.get(payload.document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found.")

    block_title = ""
    block_id = payload.block_id
    source_text = doc["full_text"]
    if payload.block_id:
        blocks = doc.get("blocks", [])
        selected = next((b for b in blocks if b.get("id") == payload.block_id), None)
        if not selected:
            raise HTTPException(status_code=404, detail="Block not found.")
        source_text = _block_to_source_text(selected)
        block_title = selected.get("title", "")

    llm_items = await _generate_qa_by_llm(source_text, payload.max_items, block_title=block_title)
    if llm_items:
        return GenerateQaResponse(
            qa_items=[
                QaItem(
                    id=str(uuid4()),
                    keyword=item.get("keyword", "").strip()[:80] or "Key Topic",
                    quote=item.get("quote", "").strip()[:280],
                    question=item.get("question", "").strip()[:500]
                    or "Can you explain this part in detail?",
                    answer=item.get("answer", "").strip()[:1200],
                    block_id=block_id,
                    block_title=block_title or None,
                )
                for item in llm_items
            ]
        )

    qa_items = _fallback_qa_from_text(source_text, payload.max_items)
    if block_id:
        for item in qa_items:
            item.block_id = block_id
            item.block_title = block_title or None
    return GenerateQaResponse(qa_items=qa_items)


@app.post("/api/generate-followups", response_model=GenerateFollowupsResponse)
async def generate_followups(payload: GenerateFollowupsRequest) -> GenerateFollowupsResponse:
    llm_items = await _generate_followups_by_llm(payload.question, payload.answer, payload.max_items)
    if llm_items:
        return GenerateFollowupsResponse(
            followups=[
                FollowupItem(
                    id=str(uuid4()),
                    anchor=item.get("anchor", "").strip()[:200],
                    question=item.get("question", "").strip()[:500]
                    or "Could you provide more technical details?",
                    answer=item.get("answer", "").strip()[:1200],
                )
                for item in llm_items
            ]
        )

    return GenerateFollowupsResponse(
        followups=_fallback_followups(payload.answer, payload.max_items)
    )


def _extract_pdf_text(raw: bytes) -> tuple[list[str], str]:
    reader = PdfReader(BytesIO(raw))
    pages: list[str] = []
    for page in reader.pages:
        try:
            txt = page.extract_text(extraction_mode="layout") or ""
        except TypeError:
            txt = page.extract_text() or ""
        txt = _normalize_pdf_text(txt)
        pages.append(txt)
    full_text = "\n\n".join([p for p in pages if p.strip()])
    return pages, full_text


def _normalize_pdf_text(text: str) -> str:
    text = text.replace("\r", "\n")
    text = re.sub(r"[ \t\f\v]+", " ", text)
    raw_lines = [re.sub(r"\s+", " ", line).strip() for line in text.split("\n")]
    lines = [line for line in raw_lines if line]
    if not lines:
        return ""

    short_line_ratio = (
        sum(1 for line in lines if len(line.split()) <= 2) / max(len(lines), 1)
    )
    force_inline = short_line_ratio >= 0.45

    merged: list[str] = []
    for line in lines:
        if not merged:
            merged.append(line)
            continue

        prev = merged[-1]
        if _is_hard_break(prev, line, force_inline):
            merged.append(line)
        elif prev.endswith("-") and len(prev) > 1:
            merged[-1] = f"{prev[:-1]}{line}"
        else:
            merged[-1] = f"{prev} {line}"

    clean = "\n".join(merged)
    clean = re.sub(r"\s+([,.;:!?])", r"\1", clean)
    clean = re.sub(r"\n{3,}", "\n\n", clean).strip()
    return clean


def _is_hard_break(prev: str, current: str, force_inline: bool) -> bool:
    bullet_prefixes = ("●", "•", "-", "*")
    if current.startswith(bullet_prefixes):
        return True
    if _is_heading(prev) or _is_heading(current):
        return True
    if not force_inline and prev.endswith((".", "!", "?", "。", "！", "？")):
        return True
    return False


def _is_heading(line: str) -> bool:
    if len(line) > 48:
        return False
    return re.fullmatch(r"[A-Z0-9/&() \-]+", line) is not None


def _fallback_qa_from_text(text: str, max_items: int) -> list[QaItem]:
    keywords = _keyword_candidates(text, max_items)
    sentences = _sentences(text)
    qa_items: list[QaItem] = []
    for keyword in keywords:
        quote = ""
        for sentence in sentences:
            if keyword.lower() in sentence.lower():
                quote = sentence[:260]
                break
        question = f"你在简历里提到 {keyword}，请讲讲具体技术实现、难点和取舍。"
        answer = f"请补充 {keyword} 的背景、你的贡献、结果指标，以及可优化方向。"
        qa_items.append(
            QaItem(
                id=str(uuid4()),
                keyword=keyword,
                quote=quote,
                question=question,
                answer=answer,
            )
        )
        if len(qa_items) >= max_items:
            break
    return qa_items


def _fallback_followups(answer: str, max_items: int) -> list[FollowupItem]:
    anchors = [w for w in re.findall(r"[A-Za-z][A-Za-z0-9_\-+/]{2,}", answer)][:max_items]
    if not anchors:
        anchors = ["implementation", "tradeoff", "measurement"][:max_items]
    result: list[FollowupItem] = []
    for a in anchors:
        result.append(
            FollowupItem(
                id=str(uuid4()),
                anchor=a,
                question=f"关于 {a}，能展开讲讲设计细节、边界条件和性能影响吗？",
                answer="",
            )
        )
    return result


def _block_to_source_text(block: dict[str, Any]) -> str:
    lines = [
        block.get("title", ""),
        block.get("organization", ""),
        block.get("role", ""),
        block.get("period", ""),
        block.get("location", ""),
        block.get("content", ""),
    ]
    bullets = block.get("bullets") or []
    lines.extend([f"- {b}" for b in bullets if isinstance(b, str)])
    return "\n".join([x for x in lines if isinstance(x, str) and x.strip()])


def _fallback_resume_blocks(text: str) -> list[ResumeBlock]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    section = ""
    blocks: list[ResumeBlock] = []
    current: dict[str, Any] | None = None

    def flush_current() -> None:
        nonlocal current
        if not current:
            return
        content = " ".join(current.get("content_lines", [])).strip()
        bullets = current.get("bullets", [])
        if not content and not bullets:
            current = None
            return
        blocks.append(
            ResumeBlock(
                id=str(uuid4()),
                block_type=current.get("block_type", "experience"),
                title=current.get("title", "Experience"),
                organization=current.get("organization", ""),
                role=current.get("role", ""),
                period=current.get("period", ""),
                location=current.get("location", ""),
                content=content[:2000],
                bullets=[b[:400] for b in bullets][:10],
            )
        )
        current = None

    for line in lines:
        if _is_heading(line):
            section = line
            continue

        if line.startswith(("●", "•", "-", "*")):
            if current is None:
                current = {
                    "title": section.title() if section else "Experience",
                    "block_type": "experience",
                    "content_lines": [],
                    "bullets": [],
                }
            current["bullets"].append(line.lstrip("●•-* ").strip())
            continue

        if _looks_like_experience_start(line):
            flush_current()
            current = _new_block_from_header(line, section)
            continue

        if current is None:
            current = {
                "title": section.title() if section else "Resume Segment",
                "block_type": "experience",
                "content_lines": [line],
                "bullets": [],
            }
        else:
            current["content_lines"].append(line)

    flush_current()

    if not blocks:
        blocks.append(
            ResumeBlock(
                id=str(uuid4()),
                block_type="experience",
                title="Resume",
                content=text[:3000],
                bullets=[],
            )
        )
    return blocks[:12]


def _looks_like_experience_start(line: str) -> bool:
    if len(line) > 220:
        return False
    has_year = bool(re.search(r"\b(19|20)\d{2}\b", line))
    has_dash = "–" in line or "-" in line
    has_caps_word = bool(re.search(r"\b[A-Z][a-zA-Z&().-]{2,}\b", line))
    return has_year and has_dash and has_caps_word


def _new_block_from_header(line: str, section: str) -> dict[str, Any]:
    period_match = re.search(
        r"((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)?\.?\s*(?:19|20)\d{2}\s*[–-]\s*(?:Present|Current|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)?\.?\s*(?:19|20)\d{2}))",
        line,
    )
    period = period_match.group(1).strip() if period_match else ""
    head = line.replace(period, "").strip(" -–")
    tokens = head.split()
    title = " ".join(tokens[:8]) if tokens else "Experience"
    return {
        "title": title[:120],
        "organization": "",
        "role": "",
        "period": period[:120],
        "location": "",
        "block_type": "experience" if "PUBLICATION" not in section else "publication",
        "content_lines": [line],
        "bullets": [],
    }


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[。！？.!?])\s+|\n+", text)
    return [p.strip() for p in parts if p.strip()]


def _keyword_candidates(text: str, max_items: int) -> list[str]:
    curated = [
        "Python",
        "Java",
        "JavaScript",
        "TypeScript",
        "React",
        "Node.js",
        "FastAPI",
        "SQL",
        "PostgreSQL",
        "MySQL",
        "Redis",
        "Docker",
        "Kubernetes",
        "AWS",
        "GCP",
        "CI/CD",
        "Machine Learning",
        "LLM",
        "NLP",
        "System Design",
    ]
    found = []
    lower = text.lower()
    for term in curated:
        if term.lower() in lower:
            found.append(term)
        if len(found) >= max_items:
            return found

    # Fallback: frequent mixed-case / acronym tokens.
    tokens = re.findall(r"\b[A-Za-z][A-Za-z0-9+./#_-]{2,}\b", text)
    freq: dict[str, int] = {}
    for t in tokens:
        key = t.strip()
        freq[key] = freq.get(key, 0) + 1
    ranked = sorted(freq.items(), key=lambda kv: kv[1], reverse=True)
    for token, _count in ranked:
        if token not in found:
            found.append(token)
        if len(found) >= max_items:
            break
    return found[:max_items]


async def _parse_resume_blocks_by_llm(full_text: str) -> list[dict[str, Any]] | None:
    prompt = (
        "Parse this resume into readable blocks for deep-dive interview prep. "
        "Return strict JSON object with key 'blocks' (array). "
        "Each block item keys: block_type, title, organization, role, period, location, content, bullets. "
        "Focus on PROFESSIONAL EXPERIENCE and PROJECT/RESEARCH blocks first. "
        "Keep content concise and preserve technical details."
    )
    sample = full_text[:14000]
    data = await _call_llm_json(prompt, sample)
    if not data or "blocks" not in data or not isinstance(data["blocks"], list):
        return None
    return [x for x in data["blocks"] if isinstance(x, dict)][:12]


async def _generate_qa_by_llm(
    full_text: str, max_items: int, block_title: str = ""
) -> list[dict[str, str]] | None:
    prompt = (
        "Extract interview-focused technical Q/A from this resume text. "
        "Return strict JSON with key 'qa_items' as an array. "
        "Each item must include: keyword, quote, question, answer. "
        "Question should be interview-style and specific. "
        "Prioritize implementation details, tradeoffs, failures, and measurable outcomes."
    )
    sample = full_text[:12000]
    context = f"max_items={max_items}\nblock_title={block_title}\n\nresume:\n{sample}"
    data = await _call_llm_json(prompt, context)
    if not data or "qa_items" not in data or not isinstance(data["qa_items"], list):
        return None
    return [x for x in data["qa_items"] if isinstance(x, dict)][:max_items]


async def _generate_followups_by_llm(
    question: str, answer: str, max_items: int
) -> list[dict[str, str]] | None:
    prompt = (
        "Given an interview question and answer, find technical anchor points and "
        "generate deeper follow-up Q/A. Return strict JSON with key 'followups' as array. "
        "Each item: anchor, question, answer."
    )
    content = f"max_items={max_items}\n\nquestion:\n{question}\n\nanswer:\n{answer[:6000]}"
    data = await _call_llm_json(prompt, content)
    if not data or "followups" not in data or not isinstance(data["followups"], list):
        return None
    return [x for x in data["followups"] if isinstance(x, dict)][:max_items]


async def _call_llm_json(system_prompt: str, user_prompt: str) -> dict[str, Any] | None:
    base_url = os.getenv("LLM_BASE_URL")
    api_key = os.getenv("LLM_API_KEY")
    model = os.getenv("LLM_MODEL", "gpt-4o-mini")
    if not base_url or not api_key:
        return None

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {"type": "json_object"},
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(base_url, headers=headers, json=payload)
            resp.raise_for_status()
    except Exception:
        return None

    try:
        raw = resp.json()["choices"][0]["message"]["content"]
    except Exception:
        return None

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", raw)
        if not match:
            return None
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            return None
