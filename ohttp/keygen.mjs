// Make a gateway key.
//
//   node keygen.mjs            new random seed
//   node keygen.mjs <seed>     show the public key configuration for an existing seed
//
// Prints OHTTP_SEED (SECRET: give it only to the gateway) and the public key configuration
// (goes in site/public/ohttp.json as "keyConfig"; safe to publish).

import { randomBytes } from "node:crypto"
import { KeyConfig } from "ohttp-ts"
import { keyConfigFromSeed } from "./gateway/handler.js"

const seed = process.argv[2] ?? randomBytes(32).toString("hex")
const keyConfig = await keyConfigFromSeed(seed)
const keys = Buffer.from(KeyConfig.serializeMultiple([keyConfig])).toString("base64")

if (!process.argv[2]) console.log(`OHTTP_SEED=${seed}`)
console.log(`keyConfig (public): ${keys}`)
