/** UTC の YYYY-MM-DD。夏時間の影響を受けない（ADR-0004） */
export const utcDate = (d = new Date()) => d.toISOString().slice(0, 10);
