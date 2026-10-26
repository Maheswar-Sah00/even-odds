import { CloverLeaves } from '../../../components/BrandMark.tsx';

/** Hero flourish: two mirrored curls meeting at the brand clover (four equal leaves). */
export function Ornament({ className }: { className?: string }) {
  const half = (
    <>
      <path d="M8 58H128" />
      <path d="M40 50C64 51 92 47 112 34" />
      <path d="M58 52C80 49 100 40 112 24" strokeWidth="2.6" />
      <path d="M78 54C96 50 110 43 118 30" />
      <path d="M128 58C112 58 104 46 108 34C112 22 128 20 133 30C137 38 131 46 124 44C118 42 119 34 125 34" />
    </>
  );
  return (
    <svg className={className} viewBox="0 0 320 72" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g>{half}</g>
      <g transform="translate(320 0) scale(-1 1)">{half}</g>
      {/* The brand clover (src/components/BrandMark.tsx), 30 units across. */}
      <g transform="translate(145 19) scale(0.94)">
        <CloverLeaves />
      </g>
    </svg>
  );
}
