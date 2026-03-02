# resume-deep-dive-tool

PDF interview prep assistant:
- Upload a resume PDF
- Auto-extract interview-relevant keywords and Q/A with an LLM API
- Highlight matched text in the document
- Edit Q/A in a right-side panel
- Create nested follow-up Q/A from existing answers (LLM or manual selection)

## Quick Start

1. Create and activate a virtual environment.
2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Set environment variables (optional, for LLM calls):

```bash
export LLM_BASE_URL="https://api.openai.com/v1/chat/completions"
export LLM_API_KEY="your_api_key"
export LLM_MODEL="gpt-4o-mini"
```

If LLM env vars are missing, the app falls back to heuristic generation.

4. Run:

```bash
uvicorn app.main:app --reload
```

5. Open:

`http://127.0.0.1:8000`

## API

- `POST /api/upload-pdf`: upload PDF and extract text
- `POST /api/generate-qa`: generate initial Q/A candidates
- `POST /api/generate-followups`: generate follow-up questions from an answer

