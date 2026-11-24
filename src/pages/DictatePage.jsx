import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, CircleAlert, Copy, Eraser, LoaderCircle, Pencil, Save, X } from 'lucide-react';
import api from '../api/client.js';
import { useApiStatus } from '../context/ApiStatusContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useTranscriber } from '../hooks/useTranscriber.js';
import {
  ENGINES,
  WEB_SPEECH_LANGUAGES,
  WHISPER_LANGUAGES,
  WHISPER_MODELS,
  isWebSpeechSupported,
} from '../engines/index.js';
import EnginePicker from '../components/EnginePicker.jsx';
import LevelMeter from '../components/LevelMeter.jsx';
import MixBar from '../components/MixBar.jsx';
import RecordButton from '../components/RecordButton.jsx';
import RecordingTimer from '../components/RecordingTimer.jsx';
import ScriptText from '../components/ScriptText.jsx';
import SpeakButton from '../components/SpeakButton.jsx';
import VoicePicker from '../components/VoicePicker.jsx';
import { countWords } from '../lib/script.js';

const EXAMPLE = 'कल की meeting को चार बजे reschedule कर दो, और client को email भेज देना।';

const readPref = (key, fallback) => {
  try {
    return localStorage.getItem(`bolo.${key}`) || fallback;
  } catch {
    return fallback;
  }
};
const writePref = (key, value) => {
  try {
    localStorage.setItem(`bolo.${key}`, value);
  } catch {
    /* storage unavailable */
  }
};

const STATUS_TEXT = {
  idle: 'Press the red button and start speaking.',
  loading: 'Getting the model ready…',
  connecting: 'Connecting…',
  listening: 'Listening',
  stopping: 'Finishing up…',
};

export default function DictatePage() {
  const navigate = useNavigate();
  const toast = useToast();
  const apiStatus = useApiStatus();
  const stt = useTranscriber();

  const [engine, setEngine] = useState(() => readPref('engine', 'gemini-live'));
  const [whisperModel, setWhisperModel] = useState(() => readPref('whisperModel', WHISPER_MODELS[1].id));
  const [whisperLanguage, setWhisperLanguage] = useState(() => readPref('whisperLanguage', ''));
  const [browserLanguage, setBrowserLanguage] = useState(() => readPref('browserLanguage', 'hi-IN'));

  const [title, setTitle] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null); // { id, content, title }

  // Engines that cannot run here, with the reason shown in the picker.
  const unavailable = useMemo(() => {
    const map = {};
    if (!apiStatus.loading && !apiStatus.gemini) {
      map['gemini-live'] = apiStatus.online
        ? 'Not set up yet: add GEMINI_API_KEY to the backend to enable it.'
        : 'The server is offline, so Gemini Live is unavailable.';
    }
    if (!isWebSpeechSupported()) {
      map['web-speech'] = 'This browser has no built-in recogniser. Use Chrome or Edge.';
    }
    return map;
  }, [apiStatus.loading, apiStatus.gemini, apiStatus.online]);

  // Fall back to Whisper when the preferred engine is not available.
  useEffect(() => {
    if (unavailable[engine]) setEngine('whisper');
  }, [unavailable, engine]);

  const chooseEngine = useCallback((id) => {
    setEngine(id);
    writePref('engine', id);
  }, []);

  // Warn before leaving with unsaved text.
  const dirty = Boolean(stt.transcript.trim()) && (!saved || saved.content !== stt.transcript || saved.title !== title);
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const { isActive, start, stop } = stt;
  const toggleRecording = useCallback(() => {
    if (isActive) {
      stop();
      return;
    }
    setEditing(false);
    const options =
      engine === 'whisper'
        ? { model: whisperModel, language: whisperLanguage }
        : engine === 'web-speech'
          ? { language: browserLanguage }
          : {};
    start(engine, options);
  }, [isActive, start, stop, engine, whisperModel, whisperLanguage, browserLanguage]);

  const save = async () => {
    const content = stt.transcript.trim();
    if (!content) return;
    setSaving(true);
    try {
      const payload = {
        title: title.trim() || undefined,
        content,
        engine: stt.lastMeta.engine || engine,
        durationMs: Math.round(stt.getElapsedMs()),
        metadata: { ...stt.lastMeta, enginesUsed: stt.enginesUsed },
      };
      const record = saved
        ? await api.updateTranscription(saved.id, { ...payload, title: title.trim() })
        : await api.createTranscription(payload);
      const savedTitle = title.trim() ? title : record.title;
      setTitle(savedTitle);
      setSaved({ id: record.id, content: stt.transcript, title: savedTitle });
      toast.show(saved ? 'Changes saved' : 'Saved to history', {
        tone: 'success',
        action: { label: 'Open history', onClick: () => navigate('/history') },
      });
    } catch (err) {
      toast.show(err.message, { tone: 'error', duration: 7000 });
    } finally {
      setSaving(false);
    }
  };

  const startOver = () => {
    if (dirty && !window.confirm('Discard the current transcript? It has not been saved.')) return;
    stt.reset();
    setTitle('');
    setSaved(null);
    setEditing(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(stt.transcript);
      toast.show('Copied to clipboard', { tone: 'success' });
    } catch {
      toast.show('Copy failed: the browser blocked clipboard access.', { tone: 'error' });
    }
  };

  const hasText = Boolean(stt.transcript.trim());
  const words = useMemo(() => countWords(stt.transcript), [stt.transcript]);
  const engineName = ENGINES.find((e) => e.id === engine)?.name;
  const loadingPercent = stt.progress?.ratio ? Math.round(stt.progress.ratio * 100) : null;

  return (
    <div className="dictate">
      <section className="dictate__main" aria-labelledby="dictate-title">
        <header className="page-head">
          <h1 id="dictate-title" className="page-title">
            Speak Hindi, English, or both.
          </h1>
          <p className="page-lede">Words appear on the pad as you talk. Save them, edit them, or listen back.</p>
        </header>

        <article className={`sheet${stt.isListening ? ' sheet--live' : ''}`}>
          <header className="sheet__head">
            <input
              className="sheet__title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled dictation"
              maxLength={160}
              aria-label="Title"
            />
            <MixBar text={stt.transcript} showLegend />
          </header>

          {editing ? (
            <textarea
              className="sheet__editor"
              value={stt.transcript}
              onChange={(e) => stt.setTranscript(e.target.value)}
              aria-label="Edit transcript"
              autoFocus
            />
          ) : (
            <div className="sheet__body" aria-live="polite" aria-atomic="false">
              {hasText || stt.interim || stt.isActive ? (
                <p className="transcript">
                  <ScriptText text={stt.transcript} />
                  {stt.interim && (
                    <>
                      {hasText ? ' ' : ''}
                      <ScriptText className="transcript__interim" text={stt.interim} />
                    </>
                  )}
                  {stt.isActive && stt.speaking && !stt.interim && (
                    <span className="hearing" aria-hidden="true">
                      {hasText ? ' ' : ''}
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  {stt.isListening && <span className="caret" aria-hidden="true" />}
                </p>
              ) : (
                <div className="sheet__empty">
                  <p className="transcript transcript--example" aria-hidden="true">
                    <ScriptText text={EXAMPLE} />
                  </p>
                  <p className="sheet__hint">
                    Your words appear here as you speak. Hindi is underlined in violet, English in teal.
                  </p>
                </div>
              )}
            </div>
          )}
        </article>

        <div className="recorder">
          <div className="recorder__main">
            <RecordButton
              status={stt.status}
              engineName={engineName}
              onClick={toggleRecording}
              subscribe={stt.subscribeLevel}
            />

            <div className="recorder__status">
              <div className="recorder__line">
                <RecordingTimer timing={stt.timing} />
                <LevelMeter subscribe={stt.subscribeLevel} active={stt.isListening} />
                <span className="recorder__count">{words === 1 ? '1 word' : `${words} words`}</span>
              </div>
              <p className="recorder__state" role="status">
                {stt.status === 'listening' ? (
                  <>
                    <span className="live-dot" aria-hidden="true" />
                    {stt.speaking ? 'Hearing you…' : `Listening with ${engineName}`}
                    {stt.lastMeta.mode === 'agent' && (
                      <span className="recorder__note">Backup model: text appears after each pause.</span>
                    )}
                  </>
                ) : (
                  stt.statusDetail || STATUS_TEXT[stt.status]
                )}
                {stt.status === 'loading' && loadingPercent !== null && ` ${loadingPercent}%`}
              </p>
              {stt.status === 'loading' && (
                <progress className="progress" max={100} value={loadingPercent ?? undefined} />
              )}
            </div>
          </div>

          <div className="recorder__actions">
            <div className="recorder__tools">
              <SpeakButton id="dictation" text={stt.transcript} variant="button" disabled={stt.isActive} />
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setEditing((v) => !v)}
                disabled={stt.isActive || !hasText}
              >
                {editing ? <Check size={18} aria-hidden="true" /> : <Pencil size={18} aria-hidden="true" />}
                {editing ? 'Done' : 'Edit'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={copy} disabled={!hasText}>
                <Copy size={18} aria-hidden="true" /> Copy
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={startOver}
                disabled={stt.isActive || (!hasText && !title)}
              >
                <Eraser size={18} aria-hidden="true" /> Start over
              </button>
            </div>
            <button
              type="button"
              className="btn btn--primary recorder__save"
              onClick={save}
              disabled={stt.isActive || !hasText || saving || !dirty}
            >
              {saving ? (
                <LoaderCircle size={18} className="spin" aria-hidden="true" />
              ) : !dirty && saved ? (
                <Check size={18} aria-hidden="true" />
              ) : (
                <Save size={18} aria-hidden="true" />
              )}
              {!dirty && saved ? 'Saved' : saved ? 'Save changes' : 'Save to history'}
            </button>
          </div>
        </div>

        {stt.error && (
          <div className="alert" role="alert">
            <CircleAlert size={20} aria-hidden="true" />
            <p>{stt.error}</p>
            <button type="button" className="icon-btn icon-btn--small" aria-label="Dismiss" onClick={stt.clearError}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        )}
      </section>

      <aside className="dictate__side" aria-label="Settings">
        <EnginePicker value={engine} onChange={chooseEngine} disabled={stt.isActive} unavailable={unavailable} />

        {engine === 'gemini-live' && apiStatus.model && (
          <p className="field__hint">
            Model: <code>{stt.lastMeta.engine === 'gemini-live' && stt.lastMeta.model ? stt.lastMeta.model : apiStatus.model}</code>
            . Audio goes straight to Google using a short-lived token from your server.
          </p>
        )}

        {engine === 'whisper' && (
          <div className="field-group">
            <div className="field">
              <label className="panel__title" htmlFor="whisper-model">
                Whisper model
              </label>
              <select
                id="whisper-model"
                value={whisperModel}
                disabled={stt.isActive}
                onChange={(e) => {
                  setWhisperModel(e.target.value);
                  writePref('whisperModel', e.target.value);
                }}
              >
                {WHISPER_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}: {m.hint}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="panel__title" htmlFor="whisper-language">
                Spoken language
              </label>
              <select
                id="whisper-language"
                value={whisperLanguage}
                disabled={stt.isActive}
                onChange={(e) => {
                  setWhisperLanguage(e.target.value);
                  writePref('whisperLanguage', e.target.value);
                }}
              >
                {WHISPER_LANGUAGES.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
              <p className="field__hint">Detected per phrase. Choose Hindi if mixed speech comes out translated.</p>
            </div>
          </div>
        )}

        {engine === 'web-speech' && (
          <div className="field">
            <label className="panel__title" htmlFor="browser-language">
              Recognition language
            </label>
            <select
              id="browser-language"
              value={browserLanguage}
              disabled={stt.isActive}
              onChange={(e) => {
                setBrowserLanguage(e.target.value);
                writePref('browserLanguage', e.target.value);
              }}
            >
              {WEB_SPEECH_LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
            <p className="field__hint">Hindi (hi-IN) also picks up English words spoken in between.</p>
          </div>
        )}

        <VoicePicker />
      </aside>
    </div>
  );
}
