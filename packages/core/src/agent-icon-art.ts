import type { OrcaIcon } from './agent-icons.generated.ts';

/** How an Orca icon is drawn in the 24x24 badge: tinted in the key's colour, or as it is on the badge disc. */
export type IconMode = 'mask' | 'chip';

const num = (n: number) => String(Math.round(n * 1000) / 1000);

/** The icon's natural mode: a favicon that fills its square, or a logo with its own colours, would be a blob tinted. */
export function naturalMode(icon: OrcaIcon): IconMode {
  if (icon.kind === 'png') return icon.solid ? 'chip' : 'mask';
  return icon.shapes.some((s) => s.fill !== 'current') ? 'chip' : 'mask';
}

/** The disc the badge is drawn on, as a clip for icons shown as they are. */
const CHIP = '<clipPath id="chip"><circle cx="12" cy="12" r="12"/></clipPath>';

/**
 * SVG for the 24x24 badge area (the caller translates it into place). `mask` fills the icon with `tint`; `chip`
 * keeps its own colours, cut to the disc. Pure string work: the data is in agent-icons.generated.ts.
 */
export function orcaIconArt(icon: OrcaIcon, mode: IconMode, tint: string): string {
  if (icon.kind === 'png') {
    const href = `data:image/png;base64,${icon.data}`;
    if (mode === 'chip')
      return `${CHIP}<image href="${href}" width="24" height="24" preserveAspectRatio="xMidYMid slice" clip-path="url(#chip)" stroke="none"/>`;
    // Tint by the picture's alpha: flood with the colour, keep it where the icon is opaque.
    return (
      `<filter id="tint" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"><feFlood flood-color="${tint}"/><feComposite in2="SourceAlpha" operator="in"/></filter>` +
      `<image href="${href}" x="4" y="4" width="16" height="16" filter="url(#tint)" stroke="none"/>`
    );
  }
  const [x = 0, y = 0, w = 24, h = 24] = icon.viewBox.split(/\s+/).map(Number);
  const side = Math.max(w, h);
  const chip = mode === 'chip';
  const k = (chip ? 24 : 16) / side;
  const place = chip
    ? `scale(${num(k)}) translate(${num(-x)} ${num(-y)})`
    : `translate(${num(4 + (16 - w * k) / 2)} ${num(4 + (16 - h * k) / 2)}) scale(${num(k)}) translate(${num(-x)} ${num(-y)})`;
  const shapes = icon.shapes
    .map(
      (s) =>
        `<path d="${s.d}" fill="${chip && s.fill !== 'current' ? s.fill : tint}"${s.opacity !== undefined ? ` fill-opacity="${s.opacity}"` : ''}${s.evenodd ? ' fill-rule="evenodd"' : ''}/>`,
    )
    .join('');
  const inner = icon.transform ? `<g transform="${icon.transform}">${shapes}</g>` : shapes;
  return chip
    ? `${CHIP}<g clip-path="url(#chip)" stroke="none"><g transform="${place}">${inner}</g></g>`
    : `<g stroke="none"><g transform="${place}">${inner}</g></g>`;
}
