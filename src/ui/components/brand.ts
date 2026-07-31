// The product's on-screen identity, rendered from one place (brand.md).
//
// The header, the About modal and the start modal all show this. Before it was
// shared, the two modals hand-rolled a flattened lookalike out of the generic
// Modal title/tag classes — a different font, size and colour from the header's
// faceplate, and three places to edit when the name changes.
import styles from '../styles/brand.module.css';

const NAME = 'VAST';
const MODEL = 'G1-J5';
const TAGLINE = 'Vast Audio Synthesis Technology';

/**
 * The brand block: `VAST` + a boxed `G1-J5` on one row, the tagline beneath.
 * No size or content variant — every surface shows the same thing (REQ-1).
 *
 * Carries no outer framing and no alignment of its own: the header composes its
 * divider class on top, and `.start-card` centres it (REQ-3/REQ-4).
 */
export function createBrand(): HTMLElement {
  const brand = document.createElement('div');
  brand.className = styles.brand!;

  const row = document.createElement('div');
  row.className = styles.brandRow!;

  const name = document.createElement('span');
  name.className = styles.brandName!;
  name.textContent = NAME;

  const model = document.createElement('span');
  model.className = styles.brandModel!;
  model.textContent = MODEL;

  row.appendChild(name);
  row.appendChild(model);

  const tagline = document.createElement('div');
  tagline.className = styles.brandTagline!;
  tagline.textContent = TAGLINE;

  brand.appendChild(row);
  brand.appendChild(tagline);
  return brand;
}
