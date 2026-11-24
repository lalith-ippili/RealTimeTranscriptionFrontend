import { memo } from 'react';
import { tokenize } from '../lib/script.js';

/**
 * Renders text word by word, tagging each word with its writing system so
 * Hindi (Devanagari) and English (Latin) words get distinct underlines.
 */
function ScriptText({ text, className = '', as: Tag = 'span' }) {
  return (
    <Tag className={className}>
      {tokenize(text).map((token, i) =>
        token.script === 'space' ? (
          token.text
        ) : (
          <span key={i} className={`w w--${token.script}`} lang={token.script === 'deva' ? 'hi' : undefined}>
            {token.text}
          </span>
        ),
      )}
    </Tag>
  );
}

export default memo(ScriptText);
