/** Distinct tier colours; tiers are always also named in text (labels, legend), never by colour alone. */
export const TIER_COLORS = ['#1d6b3f', '#0b616b', '#7339a3', '#8a6400', '#7d1f3c', '#a52a22', '#3f7a52', '#94507a', '#6b5a00', '#5e5862'] as const; // green, cyan, purple, yellow, burgundy, red… (no blues)
export const tierColor = (tier: number): string => TIER_COLORS[tier] ?? '#5e5862';
