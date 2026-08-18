//#region src/bin.d.ts
/** Standalone status/diagnostics CLI for the dsh-workbuddy-connect bundle. */
/** Execute one boot-free command. */
declare function run(argv: readonly string[]): Promise<number>;
//#endregion
export { run };