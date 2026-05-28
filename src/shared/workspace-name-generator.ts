import { randomBytes } from 'node:crypto'

// Why: short, snake_case, DB- and shell-safe identifier. Composes cleanly
// into Postgres database names and `$VAR` expansions. Budget grew from 16
// to 22 to fit the 5-char hash suffix appended for cross-machine uniqueness.
export const WORKSPACE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,21}$/

// Curated lists of friendly, short, positive-feeling words (3–7 chars each).
// Inlined to avoid a runtime dependency; ~5 KB of source.
const ADJECTIVES: readonly string[] = [
  'agile',
  'bold',
  'brave',
  'breezy',
  'bright',
  'calm',
  'chirpy',
  'clever',
  'cosmic',
  'cozy',
  'crisp',
  'dapper',
  'daring',
  'dreamy',
  'eager',
  'earnest',
  'fancy',
  'fizzy',
  'frisky',
  'gentle',
  'gleeful',
  'glossy',
  'golden',
  'happy',
  'hardy',
  'hearty',
  'humble',
  'ideal',
  'jaunty',
  'jolly',
  'joyful',
  'keen',
  'kindly',
  'limber',
  'lively',
  'lucky',
  'lush',
  'mellow',
  'merry',
  'mighty',
  'modest',
  'nifty',
  'nimble',
  'noble',
  'peppy',
  'perky',
  'plucky',
  'plush',
  'proud',
  'quick',
  'quirky',
  'royal',
  'shiny',
  'silky',
  'silver',
  'smart',
  'snug',
  'sparkly',
  'spry',
  'sturdy',
  'sunny',
  'super',
  'swift',
  'tender',
  'tidy',
  'true',
  'trusty',
  'upbeat',
  'valiant',
  'vivid',
  'warm',
  'wily',
  'witty',
  'wise',
  'zealous',
  'zesty',
  'zippy'
]

const NOUNS: readonly string[] = [
  'badger',
  'beaver',
  'bison',
  'cheetah',
  'cobra',
  'condor',
  'coyote',
  'crane',
  'dolphin',
  'dragon',
  'eagle',
  'elk',
  'falcon',
  'ferret',
  'finch',
  'fox',
  'frog',
  'gecko',
  'goat',
  'hawk',
  'heron',
  'hippo',
  'horse',
  'ibex',
  'iguana',
  'jackal',
  'jaguar',
  'kestrel',
  'kiwi',
  'koala',
  'lark',
  'lemur',
  'leopard',
  'lion',
  'lynx',
  'mantis',
  'marmot',
  'marten',
  'meerkat',
  'mole',
  'moose',
  'narwhal',
  'newt',
  'ocelot',
  'orca',
  'oriole',
  'otter',
  'owl',
  'panda',
  'panther',
  'parrot',
  'penguin',
  'possum',
  'puffin',
  'puma',
  'quail',
  'quokka',
  'rabbit',
  'raven',
  'robin',
  'salmon',
  'seal',
  'shark',
  'sloth',
  'sparrow',
  'stoat',
  'swan',
  'tapir',
  'tern',
  'tiger',
  'toad',
  'urchin',
  'vole',
  'walrus',
  'whale',
  'wolf',
  'wombat',
  'yak',
  'zebra'
]

// Why: 5-char base36 random tail gives ~60M combinations per adj_noun pair.
// Combined with 6400 base combos, the chance of two members independently
// rolling the same full slug is ~1/400B. Uses crypto.randomBytes so tests
// that mock Math.random don't accidentally make the hash deterministic.
function pickHashSuffix(): string {
  return randomBytes(4).readUInt32BE(0).toString(36).padStart(5, '0').slice(0, 5)
}

function pickRandom<T>(items: readonly T[]): T {
  // Why: Math.floor(Math.random() * len) is the standard uniform pick. We
  // mock Math.random in tests to make collision behavior deterministic.
  return items[Math.floor(Math.random() * items.length)]
}

/** Generate a fresh adjective_noun_hash suggestion (no collision check). */
export function suggestWorkspaceName(): string {
  return `${pickRandom(ADJECTIVES)}_${pickRandom(NOUNS)}_${pickHashSuffix()}`
}

/** Generate a name unique across `takenNames`; appends `_2`, `_3`, … on collision. */
export function generateUniqueWorkspaceName(takenNames: ReadonlySet<string>): string {
  // Why: keep retrying fresh suggestions if the suffix path would overflow
  // the 16-char budget; numeric suffix is preferred over re-rolling because
  // it makes the relationship between siblings visible at a glance.
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const base = suggestWorkspaceName()
    if (!takenNames.has(base)) {
      return base
    }
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base}_${suffix}`
      if (candidate.length > 16) {
        // Suffix would push past the format budget; try a fresh base instead.
        break
      }
      if (!takenNames.has(candidate)) {
        return candidate
      }
    }
  }
  // Pathological fallback: drop the format constraint to guarantee uniqueness.
  // In practice unreachable — 80 × 80 = 6400 base combinations.
  let fallback = `${suggestWorkspaceName()}_${Date.now().toString(36)}`
  while (takenNames.has(fallback)) {
    fallback = `${suggestWorkspaceName()}_${Date.now().toString(36)}`
  }
  return fallback
}

/** Validation. Returns null if `name` is acceptable, otherwise an error message. */
export function validateWorkspaceName(
  name: string,
  takenNames: ReadonlySet<string>
): string | null {
  if (!name) {
    return 'Workspace name is required.'
  }
  if (!WORKSPACE_NAME_PATTERN.test(name)) {
    return 'Use lowercase letters, digits, and underscores (max 22 chars, must start with a letter).'
  }
  if (takenNames.has(name)) {
    return 'This workspace name is already in use for this repo.'
  }
  return null
}
