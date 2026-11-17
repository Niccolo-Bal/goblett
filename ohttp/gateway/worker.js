// Cloudflare Worker entry for the gateway. Settings come from the Worker's variables;
// OHTTP_SEED must be a Secret.
import { createGateway } from "./handler.js"

let handle // built once per isolate (derives the key)

export default {
  fetch(request, env) {
    handle ??= createGateway(env)
    return handle(request)
  },
}
