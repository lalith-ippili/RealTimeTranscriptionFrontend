import { lazy, Suspense, useEffect } from 'react';
import { Link, NavLink, Outlet, Route, Routes } from 'react-router-dom';
import { History, LoaderCircle, Mic, Moon, RefreshCw, Sun } from 'lucide-react';
import { ApiStatusProvider, useApiStatus } from './context/ApiStatusContext.jsx';
import { SpeakerProvider } from './context/SpeakerContext.jsx';
import { ThemeProvider, useTheme } from './context/ThemeContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';

// Route-level code splitting: each page is its own chunk.
const loadDictate = () => import('./pages/DictatePage.jsx');
const loadHistory = () => import('./pages/HistoryPage.jsx');
const DictatePage = lazy(loadDictate);
const HistoryPage = lazy(loadHistory);

function ServerStatus() {
  const { phase, refresh } = useApiStatus();
  const text = {
    checking: 'Connecting',
    waking: 'Waking server',
    offline: 'Server offline',
    degraded: 'Database offline',
    online: 'Online',
  }[phase];

  return (
    <button
      type="button"
      className={`server server--${phase}`}
      onClick={refresh}
      title="Check the server connection again"
    >
      <span className="server__dot" aria-hidden="true" />
      <span className="server__text">{text}</span>
    </button>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === 'dark' ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
    </button>
  );
}

/** Explains slow first loads (free hosting sleeps) and a broken database. */
function StatusBanner() {
  const { phase, dbHint, refresh } = useApiStatus();
  if (phase === 'waking') {
    return (
      <div className="banner banner--info" role="status">
        <LoaderCircle size={16} className="spin" aria-hidden="true" />
        <p>Starting the server. Free hosting sleeps when idle, so the first load can take up to a minute.</p>
      </div>
    );
  }
  if (phase === 'degraded' || phase === 'offline') {
    return (
      <div className="banner banner--error" role="alert">
        <p>
          {phase === 'offline'
            ? "Can't reach the server. Saving and history are unavailable; the Whisper and Browser engines still work."
            : `The server can't reach the database${dbHint ? `: ${dbHint}` : '.'}`}
        </p>
        <button type="button" className="btn btn--link" onClick={refresh}>
          <RefreshCw size={14} aria-hidden="true" /> Retry
        </button>
      </div>
    );
  }
  return null;
}

function PageLoader() {
  return (
    <div className="page-loader" role="status">
      <LoaderCircle size={22} className="spin" aria-hidden="true" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

function Layout() {
  // Fetch the other page's code in the background so switching is instant.
  useEffect(() => {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    idle(() => {
      loadDictate();
      loadHistory();
    });
  }, []);

  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <Link to="/" className="brand" aria-label="Bolo home">
            <span className="brand__mark" aria-hidden="true">
              <Mic size={16} strokeWidth={2.5} />
            </span>
            <span className="brand__deva" lang="hi">
              बोलो
            </span>
            <span className="brand__latin">Bolo</span>
          </Link>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>
              <Mic size={16} aria-hidden="true" /> Dictate
            </NavLink>
            <NavLink to="/history">
              <History size={16} aria-hidden="true" /> History
            </NavLink>
          </nav>
          <div className="topbar__end">
            <ServerStatus />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <StatusBanner />
      <main id="main" className="content">
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <div className="empty">
      <h1 className="page-title">This page doesn&rsquo;t exist</h1>
      <p>The link may be old or mistyped.</p>
      <Link to="/" className="btn btn--primary">
        Go to dictation
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ApiStatusProvider>
          <SpeakerProvider>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<DictatePage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </SpeakerProvider>
        </ApiStatusProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
