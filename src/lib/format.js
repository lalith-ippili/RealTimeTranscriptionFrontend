export const formatDuration = (ms = 0) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

export const formatMinutes = (ms = 0) => {
  const minutes = ms / 60000;
  if (minutes < 1) return `${Math.round(ms / 1000)} s`;
  return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
};

const dateFmt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `Today, ${timeFmt.format(d)}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${timeFmt.format(d)}`;
  return dateFmt.format(d);
};

export const formatNumber = (n = 0) => new Intl.NumberFormat().format(n);
