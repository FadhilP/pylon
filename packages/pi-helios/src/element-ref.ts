export const ELEMENT_REF_FRAGMENT = String.raw`(?:f[0-9]+)?e[0-9]+`;
export const ELEMENT_REF_PATTERN = `^${ELEMENT_REF_FRAGMENT}$`;

const ELEMENT_REF = new RegExp(ELEMENT_REF_PATTERN);
const SNAPSHOT_ELEMENT_REF = new RegExp(
  String.raw`\[ref=(${ELEMENT_REF_FRAGMENT})\]`,
  "g",
);

export function isElementReference(value: string): boolean {
  return ELEMENT_REF.test(value);
}

export function elementReferences(snapshot: string): string[] {
  return Array.from(
    snapshot.matchAll(SNAPSHOT_ELEMENT_REF),
    (match) => match[1],
  );
}
