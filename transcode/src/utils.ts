export async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function exponentialBackoffSleep(base: number, exp: number, max?: number) {
    let ms = base * (1 << exp);
    if (max && ms > max) {
        ms = max;
    }
    ms = Math.random() * (ms / 2) + (ms / 2);
    return sleep(ms);
}