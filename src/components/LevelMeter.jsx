import { memo, useEffect, useRef } from 'react';

const BARS = 36;

/**
 * Rolling microphone level meter. Levels arrive through `subscribe` and are
 * painted straight onto the bars once per animation frame – no React renders.
 */
function LevelMeter({ subscribe, active }) {
  const ref = useRef(null);

  useEffect(() => {
    const bars = Array.from(ref.current?.children || []);
    const values = new Array(BARS).fill(0);
    let frame = 0;

    const paint = () => {
      frame = 0;
      for (let i = 0; i < bars.length; i++) {
        bars[i].style.transform = `scaleY(${Math.max(0.06, values[i])})`;
      }
    };

    const unsubscribe = subscribe((value) => {
      values.shift();
      values.push(value);
      if (!frame) frame = requestAnimationFrame(paint);
    });

    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
      values.fill(0);
      paint();
    };
  }, [subscribe, active]);

  return (
    <div ref={ref} className={`meter${active ? ' meter--active' : ''}`} aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <span key={i} className="meter__bar" />
      ))}
    </div>
  );
}

export default memo(LevelMeter);
