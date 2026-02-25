import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';

function MetricTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div
      style={{
        background: 'rgba(15, 23, 42, 0.96)',
        padding: '0.55rem 0.75rem',
        borderRadius: 10,
        border: '1px solid rgba(148, 163, 184, 0.4)',
        fontSize: '0.8rem',
        color: '#e5e7eb',
        boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{label}</div>
      <div>
        {p.name}: <strong>{p.value.toLocaleString()}</strong>
      </div>
      {p.payload.label && (
        <div style={{ marginTop: 4, opacity: 0.8 }}>{p.payload.label}</div>
      )}
    </div>
  );
}

export default function MetricVsTimeChart({ data, metric }) {
  if (!data?.length) return null;

  return (
    <div className="metric-chart-wrap">
      <p className="metric-chart-label">
        {metric || 'Metric'} vs time
      </p>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart
          data={data}
          margin={{ top: 6, right: 14, left: 0, bottom: 32 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.08)"
            vertical={false}
          />
          <XAxis
            dataKey="date"
            tick={{
              fill: 'rgba(255,255,255,0.7)',
              fontSize: 11,
              fontFamily: 'Inter, sans-serif',
            }}
            axisLine={{ stroke: 'rgba(255,255,255,0.18)' }}
            tickLine={false}
          />
          <YAxis
            tick={{
              fill: 'rgba(255,255,255,0.6)',
              fontSize: 11,
              fontFamily: 'Inter, sans-serif',
            }}
            axisLine={false}
            tickLine={false}
            width={70}
          />
          <Tooltip content={<MetricTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
          <Line
            type="monotone"
            dataKey="value"
            name={metric || 'value'}
            stroke="#38bdf8"
            strokeWidth={2.3}
            dot={{ r: 2.2, strokeWidth: 0 }}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

