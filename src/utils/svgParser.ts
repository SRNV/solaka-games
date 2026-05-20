/**
 * SVG Gamepad Parser
 *
 * Convention SVG :
 *  - Un élément `id="viewport"` (rect ou autre) délimite la zone logique de la manette.
 *    Tout ce qui est hors du viewport est rendu hors-champ proportionnellement dans la scène R3F.
 *    Si absent, le viewBox SVG fait office de viewport.
 *  - Les éléments dont l'`id` correspond à un InputDescriptor sont traités comme zones d'input.
 *    La comparaison est insensible à la casse (id="A" matche descriptor id="a").
 *    Le type SVG (path, polygon, circle, rect, ellipse, g…) n'a pas d'importance tant que
 *    getBBox() peut être appelé dessus.
 *
 * Positionnement proportionnel :
 *  normalX = (elemCx - viewport.x) / viewport.w   [peut dépasser 0..1 si hors champ]
 *  normalY = (elemCy - viewport.y) / viewport.h
 *
 * Géométrie :
 *  pathD contient le markup SVG complet de l'élément (outerHTML), transforms inclus.
 *  SVGLoader l'interprète correctement côté Three.js, y compris translate/rotate/scale.
 */

export interface SvgRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SvgElementData {
  id: string;
  /**
   * Identifiant stable de la zone physique, unique même pour les ids SVG dupliqués.
   * Pour un id unique : égal à `id`.
   * Pour des ids dupliqués (ex: deux <g id="joystick">) : `joystick__0`, `joystick__1`…
   * Envoyé dans chaque InputPatch pour que le serveur distingue les instances.
   */
  zoneKey: string;
  tag: string;
  /** Centre en coordonnées SVG (espace racine, transforms appliqués) */
  cx: number;
  cy: number;
  /** Rayon approx (min dim / 2) en coordonnées SVG — pour hit-test en px */
  radius: number;
  /** BBox complète en coordonnées SVG (espace racine) */
  bbox: SvgRect;
  /**
   * Markup SVG complet de l'élément (outerHTML, transforms inclus).
   * À passer à SVGLoader enveloppé dans <svg>…</svg>.
   * null si l'élément n'a pas de géométrie exploitable.
   */
  pathD: string | null;
}

// ── Tags supportés pour l'extraction de géométrie ─────────────────────────

const SHAPE_TAGS = new Set(['path', 'circle', 'ellipse', 'rect', 'polygon', 'polyline', 'line']);

/**
 * Retourne le markup SVG de l'élément (outerHTML) en incluant les transformations
 * absolues par rapport à la racine SVG.
 */
function elementToSvgMarkup(el: SVGGraphicsElement, svgEl: SVGSVGElement): string | null {
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
  const isShape = SHAPE_TAGS.has(tag);
  const isGroup = tag === 'g';
  
  if (!isShape && !isGroup) return null;
  if (isGroup && !Array.from(el.children).some(c => SHAPE_TAGS.has(c.tagName.toLowerCase().replace(/^svg:/, '')) || c.tagName.toLowerCase().replace(/^svg:/, '') === 'g')) {
    return null;
  }

  const sCTM = el.getScreenCTM();
  const svgCTM = svgEl.getScreenCTM();
  if (!sCTM || !svgCTM) return el.outerHTML;

  const m = svgCTM.inverse().multiply(sCTM);
  const matrixStr = `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;
  
  // Clone pour ne pas modifier l'original, et retire le transform local
  // car il est déjà inclus dans la matrice absolue du groupe parent.
  const clone = el.cloneNode(true) as SVGGraphicsElement;
  clone.removeAttribute('transform');
  
  return `<g transform="${matrixStr}">${clone.outerHTML}</g>`;
}

// ── Bbox dans l'espace racine SVG ──────────────────────────────────────────

/**
 * Calcule le centre "dense" (centroiïde approximatif) d'un élément dans son espace local.
 * Pour un chemin, on échantillonne des points le long du tracé.
 */
function getLocalDenseCenter(el: SVGGraphicsElement): { x: number; y: number } {
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
  
  try {
    if (tag === 'circle') {
      return { x: (el as SVGCircleElement).cx.baseVal.value, y: (el as SVGCircleElement).cy.baseVal.value };
    }
    if (tag === 'ellipse') {
      return { x: (el as SVGEllipseElement).cx.baseVal.value, y: (el as SVGEllipseElement).cy.baseVal.value };
    }
    if (tag === 'rect') {
      const r = el as SVGRectElement;
      return { x: r.x.baseVal.value + r.width.baseVal.value / 2, y: r.y.baseVal.value + r.height.baseVal.value / 2 };
    }
    if (tag === 'path') {
      const p = el as SVGPathElement;
      const len = p.getTotalLength();
      if (len > 0) {
        let sx = 0, sy = 0;
        const samples = 12;
        for (let i = 0; i < samples; i++) {
          const pt = p.getPointAtLength((len * i) / (samples - 1));
          sx += pt.x;
          sy += pt.y;
        }
        return { x: sx / samples, y: sy / samples };
      }
    }
    // Fallback sur le centre de la BBox locale
    const bb = el.getBBox();
    return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
  } catch {
    const bb = el.getBBox();
    return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
  }
}

/**
 * Retourne le centre dense de l'élément dans l'espace de coordonnées du <svg> racine.
 */
function getDenseCenterInSvgSpace(el: SVGGraphicsElement, svgEl: SVGSVGElement): { x: number; y: number } {
  const localCenter = getLocalDenseCenter(el);
  const sCTM = el.getScreenCTM();
  const svgCTM = svgEl.getScreenCTM();
  
  if (!sCTM || !svgCTM) return localCenter;

  const m = svgCTM.inverse().multiply(sCTM);
  const pt = svgEl.createSVGPoint();
  pt.x = localCenter.x;
  pt.y = localCenter.y;
  const transformed = pt.matrixTransform(m);
  
  return { x: transformed.x, y: transformed.y };
}

/**
 * Retourne la bounding box de l'élément dans l'espace de coordonnées du <svg> racine.
 * Utilise getScreenCTM() pour une précision maximale incluant tous les transforms.
 */
function getBBoxInSvgSpace(el: SVGGraphicsElement, svgEl: SVGSVGElement): DOMRect {
  const local = el.getBBox();
  const sCTM = el.getScreenCTM();
  const svgCTM = svgEl.getScreenCTM();
  
  if (!sCTM || !svgCTM) return new DOMRect(local.x, local.y, local.width, local.height);

  const m = svgCTM.inverse().multiply(sCTM);
  
  // Transforme les 4 coins
  const pt = svgEl.createSVGPoint();
  const corners = [
    { x: local.x, y: local.y },
    { x: local.x + local.width, y: local.y },
    { x: local.x, y: local.y + local.height },
    { x: local.x + local.width, y: local.y + local.height },
  ].map(c => {
    pt.x = c.x;
    pt.y = c.y;
    return pt.matrixTransform(m);
  });

  const xs = corners.map(p => p.x);
  const ys = corners.map(p => p.y);
  
  return new DOMRect(
    Math.min(...xs), Math.min(...ys),
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
  );
}

// ── Viewport detection ──────────────────────────────────────────────────────

function parseViewBox(svgEl: SVGSVGElement): SvgRect {
  const vb = svgEl.getAttribute('viewBox');
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length === 4) return { x: p[0], y: p[1], w: p[2], h: p[3] };
  }
  const w = parseFloat(svgEl.getAttribute('width') ?? '100');
  const h = parseFloat(svgEl.getAttribute('height') ?? '100');
  return { x: 0, y: 0, w, h };
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface ParsedSvg {
  /** Viewport logique de la manette (id="viewport" ou viewBox SVG) */
  viewport: SvgRect;
  /** viewBox brut du SVG */
  viewBox: SvgRect;
  elements: SvgElementData[];
}

/** Alias kept for consumers that imported the old name */
export type SvgViewBox = SvgRect;

/**
 * Parse un SVG et extrait les données géométriques de tous les éléments
 * ayant un ID (excluant 'viewport').
 * Si `wantedIds` est fourni, ne garde que ceux-là (insensible à la casse).
 */
export function parseSvg(svgText: string, wantedIds?: Set<string>): ParsedSvg {
  const container = document.createElement('div');
  container.style.cssText =
    'position:absolute;left:-999999px;top:-999999px;width:2000px;height:2000px;' +
    'visibility:hidden;overflow:visible;pointer-events:none';
  container.innerHTML = svgText;
  document.body.appendChild(container);

  const defaultResult: ParsedSvg = {
    viewport: { x: 0, y: 0, w: 100, h: 100 },
    viewBox: { x: 0, y: 0, w: 100, h: 100 },
    elements: [],
  };

  try {
    const svgEl = container.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return defaultResult;

    const viewBox = parseViewBox(svgEl);

    // Cherche l'élément id="viewport" pour délimiter la zone logique
    let viewport: SvgRect = { ...viewBox };
    const vpEl = svgEl.getElementById('viewport') as SVGGraphicsElement | null;
    if (vpEl) {
      try {
        const bb = getBBoxInSvgSpace(vpEl, svgEl);
        viewport = { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
      } catch { /* fall back to viewBox */ }
    }

    const elements: SvgElementData[] = [];
    const idCountMap = new Map<string, number>();

    /**
     * Traversée récursive pour trouver tous les éléments avec un ID.
     * On traverse les enfants en sens inverse pour que les éléments au premier plan
     * (derniers dans le DOM SVG) soient détectés en premier.
     */
    function traverse(el: Element) {
      const children = Array.from(el.children);
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i];
        const id = child.getAttribute('id');
        const tag = child.tagName.toLowerCase().replace(/^svg:/, '');
        
        // On traite l'élément s'il a un ID et n'est pas le viewport
        if (id && id !== 'viewport' && tag !== 'text' && tag !== 'tspan' && tag !== 'style') {
          if (!wantedIds || wantedIds.has(id) || wantedIds.has(id.toLowerCase())) {
            const gEl = child as SVGGraphicsElement;
            let bb: DOMRect;
            try {
              bb = getBBoxInSvgSpace(gEl, svgEl!);
            } catch {
              continue; // On passe à l'enfant suivant
            }

            if (bb.width > 0 || bb.height > 0) {
              // Gestion spécifique des <g> : on prend la géométrie du premier enfant
              const dataEl = (tag === 'g' && child.firstElementChild) 
                ? child.firstElementChild as SVGGraphicsElement 
                : gEl;

              // Calcul du centre "dense" pour le positionnement du label
              const denseCenter = getDenseCenterInSvgSpace(dataEl, svgEl!);

              // Clé unique pour cette instance physique
              const count = idCountMap.get(id) ?? 0;
              idCountMap.set(id, count + 1);
              const zoneKey = count > 0 ? `${id}__${count}` : id;

              elements.push({
                id,
                zoneKey,
                tag,
                cx: denseCenter.x,
                cy: denseCenter.y,
                radius: Math.max(Math.min(bb.width, bb.height) / 2, 1),
                bbox: { x: bb.x, y: bb.y, w: bb.width, h: bb.height },
                pathD: elementToSvgMarkup(dataEl, svgEl!),
              });
            }
          }
        }

        // Continue la traversée dans cet enfant
        traverse(child);
      }
    }

    traverse(svgEl);

    return { viewport, viewBox, elements };
  } finally {
    document.body.removeChild(container);
  }
}

// ── Normalisation ───────────────────────────────────────────────────────────

/**
 * Coordonnées normalisées par rapport au viewport logique.
 * Peut dépasser [0..1] pour les éléments hors champ.
 */
export function normalizeToViewport(
  cx: number, cy: number, radius: number, viewport: SvgRect,
): { nx: number; ny: number; nr: number } {
  return {
    nx: (cx - viewport.x) / viewport.w,
    ny: (cy - viewport.y) / viewport.h,
    nr: radius / Math.min(viewport.w, viewport.h),
  };
}
