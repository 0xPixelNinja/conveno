/** The first `X.Y.Z` (with any suffix) in the output of `<cli> --version`, or undefined. */
export function parseCliVersion(output: string): string | undefined {
  return /\d+\.\d+\.\d+\S*/.exec(output)?.[0];
}
