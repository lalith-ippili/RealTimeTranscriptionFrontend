import { scriptMix } from '../lib/script.js';

/** Thin two-colour bar: share of Hindi (Devanagari) vs English (Latin) words. */
export default function MixBar({ text, showLegend = false, className = '' }) {
  const mix = scriptMix(text);
  const hindi = Math.round(mix.devaShare * 100);
  const english = mix.total ? 100 - hindi : 0; // always adds up to 100 %
  const label = mix.total ? `${hindi}% Hindi, ${english}% English` : 'No words yet';

  return (
    <div className={`mix ${className}`}>
      <div className="mix__bar" role="img" aria-label={label}>
        {mix.total > 0 && (
          <>
            <span className="mix__deva" style={{ flexGrow: mix.deva }} />
            <span className="mix__latin" style={{ flexGrow: mix.latin }} />
          </>
        )}
      </div>
      {showLegend && (
        <p className="mix__legend">
          <span className="key key--deva">हिंदी {mix.total ? `${hindi}%` : ''}</span>
          <span className="key key--latin">English {mix.total ? `${english}%` : ''}</span>
        </p>
      )}
    </div>
  );
}
