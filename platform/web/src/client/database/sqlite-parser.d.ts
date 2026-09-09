declare module "@appland/sql-parser" {
  /** Synchronous syntax parsing only. No database access or execution. */
  const parse: (text: string) => unknown;
  export default parse;
}
