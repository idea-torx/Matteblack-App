const ADJECTIVES = [
  "Cosmic", "Velvet", "Neon", "Crystal", "Amber", "Solar", "Lunar", "Arctic",
  "Ember", "Mystic", "Golden", "Silver", "Crimson", "Azure", "Ivory", "Onyx",
  "Coral", "Indigo", "Scarlet", "Jade", "Copper", "Obsidian", "Sapphire", "Ruby",
  "Dusty", "Frozen", "Hollow", "Silent", "Gentle", "Rapid", "Vivid", "Fading",
  "Rising", "Drifting", "Floating", "Glowing", "Burning", "Melting", "Spinning",
  "Echoing", "Humming", "Pulsing", "Shining", "Blazing", "Flowing", "Soaring",
  "Twisted", "Broken", "Hidden", "Ancient", "Modern", "Digital", "Analog",
  "Electric", "Magnetic", "Quantum", "Stellar", "Nebula", "Phantom", "Shadow",
  "Thunder", "Whisper", "Vapor", "Iron", "Pixel", "Prism", "Chrome", "Cobalt",
  "Atomic", "Radiant", "Serene", "Wild", "Fierce", "Swift", "Deep", "Bright",
];

const NOUNS = [
  "Breeze", "Storm", "Cascade", "Drift", "Pulse", "Wave", "Echo", "Bloom",
  "Horizon", "Aurora", "Zenith", "Vortex", "Mirage", "Nebula", "Ember", "Frost",
  "Spark", "Flame", "Crystal", "Shadow", "Thunder", "Whisper", "Voyage", "Canyon",
  "Reef", "Tide", "Gale", "Blaze", "Haze", "Flare", "Dusk", "Dawn",
  "Rift", "Peak", "Vale", "Crest", "Mist", "Rain", "Glow", "Beam",
  "Circuit", "Signal", "Fragment", "Shard", "Prism", "Orbit", "Comet", "Nova",
  "Ripple", "Surge", "Tremor", "Quake", "Spiral", "Vertex", "Core", "Edge",
  "Dream", "Realm", "Phase", "Shift", "Arc", "Loop", "Trail", "Path",
  "Rune", "Sigil", "Cipher", "Chord", "Note", "Tone", "Rhythm", "Cadence",
  "Sonnet", "Hymn", "Anthem", "Ballad", "Requiem", "Opus", "Suite", "Fugue",
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

export function generateClipName(id: string): string {
  const hash = hashString(id);
  const adjIndex = hash % ADJECTIVES.length;
  const nounIndex = Math.floor(hash / ADJECTIVES.length) % NOUNS.length;
  return `${ADJECTIVES[adjIndex]} ${NOUNS[nounIndex]}`;
}
