# resume-deep-dive-tool

PDF interview prep assistant:
- Upload a resume PDF
- Use LLM API to parse resume into structured experience blocks
- Generate interview-relevant keywords and Q/A per experience block
- Highlight matched text in each block
- Edit Q/A in a right-side panel
- Create multiple deep-dive follow-up panels from existing answers (LLM or manual selection)

## Quick Start

1. Create and activate a virtual environment.

```bash
python3 -m venv .venv
source .venv/bin/activate
```

2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Configure environment variables first:

```bash
cp .env.example .env
# edit .env and fill LLM_API_KEY
```

The backend auto-loads `.env`. If LLM vars are missing, it falls back to heuristic parsing/generation.

4. Run:

```bash
uvicorn app.main:app --reload
```

5. Open:

`http://127.0.0.1:8000`

## API

- `POST /api/upload-pdf`: upload PDF and extract text
- `POST /api/parse-resume`: parse resume into structured blocks with LLM
- `POST /api/generate-qa`: generate Q/A candidates (supports per-block generation)
- `POST /api/generate-followups`: generate follow-up questions from an answer
