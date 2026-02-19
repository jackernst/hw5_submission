# Chat App

A React chatbot with Gemini AI, user auth, MongoDB persistence, and client-side data analysis. Glassmorphism UI with streaming responses, CSV upload, code execution, and interactive charts.

## How It Works

- **Frontend (React)** – Login/create account, chat UI with streaming, drag-and-drop CSV/images, Recharts bar charts
- **Backend (Express)** – REST API for users and sessions, connects to MongoDB
- **AI (Gemini)** – Streaming chat, Google Search grounding, Python code execution, and function calling for client-side tools
- **Storage (MongoDB)** – Users and chat sessions stored in `chatapp` database

## API Keys & Environment Variables

Create a `.env` file in the project root with:

| Variable | Required | Description |
|----------|----------|-------------|
| `REACT_APP_GEMINI_API_KEY` | Yes | Google Gemini API key for chat. Get one at [Google AI Studio](https://aistudio.google.com/apikey). |
| `REACT_APP_MONGODB_URI` | Yes | MongoDB Atlas connection string. Format: `mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/` |

The backend also accepts `MONGODB_URI` or `REACT_APP_MONGO_URI` if you prefer those names.

### Example `.env`

```
REACT_APP_GEMINI_API_KEY=AIzaSy...
REACT_APP_MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/
```

## MongoDB Setup

1. Create a [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) account and cluster.
2. Get your connection string (Database → Connect → Drivers).
3. Put it in `.env` as `REACT_APP_MONGODB_URI`.

All collections are created automatically on first use.

### Database: `chatapp`

#### Collection: `users`

One document per registered user.

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Auto-generated |
| `username` | string | Lowercase username |
| `password` | string | bcrypt hash |
| `email` | string | Email address (optional) |
| `createdAt` | string | ISO timestamp |

#### Collection: `sessions`

One document per chat conversation.

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | Auto-generated — used as `session_id` |
| `username` | string | Owner of this chat |
| `agent` | string | AI persona (e.g. `"lisa"`) |
| `title` | string | Auto-generated name, e.g. `"Chat · Feb 18, 2:34 PM"` |
| `createdAt` | string | ISO timestamp |
| `messages` | array | Ordered list of messages (see below) |

Each item in `messages`:

| Field | Type | Description |
|-------|------|-------------|
| `role` | string | `"user"` or `"model"` |
| `content` | string | Message text (plain, no CSV base64) |
| `timestamp` | string | ISO timestamp |
| `imageData` | array | *(optional)* Base64 image attachments `[{ data, mimeType }]` |
| `toolCalls` | array | *(optional)* Client-side tool invocations `[{ name, args, result }]` |

## Running the App

### Option 1: Both together (single terminal)

```bash
npm install
npm start
```

> **Note:** `npm install` installs all required packages automatically. See [Dependencies](#dependencies) below for the full list.

### Option 2: Separate terminals (recommended for development)

First, install dependencies once:

```bash
npm install
```

Then open two terminals in the project root:

**Terminal 1 — Backend:**
```bash
npm run server
```

**Terminal 2 — Frontend:**
```bash
npm run client
```

This starts:

- **Backend** – http://localhost:3001  
- **Frontend** – http://localhost:3000  

Use the app at **http://localhost:3000**. The React dev server proxies `/api` requests to the backend.

### Verify Backend

- http://localhost:3001 – Server status page  
- http://localhost:3001/api/status – JSON with `usersCount` and `sessionsCount`

## Dependencies

All packages are installed via `npm install`. Key dependencies:

### Frontend

| Package | Purpose |
|---------|---------|
| `react`, `react-dom` | UI framework |
| `react-scripts` | Create React App build tooling |
| `@google/generative-ai` | Gemini API client (chat, function calling, code execution, search grounding) |
| `react-markdown` | Render markdown in AI responses |
| `remark-gfm` | GitHub-flavored markdown (tables, strikethrough, etc.) |
| `recharts` | Interactive charts (available for future visualizations) |

### Backend

| Package | Purpose |
|---------|---------|
| `express` | HTTP server and REST API |
| `mongodb` | MongoDB driver for Node.js |
| `bcryptjs` | Password hashing |
| `cors` | Cross-origin request headers |
| `dotenv` | Load `.env` variables |

### Dev / Tooling

| Package | Purpose |
|---------|---------|
| `concurrently` | Run frontend and backend with a single `npm start` |

---

## Features

- **Create account / Login** – Username + password, hashed with bcrypt
- **Session-based chat history** – Each conversation is a separate session; sidebar lists all chats with delete option
- **Streaming Gemini responses** – Text streams in real time with animated "..." while thinking; Stop button to cancel
- **Google Search grounding** – Answers include cited web sources for factual queries
- **Python code execution** – Gemini writes and runs Python for plots, regression, histogram, scatter, and any analysis the JS tools can't handle
- **CSV upload** – Drag-and-drop or click to attach a CSV; a slim version of the data (key columns as plain text) plus a full statistical summary are sent to Gemini automatically
- **Auto-computed engagement column** – When a CSV has `Favorite Count` and `View Count` columns, an `engagement` ratio (Favorite Count / View Count) is added automatically to every row
- **Client-side data analysis tools** – Fast, zero-cost function-calling tools that run in the browser. Gemini calls these automatically for data questions; results are saved to MongoDB alongside the message:
  - `compute_column_stats(column)` – mean, median, std, min, max, count for any numeric column
  - `get_value_counts(column, top_n)` – frequency count of each unique value in a categorical column
  - `get_top_tweets(sort_column, n, ascending)` – top or bottom N tweets sorted by any metric (including `engagement`), with tweet text and key metrics
- **Tool routing logic** – The app automatically routes requests: client-side JS tools for simple stats, Python code execution for plots and complex models, Google Search for factual queries
- **Markdown rendering** – AI responses render headers, lists, code blocks, tables, and links
- **Image support** – Attach images via drag-and-drop, the 📎 button, or paste from clipboard (Ctrl+V)

## Chat System Prompt

The AI’s system instructions are loaded from **`public/prompt_chat.txt`**. Edit this file to change the assistant’s behavior (tone, role, format, etc.). Changes take effect on the next message; no rebuild needed.

### How to Get a Good Persona Prompt (Make the AI Sound Like Someone)

To make the AI sound like a specific person (celebrity, character, or role), ask your AI assistant or prompt engineer to do the following:

1. **Pull a bio** – “Look up [person’s name] on Wikipedia and summarize their background, career, and key facts.”

2. **Find speech examples** – “Search for interviews [person] has done and pull direct quotes that show how they talk—phrases they use, tone, vocabulary.”

3. **Describe the vibe** – “What’s their personality? Confident, shy, funny, formal? List 3–5 traits.”

4. **Define the role** – “This person is my assistant for [context, e.g. a Yale SOM course on Generative AI]. They should help with [specific tasks] while staying in character.”

5. **Ask for the full prompt** – “Write a system prompt for `prompt_chat.txt` that includes: (a) a short bio, (b) speech examples and phrases to mimic, (c) personality traits, and (d) their role as my assistant for [your use case].”

**Example request you can paste into ChatGPT/Claude/etc.:**

> Write a system prompt for a chatbot. The AI should sound like [Person X]. Pull their Wikipedia page and 2–3 interviews. Include: (1) a brief bio, (2) 5–8 direct quotes showing how they speak, (3) personality traits, and (4) their role as my teaching assistant for [Course Name] taught by [Professor] at [School]. Put it all in a format I can paste into `prompt_chat.txt`.
