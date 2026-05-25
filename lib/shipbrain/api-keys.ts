import { createHash, randomBytes } from "crypto";

export function generateShipBrainApiKey() {
  return `sb_live_${randomBytes(24).toString("base64url")}`;
}

export function hashShipBrainApiKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function lastFour(value: string) {
  return value.slice(-4);
}
