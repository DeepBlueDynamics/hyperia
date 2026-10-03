/**
 * The saved grid size to spawn a restored shell at. Without it node-pty starts at
 * 80x24 and the first fit resizes a prompt that is already drawn, which ConPTY
 * reflows into a duplicated prompt line until the next keypress.
 */
export const savedBirthSize = (session: any): {cols?: number; rows?: number} => {
  const ok = (n: unknown, max: number) => Number.isInteger(n) && (n as number) >= 2 && (n as number) <= max;
  return ok(session?.cols, 1000) && ok(session?.rows, 500) ? {cols: session.cols, rows: session.rows} : {};
};
