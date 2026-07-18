const COMPOSER_HIGHLIGHT_WORDS = new Set(["routine"]);

export function composerHighlightWord(word: string | null): string | null {
  return word && COMPOSER_HIGHLIGHT_WORDS.has(word) ? word : null;
}

export function highlightedTextParts(text: string, word: string | null): [string, string, string] | null {
  if (!word) return null;
  const index = text.toLowerCase().indexOf(word.toLowerCase());
  if (index < 0) return null;
  return [text.slice(0, index), text.slice(index, index + word.length), text.slice(index + word.length)];
}
