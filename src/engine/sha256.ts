// SHA-256 for the instructor password. Ported from index.html:1376-1393 at
// 5e96ce5.

export function sha256(str: string): string {
  const ascii = unescape(encodeURIComponent(str));
  const rr = (v: number, a: number) => (v >>> a) | (v << (32 - a));
  const mp = Math.pow,
    maxWord = mp(2, 32);
  let result = "";
  const words: number[] = [];
  const bitLen = ascii.length * 8;
  let hash: number[] = [];
  const k: number[] = [];
  let pc = 0;
  const isC: Record<number, number> = {};
  for (let cand = 2; pc < 64; cand++) {
    if (!isC[cand]) {
      for (let i = 0; i < 313; i += cand) isC[i] = cand;
      hash[pc] = (mp(cand, 0.5) * maxWord) | 0;
      k[pc++] = (mp(cand, 1 / 3) * maxWord) | 0;
    }
  }
  let s = ascii + "\x80";
  while ((s.length % 64) - 56) s += "\x00";
  for (let i = 0; i < s.length; i++) {
    const j = s.charCodeAt(i);
    words[i >> 2] |= j << (((3 - i) % 4) * 8);
  }
  words[words.length] = (bitLen / maxWord) | 0;
  words[words.length] = bitLen;
  for (let j = 0; j < words.length;) {
    const w = words.slice(j, (j += 16));
    const old = hash;
    hash = hash.slice(0, 8);
    for (let i = 0; i < 64; i++) {
      const w15 = w[i - 15],
        w2 = w[i - 2];
      const a = hash[0],
        e = hash[4];
      const t1 =
        hash[7] +
        (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) +
        ((e & hash[5]) ^ (~e & hash[6])) +
        k[i] +
        (w[i] =
          i < 16
            ? w[i]
            : (w[i - 16] +
                (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) +
                w[i - 7] +
                (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) |
              0);
      const t2 =
        (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) +
        ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
      hash = [(t1 + t2) | 0].concat(hash);
      hash[4] = (hash[4] + t1) | 0;
    }
    for (let i = 0; i < 8; i++) hash[i] = (hash[i] + old[i]) | 0;
  }
  for (let i = 0; i < 8; i++)
    for (let j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255;
      result += (b < 16 ? "0" : "") + b.toString(16);
    }
  return result;
}
