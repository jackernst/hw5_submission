import { useState, useEffect, useRef } from 'react';
import html2canvas from 'html2canvas';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamChat, chatWithCsvTools, CODE_KEYWORDS } from '../services/gemini';
import { parseCsvToRows, executeTool, computeDatasetSummary, enrichWithEngagement, buildSlimCsv } from '../services/csvTools';
import { generateImageTool } from '../services/jsonTools';
import {
  getSessions,
  createSession,
  deleteSession,
  saveMessage,
  loadMessages,
} from '../services/mongoApi';
import EngagementChart from './EngagementChart';
import MetricVsTimeChart from './MetricVsTimeChart';
import './Chat.css';

// ── Helpers ───────────────────────────────────────────────────────────────────

const chatTitle = () => {
  const d = new Date();
  return `Chat · ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

// Encode a string to base64 safely (handles unicode/emoji in tweet text etc.)
const toBase64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const parseCSV = (text) => {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rowCount = lines.length - 1;

  // Short human-readable preview (header + first 5 rows) for context
  const preview = lines.slice(0, 6).join('\n');

  // Full CSV as base64 — avoids ALL string-escaping issues in Python code execution
  // (tweet text with quotes, apostrophes, emojis, etc. all break triple-quoted strings)
  const raw = text.length > 500000 ? text.slice(0, 500000) : text;
  const base64 = toBase64(raw);
  const truncated = text.length > 500000;

  return { headers, rowCount, preview, base64, truncated };
};

const summarizeChannelJson = (obj) => {
  try {
    const videos = Array.isArray(obj?.videos)
      ? obj.videos
      : Array.isArray(obj?.items)
        ? obj.items
        : [];
    const count = videos.length;
    const dates = videos
      .map((v) => v?.published_at || v?.publishedAt || v?.snippet?.publishedAt)
      .filter(Boolean)
      .map((d) => new Date(d))
      .filter((d) => !Number.isNaN(+d))
      .sort((a, b) => +a - +b);
    const start = dates.length ? dates[0].toISOString().slice(0, 10) : null;
    const end = dates.length ? dates[dates.length - 1].toISOString().slice(0, 10) : null;
    const example = videos
      .slice(0, 3)
      .map((v) => v?.title || v?.snippet?.title)
      .filter(Boolean);
    const keys = videos.length ? Object.keys(videos[0] || {}) : [];
    const fields = keys.length
      ? keys.slice(0, 12).join(', ') + (keys.length > 12 ? ', …' : '')
      : '';
    const channelTitle =
      obj?.channel?.title ||
      obj?.channelTitle ||
      obj?.channel?.handle ||
      obj?.channel?.url ||
      '';
    return [
      `**YouTube channel JSON loaded**`,
      `- Videos: ${count}`,
      start && end ? `- Date range: ${start} → ${end}` : null,
      fields ? `- Example fields: ${fields}` : null,
      example.length
        ? `- Example titles: ${example
            .map((t) => `"${String(t).slice(0, 80)}"`)
            .join(', ')}`
        : null,
      channelTitle ? `- Channel: ${channelTitle}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
};

// Extract plain text from a message (for history only — never returns base64)
const messageText = (m) => {
  if (m.parts) return m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return m.content || '';
};

// ── Structured part renderer (code execution responses) ───────────────────────

function StructuredParts({ parts }) {
  return (
    <>
      {parts.map((part, i) => {
        if (part.type === 'text' && part.text?.trim()) {
          return (
            <div key={i} className="part-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
            </div>
          );
        }
        if (part.type === 'code') {
          return (
            <div key={i} className="part-code">
              <div className="part-code-header">
                <span className="part-code-lang">
                  {part.language === 'PYTHON' ? 'Python' : part.language}
                </span>
              </div>
              <pre className="part-code-body">
                <code>{part.code}</code>
              </pre>
            </div>
          );
        }
        if (part.type === 'result') {
          const ok = part.outcome === 'OUTCOME_OK';
          return (
            <div key={i} className="part-result">
              <div className="part-result-header">
                <span className={`part-result-badge ${ok ? 'ok' : 'err'}`}>
                  {ok ? '✓ Output' : '✗ Error'}
                </span>
              </div>
              <pre className="part-result-body">{part.output}</pre>
            </div>
          );
        }
        if (part.type === 'image') {
          return (
            <img
              key={i}
              src={`data:${part.mimeType};base64,${part.data}`}
              alt="Generated plot"
              className="part-image"
            />
          );
        }
        return null;
      })}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Chat({ username, firstName = '', lastName = '', onLogout }) {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [images, setImages] = useState([]);
  const [csvContext, setCsvContext] = useState(null);     // pending attachment chip
  const [jsonContext, setJsonContext] = useState(null);   // pending attachment chip
  const [channelJson, setChannelJson] = useState(null);   // parsed JSON object for tools
  const [channelJsonSummary, setChannelJsonSummary] = useState(''); // compact summary for prompts
  const [jsonError, setJsonError] = useState('');
  const [sessionCsvRows, setSessionCsvRows] = useState(null);    // parsed rows for JS tools
  const [sessionCsvHeaders, setSessionCsvHeaders] = useState(null); // headers for tool routing
  const [csvDataSummary, setCsvDataSummary] = useState(null);    // auto-computed column stats summary
  const [sessionSlimCsv, setSessionSlimCsv] = useState(null);   // key-columns CSV string sent directly to Gemini
  const [streaming, setStreaming] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [lightbox, setLightbox] = useState(null); // { data, mimeType, name? }
  const [chartLightbox, setChartLightbox] = useState(null); // { chart }

  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(false);
  const fileInputRef = useRef(null);
  const chartRef = useRef(null);
  // Set to true immediately before setActiveSessionId() is called during a send
  // so the messages useEffect knows to skip the reload (streaming is in progress).
  const justCreatedSessionRef = useRef(false);

  // On login: load sessions from DB; 'new' means an unsaved pending chat
  useEffect(() => {
    const init = async () => {
      const list = await getSessions(username);
      setSessions(list);
      setActiveSessionId('new'); // always start with a fresh empty chat on login
    };
    init();
  }, [username]);

  useEffect(() => {
    if (!activeSessionId || activeSessionId === 'new') {
      setMessages([]);
      return;
    }
    // If a session was just created during an active send, messages are already
    // in state and streaming is in progress — don't wipe them.
    if (justCreatedSessionRef.current) {
      justCreatedSessionRef.current = false;
      return;
    }
    setMessages([]);
    loadMessages(activeSessionId).then(setMessages);
  }, [activeSessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!openMenuId) return;
    const handler = () => setOpenMenuId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [openMenuId]);

  // ── Session management ──────────────────────────────────────────────────────

  const handleNewChat = () => {
    setActiveSessionId('new');
    setMessages([]);
    setInput('');
    setImages([]);
    setCsvContext(null);
    setJsonContext(null);
    setChannelJson(null);
    setChannelJsonSummary('');
    setJsonError('');
    setSessionCsvRows(null);
    setSessionCsvHeaders(null);
  };

  const handleSelectSession = (sessionId) => {
    if (sessionId === activeSessionId) return;
    setActiveSessionId(sessionId);
    setInput('');
    setImages([]);
    setCsvContext(null);
    setJsonContext(null);
    setChannelJson(null);
    setChannelJsonSummary('');
    setJsonError('');
    setSessionCsvRows(null);
    setSessionCsvHeaders(null);
  };

  const handleDeleteSession = async (sessionId, e) => {
    e.stopPropagation();
    setOpenMenuId(null);
    await deleteSession(sessionId);
    const remaining = sessions.filter((s) => s.id !== sessionId);
    setSessions(remaining);
    if (activeSessionId === sessionId) {
      setActiveSessionId(remaining.length > 0 ? remaining[0].id : 'new');
      setMessages([]);
    }
  };

  // ── File handling ───────────────────────────────────────────────────────────

  const fileToBase64 = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });

  const fileToText = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsText(file);
    });

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = [...e.dataTransfer.files];

    const csvFiles = files.filter((f) => f.name.endsWith('.csv') || f.type === 'text/csv');
    const jsonFiles = files.filter((f) => f.name.endsWith('.json') || f.type === 'application/json');
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));

    if (csvFiles.length > 0) {
      const file = csvFiles[0];
      const text = await fileToText(file);
      const parsed = parseCSV(text);
      if (parsed) {
        setCsvContext({ name: file.name, ...parsed });
        setJsonContext(null);
        setChannelJson(null);
        setChannelJsonSummary('');
        setJsonError('');
        // Parse rows, add computed engagement col, build summary + slim CSV
        const raw = parseCsvToRows(text);
        const { rows, headers } = enrichWithEngagement(raw.rows, raw.headers);
        setSessionCsvHeaders(headers);
        setSessionCsvRows(rows);
        setCsvDataSummary(computeDatasetSummary(rows, headers));
        setSessionSlimCsv(buildSlimCsv(rows, headers));
      }
    }

    if (jsonFiles.length > 0) {
      const file = jsonFiles[0];
      const text = await fileToText(file);
      try {
        const obj = JSON.parse(text);
        setJsonContext({ name: file.name, bytes: text.length });
        setChannelJson(obj);
        setChannelJsonSummary(summarizeChannelJson(obj));
        setJsonError('');

        // JSON and CSV are mutually exclusive in context to keep prompts small.
        setCsvContext(null);
        setSessionCsvRows(null);
        setSessionCsvHeaders(null);
        setCsvDataSummary(null);
        setSessionSlimCsv(null);
      } catch (err) {
        setJsonContext({ name: file.name, bytes: text.length });
        setChannelJson(null);
        setChannelJsonSummary('');
        setJsonError(`Invalid JSON: ${err?.message || 'parse failed'}`);
      }
    }

    if (imageFiles.length > 0) {
      const newImages = await Promise.all(
        imageFiles.map(async (f) => ({
          data: await fileToBase64(f),
          mimeType: f.type,
          name: f.name,
        }))
      );
      setImages((prev) => [...prev, ...newImages]);
    }
  };

  const handleFileSelect = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';

    const csvFiles = files.filter((f) => f.name.endsWith('.csv') || f.type === 'text/csv');
    const jsonFiles = files.filter((f) => f.name.endsWith('.json') || f.type === 'application/json');
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));

    if (csvFiles.length > 0) {
      const text = await fileToText(csvFiles[0]);
      const parsed = parseCSV(text);
      if (parsed) {
        setCsvContext({ name: csvFiles[0].name, ...parsed });
        setJsonContext(null);
        setChannelJson(null);
        setChannelJsonSummary('');
        setJsonError('');
        const raw = parseCsvToRows(text);
        const { rows, headers } = enrichWithEngagement(raw.rows, raw.headers);
        setSessionCsvHeaders(headers);
        setSessionCsvRows(rows);
        setCsvDataSummary(computeDatasetSummary(rows, headers));
        setSessionSlimCsv(buildSlimCsv(rows, headers));
      }
    }

    if (jsonFiles.length > 0) {
      const text = await fileToText(jsonFiles[0]);
      try {
        const obj = JSON.parse(text);
        setJsonContext({ name: jsonFiles[0].name, bytes: text.length });
        setChannelJson(obj);
        setChannelJsonSummary(summarizeChannelJson(obj));
        setJsonError('');

        setCsvContext(null);
        setSessionCsvRows(null);
        setSessionCsvHeaders(null);
        setCsvDataSummary(null);
        setSessionSlimCsv(null);
      } catch (err) {
        setJsonContext({ name: jsonFiles[0].name, bytes: text.length });
        setChannelJson(null);
        setChannelJsonSummary('');
        setJsonError(`Invalid JSON: ${err?.message || 'parse failed'}`);
      }
    }

    if (imageFiles.length > 0) {
      const newImages = await Promise.all(
        imageFiles.map(async (f) => ({
          data: await fileToBase64(f),
          mimeType: f.type,
          name: f.name,
        }))
      );
      setImages((prev) => [...prev, ...newImages]);
    }
  };

  // ── Stop generation ─────────────────────────────────────────────────────────

  const handlePaste = async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));
    if (!imageItems.length) return;
    e.preventDefault();
    const newImages = await Promise.all(
      imageItems.map(
        (item) =>
          new Promise((resolve) => {
            const file = item.getAsFile();
            if (!file) return resolve(null);
            const reader = new FileReader();
            reader.onload = () =>
              resolve({ data: reader.result.split(',')[1], mimeType: file.type, name: 'pasted-image' });
            reader.readAsDataURL(file);
          })
      )
    );
    setImages((prev) => [...prev, ...newImages.filter(Boolean)]);
  };

  const handleStop = () => {
    abortRef.current = true;
  };

  const downloadImage = (img, filename = 'image.png') => {
    const a = document.createElement('a');
    a.href = `data:${img.mimeType};base64,${img.data}`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const downloadChartAsPng = async (filename = 'chart.png') => {
    if (!chartRef.current) return;
    try {
      const canvas = await html2canvas(chartRef.current, {
        backgroundColor: '#020617',
        scale: window.devicePixelRatio && window.devicePixelRatio > 1 ? window.devicePixelRatio : 2,
      });
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to export chart', err);
    }
  };

  // ── Send message ────────────────────────────────────────────────────────────

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && !images.length && !csvContext && !jsonContext) || streaming || !activeSessionId) return;

    // Lazily create the session in DB on the very first message
    let sessionId = activeSessionId;
    if (sessionId === 'new') {
      const title = chatTitle();
      const { id } = await createSession(username, 'lisa', title);
      sessionId = id;
      justCreatedSessionRef.current = true; // tell useEffect to skip the reload
      setActiveSessionId(id);
      setSessions((prev) => [{ id, agent: 'lisa', title, createdAt: new Date().toISOString(), messageCount: 0 }, ...prev]);
    }

    const wantsGenerateImage =
      /\bgenerateimage\b/i.test(text) ||
      /^\s*generateimage\s*:/i.test(text) ||
      /\b(generate an image|make an image|create an image|image generation)\b/i.test(text);

    const wantsMetricPlot =
      /\bplot_metric_vs_time\b/i.test(text) ||
      /\b(plot|graph)\b.*\b(views?|likes?|comments?)\b.*\b(time)\b/i.test(text);

    const wantsStatsJson =
      /\bcompute_stats_json\b/i.test(text) ||
      /\b(stats?|statistics?|average|mean|median|distribution)\b.*\b(views?|likes?|comments?|duration)\b/i.test(
        text
      );

    const wantsPlayVideo =
      /\bplay_video\b/i.test(text) ||
      /\b(play|open)\b.*\b(video)\b/i.test(text);

    // ── Routing intent (computed first so we know whether Python/base64 is needed) ──
    // PYTHON_ONLY = things the client tools genuinely cannot produce
    const PYTHON_ONLY_KEYWORDS = /\b(regression|scatter|histogram|seaborn|matplotlib|numpy|time.?series|heatmap|box.?plot|violin|distribut|linear.?model|logistic|forecast|trend.?line)\b/i;
    const wantPythonOnly = PYTHON_ONLY_KEYWORDS.test(text);
    const wantCode = CODE_KEYWORDS.test(text) && !sessionCsvRows;
    const capturedCsv = csvContext;
    const capturedJson = jsonContext;
    // Base64 is only worth sending when Gemini will actually run Python
    const needsBase64 = !!capturedCsv && wantPythonOnly;
    // Mode selection:
    //   useTools        — CSV loaded + no Python needed → client-side JS tools (free, fast)
    //   useCodeExecution — Python explicitly needed (regression, histogram, etc.)
    //   else            — Google Search streaming (also used for "tell me about this file")
    const useTools = !!sessionCsvRows && !wantPythonOnly && !wantCode && !capturedCsv;
    const useCodeExecution = wantPythonOnly || wantCode;

    // ── Build prompt ─────────────────────────────────────────────────────────
    // sessionSummary: auto-computed column stats, included with every message
    const sessionSummary = csvDataSummary || '';
    // slimCsv: key columns only (text, type, metrics, engagement) as plain readable CSV
    // ~6-10k tokens — Gemini reads it directly so it can answer from context or call tools
    const slimCsvBlock = sessionSlimCsv
      ? `\n\nFull dataset (key columns):\n\`\`\`csv\n${sessionSlimCsv}\n\`\`\``
      : '';

    const csvPrefix = capturedCsv
      ? needsBase64
        // Python path: send base64 so Gemini can load it with pandas
        ? `[CSV File: "${capturedCsv.name}" | ${capturedCsv.rowCount} rows | Columns: ${capturedCsv.headers.join(', ')}]

${sessionSummary}${slimCsvBlock}

IMPORTANT — to load the full data in Python use this exact pattern:
\`\`\`python
import pandas as pd, io, base64
df = pd.read_csv(io.BytesIO(base64.b64decode("${capturedCsv.base64}")))
\`\`\`

---

`
        // Standard path: plain CSV text — no encoding needed
        : `[CSV File: "${capturedCsv.name}" | ${capturedCsv.rowCount} rows | Columns: ${capturedCsv.headers.join(', ')}]

${sessionSummary}${slimCsvBlock}

---

`
      : sessionSummary
      ? `[CSV columns: ${sessionCsvHeaders?.join(', ')}]\n\n${sessionSummary}\n\n---\n\n`
      : '';

    const jsonPrefix =
      capturedJson && channelJson
        ? `[YouTube Channel JSON: "${capturedJson.name}" | ${
            Array.isArray(channelJson?.videos)
              ? channelJson.videos.length
              : Array.isArray(channelJson?.items)
                ? channelJson.items.length
                : 'unknown'
          } videos]\n\n${channelJsonSummary}\n\n---\n\n`
        : capturedJson && jsonError
          ? `[YouTube Channel JSON: "${capturedJson.name}"]\n\n${jsonError}\n\n---\n\n`
          : '';

    // userContent  — displayed in bubble and stored in MongoDB (never contains base64)
    // promptForGemini — sent to the Gemini API (may contain the full prefix)
    const userContent =
      text ||
      (images.length ? '(Image)' : capturedCsv ? '(CSV attached)' : '(JSON attached)');
    const promptForGemini =
      jsonPrefix +
      csvPrefix +
      (text ||
        (images.length
          ? 'What do you see in this image?'
          : capturedJson
            ? 'Please analyze this YouTube channel JSON.'
            : 'Please analyze this CSV data.'));

    const userMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: userContent,
      timestamp: new Date().toISOString(),
      images: [...images],
      csvName: capturedCsv?.name || null,
    };

    setMessages((m) => [...m, userMsg]);
    setInput('');
    const capturedImages = [...images];
    setImages([]);
    setCsvContext(null);
    setJsonContext(null);
    setStreaming(true);

    // Store display text only — base64 is never persisted
    await saveMessage(sessionId, 'user', userContent, capturedImages.length ? capturedImages : null);

    // ── generateImage tool path (client-side) ────────────────────────────────
    if (wantsGenerateImage) {
      const assistantId = `a-${Date.now()}`;
      setMessages((m) => [
        ...m,
        { id: assistantId, role: 'model', content: '', timestamp: new Date().toISOString() },
      ]);

      try {
        const prompt = text.replace(/^\s*generateimage\s*:/i, '').trim() || 'Generate an image.';
        const anchor = capturedImages.length ? capturedImages[0] : null;
        const out = await generateImageTool({
          prompt,
          anchorImage: anchor ? { data: anchor.data, mimeType: anchor.mimeType } : null,
        });

        const modelImages = [{ data: out.data, mimeType: out.mimeType, name: 'generated-image' }];

        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: prompt ? `Generated image for: "${prompt}"` : 'Generated image.',
                  images: modelImages,
                }
              : msg
          )
        );

        await saveMessage(sessionId, 'model', prompt ? `Generated image for: "${prompt}"` : 'Generated image.', modelImages);
      } catch (err) {
        const errText = `Error: ${err.message || 'Image generation failed'}`;
        setMessages((m) => m.map((msg) => (msg.id === assistantId ? { ...msg, content: errText } : msg)));
        await saveMessage(sessionId, 'model', errText, null);
      } finally {
        setStreaming(false);
        inputRef.current?.focus();
      }

      return;
    }

    // ── JSON tools on channelJson (metric plot, stats, play video) ──────────
    if (channelJson && (wantsMetricPlot || wantsStatsJson || wantsPlayVideo)) {
      const assistantId = `a-${Date.now()}`;
      setMessages((m) => [
        ...m,
        { id: assistantId, role: 'model', content: '', timestamp: new Date().toISOString() },
      ]);

      try {
        let charts = [];
        let toolCalls = [];
        let contentText = '';

        if (wantsMetricPlot) {
          const metricMatch =
            text.match(/plot_metric_vs_time\s*:\s*([a-zA-Z_]+)/i) ||
            text.match(/\b(views?|likes?|comments?)\b/i);
          const metricRaw = metricMatch ? metricMatch[1] || metricMatch[0] : 'view_count';
          const metricKey = /like/i.test(metricRaw)
            ? 'like_count'
            : /comment/i.test(metricRaw)
              ? 'comment_count'
              : 'view_count';

          const chart = require('../services/jsonTools').plotMetricVsTimeTool(channelJson, {
            metric: metricKey,
          });
          toolCalls.push({ name: 'plot_metric_vs_time', args: { metric: metricKey }, result: chart });
          if (!chart.error && chart._chartType === 'metric_vs_time') {
            charts.push(chart);
            contentText = `Plotted ${metricKey} vs time for ${chart.data.length} videos.`;
          } else {
            contentText = chart.error || 'Could not plot metric vs time.';
          }
        } else if (wantsStatsJson) {
          const fieldMatch =
            text.match(/compute_stats_json\s*:\s*([a-zA-Z_]+)/i) ||
            text.match(/\b(views?|likes?|comments?|duration)\b/i);
          const raw = fieldMatch ? fieldMatch[1] || fieldMatch[0] : 'view_count';
          const fieldKey = /like/i.test(raw)
            ? 'like_count'
            : /comment/i.test(raw)
              ? 'comment_count'
              : /duration/i.test(raw)
                ? 'duration'
                : 'view_count';

          const stats = require('../services/jsonTools').computeStatsJsonTool(channelJson, {
            field: fieldKey,
          });
          toolCalls.push({ name: 'compute_stats_json', args: { field: fieldKey }, result: stats });
          if (!stats.error) {
            contentText = `Stats for ${fieldKey} (n=${stats.count}): mean=${stats.mean.toFixed(
              2
            )}, median=${stats.median.toFixed(2)}, std=${stats.std.toFixed(
              2
            )}, min=${stats.min}, max=${stats.max}.`;
          } else {
            contentText = stats.error;
          }
        } else if (wantsPlayVideo) {
          const whichMatch = text.match(/play_video\s*:\s*(.+)$/i);
          const which = whichMatch ? whichMatch[1].trim() : text;
          const info = require('../services/jsonTools').playVideoTool(channelJson, { which });
          toolCalls.push({ name: 'play_video', args: { which }, result: info });
          if (!info.error) {
            contentText = `Opening video: ${info.title}`;
            charts.push({
              _chartType: 'video_card',
              title: info.title,
              thumbnailUrl: info.thumbnailUrl,
              url: info.url,
            });
          } else {
            contentText = info.error;
          }
        }

        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: contentText,
                  charts: charts.length ? charts : undefined,
                  toolCalls: toolCalls.length ? toolCalls : undefined,
                }
              : msg
          )
        );

        await saveMessage(
          sessionId,
          'model',
          contentText,
          null,
          charts.length ? charts : null,
          toolCalls.length ? toolCalls : null
        );
      } catch (err) {
        const errText = `Error: ${err.message || 'Tool failed'}`;
        setMessages((m) =>
          m.map((msg) => (msg.id === assistantId ? { ...msg, content: errText } : msg))
        );
        await saveMessage(sessionId, 'model', errText, null);
      } finally {
        setStreaming(false);
        inputRef.current?.focus();
      }

      return;
    }

    const imageParts = capturedImages.map((img) => ({ mimeType: img.mimeType, data: img.data }));

    // History: plain display text only — session summary handles CSV context on every message
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'model')
      .map((m) => ({ role: m.role, content: m.content || messageText(m) }));

    // Ensure the model knows who the user is (for grading + personalization).
    const fullName = `${String(firstName || '').trim()} ${String(lastName || '').trim()}`.trim();
    const userHeader = fullName ? `User: ${fullName} (@${username})` : `User: @${username}`;
    const historyWithUserHeader = [{ role: 'user', content: userHeader }, ...history];

    const assistantId = `a-${Date.now()}`;
    setMessages((m) => [
      ...m,
      { id: assistantId, role: 'model', content: '', timestamp: new Date().toISOString() },
    ]);

    abortRef.current = false;

    let fullContent = '';
    let groundingData = null;
    let structuredParts = null;
    let toolCharts = [];
    let toolCalls = [];

    try {
      if (useTools) {
        // ── Function-calling path: Gemini picks tool + args, JS executes ──────
        console.log('[Chat] useTools=true | rows:', sessionCsvRows.length, '| headers:', sessionCsvHeaders);
        const { text: answer, charts: returnedCharts, toolCalls: returnedCalls } = await chatWithCsvTools(
          historyWithUserHeader,
          promptForGemini,
          sessionCsvHeaders,
          (toolName, args) => executeTool(toolName, args, sessionCsvRows)
        );
        fullContent = answer;
        toolCharts = returnedCharts || [];
        toolCalls = returnedCalls || [];
        console.log('[Chat] returnedCharts:', JSON.stringify(toolCharts));
        console.log('[Chat] toolCalls:', toolCalls.map((t) => t.name));
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: fullContent,
                  charts: toolCharts.length ? toolCharts : undefined,
                  toolCalls: toolCalls.length ? toolCalls : undefined,
                }
              : msg
          )
        );
      } else {
        // ── Streaming path: code execution or search ─────────────────────────
        for await (const chunk of streamChat(historyWithUserHeader, promptForGemini, imageParts, useCodeExecution)) {
          if (abortRef.current) break;
          if (chunk.type === 'text') {
            fullContent += chunk.text;
            // eslint-disable-next-line no-loop-func
            setMessages((m) =>
              m.map((msg) => (msg.id === assistantId ? { ...msg, content: fullContent } : msg))
            );
          } else if (chunk.type === 'fullResponse') {
            structuredParts = chunk.parts;
            // eslint-disable-next-line no-loop-func
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId ? { ...msg, content: '', parts: structuredParts } : msg
              )
            );
          } else if (chunk.type === 'grounding') {
            groundingData = chunk.data;
          }
        }
      }
    } catch (err) {
      const errText = `Error: ${err.message}`;
      setMessages((m) =>
        m.map((msg) => (msg.id === assistantId ? { ...msg, content: errText } : msg))
      );
      fullContent = errText;
    }

    if (groundingData) {
      setMessages((m) =>
        m.map((msg) => (msg.id === assistantId ? { ...msg, grounding: groundingData } : msg))
      );
    }

    // Save plain text + any tool charts to DB
    const savedContent = structuredParts
      ? structuredParts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      : fullContent;
    await saveMessage(
      sessionId,
      'model',
      savedContent,
      null,
      toolCharts.length ? toolCharts : null,
      toolCalls.length ? toolCalls : null
    );

    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, messageCount: s.messageCount + 2 } : s))
    );

    setStreaming(false);
    inputRef.current?.focus();
  };

  const removeImage = (i) => setImages((prev) => prev.filter((_, idx) => idx !== i));

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    const diffDays = Math.floor((Date.now() - d) / 86400000);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 0) return `Today · ${time}`;
    if (diffDays === 1) return `Yesterday · ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="chat-layout">
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)} role="dialog" aria-modal="true">
          <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <img
              src={`data:${lightbox.mimeType};base64,${lightbox.data}`}
              alt="Enlarged"
              className="lightbox-img"
            />
            <div className="lightbox-actions">
              <button
                type="button"
                className="lightbox-btn"
                onClick={() => downloadImage(lightbox, 'chat-image.png')}
              >
                Download
              </button>
              <button type="button" className="lightbox-btn secondary" onClick={() => setLightbox(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {chartLightbox && (
        <div className="lightbox" onClick={() => setChartLightbox(null)} role="dialog" aria-modal="true">
          <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <div className="chart-lightbox-body" ref={chartRef}>
              <MetricVsTimeChart
                data={chartLightbox.chart.data}
                metric={chartLightbox.chart.metric}
              />
            </div>
            <div className="lightbox-actions">
              <button
                type="button"
                className="lightbox-btn"
                onClick={() => downloadChartAsPng('metric-vs-time.png')}
              >
                Download PNG
              </button>
              <button
                type="button"
                className="lightbox-btn secondary"
                onClick={() => setChartLightbox(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── Sidebar ──────────────────────────────── */}
      <aside className="chat-sidebar">
        <div className="sidebar-top">
          <h1 className="sidebar-title">Chat</h1>
          <button className="new-chat-btn" onClick={handleNewChat}>
            + New Chat
          </button>
        </div>

        <div className="sidebar-sessions">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`sidebar-session${session.id === activeSessionId ? ' active' : ''}`}
              onClick={() => handleSelectSession(session.id)}
            >
              <div className="sidebar-session-info">
                <span className="sidebar-session-title">{session.title}</span>
                <span className="sidebar-session-date">{formatDate(session.createdAt)}</span>
              </div>
              <div
                className="sidebar-session-menu"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenuId(openMenuId === session.id ? null : session.id);
                }}
              >
                <span className="three-dots">⋮</span>
                {openMenuId === session.id && (
                  <div className="session-dropdown">
                    <button
                      className="session-delete-btn"
                      onClick={(e) => handleDeleteSession(session.id, e)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <span className="sidebar-username">
            {String(`${firstName || ''} ${lastName || ''}`).trim() || username}
          </span>
          <button onClick={onLogout} className="sidebar-logout">
            Log out
          </button>
        </div>
      </aside>

      {/* ── Main chat area ───────────────────────── */}
      <div className="chat-main">
        <>
        <header className="chat-header">
          <h2 className="chat-header-title">{activeSession?.title ?? 'New Chat'}</h2>
        </header>

        <div
          className={`chat-messages${dragOver ? ' drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.role}`}>
              <div className="chat-msg-meta">
                <span className="chat-msg-role">{m.role === 'user' ? username : 'Lisa'}</span>
                <span className="chat-msg-time">
                  {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>

              {/* CSV badge on user messages */}
              {m.csvName && (
                <div className="msg-csv-badge">
                  📄 {m.csvName}
                </div>
              )}

              {/* Image attachments */}
              {m.images?.length > 0 && (
                <div className="chat-msg-images">
                  {m.images.map((img, i) => (
                    <img
                      key={i}
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt=""
                      className="chat-msg-thumb"
                      onClick={() => setLightbox({ data: img.data, mimeType: img.mimeType, name: img.name })}
                      title="Click to enlarge"
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && setLightbox({ data: img.data, mimeType: img.mimeType, name: img.name })}
                    />
                  ))}
                </div>
              )}

              {/* Message body */}
              <div className="chat-msg-content">
                {m.role === 'model' ? (
                  m.parts ? (
                    <StructuredParts parts={m.parts} />
                  ) : m.content ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  ) : (
                    <span className="thinking-dots">
                      <span /><span /><span />
                    </span>
                  )
                ) : (
                  m.content
                )}
              </div>

              {/* Tool calls log */}
              {m.toolCalls?.length > 0 && (
                <details className="tool-calls-details">
                  <summary className="tool-calls-summary">
                    🔧 {m.toolCalls.length} tool{m.toolCalls.length > 1 ? 's' : ''} used
                  </summary>
                  <div className="tool-calls-list">
                    {m.toolCalls.map((tc, i) => (
                      <div key={i} className="tool-call-item">
                        <span className="tool-call-name">{tc.name}</span>
                        <span className="tool-call-args">{JSON.stringify(tc.args)}</span>
                        {tc.result && !tc.result._chartType && (
                          <span className="tool-call-result">
                            → {JSON.stringify(tc.result).slice(0, 200)}
                            {JSON.stringify(tc.result).length > 200 ? '…' : ''}
                          </span>
                        )}
                        {tc.result?._chartType && (
                          <span className="tool-call-result">→ rendered chart</span>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Charts from tool calls */}
              {m.charts?.map((chart, ci) => {
                if (chart._chartType === 'engagement') {
                  return (
                    <EngagementChart
                      key={ci}
                      data={chart.data}
                      metricColumn={chart.metricColumn}
                    />
                  );
                }
                if (chart._chartType === 'metric_vs_time') {
                  return (
                    <div key={ci} className="metric-chart-block">
                      <MetricVsTimeChart
                        data={chart.data}
                        metric={chart.metric}
                      />
                      <div className="metric-chart-actions">
                        <button
                          type="button"
                          className="metric-chart-btn"
                          onClick={() => setChartLightbox({ chart })}
                        >
                          Expand & download
                        </button>
                      </div>
                    </div>
                  );
                }
                if (chart._chartType === 'video_card') {
                  return (
                    <div key={ci} className="video-card">
                      {chart.thumbnailUrl && (
                        <img
                          src={chart.thumbnailUrl}
                          alt={chart.title || 'Video thumbnail'}
                          className="video-card-thumb"
                        />
                      )}
                      <div className="video-card-body">
                        <div className="video-card-title">{chart.title}</div>
                        {chart.url && (
                          <button
                            type="button"
                            className="video-card-btn"
                            onClick={() => window.open(chart.url, '_blank', 'noopener')}
                          >
                            Open on YouTube
                          </button>
                        )}
                      </div>
                    </div>
                  );
                }
                return null;
              })}

              {/* Search sources */}
              {m.grounding?.groundingChunks?.length > 0 && (
                <div className="chat-msg-sources">
                  <span className="sources-label">Sources</span>
                  <div className="sources-list">
                    {m.grounding.groundingChunks.map((chunk, i) =>
                      chunk.web ? (
                        <a key={i} href={chunk.web.uri} target="_blank" rel="noreferrer" className="source-link">
                          {chunk.web.title || chunk.web.uri}
                        </a>
                      ) : null
                    )}
                  </div>
                  {m.grounding.webSearchQueries?.length > 0 && (
                    <div className="sources-queries">
                      Searched: {m.grounding.webSearchQueries.join(' · ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {dragOver && <div className="chat-drop-overlay">Drop CSV, JSON, or images here</div>}

        {/* ── Input area ── */}
        <div className="chat-input-area">
          {/* CSV chip */}
          {csvContext && (
            <div className="csv-chip">
              <span className="csv-chip-icon">📄</span>
              <span className="csv-chip-name">{csvContext.name}</span>
              <span className="csv-chip-meta">
                {csvContext.rowCount} rows · {csvContext.headers.length} cols
              </span>
              <button className="csv-chip-remove" onClick={() => setCsvContext(null)} aria-label="Remove CSV">×</button>
            </div>
          )}

          {/* JSON chip */}
          {jsonContext && (
            <div className="json-chip">
              <span className="json-chip-icon">🧾</span>
              <span className="json-chip-name">{jsonContext.name}</span>
              <span className="json-chip-meta">
                {channelJson
                  ? `${Array.isArray(channelJson?.videos) ? channelJson.videos.length : '—'} videos`
                  : jsonError
                    ? 'invalid'
                    : 'loaded'}
              </span>
              <button
                className="json-chip-remove"
                onClick={() => {
                  setJsonContext(null);
                  setChannelJson(null);
                  setChannelJsonSummary('');
                  setJsonError('');
                }}
                aria-label="Remove JSON"
              >
                ×
              </button>
            </div>
          )}

          {jsonContext && jsonError && (
            <div className="json-chip-error">{jsonError}</div>
          )}

          {/* Image previews */}
          {images.length > 0 && (
            <div className="chat-image-previews">
              {images.map((img, i) => (
                <div key={i} className="chat-img-preview">
                  <img src={`data:${img.mimeType};base64,${img.data}`} alt="" />
                  <button type="button" onClick={() => removeImage(i)} aria-label="Remove">×</button>
                </div>
              ))}
            </div>
          )}

          {/* Hidden file picker */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.csv,text/csv,.json,application/json"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />

          <div className="chat-input-row">
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming}
              title="Attach image, CSV, or JSON"
            >
              📎
            </button>
            <input
              ref={inputRef}
              type="text"
              placeholder="Ask a question, request analysis, or write & run code…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
              onPaste={handlePaste}
              disabled={streaming}
            />
            {streaming ? (
              <button onClick={handleStop} className="stop-btn">
                ■ Stop
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() && !images.length && !csvContext && !jsonContext}
              >
                Send
              </button>
            )}
          </div>
        </div>
        </>
      </div>
    </div>
  );
}
