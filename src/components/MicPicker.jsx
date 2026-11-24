import { useEffect, useState } from 'react';
import { listMicrophones } from '../lib/microphone.js';

/**
 * Choose the input device. Device names only become visible after the browser
 * has been given microphone permission, so the list refreshes after recording.
 */
export default function MicPicker({ value, onChange, disabled, refreshKey, note }) {
  const [devices, setDevices] = useState([]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      listMicrophones().then((list) => {
        if (alive) setDevices(list);
      });
    load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', load);
    };
  }, [refreshKey]);

  const known = devices.some((d) => d.deviceId === value);

  return (
    <div className="field">
      <label className="panel__title" htmlFor="mic-device">
        Microphone
      </label>
      <select
        id="mic-device"
        value={known ? value : ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">System default</option>
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Microphone ${i + 1}`}
          </option>
        ))}
      </select>
      <p className="field__hint">
        {note ||
          (devices.some((d) => d.label)
            ? 'If the level bars stay flat while you talk, pick another microphone here.'
            : 'Names appear after you allow microphone access.')}
      </p>
    </div>
  );
}
