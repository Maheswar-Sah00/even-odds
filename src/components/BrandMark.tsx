/**
 * The Even Odds mark: a four-leaf clover of four equal leaves, one per pale brand colour.
 * Equal leaves for equal chances, and a clover for the luck of the draw.
 * Drawn on a 32-unit grid so it stays crisp from 16 px favicons up.
 * Decorative: the brand name is always beside it or in the link's name.
 * The same paths are in public/favicon.svg and scripts/render-brand-assets.ts.
 */
const LEAF = 'M17 14 V8.5 A6.5 6.5 0 0 1 23.5 2 A6.5 6.5 0 0 1 30 8.5 A6.5 6.5 0 0 1 23.5 15 H18 A1 1 0 0 1 17 14 Z';
const LEAF_COLORS = ['#ef9a94', '#efc95e', '#86cc9e', '#bb93e2'] as const; // pale red, yellow, green, purple (clockwise from top right)

/** The four leaves as SVG paths on the 32-unit grid, for embedding in a larger drawing. */
export function CloverLeaves() {
  return (
    <>
      {LEAF_COLORS.map((fill, i) => (
        <path key={fill} d={LEAF} fill={fill} stroke="none" transform={`rotate(${String(i * 90)} 16 16)`} />
      ))}
    </>
  );
}

export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <CloverLeaves />
    </svg>
  );
}
