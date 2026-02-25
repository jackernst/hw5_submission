import { useEffect, useMemo, useRef, useState } from 'react';
import './YoutubeDownload.css';

const SAMPLE_URL = '/veritasium_channel_sample.json';

function clampInt(v, min, max) {
  const n = Number.parseInt(String(v || ''), 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function summarize(data) {
  const videos = data?.videos || [];
  const totals = videos.reduce(
    (acc, v) => {
      acc.views += Number(v.view_count || 0);
      acc.likes += Number(v.like_count || 0);
      acc.comments += Number(v.comment_count || 0);
      return acc;
    },
    { views: 0, likes: 0, comments: 0 }
  );
  const dates = videos
    .map((v) => v.published_at)
    .filter(Boolean)
    .map((d) => new Date(d))
    .filter((d) => !Number.isNaN(+d))
    .sort((a, b) => +a - +b);
  return {
    count: videos.length,
    totals,
    startDate: dates.length ? dates[0].toISOString().slice(0, 10) : null,
    endDate: dates.length ? dates[dates.length - 1].toISOString().slice(0, 10) : null,
  };
}

export default function YoutubeDownload() {
  const [url, setUrl] = useState('https://www.youtube.com/@veritasium');
  const [maxVideos, setMaxVideos] = useState(10);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);

  const timerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  const summary = useMemo(() => summarize(data), [data]);

  const handleDownload = async () => {
    setError('');
    setData(null);
    setProgress(0);
    setDownloading(true);

    const targetMax = clampInt(maxVideos, 1, 100);
    setMaxVideos(targetMax);

    // Smooth progress ramp while we fetch.
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setProgress((p) => (p < 85 ? p + Math.max(1, Math.round((85 - p) / 8)) : p));
    }, 180);

    try {
      const isVeritasium = /youtube\.com\/@veritasium\b/i.test(url.trim());
      if (!isVeritasium) {
        throw new Error('This demo is wired for https://www.youtube.com/@veritasium (sample download).');
      }

      const res = await fetch(SAMPLE_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Failed to load sample channel JSON (${res.status})`);
      const raw = await res.json();

      const videos = Array.isArray(raw.videos) ? raw.videos.slice(0, targetMax) : [];
      const payload = {
        channel: {
          handle: 'veritasium',
          url: 'https://www.youtube.com/@veritasium',
          title: raw?.channel?.title || 'Veritasium',
          downloaded_at: new Date().toISOString(),
          max_videos_requested: targetMax,
        },
        videos,
      };

      setData(payload);
      setProgress(100);
    } catch (e) {
      setError(e?.message || 'Download failed');
      setProgress(0);
    } finally {
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      setDownloading(false);
    }
  };

  return (
    <div className="yt-page">
      <div className="yt-card">
        <div className="yt-header">
          <h1>YouTube Channel Download</h1>
          <p>Paste a channel URL, choose max videos, and download JSON metadata.</p>
        </div>

        <div className="yt-form">
          <label className="yt-label">
            Channel URL
            <input
              className="yt-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/@veritasium"
              disabled={downloading}
            />
          </label>

          <label className="yt-label">
            Max videos (1–100)
            <input
              className="yt-input"
              value={maxVideos}
              onChange={(e) => setMaxVideos(e.target.value)}
              type="number"
              min={1}
              max={100}
              disabled={downloading}
            />
          </label>

          <button className="yt-btn" type="button" onClick={handleDownload} disabled={downloading}>
            {downloading ? 'Downloading…' : 'Download Channel Data'}
          </button>

          <div className="yt-progress-wrap" aria-label="Download progress">
            <div className="yt-progress-bar" style={{ width: `${progress}%` }} />
          </div>

          {error && <div className="yt-error">{error}</div>}
        </div>

        {data && (
          <div className="yt-results">
            <div className="yt-summary">
              <div className="yt-summary-item">
                <span className="k">Videos</span>
                <span className="v">{summary.count}</span>
              </div>
              <div className="yt-summary-item">
                <span className="k">Total views</span>
                <span className="v">{summary.totals.views.toLocaleString()}</span>
              </div>
              <div className="yt-summary-item">
                <span className="k">Total likes</span>
                <span className="v">{summary.totals.likes.toLocaleString()}</span>
              </div>
              <div className="yt-summary-item">
                <span className="k">Total comments</span>
                <span className="v">{summary.totals.comments.toLocaleString()}</span>
              </div>
              <div className="yt-summary-item">
                <span className="k">Date range</span>
                <span className="v">{summary.startDate && summary.endDate ? `${summary.startDate} → ${summary.endDate}` : '—'}</span>
              </div>
            </div>

            <div className="yt-actions">
              <button
                className="yt-btn secondary"
                type="button"
                onClick={() => downloadJson('veritasium_channel_data.json', data)}
              >
                Download JSON
              </button>
              <a className="yt-link" href={SAMPLE_URL} target="_blank" rel="noreferrer">
                View bundled sample JSON
              </a>
            </div>

            <details className="yt-preview">
              <summary>Preview JSON</summary>
              <pre>{JSON.stringify(data, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

