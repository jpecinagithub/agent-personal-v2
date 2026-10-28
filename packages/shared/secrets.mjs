// T-V2-013 (part 1): secret store.
// Values live in one JSON file written with mode 0600 (write temp + rename
// + chmod, so a half-written file never replaces a good one). The store
// only ever lists names; values are returned to server-side code that
// needs them, never to an API response (see server.mjs).
import fs from "node:fs";
import path from "node:path";

const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export class SecretStore {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "{}", { mode: 0o600 });
    } else {
      fs.chmodSync(filePath, 0o600);
    }
  }
  #read() {
    return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
  }
  #write(data) {
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
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
