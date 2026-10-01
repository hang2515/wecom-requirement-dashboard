export function fallbackPortFor(error, requestedPort) {
  return error?.code === 'EADDRINUSE' && requestedPort === 3210 ? 3211 : null;
}
