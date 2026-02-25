import { GoogleGenAI } from '@google/genai';

const genAI = new GoogleGenAI({ apiKey: process.env.REACT_APP_GEMINI_API_KEY || '' });

// Tool declarations (used later for function calling + prompt docs)
export const JSON_TOOL_DECLARATIONS = [
  {
    name: 'generateImage',
    description:
      'Generate an image from a text prompt, optionally using an anchor image provided by the user. Returns a base64-encoded image.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text prompt describing the image to generate.' },
        anchorImage: {
          type: 'object',
          description:
            'Optional anchor image (base64) to guide the generation. Use when the user attached an image.',
          properties: {
            data: { type: 'string', description: 'Base64 image data (no data URL prefix).' },
            mimeType: { type: 'string', description: 'Image MIME type, e.g. image/png.' },
          },
          required: ['data', 'mimeType'],
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'plot_metric_vs_time',
    description:
      'Plot a numeric metric (views, likes, comments, etc.) vs time for the loaded YouTube channel JSON.',
    parameters: {
      type: 'object',
      properties: { metric: { type: 'string' } },
      required: ['metric'],
    },
  },
  {
    name: 'play_video',
    description:
      'Pick a video from the loaded channel JSON by title, ordinal (first), or most viewed and return its title, thumbnail, and URL.',
    parameters: {
      type: 'object',
      properties: { which: { type: 'string' } },
      required: ['which'],
    },
  },
  {
    name: 'compute_stats_json',
    description:
      'Compute mean, median, std, min, max for a numeric field (view_count, like_count, comment_count, duration) across all videos in the loaded channel JSON.',
    parameters: {
      type: 'object',
      properties: { field: { type: 'string' } },
      required: ['field'],
    },
  },
];

export async function generateImageTool({ prompt, anchorImage }) {
  // Image generation uses the Interactions API with response_modalities.
  // Model name per current GenAI docs.
  const interaction = await genAI.interactions.create({
    model: 'gemini-3-pro-image-preview',
    input: [
      { type: 'text', text: prompt },
      ...(anchorImage?.data
        ? [
            {
              type: 'image',
              data: anchorImage.data,
              mime_type: anchorImage.mimeType || 'image/png',
            },
          ]
        : []),
    ],
    response_modalities: ['image'],
  });

  const outputs = interaction?.outputs || [];
  const img = outputs.find((o) => o.type === 'image' && o.data);
  if (!img) {
    throw new Error('No image was returned by the model.');
  }

  return {
    mimeType: img.mime_type || 'image/png',
    data: img.data,
  };
}

// Helper to normalise channel JSON into a simple videos array
const getVideos = (channelJson) => {
  if (!channelJson) return [];
  if (Array.isArray(channelJson.videos)) return channelJson.videos;
  if (Array.isArray(channelJson.items)) return channelJson.items;
  return [];
};

export function plotMetricVsTimeTool(channelJson, { metric }) {
  const videos = getVideos(channelJson);
  if (!videos.length) {
    return { error: 'No videos loaded. Please attach a YouTube channel JSON file first.' };
  }

  const key = metric || 'view_count';
  const data = videos
    .map((v) => {
      const rawDate = v.published_at || v.publishedAt || v.snippet?.publishedAt;
      const title = v.title || v.snippet?.title || '';
      const value =
        v[key] ??
        v[`${key}_count`] ??
        v.statistics?.[key] ??
        v.statistics?.[`${key}_count`] ??
        (key === 'view_count' ? v.view_count || v.statistics?.viewCount : undefined);
      const n = Number(value);
      const d = rawDate ? new Date(rawDate) : null;
      if (!rawDate || !d || Number.isNaN(+d) || Number.isNaN(n)) return null;
      return {
        date: d.toISOString().slice(0, 10),
        label: title.slice(0, 60),
        value: n,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (!data.length) {
    return {
      error: `Could not find numeric data for metric "${metric}".`,
    };
  }

  return {
    _chartType: 'metric_vs_time',
    metric,
    data,
  };
}

export function playVideoTool(channelJson, { which }) {
  const videos = getVideos(channelJson);
  if (!videos.length) {
    return { error: 'No videos loaded. Please attach a YouTube channel JSON file first.' };
  }

  const normalised = videos.map((v) => ({
    videoId: v.video_id || v.id || v.contentDetails?.videoId,
    title: v.title || v.snippet?.title || '',
    thumbnailUrl:
      v.thumbnail_url ||
      v.snippet?.thumbnails?.high?.url ||
      v.snippet?.thumbnails?.default?.url ||
      '',
    viewCount:
      Number(v.view_count ?? v.statistics?.viewCount ?? v.viewCount ?? 0) || 0,
    url:
      v.video_url ||
      (v.video_id ? `https://www.youtube.com/watch?v=${v.video_id}` : null) ||
      (v.id ? `https://www.youtube.com/watch?v=${v.id}` : null),
  }));

  let chosen = normalised[0];
  const q = (which || '').toLowerCase();

  if (q.includes('most viewed') || q.includes('top') || q.includes('best')) {
    chosen = [...normalised].sort((a, b) => b.viewCount - a.viewCount)[0];
  } else if (q.includes('least viewed') || q.includes('worst')) {
    chosen = [...normalised].sort((a, b) => a.viewCount - b.viewCount)[0];
  } else if (q) {
    const byTitle = normalised.find((v) => v.title.toLowerCase().includes(q));
    if (byTitle) chosen = byTitle;
  }

  if (!chosen) return { error: 'Could not find a matching video in the channel JSON.' };

  return {
    videoId: chosen.videoId,
    title: chosen.title,
    thumbnailUrl: chosen.thumbnailUrl,
    url: chosen.url,
  };
}

export function computeStatsJsonTool(channelJson, { field }) {
  const videos = getVideos(channelJson);
  if (!videos.length) {
    return { error: 'No videos loaded. Please attach a YouTube channel JSON file first.' };
  }

  const key = field || 'view_count';
  const values = videos
    .map((v) => {
      const raw =
        v[key] ??
        v[`${key}_count`] ??
        v.statistics?.[key] ??
        v.statistics?.[`${key}_count`] ??
        (key === 'view_count' ? v.view_count || v.statistics?.viewCount : undefined);
      const n = Number(raw);
      return Number.isNaN(n) ? null : n;
    })
    .filter((v) => v !== null);

  if (!values.length) {
    return { error: `No numeric values found for field "${field}".` };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const count = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / count;
  const median =
    count % 2 === 0
      ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2
      : sorted[(count - 1) / 2];
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / count;
  const std = Math.sqrt(variance);

  return {
    field,
    count,
    mean,
    median,
    std,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}


