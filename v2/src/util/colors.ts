// ANSI color helpers

const enabled = process.env.NO_COLOR === undefined;

const code = (n: number) => (s: string) => enabled ? `\x1b[${n}m${s}\x1b[0m` : s;

export const bold = code(1);
export const dim = code(2);
export const red = code(31);
export const green = code(32);
export const yellow = code(33);
export const blue = code(34);
export const cyan = code(36);
export const gray = code(90);

export const statusColor = (status: string): ((s: string) => string) => {
  switch (status) {
    case 'pending': return yellow;
    case 'in_progress': return cyan;
    case 'completed': return green;
    case 'blocked': return red;
    case 'backlogged': return gray;
    case 'cancelled': return gray;
    default: return (s: string) => s;
  }
};
