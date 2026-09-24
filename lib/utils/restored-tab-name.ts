// Name a restored tab after the SAVED entry (#183), not the tabName that was
// baked into the layout at save time (that made a tab saved as "Bob two" after
// a rename to "Bob" come back as "Bob"). When the saved name already shows on an
// open tab, add a file-style "(n)" suffix — computed at restore time, never
// baked into the saved name — so a deliberate "give me a copy" restore stays
// tellable apart from the original.
export function restoredTabName(savedName: string, openTabNames: Iterable<string>): string {
  const taken = new Set(openTabNames);
  let finalName = savedName;
  for (let n = 2; taken.has(finalName); n++) {
    finalName = `${savedName} (${n})`;
  }
  return finalName;
}
