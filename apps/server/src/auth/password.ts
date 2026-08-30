import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const DIGEST_PREFIX = "scrypt-v1";
const SALT_BYTES = 16;
const KEY_BYTES = 64;

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const key = (await scrypt(password, salt, KEY_BYTES)) as Buffer;
  return `${DIGEST_PREFIX}:${salt.toString("hex")}:${key.toString("hex")}`;
};

export const verifyPassword = async (
  password: string,
  digest: string
): Promise<boolean> => {
  const [prefix, saltHex, keyHex, extra] = digest.split(":");
  if (
    prefix !== DIGEST_PREFIX ||
    saltHex === undefined ||
    keyHex === undefined ||
    extra !== undefined ||
    saltHex.length !== SALT_BYTES * 2 ||
    keyHex.length !== KEY_BYTES * 2 ||
    !/^[0-9a-f]+$/i.test(saltHex) ||
    !/^[0-9a-f]+$/i.test(keyHex)
  ) {
    return false;
  }

  const expected = Buffer.from(keyHex, "hex");
  const actual = (await scrypt(
    password,
    Buffer.from(saltHex, "hex"),
    KEY_BYTES
  )) as Buffer;
  return timingSafeEqual(actual, expected);
};
