import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, CircleAlert, Copy, Eraser, LoaderCircle, Pencil, Save, X } from 'lucide-react';
import api from '../api/client.js';
import { useApiStatus } from '../context/ApiStatusContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useTranscriber } from '../hooks/useTranscriber.js';
import {
  ENGINES,
  SPOKEN_LANGUAGES,
  WHISPER_MODELS,
  engineLanguageOptions,
  isWebSpeechSupported,
  languageHint,
} from '../engines/index.js';
import EnginePicker from '../components/EnginePicker.jsx';
import MicPicker from '../components/MicPicker.jsx';
import LevelMeter from '../components/LevelMeter.jsx';
import MixBar from '../components/MixBar.jsx';
import RecordButton from '../components/RecordButton.jsx';
import RecordingTimer from '../components/RecordingTimer.jsx';
import ScriptText from '../components/ScriptText.jsx';
import SpeakButton from '../components/SpeakButton.jsx';
import VoicePicker from '../components/VoicePicker.jsx';
import { countWords } from '../lib/script.js';
import { MIC_ISSUES, primeAudio } from '../lib/microphone.js';

// Matches the server's default AUDIO_MAX_MB.
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

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
  const [language, setLanguage] = useState(() => readPref('language', 'mixed'));
  const [micDevice, setMicDevice] = useState(() => readPref('micDevice', ''));

  const [title, setTitle] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null); // { id, content, title, audioSize }

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
    // Must run synchronously inside the click: browsers only let audio start
    // from a user gesture.
    primeAudio();
    setEditing(false);
    const options = { ...engineLanguageOptions(engine, language), deviceId: micDevice };
    if (engine === 'whisper') options.model = whisperModel;
    if (engine === 'gemini-live') options.relay = apiStatus.relay;
    start(engine, options);
  }, [isActive, start, stop, engine, whisperModel, language, micDevice, apiStatus.relay]);

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

      // Save the audio recording with it (only when there is new audio since the last save).
      let audioSize = saved?.audioSize || 0;
      let audioProblem = '';
      const recording = await stt.getRecording();
      if (recording && recording.blob.size !== audioSize) {
        if (recording.blob.size > MAX_AUDIO_BYTES) {
          audioProblem = 'the recording is larger than 20 MB';
        } else {
          try {
            await api.uploadAudio(record.id, recording.blob, { durationMs: recording.durationMs });
            audioSize = recording.blob.size;
          } catch (err) {
            audioProblem = err.message;
          }
        }
      }

      setTitle(savedTitle);
      setSaved({ id: record.id, content: stt.transcript, title: savedTitle, audioSize });
      if (audioProblem) {
        toast.show(`Text saved, but the audio wasn't: ${audioProblem}`, { tone: 'error', duration: 8000 });
      } else {
        const withAudio = audioSize ? ' with the audio recording' : '';
        toast.show(saved ? `Changes saved${withAudio}` : `Saved to history${withAudio}`, {
          tone: 'success',
          action: { label: 'Open history', onClick: () => navigate('/history') },
        });
      }
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
          <div className="lang">
            <div className="lang__switch" role="radiogroup" aria-label="Language you will speak">
              {SPOKEN_LANGUAGES.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={language === l.id}
                  className={`lang__option${language === l.id ? ' lang__option--on' : ''}`}
                  title={l.title}
                  disabled={stt.isActive}
                  onClick={() => {
                    setLanguage(l.id);
                    writePref('language', l.id);
                  }}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <p className="lang__hint">{languageHint(engine, language)}</p>
          </div>
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
              {stt.isListening && stt.lastMeta.mic && !stt.micIssue && (
                <p className="recorder__mic">Mic: {stt.lastMeta.mic}</p>
              )}
              {stt.isActive && (stt.micIssue || stt.warning) && (
                <p className="recorder__warning" role="alert">
                  {stt.micIssue ? MIC_ISSUES[stt.micIssue] : stt.warning}
                </p>
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
            <div className="alert__body">
              <p>{stt.error}</p>
              {!stt.isActive && (
                <div className="alert__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--small"
                    onClick={() => {
                      stt.clearError();
                      toggleRecording();
                    }}
                  >
                    Try again
                  </button>
                  {engine !== 'web-speech' && !unavailable['web-speech'] && (
                    <button
                      type="button"
                      className="btn btn--primary btn--small"
                      onClick={() => {
                        stt.clearError();
                        chooseEngine('web-speech');
                      }}
                    >
                      Use the Browser engine
                    </button>
                  )}
                </div>
              )}
            </div>
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
            .{' '}
            {apiStatus.relay
              ? 'Audio is streamed through your server, which talks to Google with your API key.'
              : 'Audio goes straight to Google using a short-lived token from your server.'}
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
          </div>
        )}

        <MicPicker
          value={micDevice}
          disabled={stt.isActive}
          refreshKey={stt.status}
          note={engine === 'web-speech' ? 'The Browser engine always uses the system default microphone.' : null}
          onChange={(id) => {
            setMicDevice(id);
            writePref('micDevice', id);
          }}
        />

        <VoicePicker />
      </aside>
    </div>
  );
}
