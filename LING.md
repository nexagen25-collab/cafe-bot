# LING.md — CafeBot Project Instructions

## Project Purpose

CafeBot is a simple chatbot that helps customers browse a cafe menu and place orders. It uses an LLM to understand user requests and respond with friendly, accurate information about available drinks and prices.

## Simple Architecture

```
User → Frontend → Backend → LLM (via prompts) → Response → User
                        ↕
                   Data (menu.json)
```

- **Frontend** — Collects user input and displays responses.
- **Backend** — Handles API routes, sends user messages to the LLM with the correct prompt, and returns results.
- **Prompts** — Text templates that shape LLM behavior (greetings, order confirmations, etc.).
- **Data** — Static files like `menu.json` that the backend reads to build responses.

## Coding Rules

1. Write one task at a time. Do not implement unrelated features.
2. Use the existing folder structure. Put backend code in `backend/`, frontend code in `frontend/`, and prompt templates in `prompts/`.
3. Keep files small and focused. One file, one responsibility.
4. Do not add dependencies that are not already listed or clearly needed.
5. When in doubt, ask the user before making architectural changes.

## Security Rules

1. Never commit `.env` or any file containing real API keys. Always use `.env.example` as the template.
2. Never hardcode secrets in source code. Read them from environment variables.
3. Validate all user input on the backend before passing it to the LLM.
4. Do not expose internal paths, keys, or stack traces to the user.
5. Treat `.env.example` as safe to commit. Treat `.env` as never to be committed.

## Token-Saving Rules

1. Use short, focused prompts. Avoid unnecessary context in prompt files.
2. Read only the files relevant to the current task. Do not scan the entire project when unnecessary.
3. When the task is complete, stop and do not generate extra code.
4. Reuse existing files (like `menu.json`) instead of duplicating data.
5. Prefer smaller, targeted edits over large rewrites.

## Modify Only Files Needed for the Current Task

- Do not touch files unrelated to the task at hand.
- If you need to create a new file, confirm it is necessary first.
- If a file has not changed, leave it exactly as it is.
- Every edit should directly serve the current objective.
