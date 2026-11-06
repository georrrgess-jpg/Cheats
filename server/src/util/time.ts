export const nowSec = () => Math.floor(Date.now() / 1000);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const MIN = 60;
export const HOUR = 3600;
export const DAY = 86400;
