// Stands in for the "jsonwebtoken" package in the browser bundle (see vite.config.js).
// Circle's Web SDK imports that Node library only to read the nonce out of a Google ID
// token; the real package needs Node's crypto and stream modules, which browsers lack.
// decode() never verified signatures in the original either. Circle verifies the token.

export function decode(token) {
  try {
    const part = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")
    const bytes = Uint8Array.from(atob(part), (c) => c.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

export default { decode }
