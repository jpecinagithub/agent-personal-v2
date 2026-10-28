// T-V2-013 (part 1): encrypted secret store.
// Values are encrypted at rest with AES-256-GCM. The encryption key lives
// in its OWN file (default: secrets.key next to the data file, configurable
// via the second constructor argument or AGENTV2_SECRETS_KEY_PATH), written
// mode 0600 and generated randomly on first use if absent. The key is never
// stored in the data file, never in the repo, and never returned by any API:
// the store only ever lists names; values are returned to server-side code
// that needs them, never to an HTTP response (see server.mjs).
// Writes are atomic (temp file + rename + chmod 0600). A legacy plaintext
// JSON store is migrated to encrypted form on load instead of crashing:
// the values are read once, re-encrypted, and the plaintext is replaced.
// Losing the key file makes the stored secrets unrecoverable by design;
// back the key up separately from the data file, never in the repo.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

function write0600(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, 0o600);
}

export class SecretStore {
  /**
   * @param {string} filePath encrypted data file
   * @param {string | { keyPath?: string }} [keyPathOrOptions] separate key file
   */
  constructor(filePath, keyPathOrOptions) {
    this.filePath = filePath;
    this.keyPath =
      typeof keyPathOrOptions === "string"
        ? keyPathOrOptions
        : (keyPathOrOptions?.keyPath ??
          process.env.AGENTV2_SECRETS_KEY_PATH ??
          path.join(path.dirname(filePath), "secrets.key"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    this.key = this.#loadOrCreateKey();
    // Normalise on load: creates the encrypted file if absent, migrates a
    // legacy plaintext file to encrypted form.
    this.#read();
  }

  #loadOrCreateKey() {
    if (fs.existsSync(this.keyPath)) {
      const raw = fs.readFileSync(this.keyPath);
      fs.chmodSync(this.keyPath, 0o600);
      if (raw.length === 32) return raw;
      // Tolerate a key file written as base64 text (44 chars) by an older
      // or manual setup: normalise it back to raw bytes on disk.
      const decoded = Buffer.from(raw.toString("utf8").trim(), "base64");
      if (decoded.length === 32) {
        write0600(this.keyPath, decoded);
        return decoded;
      }
      throw new Error("secret key file is not a valid 32-byte AES-256 key");
    }
    const key = randomBytes(32);
    write0600(this.keyPath, key);
    return key;
  }

  #encrypt(plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return JSON.stringify({
      format: "aes-256-gcm-v1",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: ciphertext.toString("base64"),
    });
  }

  #decrypt(envelope) {
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  }

  #read() {
    if (!fs.existsSync(this.filePath)) {
      this.#write({});
      return {};
    }
    fs.chmodSync(this.filePath, 0o600);
    const text = fs.readFileSync(this.filePath, "utf8").trim();
    if (text === "") {
      this.#write({});
      return {};
    }
    const parsed = JSON.parse(text);
    if (parsed && parsed.format === "aes-256-gcm-v1") {
      return this.#decrypt(parsed);
    }
    // Legacy plaintext store: migrate it to encrypted form on load.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      this.#write(parsed);
      return parsed;
    }
    throw new Error("secret store file has an unrecognized format");
  }

  #write(data) {
    write0600(this.filePath, this.#encrypt(JSON.stringify(data)));
    try {
      fs.chmodSync(this.keyPath, 0o600);
    } catch {
      // Key file was removed concurrently; next load recreates it.
    }
  }

  set(name, value) {
    if (!NAME.test(name)) throw new Error("invalid secret name");
    if (typeof value !== "string" || value.length === 0) throw new Error("secret value must be a non-empty string");
    const data = this.#read();
    data[name] = value;
    this.#write(data);
  }
  get(name) {
    return this.#read()[name];
  }
  has(name) {
    return Object.prototype.hasOwnProperty.call(this.#read(), name);
  }
  // Names only. Values never leave through this method.
  list() {
    return Object.keys(this.#read()).sort();
  }
}
