import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AudioLines, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, Pencil, Plus, RefreshCw, Search, Star, Trash2 } from 'lucide-react';
import api from '../api/client.js';
import { useToast } from '../context/ToastContext.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import MixBar from '../components/MixBar.jsx';
import SpeakButton from '../components/SpeakButton.jsx';
import TranscriptionForm from '../components/TranscriptionForm.jsx';
import TranscriptionView from '../components/TranscriptionView.jsx';
import { ENGINE_LABELS, LANGUAGE_LABELS } from '../lib/script.js';
import { formatDate, formatDuration, formatMinutes, formatNumber } from '../lib/format.js';

const PAGE_SIZE = 10;

const SORTS = [
  { id: 'created_at:desc', label: 'Newest first' },
  { id: 'created_at:asc', label: 'Oldest first' },
  { id: 'updated_at:desc', label: 'Recently edited' },
  { id: 'word_count:desc', label: 'Longest first' },
  { id: 'title:asc', label: 'Title A to Z' },
];

const DEFAULT_FILTERS = { language: '', engine: '', favorite: '', sort: 'created_at:desc' };

export default function HistoryPage() {
  const toast = useToast();

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);

  const [data, setData] = useState({ items: [], pagination: { page: 1, totalPages: 1, total: 0 } });
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [selected, setSelected] = useState(() => new Set());
  const [viewing, setViewing] = useState(null);
  const [form, setForm] = useState(null); // { item } | { item: null } for create
  const [confirm, setConfirm] = useState(null); // { ids, label }

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // Debounce the search box.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query = useMemo(() => {
    const [sortBy, order] = filters.sort.split(':');
    return {
      search,
      language: filters.language,
      engine: filters.engine,
      favorite: filters.favorite,
      sortBy,
      order,
      page,
      limit: PAGE_SIZE,
    };
  }, [search, filters, page]);

  // Fetch the list (stale responses are aborted).
  const requestRef = useRef(null);
  useEffect(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError('');
    api
      .listTranscriptions(query, { signal: controller.signal })
      .then((result) => {
        setData(result);
        setSelected(new Set());
        // Deleting the last row of the last page: step back a page.
        if (result.items.length === 0 && query.page > 1) setPage(result.pagination.totalPages);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      })
      .finally(() => {
        if (requestRef.current === controller) setLoading(false);
      });
    return () => controller.abort();
  }, [query, reloadKey]);

  useEffect(() => {
    api
      .getStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, [reloadKey]);

  const setFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  };

  const filtersActive =
    search || filters.language || filters.engine || filters.favorite || filters.sort !== DEFAULT_FILTERS.sort;

  const clearFilters = () => {
    setSearchInput('');
    setSearch('');
    setFilters(DEFAULT_FILTERS);
    setPage(1);
  };

  // ── Mutations ──────────────────────────────────────────────────────────
  const submitForm = async (body) => {
    if (form?.item) {
      const updated = await api.updateTranscription(form.item.id, body);
      toast.show('Changes saved', { tone: 'success' });
      if (viewing?.id === updated.id) setViewing(updated);
    } else {
      await api.createTranscription(body);
      toast.show('Transcription created', { tone: 'success' });
    }
    setForm(null);
    reload();
  };

  const toggleFavorite = async (item) => {
    const next = !item.isFavorite;
    setData((d) => ({ ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, isFavorite: next } : i)) }));
    try {
      await api.updateTranscription(item.id, { isFavorite: next });
      setStats((s) => (s ? { ...s, favorites: s.favorites + (next ? 1 : -1) } : s));
      if (filters.favorite === 'true' && !next) reload();
    } catch (err) {
      setData((d) => ({ ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, isFavorite: !next } : i)) }));
      toast.show(err.message, { tone: 'error' });
    }
  };

  const confirmDelete = async () => {
    const { ids } = confirm;
    try {
      if (ids.length === 1) await api.deleteTranscription(ids[0]);
      else await api.deleteTranscriptions(ids);
      toast.show(ids.length === 1 ? 'Transcription deleted' : `${ids.length} transcriptions deleted`, {
        tone: 'success',
      });
      if (viewing && ids.includes(viewing.id)) setViewing(null);
      setConfirm(null);
      reload();
    } catch (err) {
      toast.show(err.message, { tone: 'error' });
    }
  };

  const toggleSelected = (id) =>
    setSelected((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOnPageSelected = data.items.length > 0 && data.items.every((i) => selected.has(i.id));
  const toggleAll = () => setSelected(allOnPageSelected ? new Set() : new Set(data.items.map((i) => i.id)));

  const { pagination } = data;
  const isEmptyLibrary = !loading && !error && pagination.total === 0 && !filtersActive;

  return (
    <div className="history">
      <header className="history__head">
        <div>
          <h1 className="page-title">History</h1>
          {stats && stats.total > 0 && (
            <p className="history__summary">
              {formatNumber(stats.total)} {stats.total === 1 ? 'transcription' : 'transcriptions'},{' '}
              {formatNumber(stats.totalWords)} words and {formatMinutes(stats.totalDurationMs)} of speech.{' '}
              {stats.favorites > 0 && `${stats.favorites} marked as favourite.`}
            </p>
          )}
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setForm({ item: null })}>
          <Plus size={18} aria-hidden="true" /> New transcription
        </button>
      </header>

      {stats && stats.total > 0 && <Activity days={stats.last7Days} byLanguage={stats.byLanguage} />}

      <div className="toolbar" role="search">
        <label className="search">
          <Search size={18} aria-hidden="true" />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search titles and text"
            aria-label="Search transcriptions"
          />
        </label>
        <select value={filters.language} onChange={(e) => setFilter('language', e.target.value)} aria-label="Language">
          <option value="">All languages</option>
          {Object.entries(LANGUAGE_LABELS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <select value={filters.engine} onChange={(e) => setFilter('engine', e.target.value)} aria-label="Engine">
          <option value="">All engines</option>
          {Object.entries(ENGINE_LABELS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <select value={filters.sort} onChange={(e) => setFilter('sort', e.target.value)} aria-label="Sort by">
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`btn btn--toggle${filters.favorite === 'true' ? ' btn--pressed' : ''}`}
          aria-pressed={filters.favorite === 'true'}
          onClick={() => setFilter('favorite', filters.favorite === 'true' ? '' : 'true')}
        >
          <Star size={16} aria-hidden="true" fill={filters.favorite === 'true' ? 'currentColor' : 'none'} /> Favourites
        </button>
      </div>

      {selected.size > 0 && (
        <div className="bulkbar" role="region" aria-label="Selection">
          <span className="bulkbar__count">{selected.size} selected</span>
          <button type="button" className="btn btn--link" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => setConfirm({ ids: [...selected], label: `${selected.size} transcriptions` })}
          >
            <Trash2 size={16} aria-hidden="true" /> Delete selected
          </button>
        </div>
      )}

      {error ? (
        <div className="alert" role="alert">
          <CircleAlert size={20} aria-hidden="true" />
          <p>{error}</p>
          <button type="button" className="btn btn--ghost" onClick={reload}>
            <RefreshCw size={16} aria-hidden="true" /> Try again
          </button>
        </div>
      ) : isEmptyLibrary ? (
        <div className="empty">
          <h2>Nothing saved yet</h2>
          <p>Dictate something and press Save to keep it here, or type one in by hand</p>
          <div className="empty__actions">
            <Link to="/" className="btn btn--primary">
              Start dictating!
            </Link>
            <button type="button" className="btn btn--ghost" onClick={() => setForm({ item: null })}>
              Type one in
            </button>
          </div>
        </div>
      ) : (
        <div className="results">
          <div className="list-head">
            <label className="check">
              <input type="checkbox" checked={allOnPageSelected} onChange={toggleAll} disabled={!data.items.length} />
              Select page
            </label>
            {loading && (
              <span className="list-head__loading">
                <LoaderCircle size={16} className="spin" aria-hidden="true" /> Loading
              </span>
            )}
            {!loading && (
              <span className="list-head__count">
                {pagination.total === 0 ? 'No matches' : `${formatNumber(pagination.total)} found`}
                {filtersActive && (
                  <button type="button" className="btn btn--link" onClick={clearFilters}>
                    Clear filters
                  </button>
                )}
              </span>
            )}
          </div>

          {loading && data.items.length === 0 ? (
            <ul className="entries" aria-hidden="true">
              {Array.from({ length: 5 }, (_, i) => (
                <li key={i} className="entry entry--skeleton">
                  <span className="entry__check sk sk--check" />
                  <span className="entry__main">
                    <span className="sk sk--title" />
                    <span className="sk sk--line" />
                  </span>
                  <span className="entry__meta">
                    <span className="sk sk--meta" />
                  </span>
                  <span className="entry__actions">
                    <span className="sk sk--actions" />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
          <ul className={`entries${loading ? ' entries--loading' : ''}`}>
            {data.items.map((item) => (
              <li key={item.id} className={`entry${selected.has(item.id) ? ' entry--selected' : ''}`}>
                <input
                  type="checkbox"
                  className="entry__check"
                  checked={selected.has(item.id)}
                  onChange={() => toggleSelected(item.id)}
                  aria-label={`Select ${item.title}`}
                />
                <button type="button" className="entry__main" onClick={() => setViewing(item)}>
                  <span className="entry__title">{item.title}</span>
                  <span className="entry__snippet">{item.content}</span>
                  <MixBar text={item.content} className="mix--thin" />
                </button>
                <div className="entry__meta">
                  <span className={`tag tag--${item.language}`}>{LANGUAGE_LABELS[item.language] || item.language}</span>
                  <span>{ENGINE_LABELS[item.engine] || item.engine}</span>
                  <span>
                    {item.wordCount} words{item.durationMs ? `, ${formatDuration(item.durationMs)}` : ''}
                  </span>
                  <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                  {item.audio && (
                    <span className="entry__audio">
                      <AudioLines size={14} aria-hidden="true" /> Recording
                    </span>
                  )}
                </div>
                <div className="entry__actions">
                  <SpeakButton id={item.id} text={item.content} />
                  <button
                    type="button"
                    className={`icon-btn${item.isFavorite ? ' icon-btn--star' : ''}`}
                    onClick={() => toggleFavorite(item)}
                    aria-pressed={item.isFavorite}
                    aria-label={item.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                    title={item.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                  >
                    <Star size={18} fill={item.isFavorite ? 'currentColor' : 'none'} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setForm({ item })}
                    aria-label={`Edit ${item.title}`}
                    title="Edit"
                  >
                    <Pencil size={18} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    onClick={() => setConfirm({ ids: [item.id], label: `“${item.title}”` })}
                    aria-label={`Delete ${item.title}`}
                    title="Delete"
                  >
                    <Trash2 size={18} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          )}

          {!loading && data.items.length === 0 && (
            <div className="empty empty--compact">
              <p>No transcriptions match these filters.</p>
              <button type="button" className="btn btn--ghost" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          )}

          {pagination.totalPages > 1 && (
            <nav className="pager" aria-label="Pagination">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
              >
                <ChevronLeft size={18} aria-hidden="true" /> Previous
              </button>
              <span>
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                disabled={page >= pagination.totalPages || loading}
              >
                Next <ChevronRight size={18} aria-hidden="true" />
              </button>
            </nav>
          )}
        </div>
      )}

      {viewing && (
        <TranscriptionView
          item={viewing}
          onClose={() => setViewing(null)}
          onEdit={(item) => {
            setViewing(null);
            setForm({ item });
          }}
        />
      )}

      {form && (
        <TranscriptionForm
          key={form.item?.id || 'new'}
          open
          initial={form.item}
          onClose={() => setForm(null)}
          onSubmit={submitForm}
        />
      )}

      {confirm && (
        <ConfirmDialog
          open
          title={confirm.ids.length === 1 ? 'Delete this transcription?' : `Delete ${confirm.ids.length} transcriptions?`}
          message={`${confirm.label} will be removed permanently. This can't be undone.`}
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

/** Seven-day activity strip plus the language split of the whole library. */
function Activity({ days = [], byLanguage = {} }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const total = Object.values(byLanguage).reduce((a, b) => a + b, 0) || 1;

  return (
    <section className="activity" aria-label="Activity">
      <div className="activity__days">
        <h2 className="panel__title">Last 7 days</h2>
        <ol className="days">
          {days.map((d) => (
            <li key={d.day} title={`${d.count} on ${d.day}`}>
              <span className="days__bar" style={{ height: `${(d.count / max) * 100}%` }} />
              <span className="days__count">{d.count}</span>
              <span className="days__label">{dayFmt.format(new Date(`${d.day}T12:00:00`))}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="activity__langs">
        <h2 className="panel__title">By language</h2>
        <ul className="langs">
          {['mixed', 'hi', 'en', 'other']
            .filter((k) => byLanguage[k])
            .map((k) => (
              <li key={k}>
                <span className="langs__label">{LANGUAGE_LABELS[k]}</span>
                <span className="langs__track">
                  <span className={`langs__fill langs__fill--${k}`} style={{ width: `${(byLanguage[k] / total) * 100}%` }} />
                </span>
                <span className="langs__count">{byLanguage[k]}</span>
              </li>
            ))}
        </ul>
      </div>
    </section>
  );
}
