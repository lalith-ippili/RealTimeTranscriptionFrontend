import { useSpeaker } from '../context/SpeakerContext.jsx';
import { TTS_PROVIDERS } from '../lib/tts.js';

/** Choose how "Listen" reads text aloud (open-source model or browser voice). */
export default function VoicePicker() {
  const { provider, setProvider } = useSpeaker();
  const current = TTS_PROVIDERS.find((p) => p.id === provider) || TTS_PROVIDERS[0];

  return (
    <div className="field">
      <label className="panel__title" htmlFor="tts-provider">
        Read-aloud voice
      </label>
      <select id="tts-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
        {TTS_PROVIDERS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <p className="field__hint">{current.hint}</p>
    </div>
  );
}
