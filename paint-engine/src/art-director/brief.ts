/**
 * Reading a painting request into a brief.
 *
 * The brief is the honest middle ground between "what the user typed" and "a
 * PaintingPlan". It records what was *recognised*, not what was assumed: every
 * field here can be traced to a word in the request or to a default, so a plan
 * built from a brief can be explained back to the user and corrected.
 *
 * Deliberately keyword-based rather than clever. A parser that guesses will
 * quietly turn "a calm harbour at dawn" into a storm, and the user has no way to
 * tell except by looking at a bad picture. A keyword match either finds the word
 * or reports that it did not.
 */

import type { PaintingStyle } from '../types.js';

/** What kind of picture this is. Drives which recipes run. */
export type SceneKind = 'ocean' | 'landscape' | 'sky';

/** A named thing the request asked for that the recipes know how to place. */
export type Element =
  | 'clouds'
  | 'large_waves'
  | 'foam'
  | 'ship'
  | 'moon'
  | 'sun'
  | 'mountains'
  | 'birds'
  | 'rain';

/** What the picture is made of, as far as the request said. */
export interface Brief {
  raw: string;
  scene: SceneKind;
  /** Whether there is a ground or water plane with a horizon. */
  hasGround: boolean;
  elements: Element[];
  /** Free text from the request, kept for the plan view and the Vision Critic. */
  atmosphere: string;
  medium: PaintingStyle['medium'];
  contrast: PaintingStyle['contrast'];
  texture: PaintingStyle['texture'];
  edgeCharacter: PaintingStyle['edgeCharacter'];
  colorTemperature: PaintingStyle['colorTemperature'];
  detailLevel: number;
  /**
   * Whether light passes *through* something rather than sitting on it.
   *
   * Distinct from "there is light": a highlight is a mark on the edge, transmitted
   * light is placed just inside it so the brightest part lands within the form. The
   * recipes differ, and getting it backwards is what makes synthetic light look
   * painted-on.
   */
  lightThrough: boolean;
  /** Colours the request named, by role. */
  paletteSeeds: Record<string, string[]>;
  seed: number;
}

/** Words that decide the scene, in priority order — the first match wins. */
const SCENE_WORDS: Array<[SceneKind, RegExp]> = [
  ['ocean', /\b(ocean|sea|wave|waves|tide|seascape|marine|coast|coastal|beach|surf|shore|harbour|harbor)\b/i],
  ['landscape', /\b(landscape|mountain|mountains|hill|hills|valley|forest|field|meadow|countryside)\b/i],
  ['sky', /\b(sky|skies|cloud|clouds|sunset|sunrise|twilight|dusk|dawn)\b/i],
];

const ELEMENT_WORDS: Array<[Element, RegExp]> = [
  ['large_waves', /\b(wave|waves|swell|storm|stormy|tempest|surf)\b/i],
  ['foam', /\b(foam|foamy|foam-flecked|whitewater|breaker|breakers|spray)\b/i],
  ['clouds', /\b(cloud|clouds|cloudy|overcast|bank of clouds)\b/i],
  ['ship', /\b(ship|ships|boat|boats|sailboat|schooner|vessel|brig|trawler)\b/i],
  ['moon', /\b(moon|moonlit|moonshine|lunar)\b/i],
  ['sun', /\b(sun|sunlight|sunbeam|sunbeams|sunrise|sunset|golden hour)\b/i],
  ['mountains', /\b(mountain|mountains|peak|peaks|range|cliff|cliffs)\b/i],
  ['birds', /\b(bird|birds|gull|gulls|seagull)\b/i],
  ['rain', /\b(rain|rainy|downpour|drizzle|storm)\b/i],
];

const MEDIUM_WORDS: Array<[PaintingStyle['medium'], RegExp]> = [
  ['watercolor', /\b(watercolou?r|watercolour|aquarelle)\b/i],
  ['acrylic', /\b(acrylic|gouache|poster)\b/i],
  ['charcoal', /\b(charcoal|graphite|pencil)\b/i],
  ['ink', /\b(ink|pen and ink|pen-and-ink|line drawing)\b/i],
  ['pastel', /\b(pastel|chalk|soft chalk)\b/i],
  ['digital', /\b(digital|pixel art|concept art)\b/i],
  ['oil', /\b(oil|painting|painted|paint|impressionis\w*|romantic|baroque|dutch master)\b/i],
];

const ATMOSPHERE_WORDS: RegExp[] = [
  /\b(dramatic|theatrical|epic|stormy|turbulent|brooding)\b/i,
  /\b(calm|serene|peaceful|quiet|tranquil|still)\b/i,
  /\b(melanchol\w+|wistful|sombre|somber|sad)\b/i,
  /\b(romantic|luminous|ethereal|reverie)\b/i,
  /\b(golden|warm|sunlit)\b/i,
  /\b(cold|bleak|desolate|grim)\b/i,
];

/**
 * Colours the request names, mapped to the tonal role they usually play.
 *
 * Only unambiguous colour words are taken. "dark" is a *value*, not a hue, and
 * turning it into a swatch is how a palette ends up with mud in it; values are
 * handled by the depth model and by the palette's own derivation instead.
 */
const COLOUR_WORDS: Array<[string, RegExp]> = [
  ['midtones', /\b(blue|blue-grey|blue-gray|azure|teal|cyan|steel)\b/i],
  ['shadows', /\b(indigo|navy|dark blue|midnight|slate)\b/i],
  ['highlights', /\b(white|cream|ivory|silver|pale|grey|gray|grey-blue)\b/i],
  ['accents', /\b(gold|golden|amber|orange|ochre|rust|copper|warm light)\b/i],
  ['midtones', /\b(green|teal-green|olive|moss)\b/i],
  ['midtones', /\b(purple|violet|lilac|mauve)\b/i],
  ['accents', /\b(red|crimson|scarlet|vermilion)\b/i],
];

/** Builds a brief from a request. Everything here is deterministic. */
export function parseBrief(request: string, seed = 1): Brief {
  const text = request ?? '';

  const scene = (SCENE_WORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'landscape') as SceneKind;

  const elements: Element[] = [];
  for (const [element, pattern] of ELEMENT_WORDS) {
    if (pattern.test(text) && !elements.includes(element)) elements.push(element);
  }

  // A wave word with no sea word still means water, and a sea word with no wave
  // word still means water. Both defaults are safe; a bare "paint the sea" is not
  // a bare horizon.
  if (scene === 'ocean' && !elements.includes('large_waves')) elements.push('large_waves');
  if (scene === 'ocean' && !elements.includes('foam')) elements.push('foam');

  // Clouds do not depend on the scene. Every sky has weather in it, and the first
  // version only added them for `sky` and `landscape`, which produced a "stormy
  // seascape" with a cloudless sky — the storm was in the words and not in the
  // picture.
  const weather = /\b(storm\w*|tempest|overcast|turbulent|brooding|gale|squall)\b/i.test(text);
  if (weather && !elements.includes('clouds')) elements.push('clouds');
  else if ((scene === 'sky' || scene === 'landscape') && !elements.includes('clouds')) elements.push('clouds');

  const medium = MEDIUM_WORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'oil';
  const atmosphere = ATMOSPHERE_WORDS.map((p) => (text.match(p)?.[0] ?? '')).find(Boolean) ?? 'natural';

  const paletteSeeds: Record<string, string[]> = {};
  for (const [role, pattern] of COLOUR_WORDS) {
    const hit = text.match(pattern)?.[0];
    if (!hit) continue;
    const hex = hexForColourWord(hit);
    if (!hex) continue;
    paletteSeeds[role] = [...(paletteSeeds[role] ?? []), hex];
  }

  return {
    raw: text,
    scene,
    hasGround: scene !== 'sky',
    elements,
    atmosphere,
    medium,
    contrast: /\b(high[- ]contrast|dramatic|chiaroscuro|strong)\b/i.test(text) ? 'high' : 'medium',
    texture:
      /\b(impasto|thick|textured|heavy brush|loaded brush)\b/i.test(text) ? 'heavy'
        : /\b(smooth|glazed|flat|thin)\b/i.test(text) ? 'smooth'
          : 'moderate',
    edgeCharacter: /\b(soft|diffuse|blurred|sfumato|atmospheric)\b/i.test(text) ? 'soft'
      : /\b(hard|sharp|crisp|graphic|defined)\b/i.test(text) ? 'hard'
        : 'mixed',
    colorTemperature: /\b(warm|golden|amber|autumn)\b/i.test(text) ? 'warm'
      : /\b(cold|cool|icy|glacial|winter|blue hour)\b/i.test(text) ? 'cool'
        : 'neutral',
    detailLevel: /\b(detailed|intricate|busy|complex)\b/i.test(text) ? 0.8
      : /\b(simple|minimal|loose|broad|simple shapes)\b/i.test(text) ? 0.3
        : 0.6,
    // "breaking through", "through the clouds", "transmitted" all mean the light
    // is inside the form rather than on it.
    lightThrough: /\b(breaking through|through the|transmit\w*|piercing|streaming through|light through)\b/i.test(text),
    paletteSeeds,
    seed,
  };
}

/**
 * A representative hex for a colour word.
 *
 * Deliberately few, and chosen to sit where a painter would put them: these are
 * the values the palette engine then derives shadows, midtones and highlights
 * from, so a wrong seed poisons three roles rather than one.
 */
function hexForColourWord(word: string): string | null {
  const map: Record<string, string> = {
    blue: '#2f6d84',
    'blue-grey': '#5d7d8c',
    'blue-gray': '#5d7d8c',
    azure: '#3d7ea6',
    teal: '#2a7f80',
    cyan: '#63b7bd',
    steel: '#6b7f8c',
    indigo: '#28306b',
    navy: '#1b2a4a',
    'dark blue': '#20304a',
    midnight: '#101a2e',
    slate: '#4a5560',
    white: '#eef1f2',
    cream: '#efe3c8',
    ivory: '#f2ead6',
    silver: '#c7ced3',
    pale: '#d9e2e4',
    grey: '#9aa2a6',
    gray: '#9aa2a6',
    'grey-blue': '#a9b7c0',
    gold: '#c8a24a',
    golden: '#c8a24a',
    amber: '#c98f36',
    orange: '#c2703a',
    ochre: '#b98a3f',
    rust: '#9c5433',
    copper: '#b06a3c',
    'warm light': '#e0c489',
    green: '#4a7a55',
    'teal-green': '#3d7f6d',
    olive: '#6b7a4a',
    moss: '#5c7346',
    purple: '#6b5480',
    violet: '#6a5a90',
    lilac: '#a99ac0',
    mauve: '#9c8497',
    red: '#a83a2e',
    crimson: '#8e2230',
    scarlet: '#b03a26',
    vermilion: '#c4472a',
  };
  const key = word.toLowerCase();
  return map[key] ?? null;
}