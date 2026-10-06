/** Sports Diary logo. Use the on-dark version on navy surfaces, the standard one on light. */
export const BRAND = 'Sports Diary';
export const logo = (surface: 'dark' | 'light' = 'dark', cls = 'logo') =>
  `<img class="${cls}" src="/brand/${surface === 'dark' ? 'sports-diary-on-dark' : 'sports-diary'}.svg" alt="${BRAND}" width="381" height="83">`;
