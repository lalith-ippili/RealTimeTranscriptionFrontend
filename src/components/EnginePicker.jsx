import { memo } from 'react';
import { Check, Cloud, Cpu, Globe } from 'lucide-react';
import { ENGINES } from '../engines/index.js';

const ICONS = { 'gemini-live': Cloud, whisper: Cpu, 'web-speech': Globe };

/** Radio-group of speech engines. `unavailable` maps engine id → reason. */
function EnginePicker({ value, onChange, disabled, unavailable = {} }) {
  return (
    <fieldset className="engines" disabled={disabled}>
      <legend className="panel__title">Speech engine</legend>
      {ENGINES.map((engine) => {
        const Icon = ICONS[engine.id];
        const reason = unavailable[engine.id];
        const checked = value === engine.id;
        return (
          <label
            key={engine.id}
            className={`engine${checked ? ' engine--checked' : ''}${reason ? ' engine--off' : ''}`}
          >
            <input
              type="radio"
              name="engine"
              className="sr-only"
              value={engine.id}
              checked={checked}
              onChange={() => onChange(engine.id)}
              disabled={Boolean(reason)}
            />
            <span className="engine__icon" aria-hidden="true">
              <Icon size={18} />
            </span>
            <span className="engine__text">
              <span className="engine__name">{engine.name}</span>
              <span className="engine__kind">{engine.kind}</span>
              <span className="engine__desc">{reason || engine.description}</span>
            </span>
            <span className="engine__check" aria-hidden="true">
              {checked && <Check size={14} strokeWidth={3} />}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

export default memo(EnginePicker);
