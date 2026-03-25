/**
 * Lightweight Brain-local logger shim.
 * Used by brain engines that need logging without pulling in the
 * full Winston config dependency chain.
 */
export const logger = {
  info: (...args) => console.log('[brain:info]', ...args),
  warn: (...args) => console.warn('[brain:warn]', ...args),
  error: (...args) => console.error('[brain:error]', ...args),
  debug: (...args) => {
    if (process.env.DEBUG) console.debug('[brain:debug]', ...args);
  },
};
