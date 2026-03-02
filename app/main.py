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


BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Resume Deep Dive Tool")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# In-memory store for MVP use.
DOC_STORE: dict[str, dict[str, Any]] = {}


class UploadResponse(BaseModel):
    document_id: str
    pages: list[str]
    full_text: str


class GenerateQaRequest(BaseModel):
    document_id: str
    max_items: int = Field(default=8, ge=1, le=20)


class QaItem(BaseModel):
    id: str
    keyword: str
    quote: str
    question: str
    answer: str = ""


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
    DOC_STORE[document_id] = {"pages": pages, "full_text": full_text}
    return UploadResponse(document_id=document_id, pages=pages, full_text=full_text)


@app.post("/api/generate-qa", response_model=GenerateQaResponse)
async def generate_qa(payload: GenerateQaRequest) -> GenerateQaResponse:
    doc = DOC_STORE.get(payload.document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found.")

    full_text = doc["full_text"]
    llm_items = await _generate_qa_by_llm(full_text, payload.max_items)
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
                )
                for item in llm_items
            ]
        )

    return GenerateQaResponse(qa_items=_fallback_qa_from_text(full_text, payload.max_items))


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
        txt = page.extract_text() or ""
        txt = re.sub(r"[ \t]+", " ", txt)
        txt = re.sub(r"\n{3,}", "\n\n", txt).strip()
        pages.append(txt)
    full_text = "\n\n".join([p for p in pages if p.strip()])
    return pages, full_text


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


async def _generate_qa_by_llm(full_text: str, max_items: int) -> list[dict[str, str]] | None:
    prompt = (
        "Extract interview-focused technical Q/A from this resume text. "
        "Return strict JSON with key 'qa_items' as an array. "
        "Each item must include: keyword, quote, question, answer. "
        "Question should be interview-style and specific."
    )
    sample = full_text[:12000]
    data = await _call_llm_json(prompt, f"max_items={max_items}\n\nresume:\n{sample}")
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
